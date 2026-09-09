/**
 * Child-process probe for #7235: the Bash auto-background threshold race must not
 * leave a live, ref'd timer after the command finishes first. Runs the real
 * `BashTool` auto-background path for a fast command against a 30s threshold and
 * exits without disposing the job manager. A retained threshold timer would keep
 * the event loop alive until the threshold expires; the fix clears it, so the
 * process must exit promptly. The parent test measures wall-clock exit time.
 */
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const THRESHOLD_MS = 30_000;

// retentionMs:0 evicts the completed job immediately; the eviction timer is
// unref'd regardless, so the only ref'd timer under test is the race threshold.
const manager = new AsyncJobManager({ retentionMs: 0 });

const session = {
	cwd: "/tmp",
	hasUI: false,
	skills: [],
	getSessionFile: () => null,
	getSessionId: () => "autobg-probe",
	getAgentId: () => null,
	asyncJobManager: manager,
	settings: {
		get(key: string) {
			if (key === "bash.autoBackground.enabled") return true;
			if (key === "bash.autoBackground.thresholdMs") return THRESHOLD_MS;
			return undefined;
		},
		getBashInterceptorRules() {
			return [];
		},
	},
	getClientBridge: () => undefined,
} as unknown as ToolSession;

const tool = new BashTool(session);
const result = await tool.execute("autobg-probe-call", { command: "printf hi" });
const text = result.content.find(c => c.type === "text")?.text ?? "";
// First line only: the completed-result text carries a dynamic "Wall time" footer.
const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
process.stdout.write(`${JSON.stringify({ done: true, output: firstLine })}\n`);
// Deliberately no manager.dispose(): the process must exit on its own.
