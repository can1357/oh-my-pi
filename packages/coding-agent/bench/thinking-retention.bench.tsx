/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Benchmark: streamed thinking cost and retained memory.
 *
 * Streams `steps` thinking deltas (a paragraph each) into one assistant block,
 * painting it after every delta as the transcript does, then reports wall/CPU
 * time and the heap the finished block retains. `settledPaintMs` repaints the
 * block once it is finalized (the "Thought for …" fold).
 *
 * Usage: `bun bench/thinking-retention.bench.tsx [steps=500]`
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRoot, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { heapStats } from "bun:jsc";
import { AssistantMessageBlock } from "../src/ui/transcript/messages/assistant-message";

const steps = Number(process.argv[2] ?? 500);
if (!Number.isSafeInteger(steps) || steps <= 0) throw new Error("Expected a positive step count");
const WIDTH = 100;
const env = staticEnvironment(loadThemeSync("dark"), { now: 0 });

const base: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "benchmark",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

interface Streamed {
	readonly rows: number;
	readonly settledPaintMs: number;
	readonly dispose: () => void;
}

function stream(count: number): Streamed {
	return createRoot(dispose => {
		const message = signal<AssistantMessage | undefined>(undefined);
		const transient = signal(true);
		const finalized = signal(false);
		const expandThinking = signal(true);
		const node = (
			<col>{AssistantMessageBlock({ model: { message, transient, finalized, expandThinking } })}</col>
		) as UiNode;
		let thinking = "";
		for (let step = 0; step < count; step++) {
			thinking += `Paragraph ${step}: consider **correctness**, memory use, and terminal replay before selecting an implementation.\n\n`;
			message.set({ ...base, content: [{ type: "thinking", thinking: `${thinking}Pending paragraph` }] });
			paintNode(env, node, WIDTH);
		}
		message.set({ ...base, content: [{ type: "thinking", thinking }] });
		transient.set(false);
		finalized.set(true);
		const started = performance.now();
		const rows = paintNode(env, node, WIDTH).rows.length;
		return { rows, settledPaintMs: performance.now() - started, dispose };
	});
}

stream(20).dispose();
Bun.gc(true);
const before = heapStats().heapSize;
const started = performance.now();
const cpuStarted = process.cpuUsage();
const result = stream(steps);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStarted);
const cpuMs = (cpu.user + cpu.system) / 1000;
Bun.gc(true);
const retainedBytes = heapStats().heapSize - before;
console.log(
	JSON.stringify({
		steps,
		rows: result.rows,
		retainedBytes,
		elapsedMs,
		msPerStep: elapsedMs / steps,
		cpuMs,
		settledPaintMs: result.settledPaintMs,
	}),
);
result.dispose();
