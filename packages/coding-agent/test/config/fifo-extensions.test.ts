import { describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FifoCase, itRefusesFifo, mod, useFifoSandbox } from "./fifo-harness";

// Files that extensions, hooks, custom commands and tools, prompt templates and
// the `/share` script stand at, which omp reads or imports on its own: a FIFO
// there is never opened. See `fifo-harness.ts` for how each case runs.
const box = useFifoSandbox("@omp-fifo-extensions-");

const q = (value: string): string => JSON.stringify(value);

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

const pluginFile = (name: string): string =>
	path.join(box.home, ".omp", "plugins", "node_modules", "fifo-plugin", name);

/** An installed plugin, `fifo-plugin`, whose manifest declares `entry` under `key`. */
function installPlugin(key: "extensions" | "tools", entry: string): void {
	const root = path.join(box.home, ".omp", "plugins");
	write(path.join(root, "package.json"), JSON.stringify({ dependencies: { "fifo-plugin": "1" } }));
	write(pluginFile("package.json"), JSON.stringify({ name: "fifo-plugin", version: "1", omp: { [key]: [entry] } }));
}

/** The session's extensions, discovered and loaded as a session start does; the child prints the errors it returns. */
function loadExtensions(configured: string[]): string {
	return `import { discoverAndLoadExtensions } from ${mod("coding-agent", "extensibility/extensions/loader.ts")};
	const { errors } = await discoverAndLoadExtensions(${JSON.stringify(configured)}, ${q(box.projectDir)});
	if (errors.length > 0) console.log("error " + errors.map(e => e.error).join("; "));`;
}

/**
 * The extension loads with a regular file at `at`; the FIFO goes back to that
 * name once the load is done, and only then does the extension's lazy import
 * run. Moving a FIFO opens nothing.
 */
function loadThenImportLazily(at: string, regular: string): string {
	return `import * as fs from "node:fs";
	import { discoverAndLoadExtensions } from ${mod("coding-agent", "extensibility/extensions/loader.ts")};
	const at = ${q(at)};
	const aside = ${q(path.join(box.root, "fifo-aside"))};
	fs.renameSync(at, aside);
	fs.writeFileSync(at, ${q(regular)});
	const { errors } = await discoverAndLoadExtensions([], ${q(box.projectDir)});
	if (errors.length > 0) throw new Error(errors.map(e => e.error).join("; "));
	fs.rmSync(at);
	fs.renameSync(aside, at);
	try {
		await Reflect.get(globalThis, "__ompFifoLater")();
	} catch (error) {
		console.log("error " + String(error));
	}`;
}

