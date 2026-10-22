import { vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils";
import { extractProfileFlags } from "../../src/cli/profile-bootstrap";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import * as workerClient from "../../src/subprocess/worker-client";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

if (process.argv[2] === "receive") {
	const extracted = extractProfileFlags(process.argv.slice(3));
	// Require argv propagation even on the spawn fallback, whose env could mask a regression.
	setProfile(extracted.profile);
	const resumeIndex = extracted.argv.indexOf("--resume");
	if (resumeIndex === -1) throw new Error("Restarted process did not receive --resume");
	const sessionFile = extracted.argv[resumeIndex + 1];
	// Listed under the restored profile only if the profile reached the new process.
	const sessions = await SessionManager.list(process.cwd());
	const found = sessionFile && sessions.find(session => path.resolve(session.path) === path.resolve(sessionFile));
	if (!found) throw new Error(`Restarted profile could not find session ${sessionFile}`);
	const resumed = await SessionManager.open(found.path);
	process.stdout.write(
		`${JSON.stringify({ profile: getActiveProfile() ?? "default", entries: resumed.getEntries() })}\n`,
	);
	await resumed.close();
} else {
	setProfile("restart-work");
	initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled model");
	const sessionManager = SessionManager.create(process.cwd());
	sessionManager.appendMessage({ role: "user", content: "profile restart marker", timestamp: Date.now() });
	await sessionManager.ensureOnDisk();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	const mode = new InteractiveMode(session, "test");
	mode.ui.requestRender = () => {};
	mode.ui.terminal.drainInput = async () => {};
	vi.spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, import.meta.path, "receive"]);
	await mode.restart();
}
