import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { RpcLiveSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch with a scripted live controller (no audio or realtime socket).
// Stopping the fake writes `live-stopped.json` (its options) so tests can observe teardown after stdin ends.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});

class FakeLiveSession implements RpcLiveSession {
	muted = false;
	#stopped: Promise<void> | undefined;
	constructor(readonly options: LiveSessionControllerOptions) {}

	async start(): Promise<void> {
		const { callbacks } = this.options;
		callbacks.onPhase("connecting");
		callbacks.onTranscript(undefined);
		await Bun.sleep(1);
		callbacks.onTranscript({ role: "user", turn: 1, text: "hello", final: true });
		callbacks.onPhase("listening");
	}

	toggleMute(): void {
		this.muted = !this.muted;
	}

	stop(): Promise<void> {
		this.#stopped ??= (async () => {
			await Bun.write(
				path.join(cwd, "live-stopped.json"),
				JSON.stringify({ voice: this.options.voice, instructions: this.options.instructions }),
			);
			this.options.callbacks.onTerminal();
		})();
		return this.#stopped;
	}
}

await runRpcMode(session, { createLiveSession: options => new FakeLiveSession(options) });
