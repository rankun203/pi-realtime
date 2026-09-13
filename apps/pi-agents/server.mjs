import { createServer, request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assets = dirname(fileURLToPath(import.meta.url));
const uuid = /^[a-f0-9-]{36}$/;
const sessionId = /^[a-zA-Z0-9_-]{1,100}$/;
const defaultRegistry = () => join((process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')).replace(/^~(?=\/|$)/, homedir()), 'pi-realtime', 'helpers');

export async function discoverHelpers(directory) {
 let files;
 try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 const helpers = await Promise.all(files.filter(name => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).slice(0, 128).map(async name => {
  try {
   const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
   if (record.id !== name.slice(0, -5) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !Number.isInteger(record.pid) || record.pid < 1) return;
   process.kill(record.pid, 0);
   const response = await fetch(`http://127.0.0.1:${record.port}/pi-realtime/discovery`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
   if (!response.ok) return;
   const text = await response.text();
   if (text.length > 100000) return;
   const info = JSON.parse(text);
   if (info.id !== record.id || !Array.isArray(info.sessions)) return;
   return { id: record.id, port: record.port, project: String(info.project || 'Pi'), sessions: info.sessions.filter(s => sessionId.test(s.id)).map(s => ({ id: s.id, model: String(s.model), mode: String(s.mode) })) };
  } catch { return; } // Dead/stale process or helper that no longer owns this port.
 }));
 return helpers.filter(Boolean);
}

function reply(res, code, body) {
 if (res.headersSent) return res.destroy();
 res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
}

export function createDashboard({ registryDir = defaultRegistry(), publicHost = process.env.PI_AGENTS_PUBLIC_HOST } = {}) {
 const server = createServer((req, res) => void handle(req, res).catch(() => reply(res, 502, { error: 'Helper unavailable. Refresh the agent list.' })));
 async function handle(req, res) {
  const port = server.address()?.port;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : [])];
  if (!allowedHosts.includes(req.headers.host)) return reply(res, 403, { error: 'Host not allowed' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Cross-origin request denied' });
  if (req.headers.origin) {
   let origin;
   try { origin = new URL(req.headers.origin); } catch { return reply(res, 403, { error: 'Invalid origin' }); }
   if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) return reply(res, 403, { error: 'Cross-origin request denied' });
  }
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'microphone=(self), camera=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
   res.setHeader('content-type', url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
   return res.end(await readFile(join(assets, url.pathname === '/' ? 'index.html' : 'app.js')));
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') {
   const helpers = await discoverHelpers(registryDir);
   return reply(res, 200, { agents: helpers.flatMap(h => h.sessions.map(s => ({ ...s, helperId: h.id, project: h.project, path: `/agents/${h.id}/pi-realtime/openai/${s.id}` }))) });
  }
  const route = /^\/agents\/([a-f0-9-]{36})(\/pi-realtime\/(?:webrtc\/client\.js|openai\/[a-zA-Z0-9_-]{1,100}(?:\/(?:config|client-secret|event|outbox|messages|message|voice-connect|voice-heartbeat|voice-disconnect))?))$/.exec(url.pathname);
  if (!route || !['GET', 'POST'].includes(req.method)) return reply(res, 404, { error: 'Not found' });
  const helper = (await discoverHelpers(registryDir)).find(h => h.id === route[1]);
  if (!helper) return reply(res, 404, { error: 'Agent offline' });
  const id = /^\/pi-realtime\/openai\/([^/]+)/.exec(route[2])?.[1];
  if (id && !helper.sessions.some(s => s.id === id)) return reply(res, 404, { error: 'Session unavailable' });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return reply(res, 413, { error: 'Request too large' }); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  // Only forward headers required by the helper. Access cookies/assertions never leave this gateway.
  const headers = { host: req.headers.host, 'content-length': body.length };
  for (const name of ['origin', 'sec-fetch-site', 'content-type']) if (req.headers[name]) headers[name] = req.headers[name];
  const upstream = request({ hostname: '127.0.0.1', port: helper.port, path: route[2] + url.search, method: req.method, headers }, response => {
   res.statusCode = response.statusCode || 502;
   res.setHeader('content-type', response.headers['content-type'] || 'application/octet-stream');
   response.pipe(res);
  });
  upstream.setTimeout(45000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => reply(res, 502, { error: 'Agent connection failed' }));
  res.on('close', () => upstream.destroy());
  upstream.end(body);
 }
 return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const port = Number(process.env.PI_AGENTS_PORT || 8877);
 if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PI_AGENTS_PORT must be 1–65535');
 const server = createDashboard();
 server.listen(port, '127.0.0.1', () => console.log(`Pi Agents: http://127.0.0.1:${port} (loopback only)`));
 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
