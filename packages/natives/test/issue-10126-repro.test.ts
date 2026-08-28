import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildHelpMessage, initLoaderContext } from "../native/loader-state.js";

describe("issue 10126: fresh-checkout native recovery", () => {
	it("reuses the matching standalone release cache for workspace development", () => {
		const ctx = initLoaderContext({
			isCompiledBinary: false,
			nativeDir: "/repo/packages/natives/native",
		});

		expect(ctx.isWorkspaceLoad).toBe(true);
		for (const filename of ctx.addonFilenames) {
			const cachedAddon = path.join(ctx.versionedDir, filename);
			expect(ctx.candidates).toContain(cachedAddon);
			expect(ctx.candidates.indexOf(cachedAddon)).toBeGreaterThan(
				ctx.candidates.indexOf(path.join(ctx.nativeDir, filename)),
			);
		}
	});

	it("points failed compiled extraction at the matching binary release instead of unpublished addon assets", () => {
		const ctx = initLoaderContext({
			isCompiledBinary: true,
			nativeDir: "/repo/packages/natives/native",
		});
		const help = buildHelpMessage(ctx);

		expect(help).toContain(`https://github.com/can1357/oh-my-pi/releases/tag/v${ctx.packageVersion}`);
		expect(help).not.toContain("/releases/latest/download/pi_natives.");
	});
});
