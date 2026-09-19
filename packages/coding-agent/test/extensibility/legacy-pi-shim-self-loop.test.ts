import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__isLegacyPiSelfLoopResolution,
	__isLegacyPiShimImporter,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-shim-loop-guard";

// Regression for issue #8900: a custom tool that value-imports
// `@oh-my-pi/pi-coding-agent` bricked the agent with an opaque
// `RangeError: Maximum call stack size exceeded` before the TUI existed.
//
// Mechanism: the process-global `onResolve` installed by
// `installLegacyPiSpecifierShim()` also fires for imports originating *from*
// the compat shims, and the package-root override map sent the shims' own
// bare re-exports (`legacy-pi-tui-shim.ts` does
// `export * from "@oh-my-pi/pi-tui"`) straight back onto the shim. ESM
// tolerates a true self-cycle, but when consecutive hops disagree on module
// identity — macOS `/var` → `/private/var` symlink realpaths, bun
// global-cache install paths, `?mtime=` cache-bust suffixes — Bun keys every
// hop as a new module and resolution recurses without bound.
//
// The fix routes shim-originated (or otherwise self-targeting) resolutions to
// the real canonical package. These tests pin the guard predicates, including
// the path-identity-divergence cases that made the loop environment-specific.
describe("legacy pi shim resolution self-loop guard (issue #8900)", () => {
	const SHIM = "/host/src/extensibility/legacy-pi-tui-shim.ts";

	describe("__isLegacyPiSelfLoopResolution", () => {
		it("detects the direct self-edge (resolved === importer)", () => {
			expect(__isLegacyPiSelfLoopResolution(SHIM, SHIM)).toBe(true);
		});

		it("detects the self-edge across symlink realpath divergence (macOS /var vs /private/var)", () => {
			const realpaths = new Map([["/var/host/legacy-pi-tui-shim.ts", "/private/var/host/legacy-pi-tui-shim.ts"]]);
			const realpathStub = (p: string): string => {
				const mapped = realpaths.get(p);
				if (mapped) return mapped;
				return p;
			};
			expect(
				__isLegacyPiSelfLoopResolution(
					"/var/host/legacy-pi-tui-shim.ts",
					"/private/var/host/legacy-pi-tui-shim.ts",
					realpathStub,
				),
			).toBe(true);
		});

		it("detects the self-edge when the importer carries a ?mtime= cache-bust suffix", () => {
			expect(__isLegacyPiSelfLoopResolution(SHIM, `${SHIM}?mtime=42`, p => p)).toBe(true);
		});

		it("detects the self-edge through unnormalized path segments", () => {
			const unnormalized = "/host/src/extensibility/../extensibility/legacy-pi-tui-shim.ts";
			expect(__isLegacyPiSelfLoopResolution(unnormalized, SHIM, p => p)).toBe(true);
		});

		it("passes distinct modules through", () => {
			expect(__isLegacyPiSelfLoopResolution(SHIM, "/project/tools/probe.ts", p => p)).toBe(false);
		});

		it("never flags virtual omp-legacy-pi-bundled: specifiers", () => {
			expect(__isLegacyPiSelfLoopResolution("omp-legacy-pi-bundled:@oh-my-pi/pi-tui", SHIM, p => p)).toBe(false);
			expect(__isLegacyPiSelfLoopResolution(SHIM, "omp-legacy-pi-bundled:@oh-my-pi/pi-tui", p => p)).toBe(false);
		});

		it("passes missing importers through", () => {
			expect(__isLegacyPiSelfLoopResolution(SHIM, undefined, p => p)).toBe(false);
			expect(__isLegacyPiSelfLoopResolution(SHIM, "", p => p)).toBe(false);
		});
	});

	describe("__isLegacyPiShimImporter", () => {
		const SHIM_PATHS = [
			"/host/src/extensibility/legacy-pi-ai-shim.ts",
			"/host/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"/host/src/extensibility/legacy-pi-tui-shim.ts",
		] as const;

		it("flags imports issued by a shim file", () => {
			expect(__isLegacyPiShimImporter(SHIM, SHIM_PATHS, p => p)).toBe(true);
		});

		it("flags shim importers reached through a symlinked path", () => {
			const realpathStub = (p: string): string =>
				p === "/var/link/legacy-pi-tui-shim.ts" ? "/host/src/extensibility/legacy-pi-tui-shim.ts" : p;
			expect(__isLegacyPiShimImporter("/var/link/legacy-pi-tui-shim.ts", SHIM_PATHS, realpathStub)).toBe(true);
		});

		it("passes non-shim importers through", () => {
			expect(__isLegacyPiShimImporter("/project/tools/probe.ts", SHIM_PATHS, p => p)).toBe(false);
			expect(__isLegacyPiShimImporter(undefined, SHIM_PATHS, p => p)).toBe(false);
		});

		it("never flags virtual-namespace importers (compiled-binary mode)", () => {
			expect(__isLegacyPiShimImporter("omp-legacy-pi-bundled:@oh-my-pi/pi-tui", SHIM_PATHS, p => p)).toBe(false);
		});

		it("recognizes the real on-disk shim files through the default shim set", () => {
			// In dev / source-link mode the default shim set is the three
			// sibling source files. The tui shim is the one whose
			// `export * from "@oh-my-pi/pi-tui"` re-entered the resolver.
			const realTuiShim = path.resolve(import.meta.dir, "..", "..", "src", "extensibility", "legacy-pi-tui-shim.ts");
			expect(fs.existsSync(realTuiShim)).toBe(true);
			expect(__isLegacyPiShimImporter(realTuiShim)).toBe(true);
			expect(__isLegacyPiShimImporter(fs.realpathSync(realTuiShim))).toBe(true);
		});

		it("recognizes a symlinked copy of a real shim file (the environment-specific loop trigger)", () => {
			const realTuiShim = path.resolve(import.meta.dir, "..", "..", "src", "extensibility", "legacy-pi-tui-shim.ts");
			const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-8900-"));
			const linkPath = path.join(linkDir, "legacy-pi-tui-shim.ts");
			try {
				fs.symlinkSync(realTuiShim, linkPath);
			} catch {
				// Symlink creation can be unavailable (e.g. restricted CI
				// runners); the realpath-divergence behavior is still pinned
				// by the stub-based cases above.
				fs.rmSync(linkDir, { recursive: true, force: true });
				return;
			}
			try {
				expect(__isLegacyPiShimImporter(linkPath)).toBe(true);
			} finally {
				fs.rmSync(linkDir, { recursive: true, force: true });
			}
		});
	});
});
