// Process fixture — real timers are required (ts-no-test-timers exception): it
// hosts a real interactive session inside a broker PTY, a real persisted session
// file, a real RPC endpoint and one session-owned background process. The test
// observes real process death (SIGKILL) and real disposal, which fake timers
// cannot drive. Control signals are file markers, socket frames and process
// liveness, never fixed delays.
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { consumeSessionOwnerContext } from "../../src/launch/session-owner";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const [controlDir, endpointDir, sessionDir] = process.argv.slice(2);
if (!controlDir || !endpointDir || !sessionDir) {
	throw new Error("usage: session-terminal-owner <controlDir> <endpointDir> <sessionDir>");
}
const owner = consumeSessionOwnerContext(process.env);
if (!owner) throw new Error("session terminal owner fixture requires the broker launch context");
fs.mkdirSync(controlDir, { recursive: true });
fs.mkdirSync(endpointDir, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
const eventsFile = path.join(controlDir, "owner-events.jsonl");
const emit = (name: string, data: Record<string, unknown> = {}): void => {
	fs.appendFileSync(eventsFile, `${JSON.stringify({ name, ...data })}\n`);
};

const cwd = process.cwd();
await Settings.init({ inMemory: true, cwd });
await initTheme();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
modelRegistry.getApiKey = async () => "test-key";
const mock = createMockModel({
	handler: () => {
		emit("turn-started", { pid: process.pid });
		return { delayMs: 3_000, content: ["completed while detached"] };
	},
});
const sessionManager = SessionManager.create(cwd, sessionDir);
const backgroundJobs = new AsyncJobManager({});
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Fixture"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	}),
	sessionManager,
	agentId: MAIN_AGENT_ID,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	toolRegistry: new Map(),
	ownedAsyncJobManager: backgroundJobs,
});

const backgroundProcess = Bun.spawn(["/bin/sh", "-c", "exec sleep 300"], {
	cwd,
	stdio: ["ignore", "ignore", "ignore"],
});
backgroundJobs.register(
	"task",
	"lifetime background process",
	async ({ signal }) => {
		const kill = (): void => {
			try {
				backgroundProcess.kill("SIGKILL");
			} catch {}
		};
		if (signal.aborted) kill();
		else signal.addEventListener("abort", kill, { once: true });
		await backgroundProcess.exited;
		return "background process released";
	},
	{ ownerId: MAIN_AGENT_ID },
);

const socket = createAgentSessionSocket(session, { endpointDir });
const mode = new InteractiveMode(session, "fixture", undefined, undefined, undefined, undefined, new Composer());
await mode.attachSessionSocket(socket, { generation: owner.id });
await mode.init({ suppressWelcomeIntro: true });

emit("ready", {
	pid: process.pid,
	id: owner.id,
	generation: owner.id,
	projectDir: owner.projectDir,
	sessionId: session.sessionId,
	sessionFile: sessionManager.getSessionFile(),
	endpoint: socket.endpoint,
	sidecarPath: socket.sidecarPath,
	backgroundPid: backgroundProcess.pid,
});
process.stdout.write("OWNER_READY\n");
