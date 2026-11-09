// Probe fixture — a real interactive session inside a broker PTY (real timers
// required, ts-no-test-timers exception): the probe observes bytes crossing a
// real terminal, a real child process and the broker's Unix socket, so fake
// timers cannot drive it. It holds a typed draft and a pending approval gate
// while an external mirror detaches, a fresh mirror attaches and refreshes the
// renderer; every observation is appended to `child-events.jsonl` for the
// parent test, never printed on the screen it is measuring.
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";

import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const [controlDir, endpointDir, generation] = process.argv.slice(2);
if (!controlDir || !endpointDir || !generation) throw new Error("usage: <control-dir> <endpoint-dir> <generation>");
fs.mkdirSync(controlDir, { recursive: true });
fs.mkdirSync(endpointDir, { recursive: true });
const eventsFile = path.join(controlDir, "child-events.jsonl");
const emit = (name: string, data: Record<string, unknown> = {}): void => {
	fs.appendFileSync(eventsFile, `${JSON.stringify({ name, ...data })}\n`);
};

const draft = "draft λ草";
const cwd = process.cwd();
await Settings.init({ inMemory: true, cwd });
await initTheme();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const mock = createMockModel({ responses: [] });
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Probe"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	}),
	sessionManager: SessionManager.inMemory(cwd),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
	toolRegistry: new Map(),
});
const socket = createAgentSessionSocket(session, { endpointDir });
const mode = new InteractiveMode(session, "probe", undefined, undefined, undefined, undefined, new Composer());
const refresh = mode.refreshTerminalAttachment.bind(mode);
mode.refreshTerminalAttachment = (): void => {
	emit("refreshed", { draft: mode.editor.getText(), dialogs: mode.editorContainer.children.length });
	refresh();
};

process.stdin.on("data", chunk => emit("stdin", { data: String(chunk) }));

await mode.attachSessionSocket(socket, { generation });
await mode.init({ suppressWelcomeIntro: true });
mode.editor.setText(draft);
const context = mode.getToolUIContext();
if (!context) throw new Error("no tool UI context");
const approve = context.approve;
if (!approve) throw new Error("no approval prompt");
const approval = approve({
	full: "Allow tool: write\nPath: /tmp/probe.txt",
	compact: "Allow tool: write\nPath: /tmp/probe.txt",
});
emit("gate-open", { draft: mode.editor.getText(), dialogs: mode.editorContainer.children.length });
void approval.then(value => {
	emit("gate-settled", { value, draft: mode.editor.getText() });
});
emit("ready", {
	sessionId: session.sessionId,
	endpoint: path.join(endpointDir, `${session.sessionId}.sock`),
	draft: mode.editor.getText(),
});
process.stdout.write("PROBE_READY\n");
