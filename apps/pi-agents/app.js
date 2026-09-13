const select = document.getElementById('agents');
const frame = document.getElementById('chat');
const status = document.getElementById('status');
let selected = '', calling = false, refreshing = false, agents = [];
window.addEventListener('message', event => {
 if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === 'pi-agents-call') calling = event.data.active === true;
});
select.addEventListener('change', () => {
 if (calling && !confirm('End the current call and switch agents?')) { select.value = selected; return; }
 choose(select.value);
});
document.getElementById('refresh').addEventListener('click', refresh);
function choose(path) {
 if (!path || path === selected) return;
 if (selected) frame.contentWindow.postMessage({ type: 'pi-agents-disconnect' }, location.origin);
 calling = false; selected = path; select.value = path;
 frame.src = path; frame.hidden = false; document.getElementById('empty').hidden = true;
}
async function refresh() {
 if (refreshing) return;
 refreshing = true;
 try {
  const response = await fetch('/api/agents');
  if (!response.ok) throw new Error('Agent discovery failed. Check your Access login and server.');
  agents = (await response.json()).agents;
  select.replaceChildren();
  for (const agent of agents) {
   const option = document.createElement('option'); option.value = agent.path;
   option.textContent = `${agent.project.split('/').filter(Boolean).pop() || 'Pi'} · ${agent.model} · ${agent.id.slice(-8)}`;
   select.append(option);
  }
  if (selected && !agents.some(agent => agent.path === selected)) {
   const option = document.createElement('option'); option.value = selected; option.textContent = 'Selected agent offline'; select.append(option);
  }
  if (!agents.length && !selected) { const option = document.createElement('option'); option.textContent = 'No available agents'; option.value = ''; select.append(option); }
  status.textContent = `${agents.length} available session${agents.length === 1 ? '' : 's'} · refreshes automatically · calls require microphone permission`;
  if (!selected && agents.length) choose(agents[0].path);
  select.value = selected;
 } catch (error) { status.textContent = error.message; } finally { refreshing = false; }
}
refresh();
setInterval(refresh, 5000);
