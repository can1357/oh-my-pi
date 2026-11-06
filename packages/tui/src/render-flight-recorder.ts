import { performance } from "node:perf_hooks";
import * as logger from "@oh-my-pi/pi-utils/logger";

const CAPACITY = 2048;
const GAP_MS = 2000;

export interface RenderTraceEvent {
	atMs: number;
	kind: string;
	tag: string;
	value: number;
}

/** Numeric slots and static tags are reused on the hot path. Only a completed long gap is serialized. */
export class RenderFlightRecorder {
	#events = Array.from({ length: CAPACITY }, (): RenderTraceEvent => ({ atMs: 0, kind: "", tag: "", value: 0 }));
	#cursor = 0;
	#count = 0;
	#dropped = 0;
	#pending = -1;
	#providerSince = -1;
	#providerStep = "none";
	#bytes = 0;
	#tasks = 0;
	#taskMs = 0;

	constructor(
		readonly now: () => number = () => performance.now(),
		readonly emit: (message: string, context: Record<string, unknown>) => void = logger.warn,
	) {}

	event(kind: string, tag: string, value = 0): void {
		if (this.#pending < 0) return;
		const slot = this.#events[this.#cursor]!;
		slot.atMs = this.now();
		slot.kind = kind;
		slot.tag = tag;
		slot.value = value;
		this.#cursor = (this.#cursor + 1) % CAPACITY;
		if (this.#count < CAPACITY) this.#count++;
		else this.#dropped++;
	}

	request(tag: string): void {
		if (this.#pending < 0) this.#pending = this.now();
		this.event("request", tag);
		if (this.now() - this.#pending > GAP_MS) this.event("request-caller", new Error().stack ?? tag);
	}

	beginProvider(): void {
		this.#providerSince = this.now();
		this.#bytes = 0;
		this.step("provider.renderFrame");
	}

	step(tag: string): void {
		this.#providerStep = tag;
		this.event("provider-step", tag);
	}

	write(bytes: number): void {
		this.#bytes += bytes;
		this.event("write", "terminal", bytes);
	}

	task(tag: string, startedAt: number): void {
		if (this.#pending < 0) return;
		const ms = Math.max(0, this.now() - Math.max(startedAt, this.#pending));
		this.#tasks++;
		this.#taskMs += ms;
		this.event("macrotask", tag, ms);
	}

	endProvider(): void {
		this.event("provider-end", this.#providerStep, this.#bytes);
		this.#providerSince = -1;
		this.#providerStep = "none";
	}

	/** A synchronous completed provider frame, including an unchanged diff, settles pending work. */
	settle(pendingOutputBytes: number | undefined): void {
		if (this.#pending < 0) return;
		const end = this.now();
		if (end - this.#pending > GAP_MS) {
			const timeline: RenderTraceEvent[] = [];
			const sources = new Map<string, { tag: string; count: number; totalMs: number }>();
			for (let i = 0; i < this.#count; i++) {
				const slot = this.#events[(this.#cursor - this.#count + i + CAPACITY) % CAPACITY]!;
				timeline.push({ ...slot });
				if (slot.kind === "macrotask") {
					const source = sources.get(slot.tag) ?? { tag: slot.tag, count: 0, totalMs: 0 };
					source.count++;
					source.totalMs += slot.value;
					sources.set(slot.tag, source);
				}
			}
			this.emit("ui.frame-gap-cause", {
				schemaVersion: 1,
				startMs: this.#pending,
				endMs: end,
				durationMs: end - this.#pending,
				timeline,
				droppedEvents: this.#dropped,
				providerInFlightSinceMs: this.#providerSince < 0 ? null : this.#providerSince,
				providerStep: this.#providerStep,
				// The provider contract is synchronous; it has no awaited steps.
				providerAwait: null,
				frameBytes: this.#bytes,
				pendingOutputBytes: pendingOutputBytes ?? null,
				terminalDrain:
					pendingOutputBytes === undefined ? "unknown" : pendingOutputBytes === 0 ? "empty" : "pending",
				// Bun currently reports zero counters; retain raw values rather than invent utilization.
				eventLoopUtilization: performance.eventLoopUtilization(),
				macrotasks: {
					count: this.#tasks,
					totalMs: this.#taskMs,
					topSources: [...sources.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10),
					scope: "TUI scheduler and input callbacks; top sources cover retained timeline",
				},
			});
		}
		this.reset();
	}

	reset(): void {
		this.#pending = -1;
		this.#cursor = this.#count = this.#dropped = this.#tasks = this.#taskMs = this.#bytes = 0;
	}
}
