const select = document.getElementById("agents");
const frame = document.getElementById("chat");
const status = document.getElementById("status");
let selected = "",
	calling = false,
	refreshing = false,
	agents = [];
let agentListSignature = "";
window.addEventListener("message", (event) => {
	if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === "pi-agents-call")
		calling = event.data.active === true;
});
function requestSwitch(path) {
	if (path === selected) return;
	if (calling && !confirm("End the current call and switch agents?")) {
		select.value = selected;
		return;
	}
	choose(path);
}
select.addEventListener("change", () => requestSwitch(select.value));
document.getElementById("refresh").addEventListener("click", refresh);
function choose(path) {
	if (!path || path === selected) return;
	if (selected) frame.contentWindow.postMessage({ type: "pi-agents-disconnect" }, location.origin);
	calling = false;
	selected = path;
	select.value = path;
	frame.src = path;
	frame.hidden = false;
	document.getElementById("empty").hidden = true;
	renderAgentList();
}
function renderAgentList() {
	const signature = JSON.stringify([agents, selected]);
	if (signature === agentListSignature) return;
	agentListSignature = signature;
	const focusedAgent = document.activeElement?.dataset.agentPath;
	const list = document.getElementById("agent-list");
	list.replaceChildren();
	document.getElementById("agent-count").textContent = String(agents.length);
	for (const agent of agents) {
		const name = agent.project.split("/").filter(Boolean).pop() || "Pi";
		const button = document.createElement("button");
		button.className = "agent-card";
		button.dataset.agentPath = agent.path;
		button.setAttribute("aria-pressed", String(agent.path === selected));
		button.title = `${agent.project} · ${agent.model} · ${agent.id}`;
		const avatar = document.createElement("span");
		avatar.className = "avatar";
		avatar.textContent = name.slice(0, 2).toUpperCase();
		avatar.setAttribute("aria-hidden", "true");
		const info = document.createElement("span");
		info.className = "agent-info";
		const title = document.createElement("span");
		title.className = "agent-name";
		title.textContent = name;
		const model = document.createElement("span");
		model.className = "agent-model";
		model.textContent = `${agent.model} · ${agent.id.slice(-6)}`;
		info.append(title, model);
		button.append(avatar, info);
		button.addEventListener("click", () => requestSwitch(agent.path));
		list.append(button);
		if (focusedAgent === agent.path) button.focus({ preventScroll: true });
	}
	if (!agents.length) {
		const note = document.createElement("p");
		note.className = "brand-sub";
		note.textContent = "No agents connected yet.";
		list.append(note);
	}
}
async function refresh() {
	if (refreshing) return;
	refreshing = true;
	try {
		const response = await fetch("/api/agents");
		if (!response.ok) throw new Error("Agent discovery failed. Check your Access login and server.");
		const previousAgents = JSON.stringify(agents);
		agents = (await response.json()).agents;
		// Do not rebuild a user's open mobile picker on every discovery poll.
		if (JSON.stringify(agents) !== previousAgents || !select.dataset.loaded) {
			select.replaceChildren();
			for (const agent of agents) {
				const option = document.createElement("option");
				option.value = agent.path;
				option.textContent = `${agent.project.split("/").filter(Boolean).pop() || "Pi"} · ${agent.model} · ${agent.id.slice(-8)}`;
				select.append(option);
			}
			if (selected && !agents.some((agent) => agent.path === selected)) {
				const option = document.createElement("option");
				option.value = selected;
				option.textContent = "Selected agent offline";
				select.append(option);
			}
			if (!agents.length && !selected) {
				const option = document.createElement("option");
				option.textContent = "No available agents";
				option.value = "";
				select.append(option);
			}
			select.dataset.loaded = "true";
		}
		status.textContent = `${agents.length} session${agents.length === 1 ? "" : "s"} available`;
		renderAgentList();
		if (!selected && agents.length) choose(agents[0].path);
		select.value = selected;
	} catch (error) {
		status.textContent = error.message;
	} finally {
		refreshing = false;
	}
}
refresh();
setInterval(refresh, 5000);
