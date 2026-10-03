import { describe, expect, it } from "bun:test";
import { type ShadowClaimKey, ShadowClaimStore } from "../../src/eval/speculation/claim-store";

const key: ShadowClaimKey = {
	siteId: "site-1",
	dynamicPath: "",
	name: "read",
	fingerprint: "args-1",
	occurrence: 0,
};

describe("ShadowClaimStore", () => {
	it("consumes a matching settled outcome exactly once", () => {
		const store = new ShadowClaimStore<string>();
		store.add(key, { kind: "result", value: "cached", virtualDurationMs: 2 });
		expect(store.claim(key, 2)).toEqual({ kind: "result", value: "cached", virtualDurationMs: 2 });
		expect(store.claim(key, 2)).toBeUndefined();
	});

	it("preserves normal execution when a claimed result cannot fit the remaining timeout", () => {
		const store = new ShadowClaimStore<string>();
		store.add(key, { kind: "result", value: "cached", virtualDurationMs: 3 });
		expect(store.claim(key, 2)).toBeUndefined();
		expect(store.claim(key, 3)?.kind).toBe("result");
	});

	it("maps runtime occurrences to dynamic paths independent of settlement order", () => {
		const store = new ShadowClaimStore<string>();
		const first = { ...key, dynamicPath: "loop:0" };
		const second = { ...key, dynamicPath: "loop:1" };
		store.register(first, 0);
		store.register(second, 1);
		store.add(second, { kind: "result", value: "second", virtualDurationMs: 1 });
		store.add(first, { kind: "result", value: "first", virtualDurationMs: 1 });

		expect(store.claimRuntime({ ...key, occurrence: 0 }, 1)).toEqual({
			kind: "result",
			value: "first",
			virtualDurationMs: 1,
		});
		expect(store.claimRuntime({ ...key, occurrence: 1 }, 1)).toEqual({
			kind: "result",
			value: "second",
			virtualDurationMs: 1,
		});
	});

	it("waits for an already-registered outcome that settles during the real call", async () => {
		const store = new ShadowClaimStore<string>();
		store.register(key, 0);
		const claim = store.claimRuntimeAsync({ ...key, occurrence: 0 }, Number.MAX_SAFE_INTEGER);
		store.add(key, { kind: "result", value: "cached", virtualDurationMs: 1 });

		expect(await claim).toEqual({ kind: "result", value: "cached", virtualDurationMs: 1 });
		expect(store.claimRuntime({ ...key, occurrence: 0 }, 1)).toBeUndefined();
	});

	it("stops waiting for a speculative outcome when the real cell is cancelled", async () => {
		const store = new ShadowClaimStore<string>();
		const controller = new AbortController();
		store.register(key, 0);
		const claim = store.claimRuntimeAsync({ ...key, occurrence: 0 }, Number.MAX_SAFE_INTEGER, controller.signal);

		controller.abort();

		expect(await claim).toBeUndefined();
		store.add(key, { kind: "result", value: "late", virtualDurationMs: 1 });
		expect(store.claimRuntime({ ...key, occurrence: 0 }, 1)).toBeUndefined();
	});

	it("settles a registered miss without blocking the real call", async () => {
		const store = new ShadowClaimStore<string>();
		store.register(key, 0);
		const claim = store.claimRuntimeAsync({ ...key, occurrence: 0 }, Number.MAX_SAFE_INTEGER);

		store.miss(key);

		expect(await claim).toBeUndefined();
	});

	it("settles pending real calls when the owning cell closes", async () => {
		const store = new ShadowClaimStore<string>();
		store.register(key, 0);
		const claim = store.claimRuntimeAsync({ ...key, occurrence: 0 }, Number.MAX_SAFE_INTEGER);

		store.discard();

		expect(await claim).toBeUndefined();
	});

	it("drops all candidates when the owning cell closes", () => {
		const store = new ShadowClaimStore<string>();
		store.add(key, { kind: "result", value: "cached", virtualDurationMs: 1 });
		store.discard();
		expect(store.claim(key, 1)).toBeUndefined();
	});
});
