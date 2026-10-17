import { PassThrough } from "node:stream";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RpcConnection, RpcConnectionOptions } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-connection";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Point the agent dir at `dir`: sessions under a custom directory record
 * markers there (`custom-session-files`). Returns the restore for `afterEach`.
 */
export function isolateAgentDir(dir: string): () => void {
	const saved = Object.fromEntries(
		["PI_CODING_AGENT_DIR", "PI_PROFILE", "OMP_PROFILE"].map(key => [key, process.env[key]]),
	);
	setAgentDir(dir);
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	};
}

/**
 * Holds the assistant stream open after its first text delta until `gate` resolves, so a test
 * can act while a message is mid-stream (the mock model has no per-chunk delay).
 */
function holdAfterFirstDelta(inner: StreamFn, gate: Promise<void>): StreamFn {
	return async (...args) => {
		const source = await inner(...args);
		const out = new AssistantMessageEventStream();
		void (async () => {
			let held = false;
			for await (const event of source) {
				out.push(event);
				if (!held && event.type === "text_delta") {
					held = true;
					await gate;
				}
			}
		})();
		return out;
	};
}

export async function createTestSession(
	dir: string,
	mock: MockModelOptions,
	gate?: Promise<void>,
	options: {
		passiveReplica?: boolean;
		/** No session file: the host keeps the transcript in memory, so it has no artifacts directory. */
		inMemory?: boolean;
		/** A real extension `input` handler (through `ExtensionRunner`): runs for every user input, text as sent. */
		inputHook?: (text: string) => Promise<void>;
	} = {},
): Promise<AgentSession> {
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = createMockModel(mock);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: gate ? holdAfterFirstDelta(model.stream, gate) : model.stream,
	});
	const sessionManager = options.inMemory
		? SessionManager.inMemory(dir)
		: SessionManager.create(dir, path.join(dir, "sessions"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
	const { inputHook } = options;
	let extensionRunner: ExtensionRunner | undefined;
	if (inputHook) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("input", async event => {
					await inputHook(event.text);
					return undefined;
				});
			},
			dir,
			new EventBus(),
			runtime,
			"input-hook",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
	}
	return new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner,
		passiveReplica: options.passiveReplica,
	});
}

/** In-process client: writes commands into the server and collects parsed frames. */
export class TestClient {
	readonly frames: Record<string, unknown>[] = [];
	readonly conn: RpcConnection;
	#input: ReadableStreamDefaultController<Uint8Array> | undefined;
	#waiters: Array<{ match: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> =
		[];
	#nextId = 0;

	constructor(server: RpcServer, options: Partial<RpcConnectionOptions> = {}) {
		const input = new ReadableStream<Uint8Array>({ start: c => void (this.#input = c) });
		const sink = new PassThrough();
		let buffer = "";
		sink.on("data", chunk => {
			buffer += chunk.toString();
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
				buffer = buffer.slice(nl + 1);
				this.frames.push(frame);
				this.#waiters = this.#waiters.filter(w => (w.match(frame) ? (w.resolve(frame), false) : true));
			}
		});
		this.conn = server.connect(
			{ input, sink },
			{ sequenced: true, ui: true, clientId: crypto.randomUUID(), ...options },
		);
	}

	write(frame: object): void {
		this.#input!.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
	}

	async command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `c${++this.#nextId}`;
		const response = this.next(f => f.type === "response" && f.id === id);
		this.write({ id, ...body });
		return response;
	}

	next(match: (f: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#waiters.push({ match, resolve });
		const timer = setTimeout(() => reject(new Error("frame wait timed out")), timeoutMs);
		return promise.finally(() => clearTimeout(timer));
	}

	end(): void {
		this.#input!.close();
	}
}
