/**
 * Benchmark: `AgentSession#buildEphemeralSnapshot` detaching caller-supplied
 * side-channel `history` (BTW follow-ups, extension-invoked `runEphemeralTurn`
 * callers such as an IRC-relay extension building a growing peer thread).
 *
 * Prior to the fix, every ephemeral turn called `structuredClone(history)` to
 * detach it from the caller, which walks every nested content byte on every
 * call. A side-channel thread that accumulates large tool-output-shaped
 * content over many exchanges pays that cost repeatedly and unboundedly.
 *
 * This measures the marginal cost attributable to `history` as its nested
 * content grows, holding message COUNT fixed: on the unfixed code, both wall
 * time and bytes touched by `structuredClone` scale with content size; the
 * fix keeps both flat because content blocks are never deep-cloned.
 *
 * Run: `bun packages/coding-agent/bench/ephemeral-turn-history-detach.bench.ts`
 */
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, StopReason } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionRunner } from "../src/extensibility/extensions";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

const HISTORY_MESSAGES = Number(Bun.env.EPHEMERAL_HISTORY_MESSAGES ?? 20);
const CONTENT_BYTES = Number(Bun.env.EPHEMERAL_HISTORY_CONTENT_BYTES ?? 500_000);
const CALLS = Number(Bun.env.EPHEMERAL_CALLS ?? 5);

function instantDoneStream(
	model: Model,
	_context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as StopReason,
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function buildHistory(contentBytes: number): Message[] {
	const payload = "x".repeat(contentBytes);
	return Array.from({ length: HISTORY_MESSAGES }, (_, i): Message => ({
		role: "user",
		content: `turn ${i}: ${payload}`,
	}));
}

async function makeSession(): Promise<{ session: AgentSession; dispose: () => Promise<void> }> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: instantDoneStream,
		convertToLlm,
	});
	const extensionRunner = {
		emit: async () => undefined,
		emitBeforeAgentStart: async () => undefined,
		hasHandlers: () => false,
		emitSessionStop: async () => undefined,
	} as unknown as ExtensionRunner;
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated();
	const authDbPath = `${Bun.env.TMPDIR ?? "/tmp"}/ephemeral-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
	const authStorage = await AuthStorage.create(authDbPath);
	const modelRegistry = new ModelRegistry(authStorage, `${authDbPath}.models.yml`);
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner,
		sideStreamFn: instantDoneStream,
	});
	return {
		session,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
		},
	};
}

async function measure(contentBytes: number): Promise<{ ms: number[]; cloneCalls: number; cloneBytes: number }> {
	const { session, dispose } = await makeSession();
	const history = buildHistory(contentBytes);

	const realClone = globalThis.structuredClone;
	let cloneCalls = 0;
	let cloneBytes = 0;
	globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
		cloneCalls++;
		try {
			cloneBytes += JSON.stringify(value)?.length ?? 0;
		} catch {}
		return realClone(value, options);
	}) as typeof structuredClone;

	try {
		const ms: number[] = [];
		for (let i = 0; i < CALLS; i++) {
			Bun.gc(true);
			const started = Bun.nanoseconds();
			await session.runEphemeralTurn({ promptText: "probe", history });
			ms.push((Bun.nanoseconds() - started) / 1e6);
		}
		return { ms, cloneCalls, cloneBytes };
	} finally {
		globalThis.structuredClone = realClone;
		await dispose();
	}
}

const small = await measure(64);
const large = await measure(CONTENT_BYTES);

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[sorted.length >> 1]!;
}

const result = {
	historyMessages: HISTORY_MESSAGES,
	calls: CALLS,
	smallContentBytes: 64,
	largeContentBytes: CONTENT_BYTES,
	small: { medianMs: Number(median(small.ms).toFixed(3)), cloneCalls: small.cloneCalls, cloneBytes: small.cloneBytes },
	large: { medianMs: Number(median(large.ms).toFixed(3)), cloneCalls: large.cloneCalls, cloneBytes: large.cloneBytes },
};
console.log(JSON.stringify(result, null, 2));

// The regression this guards: `structuredClone(history)` walked every nested
// content byte, so growing CONTENT_BYTES (message count held fixed) grew the
// clone-attributable byte count in lockstep. The fix never deep-clones content
// blocks, so cloneBytes must stay flat regardless of content size.
const cloneBytesGrowthRatio = (large.cloneBytes + 1) / (small.cloneBytes + 1);
const contentGrowthRatio = CONTENT_BYTES / 64;
if (cloneBytesGrowthRatio > Math.max(1, contentGrowthRatio / 10)) {
	throw new Error(
		`structuredClone byte volume scaled with side-channel history content ` +
			`(${cloneBytesGrowthRatio.toFixed(1)}x for a ${contentGrowthRatio.toFixed(1)}x content increase) ` +
			`— ephemeral-turn history detach is deep-cloning nested content again.`,
	);
}