const cases: FifoCase[] = [
	// An extension's entry, which the import-graph walk would read before Bun imports it.
	{
		name: "~/.omp/plugins/node_modules/<plugin>/<extension>.ts, a plugin's extension entry",
		at: () => pluginFile("ext.ts"),
		setup() {
			installPlugin("extensions", "ext.ts");
		},
		script: () => loadExtensions([]),
		outcome: "reported",
	},
	{
		name: "<file> named with --extension",
		at: () => path.join(box.projectDir, "fifo-ext.ts"),
		script: () => loadExtensions([path.join(box.projectDir, "fifo-ext.ts")]),
		outcome: "reported",
	},
	// Package manifests read while an extension's entries and modules are found.
	{
		name: "<dir>/package.json of a directory named with --extension",
		at: () => path.join(box.projectDir, "dir-ext", "package.json"),
		setup() {
			write(path.join(box.projectDir, "dir-ext", "index.ts"), "export default function () {}\n");
		},
		script: () => loadExtensions([path.join(box.projectDir, "dir-ext")]),
		outcome: "skipped",
	},
	{
		name: "<extension>/package.json, read to tell what kind of module a .js file is",
		at: () => path.join(box.projectDir, "pkg-ext", "package.json"),
		setup() {
			const dir = path.join(box.projectDir, "pkg-ext");
			write(path.join(dir, "index.ts"), 'import { v } from "./lib.js";\nexport default () => v;\n');
			write(path.join(dir, "lib.js"), "export const v = 1;\n");
		},
		script: () => loadExtensions([path.join(box.projectDir, "pkg-ext", "index.ts")]),
		outcome: "skipped",
	},
	{
		name: "<extension>/package.json, read for a #imports specifier",
		at: () => path.join(box.projectDir, "imports-ext", "package.json"),
		setup() {
			const dir = path.join(box.projectDir, "imports-ext");
			write(path.join(dir, "index.ts"), 'import { v } from "#lib";\nexport default () => v;\n');
			write(path.join(dir, "lib.ts"), "export const v = 1;\n");
		},
		script: () => loadExtensions([path.join(box.projectDir, "imports-ext", "index.ts")]),
		outcome: "skipped",
	},
	// Extension modules omp reads itself instead of leaving them to Bun.
	{
		// The walk reads every module of the graph. The loader judges the entry
		// before the walk starts, so the walk is called here directly.
		name: "~/.omp/agent/extensions/<name>/index.ts, read by the import-graph walk",
		at: () => path.join(box.agentDir, "extensions", "walk-ext", "index.ts"),
		script: () =>
			`import { __collectLegacyPiExtensionSourcesForTests as walk } from ${mod("coding-agent", "extensibility/plugins/legacy-pi-compat.ts")};
			try {
				await walk(${q(path.join(box.agentDir, "extensions", "walk-ext", "index.ts"))});
			} catch (error) {
				console.log("error " + String(error));
			}`,
		outcome: "reported",
	},
	{
		name: "<extension>/node_modules/linkedom/commonjs/canvas-shim.cjs, linkedom's canvas fallback",
		at: () => path.join(box.projectDir, "dom-ext", "node_modules", "linkedom", "commonjs", "canvas-shim.cjs"),
		setup() {
			const dir = path.join(box.projectDir, "dom-ext");
			write(
				path.join(dir, "index.ts"),
				'import canvas from "linkedom/commonjs/canvas.cjs";\nexport default () => canvas;\n',
			);
			write(path.join(dir, "node_modules", "linkedom", "package.json"), '{ "name": "linkedom" }');
			write(path.join(dir, "node_modules", "linkedom", "commonjs", "canvas.cjs"), "module.exports = {};\n");
		},
		script: () => loadExtensions([path.join(box.projectDir, "dom-ext", "index.ts")]),
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/extensions/<name>/<module>.ts, imported lazily after the extension loaded",
		at: () => path.join(box.agentDir, "extensions", "lazy-esm", "lazy.ts"),
		setup() {
			write(
				path.join(box.agentDir, "extensions", "lazy-esm", "index.ts"),
				'export default () => {\n\tReflect.set(globalThis, "__ompFifoLater", () => import("./lazy.ts"));\n};\n',
			);
		},
		script: () => loadThenImportLazily(path.join(box.agentDir, "extensions", "lazy-esm", "lazy.ts"), "export {};\n"),
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/extensions/<name>/<module>.cjs, required lazily after the extension loaded",
		at: () => path.join(box.agentDir, "extensions", "lazy-cjs", "lazy.cjs"),
		setup() {
			const dir = path.join(box.agentDir, "extensions", "lazy-cjs");
			write(
				path.join(dir, "index.ts"),
				'import lib from "./lib.cjs";\nexport default () => {\n\tReflect.set(globalThis, "__ompFifoLater", lib.later);\n};\n',
			);
			write(path.join(dir, "lib.cjs"), 'module.exports = { later: () => require("./lazy.cjs") };\n');
		},
		script: () => loadThenImportLazily(path.join(box.agentDir, "extensions", "lazy-cjs", "lazy.cjs"), "1;\n"),
		outcome: "reported",
	},
	// Custom tools, hooks and custom commands.
	{
		name: "~/.omp/plugins/node_modules/<plugin>/<tool>.ts, a plugin's custom tool",
		at: () => pluginFile("tool.ts"),
		setup() {
			installPlugin("tools", "tool.ts");
		},
		script: () =>
			`import { discoverAndLoadCustomTools } from ${mod("coding-agent", "extensibility/custom-tools/loader.ts")};
			const { errors } = await discoverAndLoadCustomTools([], ${q(box.projectDir)}, [], undefined, ${q(box.agentDir)});
			if (errors.length > 0) console.log("error " + errors.map(e => e.error).join("; "));`,
		outcome: "reported",
	},
	{
		name: "<project>/.omp/hooks/pre/<name>.ts, a hook module given to the hooks loader",
		at: () => path.join(box.projectDir, ".omp", "hooks", "pre", "fifo-hook.ts"),
		script: () =>
			`import { discoverAndLoadHooks } from ${mod("coding-agent", "extensibility/hooks/loader.ts")};
			const hook = ${q(path.join(box.projectDir, ".omp", "hooks", "pre", "fifo-hook.ts"))};
			const { errors } = await discoverAndLoadHooks([hook], ${q(box.projectDir)});
			if (errors.length > 0) console.log("error " + errors.map(e => e.error).join("; "));`,
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/commands/<name>/index.ts",
		at: () => path.join(box.agentDir, "commands", "fifo-cmd", "index.ts"),
		script: () =>
			`import { loadCustomCommands } from ${mod("coding-agent", "extensibility/custom-commands/loader.ts")};
			const { errors } = await loadCustomCommands({ cwd: ${q(box.projectDir)}, agentDir: ${q(box.agentDir)} });
			if (errors.length > 0) console.log("error " + errors.map(e => e.error).join("; "));`,
		outcome: "reported",
	},
	// Other files omp reads for extensions.
	{
		name: "<prompt>.md, an additional prompt template path of the legacy resource loader",
		at: () => path.join(box.projectDir, "prompts", "fifo.md"),
		script: () =>
			`import { DefaultResourceLoader } from ${mod("coding-agent", "extensibility/legacy-pi-coding-agent-shim.ts")};
			const loader = new DefaultResourceLoader({
				cwd: ${q(box.projectDir)},
				agentDir: ${q(box.agentDir)},
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalPromptTemplatePaths: [${q(path.join(box.projectDir, "prompts", "fifo.md"))}],
			});
			await loader.reload();
			const { diagnostics } = loader.getPrompts();
			if (diagnostics.length > 0) console.log("error " + diagnostics.map(d => d.message).join("; "));`,
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/tools/<name>.ts, its header read for the extensions inspector",
		at: () => path.join(box.agentDir, "tools", "fifo-tool.ts"),
		script: () =>
			`import { toolFileHeaderDescription } from ${mod("coding-agent", "modes/components/extensions/inspector-runtime.ts")};
			toolFileHeaderDescription(${q(path.join(box.agentDir, "tools", "fifo-tool.ts"))});`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/share.ts, the /share script",
		at: () => path.join(box.agentDir, "share.ts"),
		script: () =>
			`import { loadCustomShare } from ${mod("coding-agent", "export/custom-share.ts")};
			try {
				await loadCustomShare();
			} catch (error) {
				console.log("error " + String(error));
			}`,
		outcome: "reported",
	},
];

describe.skipIf(process.platform === "win32")("a FIFO at an extension, hook, command or tool is never opened", () => {
	for (const c of cases) itRefusesFifo(box, c);
});
