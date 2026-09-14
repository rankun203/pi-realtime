import { spawnSync } from "node:child_process";
const result = spawnSync(
	process.execPath,
	[
		"--import",
		"tsx",
		"--test",
		".ai/validation/config.test.ts",
		".ai/validation/companion.test.ts",
		".ai/validation/companion-browser.test.ts",
		".ai/validation/native-agent.test.ts",
		".ai/validation/start-command.test.ts",
		".ai/validation/view.test.ts",
		".ai/validation/speech-cost.test.ts",
		".ai/validation/dashboard.test.ts",
		"apps/pi-agents/server.test.mjs",
	],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
