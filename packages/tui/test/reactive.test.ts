/** Exception safety of the reactive graph: a throwing run must leave every node re-runnable. */
import { describe, expect, it } from "bun:test";
import { batch, computed, createRoot, effect, signal } from "@oh-my-pi/pi-tui/reactive";

describe("reactive errors", () => {
	it("rethrows a computed's error on every read until a source recovers", () => {
		const fail = signal(true);
		const items = computed<string[]>(() => {
			if (fail()) throw new Error("boom");
			return ["ok"];
		});
		expect(() => items()).toThrow("boom");
		// Regression (#20625): the second read returned a cached `undefined`.
		expect(() => items()).toThrow("boom");
		fail.set(false);
		expect(items()).toEqual(["ok"]);
	});

	it("reruns an observer that caught the error once the computed recovers to its old value", () => {
		createRoot(dispose => {
			const fail = signal(false);
			const label = computed(() => {
				if (fail()) throw new Error("boom");
				return "ok";
			});
			const seen: string[] = [];
			effect(() => {
				try {
					seen.push(label());
				} catch {
					seen.push("error");
				}
			});
			fail.set(true);
			fail.set(false);
			expect(seen).toEqual(["ok", "error", "ok"]);
			dispose();
		});
	});

	it("runs every queued effect when one throws, then surfaces the error", () => {
		createRoot(dispose => {
			const count = signal(0);
			let after = 0;
			effect(() => {
				if (count() === 1) throw new Error("boom");
			});
			effect(() => {
				after = count();
			});
			expect(() => batch(() => count.set(1))).toThrow("boom");
			expect(after).toBe(1);
			count.set(2);
			expect(after).toBe(2);
			dispose();
		});
	});
});
