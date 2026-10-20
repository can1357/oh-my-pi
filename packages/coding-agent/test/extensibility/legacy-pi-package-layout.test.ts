import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { collectBundledPiEntries, type LegacyPiLayout } from "../../scripts/legacy-pi-virtual-module";

/** The bundled packages as they ship on npm: scope directory name and published name. */
const NPM_PACKAGES: readonly (readonly [npmDir: string, name: string])[] = [
	["pi-agent-core", "@oh-my-pi/pi-agent-core"],
	["pi-ai", "@oh-my-pi/pi-ai"],
	["pi-catalog", "@oh-my-pi/pi-catalog"],
	["pi-coding-agent", "@oh-my-pi/pi-coding-agent"],
	["pi-natives", "@oh-my-pi/pi-natives"],
	["pi-tui", "@oh-my-pi/pi-tui"],
	["pi-utils", "@oh-my-pi/pi-utils"],
];

/** A stand-in for a published package: a manifest plus the sources its exports point at. */
async function writeInstalledPackage(dir: string, name: string): Promise<void> {
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({
			name,
			exports: {
				".": "./src/index.ts",
				"./oauth": "./src/oauth.ts",
				"./sub/*": "./src/sub/*.ts",
			},
		}),
	);
	await Bun.write(path.join(dir, "src/index.ts"), "export const value = 1;\n");
	await Bun.write(path.join(dir, "src/oauth.ts"), "export const oauth = 1;\n");
	await Bun.write(path.join(dir, "src/sub/helper.ts"), "export const helper = 1;\n");
}

// Regression for issue #15208: the collector resolved every bundled package as
// `<repoRoot>/packages/<dir>`, a layout that only exists inside the monorepo.
// From an npm install it threw ENOENT on `node_modules/packages/agent/package.json`,
// so `createLegacyPiVirtualModulePlugin()` was unusable for downstream hosts
// compiling their own binary.
describe("legacy pi virtual module package layout (issue #15208)", () => {
	it("resolves the bundled packages from a hoisted npm install", async () => {
		using temp = TempDir.createSync("@omp-legacy-pi-hoisted-");
		const scopeDir = path.join(temp.path(), "node_modules", "@oh-my-pi");
		for (const [npmDir, name] of NPM_PACKAGES) {
			await writeInstalledPackage(path.join(scopeDir, npmDir), name);
		}
		const layout: LegacyPiLayout = {
			packageDir: path.join(scopeDir, "pi-coding-agent"),
			repoRoot: path.join(temp.path(), "node_modules"),
		};

		const entries = await collectBundledPiEntries(layout);
		const keys = entries.map(entry => entry.key);

		// The agent package ships as `pi-agent-core`, so its directory name in
		// the install is not the monorepo's `packages/agent`.
		expect(keys).toContain("@oh-my-pi/pi-agent-core");
		expect(keys).toContain("@oh-my-pi/pi-agent-core/oauth");
		// A wildcard export expands against the resolved package root, so the
		// key can only exist when that root was read from the install.
		expect(keys).toContain("@oh-my-pi/pi-agent-core/sub/helper");
		// Shims stay inside the installed coding-agent package.
		expect(entries.find(entry => entry.key === "@oh-my-pi/pi-ai")?.importSpecifier).toBe(
			path.join(layout.packageDir, "src", "extensibility", "legacy-pi-ai-shim.ts"),
		);
	});

	it("resolves the bundled packages from a nested npm install", async () => {
		using temp = TempDir.createSync("@omp-legacy-pi-nested-");
		const packageDir = path.join(temp.path(), "node_modules", "@oh-my-pi", "pi-coding-agent");
		// `--install-strategy=nested` keeps the dependencies inside the package
		// that needs them, so no sibling copy exists to fall back to.
		for (const [npmDir, name] of NPM_PACKAGES) {
			await writeInstalledPackage(path.join(packageDir, "node_modules", "@oh-my-pi", npmDir), name);
		}
		const layout: LegacyPiLayout = {
			packageDir,
			repoRoot: path.join(temp.path(), "node_modules"),
		};

		const keys = (await collectBundledPiEntries(layout)).map(entry => entry.key);

		expect(keys).toContain("@oh-my-pi/pi-agent-core");
		expect(keys).toContain("@oh-my-pi/pi-agent-core/sub/helper");
	});

	it("names the missing package when the install does not provide it", async () => {
		using temp = TempDir.createSync("@omp-legacy-pi-missing-");
		const packageDir = path.join(temp.path(), "node_modules", "@oh-my-pi", "pi-coding-agent");
		await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
		const layout: LegacyPiLayout = {
			packageDir,
			repoRoot: path.join(temp.path(), "node_modules"),
		};

		await expect(collectBundledPiEntries(layout)).rejects.toThrow(/pi-agent-core/);
	});
});
