/**
 * Benchmark: append-only extension context handler over a long provider history.
 *
 * Run: `bun packages/coding-agent/bench/extension-context.bench.ts`
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import type { ContextEvent, Extension } from "../src/extensibility/extensions/types";
import { SessionManager } from "../src/session/session-manager";
import type { ModelRegistry } from "../src/config/model-registry";

const MESSAGE_COUNT = Number(Bun.env.EXT_CONTEXT_MESSAGES ?? 400);
const PAYLOAD_BYTES = Number(Bun.env.EXT_CONTEXT_PAYLOAD_BYTES ?? 2500);
const WARMUP = Number(Bun.env.EXT_CONTEXT_WARMUP ?? 5);
const SAMPLES = Number(Bun.env.EXT_CONTEXT_SAMPLES ?? 50);

function buildHistory(): AgentMessage[] {
	const payload = "x".repeat(PAYLOAD_BYTES);
	return Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
		role: "user",
		content: [{ type: "text", text: `${index}:${payload}` }],
		timestamp: index,
	}));
}

function createBenchExtension(): Extension {
	const handlers: Extension["handlers"] = new Map();
	handlers.set("context", [
		(event: ContextEvent) => ({
			messages: [
				...event.messages,
				{
					role: "developer",
					content: [{ type: "text", text: "request-local context" }],
					timestamp: 999999,
				},
			],
		}),
	]);
	return {
		path: "bench-extension-context",
		resolvedPath: "bench-extension-context",
		handlers,
		tools: new Map() as Extension["tools"],
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

const history = buildHistory();
const runner = new ExtensionRunner(
	[createBenchExtension()],
	new ExtensionRuntime(),
	process.cwd(),
	SessionManager.inMemory(),
	{} as ModelRegistry,
);

for (let index = 0; index < WARMUP; index++) {
	await runner.emitContext(history);
}

const samples: number[] = [];
for (let index = 0; index < SAMPLES; index++) {
	Bun.gc(true);
	const started = Bun.nanoseconds();
	const transformed = await runner.emitContext(history);
	if (transformed.length !== history.length + 1) throw new Error("append-only context handler did not append");
	samples.push((Bun.nanoseconds() - started) / 1e6);
}

samples.sort((a, b) => a - b);
const median = samples[samples.length >> 1];
const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
console.log(
	JSON.stringify(
		{
			messages: MESSAGE_COUNT,
			approxBytes: MESSAGE_COUNT * PAYLOAD_BYTES,
			samples: SAMPLES,
			medianMs: Number(median.toFixed(3)),
			meanMs: Number(mean.toFixed(3)),
		},
		null,
		2,
	),
);
