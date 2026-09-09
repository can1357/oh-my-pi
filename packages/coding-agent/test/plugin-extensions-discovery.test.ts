import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getAgentDir, getPluginsDir, removeSyncWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const currentPiCodingAgentPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
const currentPiExtensionsPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent/extensibility/extensions", import.meta.dir);

describe("plugin extension discovery", () => {
	let projectDir: TempDir;
	let tempHome = "";
	const originalAgentDir = getAgentDir();
	const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const originalXdg = new Map<string, string | undefined>();

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-plugin-ext-");
		// Redirect the whole config root to an isolated temp home so plugin discovery
		// resolves into `<tempHome>/.omp/plugins` on every platform. Two things are needed:
		//  - mock os.homedir() so configRoot = `<tempHome>/.omp` (the previous
		//    XDG_DATA_HOME redirect was a no-op on Windows, where these tests then wrote
		//    into and rm'd the developer's real `~/.omp/plugins`);
		//  - clear the XDG_* vars, because on Linux/macOS the resolver prefers
		//    `$XDG_DATA_HOME/omp` over the home config root when that dir exists, so an
		//    XDG-migrated environment would otherwise still resolve the real plugins dir.
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-home-"));
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));

		const pluginsDir = getPluginsDir();
		// Safety gate: never write fixtures outside the temp home. This is the exact
		// failure mode being fixed — a resolver/mock regression that resolves to the real
		// ~/.omp must fail loudly here instead of clobbering the developer's plugins.
		if (!pluginsDir.startsWith(tempHome + path.sep)) {
			throw new Error(`plugin isolation failed: getPluginsDir() resolved outside the temp home: ${pluginsDir}`);
		}
		const pluginDir = path.join(pluginsDir, "node_modules", "@demo", "plugin");
		fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"@demo/plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "@demo/plugin",
				version: "1.0.0",
				omp: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "dist", "extension.ts"),
			`
				export default function(pi) {
					pi.registerCommand("plugin-ext", { handler: async () => {} });
				}
			`,
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		spyOn(os, "homedir").mockRestore();
		for (const [key, value] of originalXdg) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		originalXdg.clear();
		setAgentDir(originalAgentDir);
		removeSyncWithRetries(tempHome);
	});

	it("loads installed plugin extensions declared in package.json", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path.endsWith(path.join("dist", "extension.ts")));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("plugin-ext")).toBe(true);
	});

	it("loads installed legacy Pi plugin extensions from Windows drive-letter paths", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "legacy-pi-plugin");
		const extensionPath = path.join(pluginDir, "dist", "extension.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"legacy-pi-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-pi-plugin",
				version: "1.0.0",
				pi: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import * as nodePath from "path";',
				'if (false) import("./optional-missing.js");',
				'import { isToolCallEventType as legacyRoot } from "@mariozechner/pi-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@mariozechner/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentPiCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				'if (typeof nodePath.join !== "function") throw new Error("node builtin import did not resolve");',
				"",
				"export default function(pi) {",
				"\tconst { Type } = pi.typebox;",
				"\tpi.registerTool({",
				'\t\tname: "legacy-pi-ext",',
				'\t\tdescription: "Legacy Pi extension smoke test",',
				"\t\tparameters: Type.Object({}),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"\t});",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		if (process.platform === "win32") {
			expect(extensionPath).toMatch(/^[A-Za-z]:\\/);
		}
		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.tools.has("legacy-pi-ext")).toBe(true);
	});

	it("loads installed legacy Pi plugin extensions that use package imports", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "package-import-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "src", "feature"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"package-import-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "package-import-plugin",
				version: "1.0.0",
				imports: {
					"#src/*": "./src/*",
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import { commandName } from "#src/feature/command";',
				"",
				"export default function(pi) {",
				"\tpi.registerCommand(commandName, { handler: async () => {} });",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(pluginDir, "src", "feature", "command.ts"),
			[
				'import { isToolCallEventType as legacyExtensions } from "@earendil-works/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				'export const commandName = "package-import-ext";',
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("package-import-ext")).toBe(true);
	});

	it("honors package import conditional object order", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "conditional-import-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "node"), { recursive: true });
		fs.mkdirSync(path.join(pluginDir, "import"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"conditional-import-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "conditional-import-plugin",
				version: "1.0.0",
				imports: {
					"#src/*": {
						node: "./node/*",
						import: "./import/*",
					},
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			extensionPath,
			[
				'import { commandName } from "#src/command";',
				"",
				"export default function(pi) {",
				"\tpi.registerCommand(commandName, { handler: async () => {} });",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(pluginDir, "node", "command.ts"),
			'export const commandName = "node-conditional-ext";',
		);
		fs.writeFileSync(
			path.join(pluginDir, "import", "command.ts"),
			'export const commandName = "import-conditional-ext";',
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("node-conditional-ext")).toBe(true);
		expect(extension?.commands.has("import-conditional-ext")).toBe(false);
	});

	it("leaves package import aliases that point at non-source files for Bun's native loaders", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "json-import-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"json-import-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "json-import-plugin",
				version: "1.0.0",
				imports: {
					"#schema": "./src/schema.json",
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.writeFileSync(path.join(pluginDir, "src", "schema.json"), JSON.stringify({ commandName: "json-schema-ext" }));
		fs.writeFileSync(
			extensionPath,
			[
				'import schema from "#schema" with { type: "json" };',
				"",
				"export default function(pi) {",
				"\tpi.registerCommand(schema.commandName, { handler: async () => {} });",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("json-schema-ext")).toBe(true);
	});

	it("preserves exact null package import exclusions ahead of wildcard fallbacks", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "null-exact-import-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"null-exact-import-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "null-exact-import-plugin",
				version: "1.0.0",
				imports: {
					"#src/internal": null,
					"#src/*": "./src/*",
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.writeFileSync(path.join(pluginDir, "src", "internal.ts"), 'export const commandName = "null-exact-ext";');
		fs.writeFileSync(
			extensionPath,
			[
				'import { commandName } from "#src/internal";',
				"",
				"export default function(pi) {",
				"\tpi.registerCommand(commandName, { handler: async () => {} });",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path === extensionPath);

		expect(pluginError?.error).toContain("#src/internal");
		expect(extension).toBeUndefined();
	});

	it("preserves active null conditional package import exclusions", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "null-conditional-import-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"null-conditional-import-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "null-conditional-import-plugin",
				version: "1.0.0",
				imports: {
					"#blocked": {
						node: null,
						default: "./src/blocked.ts",
					},
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.writeFileSync(path.join(pluginDir, "src", "blocked.ts"), 'export const commandName = "null-conditional-ext";');
		fs.writeFileSync(
			extensionPath,
			[
				'import { commandName } from "#blocked";',
				"",
				"export default function(pi) {",
				"\tpi.registerCommand(commandName, { handler: async () => {} });",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path === extensionPath);

		expect(pluginError?.error).toContain("#blocked");
		expect(extension).toBeUndefined();
	});

	it("rewrites side-effect imports of package-import aliases and legacy Pi scopes", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "side-effect-plugin");
		const extensionPath = path.join(pluginDir, "src", "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"side-effect-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "side-effect-plugin",
				version: "1.0.0",
				imports: {
					"#src/*": "./src/*",
				},
				pi: {
					extensions: ["./src/index.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				// Side-effect imports — no `from`, no dynamic `import()`. The
				// regex matchers must walk and rewrite both shapes so the legacy
				// `@earendil-works` import inside `register.ts` resolves to the
				// host `@oh-my-pi` package.
				'import "#src/register";',
				'import "./marker";',
				"",
				"declare global { var __sideEffectMarker: { ok: boolean; runs: number } | undefined; }",
				"",
				"export default function(pi) {",
				'\tif (!globalThis.__sideEffectMarker?.ok) throw new Error("register side-effect did not run");',
				'\tpi.registerCommand("side-effect-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(pluginDir, "src", "register.ts"),
			[
				'import { isToolCallEventType as legacyExtensions } from "@earendil-works/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy side-effect import did not remap");',
				"(globalThis as { __sideEffectMarker?: { ok: boolean; runs: number } }).__sideEffectMarker = { ok: true, runs: 1 };",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(pluginDir, "src", "marker.ts"),
			[
				"const slot = (globalThis as { __sideEffectMarker?: { ok: boolean; runs: number } }).__sideEffectMarker;",
				'if (!slot) throw new Error("relative side-effect import did not run before sibling");',
				"slot.runs += 1;",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("side-effect-ext")).toBe(true);
		expect((globalThis as { __sideEffectMarker?: { ok: boolean; runs: number } }).__sideEffectMarker).toEqual({
			ok: true,
			runs: 2,
		});
		delete (globalThis as { __sideEffectMarker?: unknown }).__sideEffectMarker;
	});

	it("loads installed plugin extensions whose manifest entry points at a directory with index.ts", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "dir-entry-plugin");
		const extensionDir = path.join(pluginDir, ".pi", "extensions", "dir-entry");
		const extensionPath = path.join(extensionDir, "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"dir-entry-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "dir-entry-plugin",
				version: "1.0.0",
				pi: {
					// Directory entry — loader must resolve to the directory's index file.
					extensions: [".pi/extensions/dir-entry"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.registerCommand("dir-entry-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path.includes(path.join("dir-entry-plugin", ".pi")));

		expect(pluginError).toBeUndefined();
		expect(extension).toBeDefined();
		expect(extension?.commands.has("dir-entry-ext")).toBe(true);
	});

	it("loads installed plugin extensions whose manifest entry points at a directory of sub-extensions", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "subdir-entry-plugin");
		const extensionDir = path.join(pluginDir, "extensions", "feature");
		const extensionPath = path.join(extensionDir, "index.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"subdir-entry-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "subdir-entry-plugin",
				version: "1.0.0",
				pi: {
					// Directory entry with no direct index — the loader must scan one
					// level and pick up `extensions/<name>/index.ts` (pi package layout).
					extensions: ["./extensions"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.registerCommand("subdir-entry-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path.includes("subdir-entry-plugin"));

		expect(pluginError).toBeUndefined();
		expect(extension).toBeDefined();
		expect(extension?.commands.has("subdir-entry-ext")).toBe(true);
	});

	it("resolves a sub-extension directory via its own package.json manifest over a decoy index", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "nested-manifest-plugin");
		const featureDir = path.join(pluginDir, "extensions", "feature");
		const realEntry = path.join(featureDir, "dist", "real-ext.ts");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(path.dirname(realEntry), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"nested-manifest-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "nested-manifest-plugin",
				version: "1.0.0",
				pi: { extensions: ["./extensions"] },
			}),
		);
		// Child package declares its real entry via its own manifest; the index.ts
		// is a decoy that must NOT win (manifest takes precedence, like the -e scanner).
		fs.writeFileSync(
			path.join(featureDir, "package.json"),
			JSON.stringify({ name: "feature-ext", version: "1.0.0", omp: { extensions: ["./dist/real-ext.ts"] } }),
		);
		fs.writeFileSync(
			realEntry,
			[
				"export default function(pi) {",
				'\tpi.registerCommand("nested-manifest-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(featureDir, "index.ts"),
			[
				"export default function(pi) {",
				'\tpi.registerCommand("decoy-index-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === realEntry);
		const decoy = result.extensions.find(ext => ext.commands.has("decoy-index-ext"));
		const pluginError = result.errors.find(err => err.path.includes("nested-manifest-plugin"));

		expect(pluginError).toBeUndefined();
		expect(extension).toBeDefined();
		expect(extension?.commands.has("nested-manifest-ext")).toBe(true);
		expect(decoy).toBeUndefined();
	});

	it("does not fall back to a decoy index when a sub-extension manifest declares a missing entry", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "missing-decl-plugin");
		const featureDir = path.join(pluginDir, "extensions", "feature");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(featureDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"missing-decl-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "missing-decl-plugin",
				version: "1.0.0",
				pi: { extensions: ["./extensions"] },
			}),
		);
		// The child manifest is authoritative: it declares ./dist/real-ext.ts, which does
		// not exist (e.g. unbuilt). The leftover index.ts must NOT be loaded as a fallback.
		fs.writeFileSync(
			path.join(featureDir, "package.json"),
			JSON.stringify({ name: "feature-ext", version: "1.0.0", omp: { extensions: ["./dist/real-ext.ts"] } }),
		);
		fs.writeFileSync(
			path.join(featureDir, "index.ts"),
			[
				"export default function(pi) {",
				'\tpi.registerCommand("decoy-index-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const decoy = result.extensions.find(ext => ext.commands.has("decoy-index-ext"));

		expect(decoy).toBeUndefined();
	});

	it("skips .d.ts declaration files when scanning a flat extensions directory", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "dts-plugin");
		const extensionsDir = path.join(pluginDir, "extensions");
		const moduleEntry = path.join(extensionsDir, "ext.js");
		removeSyncWithRetries(path.join(pluginsDir, "node_modules"));
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"dts-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "dts-plugin",
				version: "1.0.0",
				omp: { extensions: ["./extensions"] },
			}),
		);
		fs.writeFileSync(
			moduleEntry,
			["export default function(pi) {", '\tpi.registerCommand("dts-ext", { handler: async () => {} });', "}"].join(
				"\n",
			),
		);
		// A sibling declaration file must be ignored — importing it would fail.
		fs.writeFileSync(path.join(extensionsDir, "ext.d.ts"), "export default function (pi: unknown): void;\n");

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === moduleEntry);
		const declaration = result.extensions.find(ext => ext.path.endsWith("ext.d.ts"));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("dts-ext")).toBe(true);
		expect(declaration).toBeUndefined();
	});
});
