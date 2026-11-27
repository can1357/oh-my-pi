import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLoadedBindings } from "../native/loader-state.js";

async function withCandidate(contents: string, test: (candidate: string) => void) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-legacy-desktop-"));
	const candidate = path.join(dir, "pi_natives.node");
	try {
		await fs.writeFile(candidate, contents);
		test(candidate);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const unusedCandidate =
	"/home/u/.bun/install/global/node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64.node";

function ctxFor(version: string) {
	return { isWorkspaceLoad: false, packageVersion: version };
}

function stamped(version: string): string {
	const slot = `PI_NATIVES_VERSION_STAMP:${version}`;
	return `${slot}${"\0".repeat(64 - slot.length)}`;
}

function reporting(version: string | null) {
	return { __piNativesBuildVersion: () => version, grep: () => {} };
}

class LegacyDesktopSession {
	capture() {}
	execute() {}
	close() {}
}

const legacyCoreBindings = {
	countTokens() {},
	executeShell() {},
	visibleWidth() {},
};

describe("legacy native addon loading", () => {
	it("accepts a compatible pre-sentinel addon from disk", async () => {
		const ctx = ctxFor("17.2.8");
		const bindings = { ...legacyCoreBindings, DesktopSession: LegacyDesktopSession };
		await withCandidate("legacy native addon", candidate => {
			expect(() => validateLoadedBindings(ctx, bindings, candidate)).not.toThrow();
		});
	});

	it("rejects a pre-sentinel addon without the compatible core ABI", async () => {
		const ctx = ctxFor("17.2.8");
		await withCandidate("legacy native addon", candidate => {
			expect(() => validateLoadedBindings(ctx, { DesktopSession: LegacyDesktopSession }, candidate)).toThrow(
				"reinstall to re-sync",
			);
		});
	});
	it("rejects a pre-sentinel core without the legacy desktop ABI", async () => {
		const ctx = ctxFor("17.2.8");
		await withCandidate("legacy native addon", candidate => {
			expect(() => validateLoadedBindings(ctx, legacyCoreBindings, candidate)).toThrow("reinstall to re-sync");
		});
	});

	it("keeps resident old addons restart-only", async () => {
		const ctx = ctxFor("17.2.8");
		const bindings = { __piNativesV17_2_7: () => {}, ...legacyCoreBindings, DesktopSession: LegacyDesktopSession };
		await withCandidate(stamped("17.2.8"), candidate => {
			expect(() => validateLoadedBindings(ctx, bindings, candidate)).toThrow("restart omp");
		});
	});

	it("does not treat a stamped addon with the core ABI as pre-sentinel", async () => {
		const ctx = ctxFor("17.2.8");
		const bindings = {
			__piNativesBuildVersion: () => null,
			...legacyCoreBindings,
			DesktopSession: LegacyDesktopSession,
		};
		await withCandidate("unstamped", candidate => {
			expect(() => validateLoadedBindings(ctx, bindings, candidate)).toThrow("reinstall to re-sync");
		});
	});
});

describe("loaded addon release validation", () => {
	it("accepts bindings that report the expected version", () => {
		expect(() => validateLoadedBindings(ctxFor("16.3.11"), reporting("16.3.11"), unusedCandidate)).not.toThrow();
	});

	it("reports a mid-session upgrade (restart) only when disk has the expected stamp", async () => {
		const ctx = ctxFor("16.3.11");
		for (const resident of [reporting("16.3.10"), { __piNativesV16_3_10: () => {}, grep: () => {} }]) {
			await withCandidate(stamped("16.3.11"), candidate => {
				expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("16.3.10");
				expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("restart omp");
				expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("Disk is already consistent");
				expect(() => validateLoadedBindings(ctx, resident, candidate)).not.toThrow("reinstall to re-sync");
			});
		}
	});

	it("reports disk-stale (reinstall) when the file carries a prior stamp", async () => {
		const ctx = ctxFor("16.3.11");
		await withCandidate(stamped("16.3.10"), candidate => {
			const stale = reporting("16.3.10");
			expect(() => validateLoadedBindings(ctx, stale, candidate)).toThrow(
				"from a different release than this loader",
			);
			expect(() => validateLoadedBindings(ctx, stale, candidate)).toThrow("reinstall to re-sync");
			expect(() => validateLoadedBindings(ctx, stale, candidate)).not.toThrow("restart omp");
		});
	});

	it("does not treat a longer version with the expected prefix as the expected stamp", async () => {
		await withCandidate(stamped("16.3.110"), candidate => {
			expect(() => validateLoadedBindings(ctxFor("16.3.11"), reporting("16.3.110"), candidate)).toThrow(
				"reinstall to re-sync",
			);
		});
	});

	it("rejects an unstamped build as disk-stale", async () => {
		await withCandidate(`PI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`, candidate => {
			expect(() => validateLoadedBindings(ctxFor("16.3.11"), reporting(null), candidate)).toThrow(
				"reports no release version",
			);
		});
	});

	it("skips validation entirely in workspace dev", () => {
		const ctx = { ...ctxFor("16.3.11"), isWorkspaceLoad: true };
		expect(() => validateLoadedBindings(ctx, { grep: () => {} }, unusedCandidate)).not.toThrow();
	});
});
