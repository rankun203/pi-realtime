import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard, discoverHelpers } from "./server.mjs";

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) =>
	new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});

test("dashboard discovers verified local helpers, proxies only registered sessions and rejects CSRF/rebinding", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-test-"));
	const id = "11111111-1111-4111-8111-111111111111";
	let writes = 0;
	const helper = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/pi-realtime/discovery")
			return res.end(
				JSON.stringify({
					id,
					project: "/workspace/demo",
					sessions: [{ id: "session-a", model: "mini", mode: "agent" }],
				}),
			);
		if (req.method === "POST") writes++;
		res.end(JSON.stringify({ ok: true, path: req.url, host: req.headers.host, cookie: req.headers.cookie }));
	});
	const helperPort = await listen(helper);
	const dashboard = createDashboard({ registryDir: directory });
	const port = await listen(dashboard);
	const base = `http://127.0.0.1:${port}`;
	try {
		await writeFile(
			join(directory, `${id}.json`),
			JSON.stringify({ id, pid: process.pid, port: helperPort, host: "ignored.invalid" }),
		);
		assert.equal((await discoverHelpers(directory)).length, 1);
		const list = await fetch(`${base}/api/agents`).then((r) => r.json());
		assert.equal(list.agents.length, 1);
		const path = list.agents[0].path;
		const proxy = await fetch(`${base}${path}/messages`, { headers: { cookie: "private-access-cookie" } }).then((r) =>
			r.json(),
		);
		assert.equal(proxy.path, "/pi-realtime/openai/session-a/messages");
		assert.equal(proxy.cookie, undefined);
		assert.equal(proxy.host, `127.0.0.1:${port}`);
		const post = await fetch(`${base}${path}/message`, { method: "POST", headers: { origin: base }, body: "{}" });
		assert.equal(post.status, 200);
		assert.equal(writes, 1);
		assert.equal(
			(await fetch(`${base}${path}/message`, { method: "POST", headers: { origin: "https://evil.test" } })).status,
			403,
		);
		const rebindingStatus = await new Promise((resolve, reject) => {
			const req = request(`${base}/api/agents`, { headers: { host: "evil.test" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(rebindingStatus, 403);
		assert.equal(writes, 1);
		assert.equal((await fetch(`${base}/agents/${id}/pi-realtime/openai/not-registered/config`)).status, 404);
		assert.equal((await fetch(`${base}/agents/${id}/arbitrary-local-service`)).status, 404);
		const page = await fetch(base);
		assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self'/);
		assert.match(await page.text(), /Pi Agents/);
		await writeFile(
			join(directory, `${id}.json`),
			JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", pid: process.pid, port: helperPort }),
		);
		assert.equal((await discoverHelpers(directory)).length, 0);
	} finally {
		await close(dashboard);
		await close(helper);
		await rm(directory, { recursive: true, force: true });
	}
});
