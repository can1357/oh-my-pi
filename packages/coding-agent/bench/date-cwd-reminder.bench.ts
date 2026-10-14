/**
 * Benchmark: date/cwd reminder injection cost vs transcript depth.
 *
 * An ordinary turn (new messages appended) can never hit the replay memo, so
 * the miss path must cost the parent path's single output array — no
 * transcript snapshot, no second copy. A retry replaying the same request
 * reuses the injector-owned layout instead of re-running the per-message
 * work. This bench times both: miss cost per request at depth N, and hit cost
 * for an identical rebuild.
 *
 * Run: bun packages/coding-agent/bench/date-cwd-reminder.bench.ts
 */
import type { Message } from "@oh-my-pi/pi-ai";
import { DateCwdReminderInjector } from "../src/session/date-cwd-reminder";

const SIZES = [100, 1_000, 10_000];
const WARMUP = 20;
const SAMPLES = 200;

function makeTranscript(n: number): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < n; i++) {
		messages.push({ role: "user", content: `turn ${i}`, timestamp: i });
	}
	return messages;
}

function medianMs(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]! / 1e6;
}

/** Time one transform per growing transcript (miss path) and identical rebuilds (hit path). */
function measure(n: number): { missMs: number; hitMs: number } {
	const injector = new DateCwdReminderInjector();
	const base = makeTranscript(n);
	const context = (messages: Message[]) => ({ systemPrompt: ["system"], messages });

	injector.transform(context(base), "2026-08-14", "/work/omp");
	for (let i = 0; i < WARMUP; i++) {
		injector.transform(
			context([...base, { role: "user", content: `warmup ${i}`, timestamp: n + i }]),
			"2026-08-14",
			"/work/omp",
		);
	}
	const miss: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const grown = [...base, { role: "user", content: `turn ${n + i}`, timestamp: n + i } as Message];
		const start = Bun.nanoseconds();
		injector.transform(context(grown), "2026-08-14", "/work/omp");
		miss.push(Bun.nanoseconds() - start);
	}

	const memoInjector = new DateCwdReminderInjector();
	memoInjector.transform(context(base), "2026-08-14", "/work/omp");
	memoInjector.transform(context([...base]), "2026-08-14", "/work/omp");
	const hit: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const input = [...base];
		const start = Bun.nanoseconds();
		memoInjector.transform(context(input), "2026-08-14", "/work/omp");
		hit.push(Bun.nanoseconds() - start);
	}
	return { missMs: medianMs(miss), hitMs: medianMs(hit) };
}

for (const n of SIZES) {
	const { missMs, hitMs } = measure(n);
	console.log(
		`date-cwd-reminder n=${n}: miss ${missMs.toFixed(3)}ms/op, hit ${hitMs.toFixed(3)}ms/op (median of ${SAMPLES})`,
	);
}
