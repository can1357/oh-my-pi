import { describe, expect, it } from "bun:test";
import { BUNDLED_PI_REGISTRY_KEYS } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/legacy-pi-bundled-keys";
import { __buildLegacyPiPackageRootOverrides } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// Regression for issue #3442: extension validation in compiled-binary mode
// failed to resolve `@earendil-works/pi-ai/oauth` because the override map
// only covered bare package roots — every non-wildcard subpath fell through
// to `Bun.resolveSync`, which bunfs can't satisfy on Bun 1.3.14+, then the
// `rewriteLegacyPiImports` catch left the original specifier in place and
// Bun's native resolver couldn't find a peer install. The fix seeds the
// override map with every key in `BUNDLED_PI_REGISTRY_KEYS` so subpath
// imports route to the same `omp-legacy-pi-bundled:` virtual namespace
// that already serves the roots.
describe("legacy pi compat compiled-mode subpath overrides (issue #3442)", () => {
	it("serves @pk-nerdsaver-ai/pi-ai/oauth through the bundled virtual namespace in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides["@pk-nerdsaver-ai/pi-ai/oauth"]).toBe("omp-legacy-pi-bundled:@pk-nerdsaver-ai/pi-ai/oauth");
	});

	it("expands wildcard exports for concrete on-disk targets (issue #3442 follow-up)", () => {
		// `pi-ai/oauth/anthropic` is exposed via the `./oauth/*` wildcard export;
		// the original fix only bundled non-wildcard subpaths, so peer-only plugins
		// importing `@(scope)/pi-ai/oauth/anthropic` (remapped via PI_SUBPATH_REMAPS
		// from `@mariozechner/pi-ai/utils/oauth/anthropic`) still hit the bunfs
		// fall-through. The generator now globs each wildcard's source pattern
		// and registers every concrete `.ts` match against the virtual namespace.
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides["@pk-nerdsaver-ai/pi-ai/oauth/anthropic"]).toBe(
			"omp-legacy-pi-bundled:@pk-nerdsaver-ai/pi-ai/oauth/anthropic",
		);
		// Sanity: the wildcard expansion also reaches deeper subroots so plugins
		// pinned to e.g. `@pk-nerdsaver-ai/pi-ai/providers/openai` keep resolving.
		expect(BUNDLED_PI_REGISTRY_KEYS.has("@pk-nerdsaver-ai/pi-ai/oauth/anthropic")).toBe(true);
		expect(BUNDLED_PI_REGISTRY_KEYS.has("@pk-nerdsaver-ai/pi-ai/oauth/openai-codex")).toBe(true);
	});

	it("expands web search provider wildcard exports for compiled plugin imports", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		const providerKeys = [
			"@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/xai",
			"@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/tinyfish",
			"@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/firecrawl",
			"@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/duckduckgo",
		] as const;

		for (const key of providerKeys) {
			expect(BUNDLED_PI_REGISTRY_KEYS.has(key)).toBe(true);
			expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
		}
	});

	it("does not enumerate root catch-all wildcards (./* / ./*.js)", () => {
		// Root `./*` / `./*.js` patterns would static-import top-level files
		// like the package's own `cli.ts` and explode the bundle through the
		// binary entry's transitive graph. Plugins almost never import top-level
		// pi-* files directly, so we keep those routed via `Bun.resolveSync`.
		// Concrete check: `@pk-nerdsaver-ai/pi-coding-agent/cli` is NOT bundled.
		expect(BUNDLED_PI_REGISTRY_KEYS.has("@pk-nerdsaver-ai/pi-coding-agent/cli")).toBe(false);
		expect(BUNDLED_PI_REGISTRY_KEYS.has("@pk-nerdsaver-ai/pi-coding-agent/main")).toBe(false);
	});

	it("does not bundle main-thread-unsafe worker entrypoints", () => {
		// Worker entry modules throw at top level unless `parentPort` exists.
		// The compiled legacy registry is imported on the main thread while
		// validating plugin extensions, so enumerating these files recreates the
		// `js worker-entry: missing parentPort` failure from #3508.
		expect(BUNDLED_PI_REGISTRY_KEYS.has("@pk-nerdsaver-ai/pi-coding-agent/eval/js/worker-entry")).toBe(false);
	});

	it("maps every bundled key (minus shimmed roots + typebox) to its virtual specifier in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		const missing: string[] = [];
		for (const key of BUNDLED_PI_REGISTRY_KEYS) {
			// pi-ai/pi-coding-agent roots intentionally use the legacy compat shims
			// (they re-attach `Type`, `defineTool`, etc. dropped from the canonical
			// package surface); typebox is served via TYPEBOX_SHIM_PATH.
			if (key === "@pk-nerdsaver-ai/pi-ai" || key === "@pk-nerdsaver-ai/pi-coding-agent" || key === "typebox") continue;
			if (overrides[key] !== `omp-legacy-pi-bundled:${key}`) {
				missing.push(key);
			}
		}
		expect(missing).toEqual([]);
	});

	it("keeps pi-ai/pi-coding-agent roots routed to their compat shims in compiled mode", () => {
		// The shim entries themselves resolve to virtual bundled specifiers in
		// compiled mode (the shim files are bundled under their own registry
		// keys); the test asserts only that the roots stay distinct from the
		// canonical pi-* surface — extensions still see the `Type` /
		// `defineTool` helpers the canonical entrypoints dropped.
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides["@pk-nerdsaver-ai/pi-ai"]).toBeDefined();
		expect(overrides["@pk-nerdsaver-ai/pi-ai"]).not.toBe("omp-legacy-pi-bundled:@pk-nerdsaver-ai/pi-ai/oauth");
		expect(overrides["@pk-nerdsaver-ai/pi-coding-agent"]).toBeDefined();
	});

	it("does not register subpath overrides in dev/install mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(false);
		expect(overrides).not.toHaveProperty("@pk-nerdsaver-ai/pi-ai/oauth");
		expect(overrides).not.toHaveProperty("@pk-nerdsaver-ai/pi-coding-agent/tools");
		// Dev keeps only the historical shim entries so canonical subpath
		// imports continue to flow through `Bun.resolveSync` against the live
		// monorepo / installed `node_modules` tree.
	});

	it("never emits a virtual specifier for typebox via the override map", () => {
		// typebox is routed through `TYPEBOX_SHIM_PATH` + a dedicated onResolve
		// hook; mirroring it in the override map would double-register and the
		// virtual loader would race the dedicated shim path.
		const overrides = __buildLegacyPiPackageRootOverrides(true);
		expect(overrides).not.toHaveProperty("typebox");
	});
});
