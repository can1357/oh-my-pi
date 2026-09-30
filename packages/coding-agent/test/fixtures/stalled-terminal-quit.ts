/**
 * Quits a resumable interactive session through `InteractiveMode.shutdown()`
 * on the terminal it was given (a PTY the test is not reading), with a large
 * backlog queued, as a long session's last output leaves it.
 *
 * Reports progress over IPC without holding anything up: `shutdown` as the
 * quit starts, `exit-cleanup` once it reaches postmortem's exit cleanup.
 */
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem } from "@oh-my-pi/pi-utils";

const dir = process.argv[2];
if (!dir) throw new Error("usage: stalled-terminal-quit.ts <dir>");

initTheme();
await Settings.init({ inMemory: true, cwd: dir });
const modelRegistry = new ModelRegistry(await AuthStorage.create(path.join(dir, "auth.db")));
const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("expected bundled model");
const sessionManager = SessionManager.create(dir, path.join(dir, "sessions"));
const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
	sessionManager,
	settings: Settings.isolated(),
	modelRegistry,
});
// One exchange puts the session on disk, so the quit prints the resume hint.
sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
sessionManager.appendMessage({
	role: "assistant",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: "yo" }],
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	api: "anthropic-messages",
	timestamp: Date.now(),
});
await sessionManager.ensureOnDisk();

const composer = new Composer();
composer.start();
const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer);
mode.ui.terminal.write("x".repeat(4 * 1024 * 1024));

// Registered last, so it runs first in the exit cleanup; it only reports.
postmortem.register("report-exit-cleanup", () => {
	process.send?.("exit-cleanup");
});
process.send?.("shutdown");
await mode.shutdown();
