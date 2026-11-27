/**
 * The runtime loader resolves the x64 CPU variant (modern/baseline) in every
 * context that loads the addon, including Bun worker threads, where spawning
 * `sysctl` to detect AVX2 is unreliable. The contract pinned here:
 *   1. Once any context resolves the variant (the main thread does first), it
 *      is cached via a private env key. Bun workers and child subprocesses
 *      inherit `process.env` at spawn, so they read the cache and skip
 *      detection entirely.
 *   2. The user-facing `PI_NATIVE_VARIANT` override always wins, including over
 *      a stale cache value.
 *   3. Non-x64 architectures return `null` and never poison the cache.
 *   4. A `modern` verdict puts the modern filename ahead of baseline in the
 *      `darwin-x64` candidate list.
 */
import { describe, expect, it } from "bun:test";
import { getAddonFilenames, selectCpuVariant } from "../native/loader-state.js";

const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

describe("CPU variant resolution across worker contexts", () => {
	it("returns the cached variant from env without re-detecting", () => {
		let detectorCalls = 0;
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => {
				detectorCalls += 1;
				return false;
			},
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("cache");
		expect(detectorCalls).toBe(0);
		expect(result.cacheEnvKey).toBeUndefined();
		expect(result.cacheEnvValue).toBeUndefined();
	});

	it("surfaces a fresh detection so the caller can cache it for workers", () => {
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: {},
			detectAvx2: () => true,
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("detect");
		// The caller must persist these so spawned Bun workers and child
		// subprocesses (which inherit process.env at spawn time) read the
		// resolved variant instead of re-running `sysctl` from contexts where
		// the spawn is unreliable.
		expect(result.cacheEnvKey).toBe(VARIANT_CACHE_ENV_KEY);
		expect(result.cacheEnvValue).toBe("modern");
	});

	it("falls through to baseline when detection fails, still emitting a cache hint", () => {
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: {},
			detectAvx2: () => false,
		});
		expect(result.variant).toBe("baseline");
		expect(result.source).toBe("detect");
		expect(result.cacheEnvKey).toBe(VARIANT_CACHE_ENV_KEY);
		expect(result.cacheEnvValue).toBe("baseline");
	});

	it("honors PI_NATIVE_VARIANT override above both cache and detection", () => {
		let detectorCalls = 0;
		const result = selectCpuVariant({
			arch: "x64",
			override: "baseline",
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => {
				detectorCalls += 1;
				return true;
			},
		});
		expect(result.variant).toBe("baseline");
		expect(result.source).toBe("override");
		expect(detectorCalls).toBe(0);
		// Override path must NOT poison the cache: the user may toggle it
		// per-invocation, and child processes should still re-evaluate the
		// override env var themselves.
		expect(result.cacheEnvKey).toBeUndefined();
	});

	it("ignores garbage values in PI_NATIVE_VARIANT and in the cache", () => {
		const result = selectCpuVariant({
			arch: "x64",
			override: "garbage" as unknown as "modern",
			env: { [VARIANT_CACHE_ENV_KEY]: "also-garbage" },
			detectAvx2: () => true,
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("detect");
	});

	it("returns variant=null for non-x64 architectures and never emits a cache entry", () => {
		for (const arch of ["arm64", "ia32", "ppc64"]) {
			const result = selectCpuVariant({
				arch,
				override: null,
				env: {},
				detectAvx2: () => true,
			});
			expect(result.variant).toBeNull();
			expect(result.source).toBe("non-x64");
			expect(result.cacheEnvKey).toBeUndefined();
		}
	});

	it("places modern ahead of baseline in the file-search list when the resolved verdict is modern", () => {
		// With the cache populated by the main thread, a worker whose own
		// detector fails still resolves modern, so the candidate list carries
		// the modern filename the build produced instead of only
		// [baseline, default].
		const variant = selectCpuVariant({
			arch: "x64",
			override: null,
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => false, // simulate the failing worker detector
		}).variant;
		expect(variant).toBe("modern");
		const filenames = getAddonFilenames({ tag: "darwin-x64", arch: "x64", variant });
		expect(filenames[0]).toBe("pi_natives.darwin-x64-modern.node");
		expect(filenames).toContain("pi_natives.darwin-x64-baseline.node");
	});
});
