import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function createHelperDiscovery() {
	const id = randomUUID();
	const home = homedir();
	const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home) ?? join(home, ".pi", "agent");
	const directory = join(agentDir, "pi-realtime", "helpers");
	const file = join(directory, `${id}.json`);
	return {
		id,
		publish(port: number) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(`${file}.tmp`, JSON.stringify({ id, pid: process.pid, port }), { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		},
		remove() {
			try {
				unlinkSync(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}
