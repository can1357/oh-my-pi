/**
 * Regression for #10605: `createLiveConfigHeaders` proxies are re-wrapped across
 * turns and subagent batches (e.g. `applyModelPatch`/provider-override rebuilds
 * fold a model's existing `headers` proxy back in as a source). Before the fix
 * each nesting layer's traps enumerated the inner proxy key-by-key, re-firing
 * its traps (and its own nested sources') per property — O(keys^depth). A
 * `structuredClone(model)` or a single inference-path header read then pinned
 * the main thread for minutes once the chain grew.
 *
 * Contract: a nested live-headers proxy still resolves the correct header union,
 * later layers override earlier ones, the outer `authHeader` wins, values stay
 * live (a rotated credential is observed on the next read), and enumeration cost
 * stays linear in depth rather than exponential.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createLiveConfigHeaders } from "@oh-my-pi/pi-coding-agent/config/model-config-values";

const TEMP_ENV_KEYS: string[] = [];

function setEnv(key: string, value: string): void {
	TEMP_ENV_KEYS.push(key);
	process.env[key] = value;
}

afterEach(() => {
	for (const key of TEMP_ENV_KEYS.splice(0)) delete process.env[key];
});

describe("createLiveConfigHeaders nesting", () => {
	it("folds a nested live proxy: later layers override, earlier keys survive", () => {
		const inner = createLiveConfigHeaders([{ "X-Tenant": "old", "X-Keep": "k" }]);
		const outer = createLiveConfigHeaders([inner, { "X-Tenant": "new" }]);

		expect(outer?.["X-Tenant"]).toBe("new");
		expect(outer?.["X-Keep"]).toBe("k");
		expect(Object.keys(outer ?? {}).sort()).toEqual(["X-Keep", "X-Tenant"]);
	});

	it("applies the outer authHeader over a nested source", () => {
		setEnv("OMP_TEST_LIVE_KEY", "sekret");
		const inner = createLiveConfigHeaders([{ "X-Keep": "k" }]);
		const outer = createLiveConfigHeaders([inner], { authHeader: true, apiKeyConfig: "OMP_TEST_LIVE_KEY" });

		expect(outer?.Authorization).toBe("Bearer sekret");
	});

	it("keeps values live through a nested wrap so a rotated credential is observed", () => {
		setEnv("OMP_TEST_LIVE_DYN", "v1");
		const base = createLiveConfigHeaders([{ "X-Dyn": "OMP_TEST_LIVE_DYN" }]);
		const wrapped = createLiveConfigHeaders([base, { "X-Extra": "e" }]);

		expect(wrapped?.["X-Dyn"]).toBe("v1");
		setEnv("OMP_TEST_LIVE_DYN", "v2");
		expect(wrapped?.["X-Dyn"]).toBe("v2");
	});

	it("resolves a deep re-wrapped chain with cost linear in depth, not exponential", () => {
		const DEPTH = 64;
		let baseReads = 0;
		const base: Record<string, string> = {};
		Object.defineProperty(base, "X-Base", {
			enumerable: true,
			configurable: true,
			get() {
				baseReads++;
				return "b";
			},
		});

		let headers = createLiveConfigHeaders([base]);
		for (let i = 0; i < DEPTH; i++) {
			headers = createLiveConfigHeaders([headers, { [`X-L${i}`]: String(i) }]);
		}

		// One full enumeration + value read of the outermost proxy.
		const entries = Object.entries(headers ?? {});

		// Union is complete: the base key plus one per layer.
		expect(entries.length).toBe(DEPTH + 1);
		expect(headers?.["X-Base"]).toBe("b");
		expect(headers?.[`X-L${DEPTH - 1}`]).toBe(String(DEPTH - 1));

		// The base source is materialized a bounded number of times. The old
		// per-key nested enumeration re-read it O(keys^depth) times (and hung well
		// before depth 64); the folded resolver reads it a small multiple of the
		// key count. A generous linear ceiling still fails loudly on regression.
		expect(baseReads).toBeLessThan(10 * (DEPTH + 1));
	});
});
