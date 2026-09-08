import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	__collectLegacyPiExtensionSourcesForTests,
	__rewriteLegacyExtensionSourceForTests,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
	it("loads in place with ESM-to-CommonJS default, named, and require interop", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "asset-ext", version: "1.0.0" }),
			"ui.html": "<html>PLAN-UI</html>",
			"config.js": 'module.exports = { value: "required-cjs-ok" };\n',
			"consumer.js": [
				'import { createRequire } from "node:module";',
				"const require = createRequire(import.meta.url);",
				'export const requiredValue = require("./config.js").value;',
			].join("\n"),
			"helper.js": "module.exports = { value: 42 };\n",
			"named-helper.cjs": 'module.exports = { namedValue: "named-cjs-ok" };\n',
			"index.ts": [
				'import { readFileSync } from "node:fs";',
				'import { fileURLToPath } from "node:url";',
				'import * as path from "node:path";',
				'import { requiredValue } from "./consumer.js";',
				'import helper from "./helper.js";',
				'import { namedValue } from "./named-helper.cjs";',
				"const here = path.dirname(fileURLToPath(import.meta.url));",
				"export const dirName = here;",
				'export const html = readFileSync(path.join(here, "ui.html"), "utf8");',
				"export const defaultValue = helper.value;",
				"export { namedValue, requiredValue };",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			defaultValue: number;
			dirName: string;
			html: string;
			namedValue: string;
			requiredValue: string;
		};

		// Bun realpaths loaded modules, so the in-place path is compared to the fixture's real path.
		expect(mod.dirName).toBe(await fs.realpath(dir));
		expect(mod.html).toBe("<html>PLAN-UI</html>");
		expect(mod.requiredValue).toBe("required-cjs-ok");
		expect(mod.defaultValue).toBe(42);
		expect(mod.namedValue).toBe("named-cjs-ok");
	});

	it("remaps legacy Pi requires in graph-owned CommonJS packages to the host shim", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-legacy-pi-require-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js": 'module.exports = require("@mariozechner/pi-ai").Type;\n',
			"index.ts": [
				'import { Type } from "@oh-my-pi/pi-ai";',
				'import requiredType from "direct";',
				"export const sharesHostType = requiredType === Type;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { sharesHostType: boolean };

		expect(mod.sharesHostType).toBe(true);
	});

	it("loads a default import from an ESM package's CommonJS canvas fallback", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "esm-canvas-consumer", version: "1.0.0", type: "module" }),
			"index.js": 'export { canvasValue } from "esm-canvas-package";\n',
			"node_modules/esm-canvas-package/package.json": JSON.stringify({
				name: "esm-canvas-package",
				version: "1.0.0",
				type: "module",
				exports: "./index.js",
			}),
			"node_modules/esm-canvas-package/index.js": [
				'import Canvas from "./commonjs/canvas.cjs";',
				"export const canvasValue = Canvas.createCanvas();",
			].join("\n"),
			"node_modules/esm-canvas-package/commonjs/canvas.cjs": [
				"try {",
				'  module.exports = require("canvas");',
				"} catch {",
				'  module.exports = require("./canvas-shim.cjs");',
				"}",
			].join("\n"),
			"node_modules/esm-canvas-package/commonjs/canvas-shim.cjs":
				'module.exports = { createCanvas: () => "canvas-shim" };\n',
		});

		const mod = await loadLegacyPiModule(path.join(dir, "index.js"));

		expect(Reflect.get(Object(mod), "canvasValue")).toBe("canvas-shim");
	});

	it("reads a lazy CommonJS helper at import time", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "lazy-cjs-ext", version: "1.0.0", type: "module" }),
			"index.js": [
				'export const loadValue = () => import("./helper.cjs").then(mod => mod.default.value);',
				"export default function (pi) { void pi; }",
			].join("\n"),
			"helper.cjs": 'module.exports = { value: "v1" };\n',
		});
		const helper = path.join(dir, "helper.cjs");
		const mod = (await loadLegacyPiModule(path.join(dir, "index.js"))) as { loadValue(): Promise<string> };

		await fs.writeFile(helper, 'module.exports = { value: "v2" };\n', "utf8");

		expect(await mod.loadValue()).toBe("v2");
	});

	it("reloads an edited CommonJS helper imported from ESM", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-reload-ext", version: "1.0.0", type: "module" }),
			"index.js": [
				'import helper from "./helper.cjs";',
				"export const helperValue = helper.value;",
				"export default function (pi) { void pi; }",
			].join("\n"),
			"helper.cjs": 'module.exports = { value: "v1" };\n',
		});
		const entry = path.join(dir, "index.js");
		const helper = path.join(dir, "helper.cjs");

		const first = await loadLegacyPiModule(entry);
		expect(Reflect.get(Object(first), "helperValue")).toBe("v1");

		const firstHelperStat = await fs.stat(helper);
		await fs.writeFile(helper, 'module.exports = { value: "v2" };\n', "utf8");
		const bumpedHelperMtime = new Date(Math.ceil(firstHelperStat.mtimeMs) + 2_000);
		await fs.utimes(helper, bumpedHelperMtime, bumpedHelperMtime);

		const second = await loadLegacyPiModule(entry);
		expect(Reflect.get(Object(second), "helperValue")).toBe("v2");
	});

	it("reloads an edited entry module without polluting fileURLToPath-derived paths", async () => {
		const entrySource = (version: string): string =>
			[
				'import { readFileSync } from "node:fs";',
				'import { fileURLToPath } from "node:url";',
				'import * as path from "node:path";',
				"export const entryPath = fileURLToPath(import.meta.url);",
				"const here = path.dirname(entryPath);",
				`export const version = ${JSON.stringify(version)};`,
				'export const asset = readFileSync(path.join(here, "marker.txt"), "utf8");',
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "mtime-reload-ext", version: "1.0.0" }),
			"marker.txt": "asset-ok",
			"index.ts": entrySource("v1"),
		});
		const entry = path.join(dir, "index.ts");
		const expectedEntryPath = await fs.realpath(entry);

		const first = (await loadLegacyPiModule(entry)) as { version: string; entryPath: string; asset: string };
		expect(first.version).toBe("v1");
		expect(first.entryPath).toBe(expectedEntryPath);
		expect(first.asset).toBe("asset-ok");

		const firstStat = await fs.stat(entry);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		const bumpedMtime = new Date(Math.ceil(firstStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedMtime, bumpedMtime);

		const second = (await loadLegacyPiModule(entry)) as { version: string; entryPath: string; asset: string };
		expect(second.version).toBe("v2");
		expect(second.entryPath).toBe(expectedEntryPath);
		expect(second.entryPath.includes("?")).toBe(false);
		expect(second.asset).toBe("asset-ok");
	});

	it("reloads an edited relative helper module on same-process re-import", async () => {
		const entrySource = (version: string): string =>
			[
				'import { fileURLToPath } from "node:url";',
				'import { H } from "./helper.ts";',
				"export { H };",
				"export const entryPath = fileURLToPath(import.meta.url);",
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "helper-mtime-reload-ext", version: "1.0.0" }),
			"index.ts": entrySource("v1"),
			"helper.ts": 'export const H = "v1";\n',
		});
		const entry = path.join(dir, "index.ts");
		const helper = path.join(dir, "helper.ts");
		const expectedEntryPath = await fs.realpath(entry);

		const first = (await loadLegacyPiModule(entry)) as { entryVersion: string; H: string; entryPath: string };
		expect(first.entryVersion).toBe("v1");
		expect(first.H).toBe("v1");
		expect(first.entryPath).toBe(expectedEntryPath);

		const firstEntryStat = await fs.stat(entry);
		const firstHelperStat = await fs.stat(helper);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		await fs.writeFile(helper, 'export const H = "v2";\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		const bumpedHelperMtime = new Date(Math.ceil(firstHelperStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(helper, bumpedHelperMtime, bumpedHelperMtime);

		const second = (await loadLegacyPiModule(entry)) as { entryVersion: string; H: string; entryPath: string };
		expect(second.entryVersion).toBe("v2");
		expect(second.H).toBe("v2");
		expect(second.entryPath).toBe(expectedEntryPath);
		expect(second.entryPath.includes("?")).toBe(false);
	});

	it("reloads edited children of an extension-local bare dependency", async () => {
		const entrySource = (version: string): string =>
			[
				'import { depValue } from "localdep";',
				"export { depValue };",
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "bare-dep-child-reload-ext", version: "1.0.0" }),
			"node_modules/localdep/package.json": JSON.stringify({
				name: "localdep",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/localdep/index.js": 'export { depValue } from "./helper.js";\n',
			"node_modules/localdep/helper.js": 'export const depValue = "dep-v1";\n',
			"index.ts": entrySource("v1"),
		});
		const entry = path.join(dir, "index.ts");
		const helper = path.join(dir, "node_modules", "localdep", "helper.js");

		const first = (await loadLegacyPiModule(entry)) as { entryVersion: string; depValue: string };
		expect(first.entryVersion).toBe("v1");
		expect(first.depValue).toBe("dep-v1");

		const firstEntryStat = await fs.stat(entry);
		const firstHelperStat = await fs.stat(helper);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		await fs.writeFile(helper, 'export const depValue = "dep-v2";\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		const bumpedHelperMtime = new Date(Math.ceil(firstHelperStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(helper, bumpedHelperMtime, bumpedHelperMtime);

		const second = (await loadLegacyPiModule(entry)) as { entryVersion: string; depValue: string };
		expect(second.entryVersion).toBe("v2");
		expect(second.depValue).toBe("dep-v2");
	});

	it("reloads edited children of an installed plugin's extension-local bare dependency", async () => {
		const entrySource = (version: string): string =>
			[
				'import { depValue } from "localdep";',
				"export { depValue };",
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"plugins/node_modules/installed-plugin/package.json": JSON.stringify({
				name: "installed-plugin",
				version: "1.0.0",
			}),
			"plugins/node_modules/installed-plugin/node_modules/localdep/package.json": JSON.stringify({
				name: "localdep",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"plugins/node_modules/installed-plugin/node_modules/localdep/index.js":
				'export { depValue } from "./helper.js";\n',
			"plugins/node_modules/installed-plugin/node_modules/localdep/helper.js": 'export const depValue = "dep-v1";\n',
			"plugins/node_modules/installed-plugin/index.ts": entrySource("v1"),
		});
		const pluginRoot = path.join(dir, "plugins", "node_modules", "installed-plugin");
		const entry = path.join(pluginRoot, "index.ts");
		const helper = path.join(pluginRoot, "node_modules", "localdep", "helper.js");

		const first = (await loadLegacyPiModule(entry)) as { entryVersion: string; depValue: string };
		expect(first.entryVersion).toBe("v1");
		expect(first.depValue).toBe("dep-v1");

		const firstEntryStat = await fs.stat(entry);
		const firstHelperStat = await fs.stat(helper);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		await fs.writeFile(helper, 'export const depValue = "dep-v2";\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		const bumpedHelperMtime = new Date(Math.ceil(firstHelperStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(helper, bumpedHelperMtime, bumpedHelperMtime);

		const second = (await loadLegacyPiModule(entry)) as { entryVersion: string; depValue: string };
		expect(second.entryVersion).toBe("v2");
		expect(second.depValue).toBe("dep-v2");
	});

	it("keeps transitive bare dependency importer paths query-free", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "transitive-bare-dep-ext", version: "1.0.0", type: "module" }),
			"node_modules/directdep/package.json": JSON.stringify({
				name: "directdep",
				version: "1.0.0",
				type: "module",
				exports: "./index.js",
			}),
			"node_modules/directdep/index.js": 'export { nestedUrl } from "nesteddep";\n',
			"node_modules/nesteddep/package.json": JSON.stringify({
				name: "nesteddep",
				version: "1.0.0",
				type: "module",
				exports: "./index.js",
			}),
			"node_modules/nesteddep/index.js": "export const nestedUrl = import.meta.url;\n",
			"index.ts": 'export { nestedUrl } from "directdep";\nexport default function (pi) { void pi; }\n',
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { nestedUrl: string };
		const expectedNestedUrl = url.pathToFileURL(
			await fs.realpath(path.join(dir, "node_modules/nesteddep/index.js")),
		).href;

		expect(mod.nestedUrl).toBe(expectedNestedUrl);
	});

	it("preserves named re-exports from relative ESM children in a no-type dual package", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "dual-package-ext", version: "1.0.0", type: "module" }),
			"node_modules/dual-package/package.json": JSON.stringify({
				name: "dual-package",
				version: "1.0.0",
				main: "lib/commonjs/index.js",
				module: "lib/es/index.js",
			}),
			"node_modules/dual-package/lib/commonjs/index.js": `exports.stringify = value => \`cjs:\${value}\`;\n`,
			"node_modules/dual-package/lib/es/index.js":
				'import "./setup.js";\nexport { stringify } from "./stringify.js";\n',
			"node_modules/dual-package/lib/es/stringify.js": `export const stringify = value => \`esm:\${value}\`;\n`,
			"node_modules/dual-package/lib/es/setup.js": "await Promise.resolve();\n",
			"index.ts": [
				'import { stringify } from "dual-package";',
				'export const result = stringify("value");',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { result: string };

		expect(mod.result).toBe("esm:value");
	});

	it("keeps a syntax-ambiguous conditional import target on its ESM branch", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "conditional-esm-ext", version: "1.0.0", type: "module" }),
			"node_modules/conditional/package.json": JSON.stringify({
				name: "conditional",
				version: "1.0.0",
				exports: {
					".": {
						import: "./esm.js",
						require: "./cjs.js",
					},
				},
			}),
			"node_modules/conditional/esm.js": "await Promise.resolve();\n",
			"node_modules/conditional/cjs.js": 'throw new Error("require branch loaded");\n',
			"index.ts": [
				'import "conditional";',
				"export const loaded = true;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { loaded: boolean };

		expect(mod.loaded).toBe(true);
	});

	it("reloads a hoisted CommonJS dependency required by a relative CommonJS child", async () => {
		const entrySource = (version: string): string =>
			[
				'import dependency from "directdep";',
				"export const dependencyValue = dependency.value;",
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "relative-transitive-cjs-ext", version: "1.0.0", type: "module" }),
			"node_modules/directdep/package.json": JSON.stringify({
				name: "directdep",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/directdep/index.js": 'module.exports = require("./child.js");\n',
			"node_modules/directdep/child.js": [
				"void 'export { ignored } from \"ignored\";';",
				'// import ignored from "ignored";',
				'module.exports = require("transitive-dependency");',
			].join("\n"),
			"node_modules/transitive-dependency/package.json": JSON.stringify({
				name: "transitive-dependency",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/transitive-dependency/index.js": 'module.exports = { value: "dep-v1" };\n',
			"index.ts": entrySource("v1"),
		});
		const entry = path.join(dir, "index.ts");
		const transitiveDependency = path.join(dir, "node_modules", "transitive-dependency", "index.js");

		const first = (await loadLegacyPiModule(entry)) as { entryVersion: string; dependencyValue: string };
		expect(first.entryVersion).toBe("v1");
		expect(first.dependencyValue).toBe("dep-v1");

		const firstEntryStat = await fs.stat(entry);
		const firstDependencyStat = await fs.stat(transitiveDependency);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		await fs.writeFile(transitiveDependency, 'module.exports = { value: "dep-v2" };\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		const bumpedDependencyMtime = new Date(Math.ceil(firstDependencyStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(transitiveDependency, bumpedDependencyMtime, bumpedDependencyMtime);

		const second = (await loadLegacyPiModule(entry)) as { entryVersion: string; dependencyValue: string };
		expect(second.entryVersion).toBe("v2");
		expect(second.dependencyValue).toBe("dep-v2");
	});

	it("preserves named imports through CommonJS package re-exports", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "named-cjs-reexport-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js": 'module.exports = require("middle");\n',
			"node_modules/middle/package.json": JSON.stringify({
				name: "middle",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/middle/index.js": 'module.exports = require("leaf");\n',
			"node_modules/leaf/package.json": JSON.stringify({
				name: "leaf",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/leaf/index.js": [
				'module.exports = require("direct");',
				'module.exports.value = "named-reexport-ok";',
			].join("\n"),
			"index.ts": [
				'import { value } from "direct";',
				"export { value };",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { value: string };

		expect(mod.value).toBe("named-reexport-ok");
	});

	it("preserves named imports from CommonJS defineProperty and exportStar patterns", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-export-helper-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js": [
				'Object.defineProperty(exports, "local", { enumerable: true, get: () => "local-ok" });',
				"const __exportStar = (mod, target) => {",
				"  for (const key in mod) {",
				'    if (key !== "default" && !Object.prototype.hasOwnProperty.call(target, key)) {',
				"      Object.defineProperty(target, key, { enumerable: true, get: () => mod[key] });",
				"    }",
				"  }",
				"};",
				'__exportStar(require("leaf"), exports);',
			].join("\n"),
			"node_modules/leaf/package.json": JSON.stringify({
				name: "leaf",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/leaf/index.js": 'module.exports = { value: "star-ok" };\n',
			"index.ts": [
				'import { local, value } from "direct";',
				"export { local, value };",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			local: string;
			value: string;
		};

		expect(mod.local).toBe("local-ok");
		expect(mod.value).toBe("star-ok");
	});

	it("keeps dynamic-import children of a CommonJS package on its CommonJS branch", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "dynamic-cjs-child-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js":
				'module.exports = { load: () => import("./child.js").then(mod => mod.default.value) };\n',
			"node_modules/direct/child.js": 'module.exports = { value: "dynamic-child-ok" };\n',
			"index.ts": [
				'import direct from "direct";',
				"export const result = await direct.load();",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { result: string };

		expect(mod.result).toBe("dynamic-child-ok");
	});

	it("preserves default imports from CommonJS objects with non-identifier keys", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "hyphenated-cjs-export-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js": 'module.exports = { "foo-bar": true, value: "default-ok" };\n',
			"index.ts": [
				'import direct from "direct";',
				"export const result = direct.value;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { result: string };

		expect(mod.result).toBe("default-ok");
	});

	it("reloads a lazily imported CommonJS package re-export", async () => {
		const entrySource = (version: string): string =>
			[
				'export const loadValue = () => import("direct").then(mod => mod.default.value);',
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			].join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "lazy-cjs-reexport-ext", version: "1.0.0", type: "module" }),
			"node_modules/direct/package.json": JSON.stringify({
				name: "direct",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/direct/index.js": 'module.exports = require("leaf");\n',
			"node_modules/leaf/package.json": JSON.stringify({
				name: "leaf",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/leaf/index.js": 'module.exports = { value: "lazy-v1" };\n',
			"index.ts": entrySource("v1"),
		});
		const entry = path.join(dir, "index.ts");
		const leaf = path.join(dir, "node_modules", "leaf", "index.js");

		const first = (await loadLegacyPiModule(entry)) as {
			entryVersion: string;
			loadValue(): Promise<string>;
		};
		expect(first.entryVersion).toBe("v1");
		expect(await first.loadValue()).toBe("lazy-v1");

		const firstEntryStat = await fs.stat(entry);
		const firstLeafStat = await fs.stat(leaf);
		await fs.writeFile(entry, entrySource("v2"), "utf8");
		await fs.writeFile(leaf, 'module.exports = { value: "lazy-v2" };\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		const bumpedLeafMtime = new Date(Math.ceil(firstLeafStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(leaf, bumpedLeafMtime, bumpedLeafMtime);

		const second = (await loadLegacyPiModule(entry)) as {
			entryVersion: string;
			loadValue(): Promise<string>;
		};
		expect(second.entryVersion).toBe("v2");
		expect(await second.loadValue()).toBe("lazy-v2");
	});

	it("reloads modules added to the relative import graph after the first load", async () => {
		const entrySource = (version: string, includeHelper: boolean): string =>
			[
				'import { fileURLToPath } from "node:url";',
				includeHelper ? 'export { leafValue } from "./helper.ts";' : "",
				"export const entryPath = fileURLToPath(import.meta.url);",
				`export const entryVersion = ${JSON.stringify(version)};`,
				"export default function (pi) { void pi; }",
			]
				.filter(Boolean)
				.join("\n");
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "expanding-graph-reload-ext", version: "1.0.0" }),
			"index.ts": entrySource("v1", false),
		});
		const entry = path.join(dir, "index.ts");
		const helper = path.join(dir, "helper.ts");
		const leaf = path.join(dir, "leaf.ts");
		const expectedEntryPath = await fs.realpath(entry);

		const first = (await loadLegacyPiModule(entry)) as { entryVersion: string; entryPath: string };
		expect(first.entryVersion).toBe("v1");
		expect(first.entryPath).toBe(expectedEntryPath);

		const firstEntryStat = await fs.stat(entry);
		const firstGraphMtime = new Date(Math.ceil(firstEntryStat.mtimeMs) + 2_000);
		await fs.writeFile(entry, entrySource("v2", true), "utf8");
		await fs.writeFile(helper, 'export { leafValue } from "./leaf.ts";\n', "utf8");
		await fs.writeFile(leaf, 'export const leafValue = "leaf-v1";\n', "utf8");
		await fs.utimes(entry, firstGraphMtime, firstGraphMtime);
		await fs.utimes(helper, firstGraphMtime, firstGraphMtime);
		await fs.utimes(leaf, firstGraphMtime, firstGraphMtime);

		const second = (await loadLegacyPiModule(entry)) as {
			entryVersion: string;
			entryPath: string;
			leafValue: string;
		};
		expect(second.entryVersion).toBe("v2");
		expect(second.leafValue).toBe("leaf-v1");
		expect(second.entryPath).toBe(expectedEntryPath);
		expect(second.entryPath.includes("?")).toBe(false);

		const secondEntryStat = await fs.stat(entry);
		const secondLeafStat = await fs.stat(leaf);
		await fs.writeFile(entry, entrySource("v3", true), "utf8");
		await fs.writeFile(leaf, 'export const leafValue = "leaf-v2";\n', "utf8");
		const bumpedEntryMtime = new Date(Math.ceil(secondEntryStat.mtimeMs) + 2_000);
		const bumpedLeafMtime = new Date(Math.ceil(secondLeafStat.mtimeMs) + 2_000);
		await fs.utimes(entry, bumpedEntryMtime, bumpedEntryMtime);
		await fs.utimes(leaf, bumpedLeafMtime, bumpedLeafMtime);

		const third = (await loadLegacyPiModule(entry)) as {
			entryVersion: string;
			entryPath: string;
			leafValue: string;
		};
		expect(third.entryVersion).toBe("v3");
		expect(third.leafValue).toBe("leaf-v2");
		expect(third.entryPath).toBe(expectedEntryPath);
		expect(third.entryPath.includes("?")).toBe(false);
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

	it("leaves JSON import-attribute targets on Bun's native loader", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "json-import-ext", version: "1.0.0" }),
			"prices.json": JSON.stringify({ input: 0.15 }),
			"index.ts": [
				'import prices from "./prices.json" with { type: "json" };',
				"export const inputPrice = prices.input;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { inputPrice: number };

		expect(mod.inputPrice).toBe(0.15);
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
				'import { Effort } from "@earendil-works/pi-ai";',
				"export const depValue = cjs.value;",
				'export const hasAi = typeof Effort === "object";',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { depValue: string; hasAi: boolean };

		// CJS dep under node_modules keeps Bun's native resolution (it is excluded
		// from the rewrite onLoad), and the legacy pi import is remapped.
		expect(mod.depValue).toBe("cjs-native");
		expect(mod.hasAi).toBe(true);
	});

	it("exposes legacy root tool factories used by pi-lean-ctx", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-tool-factory-ext", version: "1.0.0" }),
			"index.ts": [
				'import { Text } from "@earendil-works/pi-tui";',
				"import {",
				"  createBashToolDefinition,",
				"  createFindToolDefinition,",
				"  createGrepToolDefinition,",
				"  createLsToolDefinition,",
				"  createReadToolDefinition,",
				"  DEFAULT_MAX_LINES,",
				"  getLanguageFromPath,",
				"  highlightCode,",
				"  truncateHead,",
				'} from "@earendil-works/pi-coding-agent";',
				"const cwd = process.cwd();",
				"const definitions = [",
				"  createBashToolDefinition(cwd),",
				"  createReadToolDefinition(cwd),",
				"  createGrepToolDefinition(cwd),",
				"  createFindToolDefinition(cwd),",
				"  createLsToolDefinition(cwd),",
				"];",
				"const fakeTheme = { fg: (_color, text) => text, bold: text => text };",
				"const fakeContext = { lastComponent: new Text('', 0, 0) };",
				"for (const definition of definitions) {",
				"  if (typeof definition.renderCall === 'function') definition.renderCall({ command: 'echo ok', path: '.', pattern: '*.ts' }, fakeTheme, fakeContext);",
				"}",
				"export const toolNames = definitions.map(definition => definition.name);",
				"export const helperValues = {",
				"  maxLines: DEFAULT_MAX_LINES,",
				"  language: getLanguageFromPath('src/example.ts'),",
				"  highlighted: highlightCode('const x = 1;', 'ts').length,",
				"  truncated: truncateHead('a\\nb', { maxLines: 1 }).truncated,",
				"};",
				"export default function (pi) { for (const definition of definitions) pi.registerTool(definition); }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			toolNames: string[];
			helperValues: { maxLines: number; language: string; highlighted: number; truncated: boolean };
		};

		expect(mod.toolNames).toEqual(["bash", "read", "grep", "find", "ls"]);
		expect(mod.helperValues).toEqual({
			maxLines: 3000,
			language: "typescript",
			highlighted: 1,
			truncated: true,
		});
	});

	it("exposes a fresh legacy extension runtime through the package root", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-extension-runtime-ext", version: "1.0.0" }),
			"index.ts": [
				'import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";',
				"const first = createExtensionRuntime();",
				"const second = createExtensionRuntime();",
				"first.flagValues.set('sprite', true);",
				"let initializationError;",
				"try {",
				"  first.getActiveTools();",
				"} catch (error) {",
				"  initializationError = error instanceof Error ? error.message : String(error);",
				"}",
				"export const runtimeContract = {",
				"  firstFlag: first.flagValues.get('sprite'),",
				"  secondHasFlag: second.flagValues.has('sprite'),",
				"  initializationError,",
				"};",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			runtimeContract: {
				firstFlag: boolean;
				secondHasFlag: boolean;
				initializationError: string;
			};
		};

		expect(mod.runtimeContract).toEqual({
			firstFlag: true,
			secondHasFlag: false,
			initializationError:
				"Extension runtime not initialized. Action methods cannot be called during extension loading.",
		});
	});

	it("honors legacy bash operations overrides", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-bash-ops-ext", version: "1.0.0" }),
			"index.ts": [
				'import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";',
				"const updates = [];",
				"let captured;",
				"const tool = createBashToolDefinition(process.cwd(), {",
				"  operations: {",
				"    async exec(command, cwd, options) {",
				"      captured = { command, cwd, timeout: options.timeout, envValue: options.env.SENTINEL };",
				"      options.onData(Buffer.from('remote output'));",
				"      return { exitCode: 0 };",
				"    },",
				"  },",
				"  spawnHook(context) {",
				"    return { ...context, command: 'remote:' + context.command, cwd: '/remote', env: { ...context.env, SENTINEL: 'yes' } };",
				"  },",
				"});",
				"const result = await tool.execute('call-1', { command: 'whoami', timeout: 7 }, undefined, update => {",
				"  const text = update.content.find(block => block.type === 'text')?.text;",
				"  if (text) updates.push(text);",
				"});",
				"export const observed = {",
				"  captured,",
				"  text: result.content.find(block => block.type === 'text')?.text,",
				"  updates,",
				"};",
				"export default function (pi) { pi.registerTool(tool); }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			observed: {
				captured: { command: string; cwd: string; timeout: number; envValue: string };
				text: string;
				updates: string[];
			};
		};

		expect(mod.observed.captured).toEqual({
			command: "remote:whoami",
			cwd: "/remote",
			timeout: 7,
			envValue: "yes",
		});
		expect(mod.observed.text).toBe("remote output");
		expect(mod.observed.updates).toEqual(["remote output"]);
	});

	it("preserves relative paths from legacy find operations", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-find-ops-ext", version: "1.0.0" }),
			"index.ts": [
				'import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";',
				"const tool = createFindToolDefinition('/remote/project', {",
				"  operations: {",
				"    exists: () => true,",
				"    glob: () => ['src/a.ts', '/remote/project/src/b.ts'],",
				"  },",
				"});",
				"const result = await tool.execute('call-1', { pattern: '**/*.ts', path: '.' });",
				"const text = result.content.find(block => block.type === 'text')?.text ?? '';",
				"export const lines = text.split('\\n');",
				"export default function (pi) { pi.registerTool(tool); }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { lines: string[] };

		expect(mod.lines).toEqual(["src/a.ts", "src/b.ts"]);
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
				'import{rootValue}from"rootdep";',
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

	it("pre-rewrites a nested ESM cluster required by CommonJS", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "nested-esm-ext", version: "1.0.0", type: "module" }),
			"node_modules/cjs-parent/package.json": JSON.stringify({
				name: "cjs-parent",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/cjs-parent/index.js": 'module.exports = require("nested-esm");',
			"node_modules/cjs-parent/node_modules/nested-esm/package.json": JSON.stringify({
				name: "nested-esm",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/cjs-parent/node_modules/nested-esm/index.js":
				'import { value } from "nested-leaf"; export default value;',
			"node_modules/cjs-parent/node_modules/nested-leaf/package.json": JSON.stringify({
				name: "nested-leaf",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/cjs-parent/node_modules/nested-leaf/index.js": 'export const value = "nested-ok";',
			"index.js": 'import value from "cjs-parent"; export { value };',
		});
		const entry = path.join(dir, "index.js");
		const nestedEntry = await fs.realpath(path.join(dir, "node_modules/cjs-parent/node_modules/nested-esm/index.js"));
		const nestedLeaf = await fs.realpath(path.join(dir, "node_modules/cjs-parent/node_modules/nested-leaf/index.js"));

		const sources = await __collectLegacyPiExtensionSourcesForTests(entry);

		expect(sources.has(nestedEntry)).toBe(true);
		expect(sources.get(nestedEntry)).toContain(url.pathToFileURL(nestedLeaf).href);
	});

	it("loads a nested ESM cluster required after the extension import settles", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "lazy-nested-esm-ext", version: "1.0.0", type: "module" }),
			"node_modules/cjs-parent/package.json": JSON.stringify({
				name: "cjs-parent",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/cjs-parent/index.js": 'module.exports = { load: () => require("nested-esm").default };',
			"node_modules/cjs-parent/node_modules/nested-esm/package.json": JSON.stringify({
				name: "nested-esm",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/cjs-parent/node_modules/nested-esm/index.js":
				'import { value } from "nested-leaf"; export default value;',
			"node_modules/cjs-parent/node_modules/nested-leaf/package.json": JSON.stringify({
				name: "nested-leaf",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/cjs-parent/node_modules/nested-leaf/index.js": 'export const value = "lazy-nested-ok";',
			"index.js": [
				'import parent from "cjs-parent";',
				"export const loadValue = parent.load;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = await loadLegacyPiModule(path.join(dir, "index.js"));
		const loadValue = Reflect.get(Object(mod), "loadValue");
		if (typeof loadValue !== "function") {
			throw new Error("lazy nested ESM fixture did not export loadValue");
		}

		expect(loadValue()).toBe("lazy-nested-ok");
	});

	it("rewalks an ESM graph when a later require upgrades it to synchronous loading", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "sync-upgrade-ext", version: "1.0.0", type: "module" }),
			"node_modules/cjs-parent/package.json": JSON.stringify({
				name: "cjs-parent",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/cjs-parent/index.js": 'module.exports = { load: () => require("shared").default };',
			"node_modules/shared/package.json": JSON.stringify({
				name: "shared",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/shared/index.js": 'import { value } from "shared-leaf"; export default value;',
			"node_modules/shared-leaf/package.json": JSON.stringify({
				name: "shared-leaf",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/shared-leaf/index.js": 'export const value = "sync-upgrade-ok";',
			"index.ts": [
				'import parent from "cjs-parent";',
				'import type { Marker } from "shared";',
				"export const loadValue = parent.load;",
				"export type SharedMarker = Marker;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = await loadLegacyPiModule(path.join(dir, "index.ts"));
		const loadValue = Reflect.get(Object(mod), "loadValue");
		if (typeof loadValue !== "function") {
			throw new Error("sync-upgrade fixture did not export loadValue");
		}

		expect(loadValue()).toBe("sync-upgrade-ok");
	});

	it("serves an async-hooked module synchronously after a reload adds a require edge", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "reload-upgrade-ext", version: "1.0.0", type: "module" }),
			"node_modules/cjs-parent/package.json": JSON.stringify({
				name: "cjs-parent",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/cjs-parent/index.js": 'module.exports = { load: () => require("shared").default };',
			"node_modules/shared/package.json": JSON.stringify({
				name: "shared",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/shared/index.js": 'import { value } from "shared-leaf"; export default value;',
			"node_modules/shared-leaf/package.json": JSON.stringify({
				name: "shared-leaf",
				version: "1.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/shared-leaf/index.js": 'export const value = "reload-upgrade-ok";',
			// v1 reaches `shared` through `import` only, so the first load
			// registers it with the async rewrite hook.
			"index.js": [
				'import shared from "shared";',
				"export const loadValue = () => shared;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});
		const entry = path.join(dir, "index.js");

		const first = await loadLegacyPiModule(entry);
		const firstLoad = Reflect.get(Object(first), "loadValue");
		if (typeof firstLoad !== "function") {
			throw new Error("reload-upgrade fixture v1 did not export loadValue");
		}
		expect(firstLoad()).toBe("reload-upgrade-ok");

		// v2 upgrades `shared` to synchronous loading via a new require() edge.
		// The async hook from the first load still owns the path, so it must
		// serve the pre-rewritten synchronous source inline.
		await fs.writeFile(
			entry,
			[
				'import parent from "cjs-parent";',
				"export const loadValue = parent.load;",
				"export default function (pi) { void pi; }",
			].join("\n"),
			"utf8",
		);

		const second = await loadLegacyPiModule(entry);
		const secondLoad = Reflect.get(Object(second), "loadValue");
		if (typeof secondLoad !== "function") {
			throw new Error("reload-upgrade fixture v2 did not export loadValue");
		}
		expect(secondLoad()).toBe("reload-upgrade-ok");
	});

	it("serves fresh source after a reload drops a module's require edge", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "reload-downgrade-ext", version: "1.0.0", type: "module" }),
			"node_modules/cjs-parent/package.json": JSON.stringify({
				name: "cjs-parent",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/cjs-parent/index.js": 'module.exports = { load: () => require("../../lib.js").value };',
			// v1 reaches `lib.js` through a require() edge, so the first load
			// flags it synchronous and snapshots its pre-rewritten source.
			"lib.js": 'export const value = "downgrade-v1";',
			"index.js": [
				'import parent from "cjs-parent";',
				"export const loadValue = parent.load;",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});
		const entry = path.join(dir, "index.js");

		const first = await loadLegacyPiModule(entry);
		const firstLoad = Reflect.get(Object(first), "loadValue");
		if (typeof firstLoad !== "function") {
			throw new Error("reload-downgrade fixture v1 did not export loadValue");
		}
		expect(firstLoad()).toBe("downgrade-v1");

		// v2 drops the require edge and edits lib.js. The permanent hooks still
		// serve the path from the synchronous snapshot, so the reload walk must
		// refresh it instead of replaying the v1 bytes.
		await fs.writeFile(path.join(dir, "lib.js"), 'export const value = "downgrade-v2";', "utf8");
		await fs.writeFile(
			entry,
			[
				'import { value } from "./lib.js";',
				"export const loadValue = () => value;",
				"export default function (pi) { void pi; }",
			].join("\n"),
			"utf8",
		);

		const second = await loadLegacyPiModule(entry);
		const secondLoad = Reflect.get(Object(second), "loadValue");
		if (typeof secondLoad !== "function") {
			throw new Error("reload-downgrade fixture v2 did not export loadValue");
		}
		expect(secondLoad()).toBe("downgrade-v2");
	});

	it("chooses the ESM branch when dual package graphs converge", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "dual-convergence-ext", version: "1.0.0", type: "module" }),
			"node_modules/dual/package.json": JSON.stringify({
				name: "dual",
				version: "1.0.0",
				exports: { import: "./esm.js", require: "./cjs.js" },
			}),
			"node_modules/dual/esm.js": 'import "./shared.js"; export const mode = "esm";',
			"node_modules/dual/cjs.js": 'if (false) require("./shared.js"); module.exports = { mode: "cjs" };',
			"node_modules/dual/shared.js": "globalThis.__ompDualGraphLoaded = true;",
			"node_modules/dual-consumer/package.json": JSON.stringify({
				name: "dual-consumer",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/dual-consumer/index.js": 'module.exports = require("dual");',
			"index.js": 'import "dual"; import "dual-consumer";',
		});
		const shared = await fs.realpath(path.join(dir, "node_modules/dual/shared.js"));

		const sources = await __collectLegacyPiExtensionSourcesForTests(path.join(dir, "index.js"));

		expect(sources.has(shared)).toBe(true);
	});

	it("rewrites directory and builtin-named package requires through package main", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "directory-require-ext", version: "1.0.0" }),
			"node_modules/directory-package/package.json": JSON.stringify({
				name: "directory-package",
				version: "1.0.0",
				main: "lib/plumbing.js",
			}),
			"node_modules/directory-package/lib/plumbing.js": 'module.exports = "directory-ok";',
			"node_modules/directory-package/configure/request.js": "",
			"node_modules/punycode/package.json": JSON.stringify({
				name: "punycode",
				version: "1.0.0",
				main: "punycode.js",
			}),
			"node_modules/punycode/punycode.js": 'module.exports = "punycode-ok";',
			"index.js": "",
		});
		const importer = path.join(dir, "node_modules/directory-package/configure/request.js");
		const rewritten = await __rewriteLegacyExtensionSourceForTests(
			'const directory = require("../"); const punycode = require("punycode/");',
			importer,
		);
		const directoryEntry = (
			await fs.realpath(path.join(dir, "node_modules/directory-package/lib/plumbing.js"))
		).replaceAll("\\", "/");
		const punycodeEntry = (await fs.realpath(path.join(dir, "node_modules/punycode/punycode.js"))).replaceAll(
			"\\",
			"/",
		);

		expect(rewritten).toContain(`require("${directoryEntry}")`);
		expect(rewritten).toContain(`require("${punycodeEntry}")`);
	});

	it("honors export pattern specificity and package encapsulation", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "exports-contract-ext", version: "1.0.0", type: "module" }),
			"node_modules/pattern-dep/package.json": JSON.stringify({
				name: "pattern-dep",
				version: "1.0.0",
				type: "module",
				exports: { "./*": "./fallback/*.js", "./feature/*": "./features/*.js" },
			}),
			"node_modules/pattern-dep/fallback/feature/x.js": "export const selected = 'fallback';",
			"node_modules/pattern-dep/features/x.js": "export const selected = 'specific';",
			"node_modules/blocked-dep/package.json": JSON.stringify({
				name: "blocked-dep",
				version: "1.0.0",
				main: "./legacy.cjs",
				exports: { ".": { import: "./esm.js" }, "./private": null },
			}),
			"node_modules/blocked-dep/esm.js": "export default {};",
			"node_modules/blocked-dep/legacy.cjs": "module.exports = {};",
			"node_modules/blocked-dep/private.js": "export default {};",
			"index.ts": "",
		});
		const importer = path.join(dir, "index.ts");
		const rewritten = await __rewriteLegacyExtensionSourceForTests(
			[
				'import { selected } from "pattern-dep/feature/x";',
				'import privateValue from "blocked-dep/private";',
				'const privateRequire = require("blocked-dep/private");',
				'const rootRequire = require("blocked-dep");',
			].join("\n"),
			importer,
		);

		const specificUrl = url.pathToFileURL(
			await fs.realpath(path.join(dir, "node_modules/pattern-dep/features/x.js")),
		).href;
		expect(rewritten).toContain(specificUrl);
		expect(rewritten).not.toContain("fallback/feature/x.js");
		expect(rewritten).toContain('from "blocked-dep/private"');
		expect(rewritten).toContain('require("blocked-dep/private")');
		expect(rewritten).toContain('require("blocked-dep")');
	});

	it("rejects package resolutions that escape the package root", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "package-boundary-ext", version: "1.0.0", type: "module" }),
			"node_modules/main-escape/package.json": JSON.stringify({
				name: "main-escape",
				version: "1.0.0",
				main: "../outside/index.js",
			}),
			"node_modules/exports-escape/package.json": JSON.stringify({
				name: "exports-escape",
				version: "1.0.0",
				exports: { "./*": "./../outside/*.js" },
			}),
			"node_modules/subpath-escape/package.json": JSON.stringify({
				name: "subpath-escape",
				version: "1.0.0",
			}),
			"node_modules/native-escape/package.json": JSON.stringify({
				name: "native-escape",
				version: "1.0.0",
			}),
			"node_modules/outside/index.js": "export default {};",
			"node_modules/outside/value.js": "export default {};",
			"node_modules/outside/addon.node": "native fixture",
			"index.ts": "",
			"node_modules/symlink-escape/package.json": JSON.stringify({
				name: "symlink-escape",
				version: "1.0.0",
				exports: { "./value": "./link.js" },
			}),
		});
		await fs.symlink(
			path.join(dir, "node_modules", "outside", "value.js"),
			path.join(dir, "node_modules", "symlink-escape", "link.js"),
		);
		const importer = path.join(dir, "index.ts");
		const rewritten = await __rewriteLegacyExtensionSourceForTests(
			[
				'import mainEscape from "main-escape";',
				'import exportsEscape from "exports-escape/value";',
				'import subpathEscape from "subpath-escape/../outside";',
				'import symlinkEscape from "symlink-escape/value";',
				'const nativeEscape = require("native-escape/../outside/addon.node");',
				"export { exportsEscape, mainEscape, nativeEscape, subpathEscape, symlinkEscape };",
			].join("\n"),
			importer,
		);

		expect(rewritten).toContain('from "main-escape"');
		expect(rewritten).toContain('from "exports-escape/value"');
		expect(rewritten).toContain('from "subpath-escape/../outside"');
		expect(rewritten).toContain('require("native-escape/../outside/addon.node")');
		expect(rewritten).toContain('from "symlink-escape/value"');
	});

	it("pins bare package requires to absolute extension paths", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "bare-require-ext", version: "1.0.0" }),
			"node_modules/@fixture/native-platform/package.json": JSON.stringify({
				name: "@fixture/native-platform",
				version: "1.0.0",
				main: "binding.node",
			}),
			"node_modules/@fixture/native-platform/binding.node": "native fixture",
			"node_modules/plain-dep/package.json": JSON.stringify({
				name: "plain-dep",
				version: "1.0.0",
				main: "index.js",
			}),
			"node_modules/plain-dep/index.js": "module.exports = {};",
			"node_modules/condition-dep/package.json": JSON.stringify({
				name: "condition-dep",
				version: "1.0.0",
				exports: { import: "./esm.js", require: "./cjs.cjs" },
			}),
			"node_modules/condition-dep/esm.js": "export default {};",
			"node_modules/condition-dep/cjs.cjs": "module.exports = {};",
			"index.ts": "",
		});
		const importer = path.join(dir, "index.ts");
		const rewritten = await __rewriteLegacyExtensionSourceForTests(
			[
				'const binding = require("@fixture/native-platform");',
				'const plain = require("plain-dep");',
				'const conditional = require("condition-dep");',
				'import conditionalEquals = require("condition-dep");',
				'const local = require("./local.node");',
				'const member = loader.require("plain-dep");',
				'const importText = `from"plain-dep"`;',
				'const importPattern = /from"typebox"/;',
				'function shadowed(require) { return require("plain-dep"); }',
				"export { binding, conditional, conditionalEquals, importPattern, importText, local, member, plain, shadowed };",
			].join("\n"),
			importer,
		);

		const addon = await fs.realpath(path.join(dir, "node_modules/@fixture/native-platform/binding.node"));
		const plainDep = await fs.realpath(path.join(dir, "node_modules/plain-dep/index.js"));
		const conditionalDep = await fs.realpath(path.join(dir, "node_modules/condition-dep/cjs.cjs"));
		expect(rewritten).toContain(`require("${addon.replaceAll("\\", "/")}")`);
		expect(rewritten).toContain(`require("${plainDep.replaceAll("\\", "/")}")`);
		expect(rewritten).toContain(`require("${conditionalDep.replaceAll("\\", "/")}")`);
		expect(rewritten).toContain(`import conditionalEquals = require("${conditionalDep.replaceAll("\\", "/")}")`);
		expect(rewritten).toContain('require("./local.node")');
		expect(rewritten).toContain('loader.require("plain-dep")');
		expect(rewritten).toContain('`from"plain-dep"`');
		expect(rewritten).toContain('/from"typebox"/');
		expect(rewritten).toContain('function shadowed(require) { return require("plain-dep"); }');
	});

	it("preserves native-addon rewrites inside wrapped CommonJS dependencies", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "native-cjs-consumer", version: "1.0.0", type: "module" }),
			"index.js": [
				'import loader from "native-loader";',
				"export const loadSource = loader.load.toString();",
				"export default function (pi) { void pi; }",
			].join("\n"),
			"node_modules/native-loader/package.json": JSON.stringify({
				name: "native-loader",
				version: "1.0.0",
				main: "index.cjs",
			}),
			"node_modules/native-loader/index.cjs":
				'module.exports = { load: () => require("@fixture/native-platform") };\n',
			"node_modules/native-loader/node_modules/@fixture/native-platform/package.json": JSON.stringify({
				name: "@fixture/native-platform",
				version: "1.0.0",
				main: "binding.node",
			}),
			"node_modules/native-loader/node_modules/@fixture/native-platform/binding.node": "native fixture",
		});

		const mod = await loadLegacyPiModule(path.join(dir, "index.js"));
		const loadSource = Reflect.get(Object(mod), "loadSource");
		const addon = await fs.realpath(
			path.join(dir, "node_modules/native-loader/node_modules/@fixture/native-platform/binding.node"),
		);

		expect(loadSource).toContain(addon.replaceAll("\\", "/"));
	});

	it("remaps legacy pi-ai utils/oauth subpaths to registry OAuth exports", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "legacy-oauth-ext", version: "1.0.0" }),
			"index.ts": [
				'import { registerOAuthProvider } from "@mariozechner/pi-ai/utils/oauth";',
				'import { fetchAnthropicBootstrapIdentity } from "@mariozechner/pi-ai/utils/oauth/anthropic";',
				'export const hasRegisterOAuthProvider = typeof registerOAuthProvider === "function";',
				'export const hasFetchAnthropicBootstrapIdentity = typeof fetchAnthropicBootstrapIdentity === "function";',
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
			hasRegisterOAuthProvider: boolean;
			hasFetchAnthropicBootstrapIdentity: boolean;
		};

		expect(mod.hasRegisterOAuthProvider).toBe(true);
		expect(mod.hasFetchAnthropicBootstrapIdentity).toBe(true);
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
				'import { Effort } from "@earendil-works/pi-ai";',
				'export const hasAi = typeof Effort === "object";',
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
