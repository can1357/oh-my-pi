import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHIM_PATH = path.join(import.meta.dir, "../../src/extensibility/plugins/legacy-pi-compat.ts");
const PACKAGE_DIR = path.join(import.meta.dir, "../..");

/**
 * `Bun.plugin()` registrations are process-global and permanent, so the shim is
 * installed in a child process: a leaked resolve hook would change module
 * resolution for every later test in this runner. `target` is required after
 * the shim is live; the child prints what it loaded.
 */
async function requireThroughShim(target: string): Promise<string> {
	const source = [
		`const { installLegacyPiSpecifierShim } = await import(${JSON.stringify(SHIM_PATH)});`,
		"installLegacyPiSpecifierShim();",
		"try {",
		`	const loaded = require(${JSON.stringify(target)});`,
		'	console.log("OK " + JSON.stringify({ keys: Object.keys(loaded).length, pluginLocal: loaded.PLUGIN_LOCAL_COPY === true }));',
		"} catch (err) {",
		'	console.log("ERR " + String(err).slice(0, 200));',
		"}",
	].join("\n");
	// `process.execPath` pins the child to the Bun running this test, not
	// whichever `bun` happens to be first on PATH.
	const proc = Bun.spawn([process.execPath, "-e", source], { cwd: PACKAGE_DIR, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const stderr = err.trim();
	return stderr ? `${out.trim()}\n[stderr] ${stderr.slice(0, 500)}` : out.trim();
}

function parseLoaded(output: string): { keys: number; pluginLocal: boolean } {
	expect(output).not.toContain("NameTooLong");
	expect(output.startsWith("OK ")).toBe(true);
	return JSON.parse(output.slice("OK ".length).split("\n")[0]);
}

describe("legacy-pi specifier shim", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await tempDir?.remove();
		tempDir = undefined;
	});

	it("resolves a canonical @oh-my-pi subpath that remaps to itself", async () => {
		// Regression: the resolve hook matches `@oh-my-pi/pi-*` as well as the
		// legacy scopes, so resolving the remapped specifier called
		// `Bun.resolveSync` with a specifier this same hook matches. Bun
		// re-entered the hook and re-prefixed the namespace on every pass until
		// the import died as `NameTooLong reading "file:file:…"`, breaking every
		// `require("@oh-my-pi/pi-ai/index.js")` first-use boundary — the
		// `/login` provider selector among them.
		const loaded = parseLoaded(await requireThroughShim("@oh-my-pi/pi-ai/index.js"));
		expect(loaded.pluginLocal).toBe(false);
		expect(loaded.keys).toBeGreaterThan(1);
	}, 30_000);

	it("keeps a plugin's canonical subpath import on the host copy, not a plugin-local install", async () => {
		// A plugin that ships its own `@oh-my-pi/pi-ai` must still share the host
		// singleton (split registries otherwise); only the host copy exposes more
		// than the fixture's single marker export.
		tempDir = TempDir.createSync("@pi-legacy-canonical-shadow-");
		const localPackage = tempDir.join("node_modules/@oh-my-pi/pi-ai");
		await Bun.write(
			path.join(localPackage, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-ai", version: "0.0.0", main: "index.js" }),
		);
		await Bun.write(path.join(localPackage, "index.js"), "module.exports = { PLUGIN_LOCAL_COPY: true };");
		const pluginEntry = tempDir.join("plugin.cjs");
		await Bun.write(pluginEntry, 'module.exports = require("@oh-my-pi/pi-ai/index.js");');

		const loaded = parseLoaded(await requireThroughShim(pluginEntry));
		expect(loaded.pluginLocal).toBe(false);
		expect(loaded.keys).toBeGreaterThan(1);
	}, 30_000);
});
