/** Dependency tracking: what a computation reruns for, and what it stops rerunning for. */
import { describe, expect, it } from "bun:test";
import { batch, computed, createRoot, effect, type Signal, signal } from "@oh-my-pi/pi-tui";

describe("reactive tracking", () => {
	it("runs a diamond's effect once per write, with both sides updated", () => {
		createRoot(dispose => {
			const a = signal(1);
			const left = computed(() => a() * 2);
			const right = computed(() => a() + 10);
			const seen: number[] = [];
			effect(() => {
				seen.push(left() + right());
			});
			a.set(2);
			a.set(3);
			expect(seen).toEqual([13, 16, 19]);
			dispose();
		});
	});

	it("stops rerunning for a source the last run no longer read", () => {
		createRoot(dispose => {
			const useX = signal(true);
			const x = signal(0);
			const y = signal(0);
			let runs = 0;
			effect(() => {
				runs++;
				if (useX()) x();
				else y();
			});
			useX.set(false);
			const before = runs;
			x.set(1);
			expect(runs).toBe(before);
			y.set(1);
			expect(runs).toBe(before + 1);
			dispose();
		});
	});

	it("checks sources in first-read order, so a changed guard skips a stale branch", () => {
		createRoot(dispose => {
			const mode = signal<"a" | "b">("a");
			const input = signal(1);
			const isA = computed(() => mode() === "a");
			let expensiveRuns = 0;
			const expensive = computed(() => {
				expensiveRuns++;
				return input() * 2;
			});
			const view = computed(() => (isA() ? expensive() : -1));
			const seen: number[] = [];
			effect(() => {
				seen.push(view());
			});
			expect(expensiveRuns).toBe(1);
			batch(() => {
				mode.set("b");
				input.set(5);
			});
			expect(seen).toEqual([2, -1]);
			// The guard changed first: the branch it turned off is never recomputed.
			expect(expensiveRuns).toBe(1);
			dispose();
		});
	});

	it("keeps a guard's first-read position when it is read again after a nested computation read it", () => {
		createRoot(dispose => {
			const mode = signal<"a" | "b">("a");
			const input = signal(1);
			const isA = computed(() => mode() === "a");
			let expensiveRuns = 0;
			const expensive = computed(() => {
				expensiveRuns++;
				return input() * 2;
			});
			const mirror = computed(() => isA());
			const view = computed(() => {
				if (!isA()) return -1;
				const value = expensive();
				// `mirror` first runs here and reads `isA`; the read after it is a repeat, not a new source.
				mirror();
				isA();
				return value;
			});
			const seen: number[] = [];
			effect(() => {
				seen.push(view());
			});
			batch(() => {
				mode.set("b");
				input.set(5);
			});
			expect(seen).toEqual([2, -1]);
			expect(expensiveRuns).toBe(1);
			dispose();
		});
	});

	it("drops a source read again after a nested computation read it", () => {
		createRoot(dispose => {
			const on = signal(true);
			const s = signal(1);
			const plusOne = computed(() => s() + 1);
			const seen: number[] = [];
			effect(() => {
				if (!on()) {
					seen.push(0);
					return;
				}
				// `s`, then a computed that (first) runs inside this run and reads `s`, then `s` again.
				const first = s();
				const nested = plusOne();
				seen.push(first + nested + s());
			});
			s.set(2);
			expect(seen).toEqual([4, 7]);
			on.set(false);
			s.set(3);
			// No longer read: neither the direct reads nor the nested one keep the effect subscribed.
			expect(seen).toEqual([4, 7, 0]);
			dispose();
		});
	});

	it("follows a large source set as it grows and shrinks", () => {
		createRoot(dispose => {
			const signals: Signal<number>[] = Array.from({ length: 2000 }, () => signal(1));
			const count = signal(signals.length);
			let runs = 0;
			const sum = computed(() => {
				runs++;
				let total = 0;
				for (let i = 0; i < count(); i++) total += signals[i]!();
				return total;
			});
			expect(sum()).toBe(2000);
			signals[1999]!.set(2);
			expect(sum()).toBe(2001);
			count.set(10);
			expect(sum()).toBe(10);
			const settled = runs;
			signals[1999]!.set(3);
			signals[500]!.set(3);
			expect(sum()).toBe(10);
			expect(runs).toBe(settled);
			signals[9]!.set(5);
			expect(sum()).toBe(14);
			dispose();
		});
	});

	it("recovers a computed that threw once a source it read before throwing changes", () => {
		createRoot(dispose => {
			const a = signal(-1);
			const b = signal(10);
			const guarded = computed(() => {
				const value = a();
				if (value < 0) throw new Error("negative");
				return value + b();
			});
			expect(() => guarded()).toThrow("negative");
			a.set(1);
			expect(guarded()).toBe(11);
			b.set(20);
			expect(guarded()).toBe(21);
			dispose();
		});
	});

	it("stops a disposed effect from rerunning", () => {
		const s = signal(0);
		let runs = 0;
		createRoot(dispose => {
			effect(() => {
				runs++;
				s();
			});
			dispose();
		});
		s.set(1);
		expect(runs).toBe(1);
	});
});
