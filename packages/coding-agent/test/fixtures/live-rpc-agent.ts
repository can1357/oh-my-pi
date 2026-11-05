import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { RpcDictationController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-dictation";
import type { RpcLiveSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SttCallbacks, SttState, SttTarget } from "@oh-my-pi/pi-coding-agent/stt";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch with a scripted live controller (no audio or realtime socket).
// Stopping the fake writes `live-stopped.json` (its options) so tests can observe teardown after stdin ends.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.registerCommand("dictation-new-session", {
			handler: async (_args, ctx) => {
				await ctx.newSession();
			},
		});
		pi.registerCommand("dictation-switch-session", {
			handler: async (args, ctx) => {
				await ctx.switchSession(args);
			},
		});
		pi.registerCommand("dictation-reload-session", {
			handler: async (_args, ctx) => {
				await ctx.reload();
			},
		});
		pi.on("session_switch", async (event, ctx) => {
			await Bun.write(
				path.join(cwd, "session-switch.json"),
				JSON.stringify({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }),
			);
		});
		pi.registerCommand("dictation-nested-session", {
			handler: async (_args, ctx) => {
				await ctx.newSession({
					setup: async () => {
						await ctx.newSession();
						await ctx.ui.confirm("Transition held", "Release the outer session change");
					},
				});
			},
		});
	},
	cwd,
	new EventBus(),
	runtime,
	"dictation-session-change",
);
const extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const mock = createMockModel({ provider: model.provider, id: model.id, handler: () => ({ content: ["Done"] }) });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({
		"compaction.enabled": false,
		"stt.enabled": process.env.RPC_DISABLE_DICTATION !== "1",
	}),
	modelRegistry,
	extensionRunner,
});

class FakeLiveSession implements RpcLiveSession {
	muted = false;
	#stopped: Promise<void> | undefined;
	constructor(readonly options: LiveSessionControllerOptions) {}

	get sdpAnswer(): string | undefined {
		return this.options.sdpOffer === undefined ? undefined : `answer to ${this.options.sdpOffer}`;
	}

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

class FakeDictationController implements RpcDictationController {
	state: SttState = "idle";
	#callbacks: SttCallbacks | undefined;
	#target: SttTarget | undefined;
	#cancelled = false;
	#startGate = Promise.withResolvers<void>();
	#closed = false;

	async start(target: SttTarget, callbacks: SttCallbacks): Promise<void> {
		this.#callbacks = callbacks;
		this.#target = target;
		if (process.env.RPC_SLOW_DICTATION) await this.#startGate.promise;
		if (this.#cancelled) return;
		this.state = "recording";
		callbacks.onStateChange("recording");
		target.setVolatileText("hello");
	}

	async stop(): Promise<void> {
		this.#cancelled = true;
		this.#startGate.resolve();
		if (this.state !== "recording") return;
		this.state = "transcribing";
		this.#callbacks?.onStateChange("transcribing");
		if (process.env.RPC_FAIL_DICTATION) {
			this.state = "idle";
			this.#callbacks?.onStateChange("idle");
			this.#callbacks?.showWarning("recognizer failed");
			return;
		}
		this.#target?.commitVolatileText("hello world");
		this.state = "idle";
		this.#callbacks?.onStateChange("idle");
	}

	dispose(): void {
		if (this.#closed) return;
		if (process.env.RPC_FAIL_DICTATION_DISPOSE) throw new Error("microphone cleanup failed");
		this.#closed = true;
		this.#cancelled = true;
		this.#startGate.resolve();
		fs.writeFileSync(path.join(cwd, "dictation-stopped.json"), JSON.stringify({ state: this.state }));
		this.state = "idle";
	}
}

await runRpcMode(session, {
	createLiveSession: options => new FakeLiveSession(options),
	createDictationController: () => new FakeDictationController(),
});
