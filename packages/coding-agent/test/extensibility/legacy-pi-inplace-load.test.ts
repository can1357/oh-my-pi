import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	__rewriteLegacyExtensionSourceForTests,
	loadLegacyPiModule,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

// Issue #1674: legacy Pi extensions load browser-UI assets (HTML/CSS) at module
// init via `readFileSync(join(__dirname, "ui.html"))`. The compat layer must run
// the extension from its real on-disk location so `import.meta.url` (and thus
// `__dirname`) points at the extension's own directory — no temp-directory
// mirror, no asset copying. These tests pin that contract end-to-end through the
// public `loadLegacyPiModule` entry point.

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writePackage(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-inplace-"));
	tempRoots.push(dir);
	for (const rel in files) {
		const abs = path.join(dir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, files[rel], "utf8");
	}
	return dir;
}

describe("legacy-pi in-place module loading (issue #1674)", () => {
	it("reads __dirname-relative HTML assets from the real extension directory", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "asset-ext", version: "1.0.0" }),
			"ui.html": "<html>PLAN-UI</html>",
			"index.ts": [
				'import { readFileSync } from "node:fs";',
				'import { fileURLToPath } from "node:url";',
				'import * as path from "node:path";',
				"const here = path.dirname(fileURLToPath(import.meta.url));",
				"export const dirName = here;",
				'export const html = readFileSync(path.join(here, "ui.html"), "utf8");',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { dirName: string; html: string };

		// The asset resolves because the module runs in place — its computed
		// __dirname is the extension's real directory, not a mirror temp root.
		// (Bun realpaths loaded modules, so compare against the realpath.)
		expect(mod.dirName).toBe(await fs.realpath(dir));
		expect(mod.html).toBe("<html>PLAN-UI</html>");
	});

	it("resolves a .css sibling of a relatively-imported submodule", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "multi-file-ext", version: "1.0.0" }),
			"sub/widget.css": ".x{color:red}",
			"sub/widget.ts": [
				'import { readFileSync } from "node:fs";',
				'import { fileURLToPath } from "node:url";',
				'import * as path from "node:path";',
				"const here = path.dirname(fileURLToPath(import.meta.url));",
				'export const css = readFileSync(path.join(here, "widget.css"), "utf8");',
			].join("\n"),
			"index.ts": ['export { css } from "./sub/widget.ts";', "export default function (pi) { void pi; }"].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { css: string };

		// The submodule under sub/ also runs in place, so its sibling asset
		// resolves relative to sub/ rather than a flattened mirror root.
		expect(mod.css).toBe(".x{color:red}");
	});

	it("loads the extension's own node_modules deps natively while remapping legacy pi imports", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "dep-ext", version: "1.0.0" }),
			"node_modules/cjsdep/package.json": JSON.stringify({ name: "cjsdep", version: "1.0.0", main: "index.js" }),
			"node_modules/cjsdep/index.js": 'module.exports = { value: "cjs-native" };',
			"index.ts": [
				'import cjs from "cjsdep";',
				// `@earendil-works/*` is a fork alias with no real published package,
				// so a working import proves the load-time rewrite fired rather than
				// a coincidental native resolution against a cached package.
				'import { z } from "@earendil-works/pi-ai";',
				"export const depValue = cjs.value;",
				'export const hasZod = typeof z?.object === "function";',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { depValue: string; hasZod: boolean };

		// CJS dep under node_modules keeps Bun's native resolution (it is excluded
		// from the rewrite onLoad), and the legacy pi import is remapped to the
		// bundled Zod-backed shim.
		expect(mod.depValue).toBe("cjs-native");
		expect(mod.hasZod).toBe(true);
	});

	it("rewrites extension bare deps to file URLs for compiled-binary loading", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "compiled-dep-ext", version: "1.0.0" }),
			"node_modules/esmdep/package.json": JSON.stringify({
				name: "esmdep",
				version: "1.0.0",
				type: "module",
				exports: { "./value": "./value.js" },
			}),
			"node_modules/rootdep/package.json": JSON.stringify({
				name: "rootdep",
				version: "1.0.0",
				type: "module",
				exports: "./dist/index.js",
			}),
			"node_modules/rootdep/dist/index.js": "export const rootValue = 2;",
			"node_modules/esmdep/value.js": "export const value = 1;",
			"index.ts": "",
		});
		const importer = path.join(dir, "index.ts");
		const rewritten = await __rewriteLegacyExtensionSourceForTests(
			[
				'import * as path from "node:path";',
				'import { value } from "esmdep/value";',
				'import { rootValue } from "rootdep";',
				"export const loaded = value + rootValue;",
			].join("\n"),
			importer,
		);

		const expectedEsmDepUrls = [
			path.join(dir, "node_modules/esmdep/value.js"),
			await fs.realpath(path.join(dir, "node_modules/esmdep/value.js")),
		].map(p => url.pathToFileURL(p).href);
		const expectedRootDepUrls = [
			path.join(dir, "node_modules/rootdep/dist/index.js"),
			await fs.realpath(path.join(dir, "node_modules/rootdep/dist/index.js")),
		].map(p => url.pathToFileURL(p).href);
		expect(expectedEsmDepUrls.some(expected => rewritten.includes(expected))).toBe(true);
		expect(expectedRootDepUrls.some(expected => rewritten.includes(expected))).toBe(true);
		expect(rewritten).toContain('from "node:path"');
	});

	it("remaps legacy pi-ai utils/oauth subpaths to registry OAuth exports", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-oauth-ext", version: "1.0.0" }),
			"index.ts": [
				'import { registerOAuthProvider } from "@mariozechner/pi-ai/utils/oauth";',
				'import { refreshAnthropicToken } from "@mariozechner/pi-ai/utils/oauth/anthropic";',
				'export const hasRegisterOAuthProvider = typeof registerOAuthProvider === "function";',
				'export const hasRefreshAnthropicToken = typeof refreshAnthropicToken === "function";',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			hasRegisterOAuthProvider: boolean;
			hasRefreshAnthropicToken: boolean;
		};

		expect(mod.hasRegisterOAuthProvider).toBe(true);
		expect(mod.hasRefreshAnthropicToken).toBe(true);
	});

	it("rewrites legacy imports in ../src modules reached through relative imports", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "dist-ext", version: "1.0.0" }),
			"src/helper.ts": [
				'import { isCompiledBinary } from "@earendil-works/pi-utils";',
				'export const ok = typeof isCompiledBinary === "function";',
			].join("\n"),
			"dist/extension.ts": [
				'export { ok } from "../src/helper.ts";',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "dist", "extension.ts"))) as { ok: boolean };

		// `../src/helper.ts` lives outside the entry's own dir but is part of the
		// entry's relative-import graph, so its legacy import is still rewritten.
		expect(mod.ok).toBe(true);
	});

	it("does not rewrite sibling files outside the loaded extension's import graph", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "scoped-ext", version: "1.0.0" }),
			"index.ts": ['export { local } from "./local.ts";', "export default function (pi) { void pi; }"].join("\n"),
			"local.ts": 'export const local = "local-ok";',
			// Not imported by index.ts, so it must stay outside the rewrite scope.
			// `@earendil-works/*` only resolves via the rewrite, so an un-rewritten
			// import fails — proving the hook did not over-reach to this sibling.
			"unrelated.ts": [
				'import { z } from "@earendil-works/pi-ai";',
				'export const hasZod = typeof z?.object === "function";',
			].join("\n"),
		});

		const entryMod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { local: string };
		expect(entryMod.local).toBe("local-ok");

		// Loading the un-imported sibling directly must NOT benefit from the
		// extension's rewrite hook; its fork-scope import stays unresolved.
		const siblingUrl = `${url.pathToFileURL(await fs.realpath(path.join(dir, "unrelated.ts"))).href}?nonce=${Date.now()}`;
		await expect(import(siblingUrl)).rejects.toThrow(/@earendil-works\/pi-ai/);
	});
});
