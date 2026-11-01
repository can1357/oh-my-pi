import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	collectBundledPiEntries,
	createLegacyPiVirtualModulePlugin,
	type LegacyPiLayout,
} from "../../scripts/legacy-pi-virtual-module";

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

/** The shims the collector points at inside the installed coding-agent package. */
const SHIM_FILES = [
	"legacy-pi-ai-shim.ts",
	"legacy-pi-coding-agent-shim.ts",
	"legacy-pi-tui-shim.ts",
	"legacy-typebox.ts",
];

/** A stand-in for a published package: a manifest plus the sources its exports point at. */
async function writeInstalledPackage(dir: string, name: string, marker: string = name): Promise<void> {
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
	// The marker is a top-level assignment so tree shaking cannot drop it.
	await Bun.write(
		path.join(dir, "src/index.ts"),
		`globalThis.__ompLegacyPiMarker = ${JSON.stringify(marker)};\nexport const value = 1;\n`,
	);
	await Bun.write(path.join(dir, "src/oauth.ts"), "export const oauth = 1;\n");
	await Bun.write(path.join(dir, "src/sub/helper.ts"), "export const helper = 1;\n");
}

/** The installed `@oh-my-pi/pi-coding-agent` package: manifest plus the shims it ships. */
async function writeInstalledCodingAgent(packageDir: string): Promise<void> {
	// The published package exports its root, which is also what lets Node
	// resolve the package by its own name from inside itself.
	await Bun.write(
		path.join(packageDir, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			version: "0.0.0",
			exports: { ".": "./src/index.ts" },
		}),
	);
	await Bun.write(path.join(packageDir, "src", "index.ts"), "export const codingAgent = 1;\n");
	for (const shim of SHIM_FILES) {
		await Bun.write(path.join(packageDir, "src", "extensibility", shim), "export const shim = 1;\n");
	}
}

/** Bundles a host that imports the virtual module, the way a downstream host compiles its binary. */
async function bundleLegacyPiModules(layout: LegacyPiLayout, host: string): Promise<{ code: string; logs: string[] }> {
	const entry = path.join(host, "entry.ts");
	await Bun.write(
		entry,
		[
			'import { BUNDLED_PI_MODULE_LOADERS } from "omp-legacy-pi-modules";',
			'export const loadAgent = BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-agent-core"];',
			'export const loadOauth = BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-agent-core/oauth"];',
		].join("\n"),
	);
	const result = await Bun.build({
		entrypoints: [entry],
		target: "bun",
		plugins: [await createLegacyPiVirtualModulePlugin(layout)],
		throw: false,
	});
	return {
		code: result.outputs[0] ? await result.outputs[0].text() : "",
		logs: result.logs.map(log => log.message),
	};
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

	// The generated loaders import the bundled packages by their bare names, so
	// the bundler resolves them against the importing module's directory. The
	// virtual module therefore has to live inside the installed package: a
	// host project has no copy of the Pi packages when npm keeps them nested,
	// and the build then failed with `Could not resolve: "@oh-my-pi/pi-agent-core"`.
	it("bundles the packages of a nested npm install", async () => {
		using temp = TempDir.createSync("@omp-legacy-pi-nested-build-");
		const host = temp.path();
		const packageDir = path.join(host, "node_modules", "@oh-my-pi", "pi-coding-agent");
		for (const [npmDir, name] of NPM_PACKAGES) {
			await writeInstalledPackage(
				path.join(packageDir, "node_modules", "@oh-my-pi", npmDir),
				name,
				`nested:${npmDir}`,
			);
		}
		await writeInstalledCodingAgent(packageDir);
		const layout: LegacyPiLayout = { packageDir, repoRoot: path.join(host, "node_modules") };
		const bundle = await bundleLegacyPiModules(layout, host);

		expect(bundle.logs).toEqual([]);
		// The nested copy is what got bundled, not a hoisted one.
		expect(bundle.code).toContain("nested:pi-agent-core");
	});

	it("bundles the packages of a hoisted npm install", async () => {
		using temp = TempDir.createSync("@omp-legacy-pi-hoisted-build-");
		const host = temp.path();
		const packageDir = path.join(host, "node_modules", "@oh-my-pi", "pi-coding-agent");
		for (const [npmDir, name] of NPM_PACKAGES) {
			await writeInstalledPackage(path.join(host, "node_modules", "@oh-my-pi", npmDir), name, `hoisted:${npmDir}`);
		}
		await writeInstalledCodingAgent(packageDir);
		const layout: LegacyPiLayout = { packageDir, repoRoot: path.join(host, "node_modules") };
		const bundle = await bundleLegacyPiModules(layout, host);

		expect(bundle.logs).toEqual([]);
		expect(bundle.code).toContain("hoisted:pi-agent-core");
	});
});
