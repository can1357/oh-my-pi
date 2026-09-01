import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { type ExtensionModule, extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getCapability, initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { filterUserScoped } from "./utils/filter-user-extensions";

describe("extensions discovery", () => {
	let tempDir: TempDir;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-ext-test-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		resetSettingsForTest();
	});
	afterEach(() => {
		resetSettingsForTest();
		tempDir.removeSync();
	});

	const discoverForTest = async (configuredPaths: string[] = [], ambient = false) => {
		const paths = ambient ? configuredPaths : [extensionsDir, ...configuredPaths];
		const result = await discoverAndLoadExtensions(paths, tempDir.path(), undefined, undefined, { ambient });
		return {
			...result,
			extensions: filterUserScoped(result.extensions, [tempDir.path(), ...configuredPaths]),
			errors: filterUserScoped(result.errors, [tempDir.path(), ...configuredPaths]),
		};
	};

	const extensionCode = `
		export default function(pi) {
			pi.registerCommand("test", { handler: async () => {} });
		}
	`;

	const extensionCodeWithTool = (toolName: string) => `
		export default function(pi) {
			const { Type } = pi.typebox;
			pi.registerTool({
				name: "${toolName}",
				label: "${toolName}",
				description: "Test tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});
		}
	`;

	it("discovers direct .ts files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.ts"), extensionCode);
		fs.writeFileSync(path.join(extensionsDir, "bar.ts"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(result.extensions.map(e => path.basename(e.path)).sort()).toEqual(["bar.ts", "foo.ts"]);
	});

	it("discovers direct .js files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.js"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(path.basename(result.extensions[0].path)).toBe("foo.js");
	});

	it("discovers subdirectory with index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-extension");
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers subdirectory with index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.js");
	});

	it("prefers index.ts over index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers subdirectory with package.json pi field", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		const srcDir = path.join(subdir, "src");
		fs.mkdirSync(subdir);
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "main.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./src/main.ts"],
				},
			}),
		);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("src");
		expect(result.extensions[0].path).toContain("main.ts");
	});

	it("SDK explicit-only discovery loads package hooks without ambient package hooks", async () => {
		const ambientPackage = path.join(tempDir.path(), "ambient-package");
		fs.mkdirSync(path.join(ambientPackage, "hooks", "pre"), { recursive: true });
		fs.writeFileSync(path.join(ambientPackage, "hooks", "pre", "ambient.ts"), extensionCodeWithTool("ambient-tool"));
		fs.writeFileSync(
			path.join(getProjectAgentDir(tempDir.path()), "settings.json"),
			JSON.stringify({ extensions: [ambientPackage] }),
		);

		const packageDir = path.join(tempDir.path(), "explicit-package");
		const sourceDir = path.join(packageDir, "src");
		const hookDir = path.join(packageDir, "hooks", "pre");
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.mkdirSync(hookDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "main.ts"), extensionCodeWithTool("explicit-tool"));
		fs.writeFileSync(path.join(hookDir, "read.ts"), extensionCodeWithTool("explicit-hook-tool"));
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({
				name: "explicit-package",
				omp: {
					extensions: ["./src/main.ts"],
				},
			}),
		);

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { extensions: [ambientPackage] },
		});
		const paths = await discoverSessionExtensionPaths(
			{ disableExtensionDiscovery: true, additionalExtensionPaths: [packageDir] },
			tempDir.path(),
			settings,
		);
		const result = await loadExtensions(paths, tempDir.path());

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map(extension => extension.path)).toEqual([
			path.join(hookDir, "read.ts"),
			path.join(sourceDir, "main.ts"),
		]);
		expect(result.extensions.flatMap(extension => [...extension.tools.keys()])).toEqual([
			"explicit-hook-tool",
			"explicit-tool",
		]);
	});

	it("explicit-only discovery ignores unreadable optional hook directories", async () => {
		const packageDir = path.join(tempDir.path(), "explicit-package");
		const sourceDir = path.join(packageDir, "src");
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "main.ts"), extensionCode);
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({
				name: "explicit-package",
				omp: {
					extensions: ["./src/main.ts"],
				},
			}),
		);

		const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readdirSpy = vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(permissionError);
		try {
			await expect(
				discoverExtensionPaths([packageDir], tempDir.path(), undefined, { ambient: false }),
			).resolves.toEqual([path.join(sourceDir, "main.ts")]);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("discovers a symlinked extension package directory", async () => {
		const packageDir = path.join(tempDir.path(), "linked-package");
		const sourceDir = path.join(packageDir, "src");
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "main.ts"), extensionCode);
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({
				name: "linked-package",
				pi: {
					extensions: ["./src/main.ts"],
				},
			}),
		);
		fs.symlinkSync(packageDir, path.join(extensionsDir, "linked-package"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain(path.join("linked-package", "src", "main.ts"));
	});

	it("discovers index.ts in a symlinked extension directory", async () => {
		const packageDir = path.join(tempDir.path(), "linked-index-ts");
		fs.mkdirSync(packageDir);
		fs.writeFileSync(path.join(packageDir, "index.ts"), extensionCode);
		fs.symlinkSync(packageDir, path.join(extensionsDir, "linked-index-ts"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain(path.join("linked-index-ts", "index.ts"));
	});

	it("discovers index.js in a symlinked extension directory", async () => {
		const packageDir = path.join(tempDir.path(), "linked-index-js");
		fs.mkdirSync(packageDir);
		fs.writeFileSync(path.join(packageDir, "index.js"), extensionCode);
		fs.symlinkSync(packageDir, path.join(extensionsDir, "linked-index-js"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain(path.join("linked-index-js", "index.js"));
	});

	it("package.json can declare multiple extensions", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "ext1.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "ext2.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./ext1.ts", "./ext2.ts"],
				},
			}),
		);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
	});

	it("package.json with pi field takes precedence over index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCodeWithTool("from-index"));
		fs.writeFileSync(path.join(subdir, "custom.ts"), extensionCodeWithTool("from-custom"));
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				pi: {
					extensions: ["./custom.ts"],
				},
			}),
		);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("custom.ts");
		// Verify the right tool was registered
		expect(result.extensions[0].tools.has("from-custom")).toBe(true);
		expect(result.extensions[0].tools.has("from-index")).toBe(false);
	});

	it("ignores package.json without pi field, falls back to index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				version: "1.0.0",
			}),
		);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("ignores subdirectory without index or package.json", async () => {
		const subdir = path.join(extensionsDir, "not-an-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "helper.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir, "utils.ts"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("does not recurse beyond one level", async () => {
		const subdir = path.join(extensionsDir, "container");
		const nested = path.join(subdir, "nested");
		fs.mkdirSync(subdir);
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, "index.ts"), extensionCode);
		// No index.ts or package.json in container/

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("handles mixed direct files and subdirectories", async () => {
		// Direct file
		fs.writeFileSync(path.join(extensionsDir, "direct.ts"), extensionCode);

		// Subdirectory with index
		const subdir1 = path.join(extensionsDir, "with-index");
		fs.mkdirSync(subdir1);
		fs.writeFileSync(path.join(subdir1, "index.ts"), extensionCode);

		// Subdirectory with package.json
		const subdir2 = path.join(extensionsDir, "with-manifest");
		fs.mkdirSync(subdir2);
		fs.writeFileSync(path.join(subdir2, "entry.ts"), extensionCode);
		fs.writeFileSync(path.join(subdir2, "package.json"), JSON.stringify({ pi: { extensions: ["./entry.ts"] } }));

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(3);
	});

	it("discovers a symlinked extension directory with index.ts", async () => {
		// A single extension dir shared across profiles via a symlink: the real
		// directory lives outside extensions/ and is linked into it. Native glob
		// never descends into the symlink, so this exercises the symlink fallback.
		const realDir = path.join(tempDir.path(), "external", "shared-ext");
		fs.mkdirSync(realDir, { recursive: true });
		fs.writeFileSync(path.join(realDir, "index.ts"), extensionCode);
		fs.symlinkSync(realDir, path.join(extensionsDir, "linked-ext"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("linked-ext");
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers a symlinked extension directory with a package.json manifest", async () => {
		// Mirrors the real-world shape: a packaged extension (package.json + index.ts)
		// symlinked into a profile's extensions/ dir.
		const realDir = path.join(tempDir.path(), "external", "ctk");
		fs.mkdirSync(realDir, { recursive: true });
		fs.writeFileSync(path.join(realDir, "index.ts"), extensionCodeWithTool("ctk-tool"));
		fs.writeFileSync(
			path.join(realDir, "package.json"),
			JSON.stringify({ name: "ctk", omp: { extensions: ["./index.ts"] } }),
		);
		fs.symlinkSync(realDir, path.join(extensionsDir, "ctk"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		// Manifest declares index.ts; it must be discovered exactly once (no double
		// from the synthesized index.ts match colliding with the manifest entry).
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
		expect(result.extensions[0].tools.has("ctk-tool")).toBe(true);
	});

	it("discovers a symlinked extension file", async () => {
		// Symlinked *files* resolve through the native file-type filter; guards that
		// the directory fallback does not regress the file case.
		const realFile = path.join(tempDir.path(), "external", "shared.ts");
		fs.mkdirSync(path.dirname(realFile), { recursive: true });
		fs.writeFileSync(realFile, extensionCode);
		fs.symlinkSync(realFile, path.join(extensionsDir, "linked.ts"), "file");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("linked.ts");
	});

	it("does not crash on a dangling symlinked extension directory", async () => {
		// A profile symlink pointing at a since-deleted shared extension. The fallback
		// reads the (missing) target, gets [], and must yield no extension and no
		// error rather than throwing.
		fs.symlinkSync(path.join(tempDir.path(), "external", "gone"), path.join(extensionsDir, "broken"), "dir");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("discovers a symlinked extension directory whose name ends in .ts", async () => {
		// Odd but legal: a *.ts-named symlink that targets a directory. The native
		// file-type filter rejects it as a direct file (target is a dir), so it must
		// resolve exactly once via the synthesized subdir index — never double-counted
		// as both a direct file and a subdir entry.
		const realDir = path.join(tempDir.path(), "external", "weird");
		fs.mkdirSync(realDir, { recursive: true });
		fs.writeFileSync(path.join(realDir, "index.ts"), extensionCode);
		fs.symlinkSync(realDir, path.join(extensionsDir, "weird.ts"), "dir");

		const result = await discoverForTest([], true);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("weird.ts");
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("skips non-existent paths declared in package.json", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "exists.ts"), extensionCode);
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				pi: {
					extensions: ["./exists.ts", "./missing.ts"],
				},
			}),
		);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("exists.ts");
	});

	it("loads extensions and registers commands", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-command.ts"), extensionCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("test")).toBe(true);
	});

	it("loads extensions and registers tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-tool.ts"), extensionCodeWithTool("my-tool"));

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("my-tool")).toBe(true);
	});

	it("reports errors for invalid extension code", async () => {
		fs.writeFileSync(path.join(extensionsDir, "invalid.ts"), "this is not valid typescript export");

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toContain("invalid.ts");
		expect(result.extensions).toHaveLength(0);
	});

	it("handles explicitly configured paths", async () => {
		const customPath = path.join(tempDir.path(), "custom-location", "my-ext.ts");
		fs.mkdirSync(path.dirname(customPath), { recursive: true });
		fs.writeFileSync(customPath, extensionCode);

		const result = await discoverForTest([customPath]);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-ext.ts");
	});

	it("resolves 3rd party npm dependencies (chalk)", async () => {
		// Load the real chalk-logger extension from examples
		const chalkLoggerPath = path.resolve(import.meta.dirname, "..", "examples", "extensions", "chalk-logger.ts");

		const result = await discoverForTest([chalkLoggerPath]);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("chalk-logger.ts");
		// The extension registers event handlers, not commands/tools
		expect(result.extensions[0].handlers.size).toBeGreaterThan(0);
	});

	it("resolves dependencies from extension's own node_modules", async () => {
		const extDir = path.join(tempDir.path(), "with-deps");
		const extNodeModules = path.join(extDir, "node_modules", "local-duration-parser");
		fs.mkdirSync(extNodeModules, { recursive: true });

		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({
				name: "pi-extension-with-deps",
				version: "1.0.0",
				type: "module",
				omp: { extensions: ["./index.ts"] },
			}),
		);

		fs.writeFileSync(
			path.join(extDir, "index.ts"),
			`			import parseDuration from "local-duration-parser";

				export default function (pi) {
					const { Type } = pi.typebox;
					pi.registerTool({
						name: "parse_duration",
						label: "Parse Duration",
						description: "Parse duration strings",
						parameters: Type.Object({ duration: Type.String() }),
						execute: async (_toolCallId, params) => ({
							content: [{ type: "text", text: String(parseDuration(params.duration)) }],
							details: {},
						}),
					});
				}
			`,
		);

		fs.writeFileSync(
			path.join(extNodeModules, "package.json"),
			JSON.stringify({
				name: "local-duration-parser",
				version: "1.0.0",
				type: "module",
				exports: "./index.js",
			}),
		);
		fs.writeFileSync(
			path.join(extNodeModules, "index.js"),
			"export default function parseDuration(input) { return input.length; }",
		);

		const result = await discoverForTest([extDir]);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("with-deps");
		expect(result.extensions[0].tools.has("parse_duration")).toBe(true);
	});

	it("registers message renderers", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerMessageRenderer("my-custom-type", (message, options, theme) => {
					return null; // Use default rendering
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-renderer.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].messageRenderers.has("my-custom-type")).toBe(true);
	});

	it("reports error when extension throws during initialization", async () => {
		const extCode = `
			export default function(pi) {
				throw new Error("Initialization failed!");
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("Initialization failed!");
		expect(result.extensions).toHaveLength(0);
	});

	it("reports error when extension has no default export", async () => {
		const extCode = `
			export function notDefault(pi) {
				pi.registerCommand("test", { handler: async () => {} });
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "no-default.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("does not export a valid factory function");
		expect(result.extensions).toHaveLength(0);
	});

	it("allows multiple extensions to register different tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), extensionCodeWithTool("tool-a"));
		fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), extensionCodeWithTool("tool-b"));

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);

		const allTools = new Set<string>();
		for (const ext of result.extensions) {
			for (const name of ext.tools.keys()) {
				allTools.add(name);
			}
		}
		expect(allTools.has("tool-a")).toBe(true);
		expect(allTools.has("tool-b")).toBe(true);
	});

	it("loads extension with event handlers", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("agent_start", async () => {});
				pi.on("tool_call", async (event) => undefined);
				pi.on("agent_end", async () => {});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-handlers.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].handlers.has("agent_start")).toBe(true);
		expect(result.extensions[0].handlers.has("tool_call")).toBe(true);
		expect(result.extensions[0].handlers.has("agent_end")).toBe(true);
	});

	it("loads hookCapability JS factories as extension handlers", async () => {
		const hookDir = path.join(getProjectAgentDir(tempDir.path()), "hooks", "pre");
		fs.mkdirSync(hookDir, { recursive: true });
		const hookPath = path.join(hookDir, "guard-test.ts");
		fs.writeFileSync(
			hookPath,
			`
				export default function(pi) {
					pi.on("tool_call", async () => ({ block: true, reason: "blocked by hook" }));
				}
			`,
		);

		const result = await discoverForTest([], true);
		const loadedHook = result.extensions.find(extension => extension.path === hookPath);

		expect(result.errors).toHaveLength(0);
		expect(loadedHook?.handlers.has("tool_call")).toBe(true);
	});

	it("can exclude ambient hooks without disabling native provider extensions", async () => {
		const hookDir = path.join(getProjectAgentDir(tempDir.path()), "hooks", "pre");
		fs.mkdirSync(hookDir, { recursive: true });
		const hookPath = path.join(hookDir, "models-poison.ts");
		fs.writeFileSync(
			hookPath,
			`export default function(pi) {
				pi.on("tool_call", async () => ({ block: true, reason: "blocked by hook" }));
			}`,
		);
		const nativeExtensionPath = path.join(extensionsDir, "provider.ts");
		fs.writeFileSync(nativeExtensionPath, extensionCode);

		const paths = await discoverExtensionPaths([], tempDir.path(), undefined, {
			ambient: true,
			includeAmbientHooks: false,
		});

		expect(paths).toContain(nativeExtensionPath);
		expect(paths).not.toContain(hookPath);
	});

	it("keeps discovered hooks separate from disabled extension-module ids", async () => {
		const extensionPath = path.join(extensionsDir, "guard.ts");
		fs.writeFileSync(extensionPath, extensionCode);

		const hookDir = path.join(getProjectAgentDir(tempDir.path()), "hooks", "pre");
		fs.mkdirSync(hookDir, { recursive: true });
		const hookPath = path.join(hookDir, "guard.ts");
		fs.writeFileSync(
			hookPath,
			`
				export default function(pi) {
					pi.on("tool_call", async () => ({ block: true, reason: "blocked by hook" }));
				}
			`,
		);

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { disabledExtensions: ["extension-module:guard"] },
		});
		initializeWithSettings(settings);

		const result = await discoverForTest([], true);
		const loadedHook = result.extensions.find(extension => extension.path === hookPath);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.find(extension => extension.path === extensionPath)).toBeUndefined();
		expect(loadedHook?.handlers.has("tool_call")).toBe(true);
	});

	it("loads extension with shortcuts", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerShortcut("ctrl+t", {
					description: "Test shortcut",
					handler: async (ctx) => {},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-shortcut.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].shortcuts.has("ctrl+t")).toBe(true);
	});

	it("loads extension with flags", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerFlag("--my-flag", {
					description: "My custom flag",
					handler: async (value) => {},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

		const result = await discoverForTest();

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].flags.has("--my-flag")).toBe(true);
	});

	it("loadExtensions only loads explicit paths without discovery", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCodeWithTool("discovered"));

		// Create explicit extension outside discovery path
		const explicitPath = path.join(tempDir.path(), "explicit.ts");
		fs.writeFileSync(explicitPath, extensionCodeWithTool("explicit"));

		// Use loadExtensions directly to skip discovery
		const result = await loadExtensions([explicitPath], tempDir.path());

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("explicit")).toBe(true);
		expect(result.extensions[0].tools.has("discovered")).toBe(false);
	});

	it("loadExtensions with no paths loads nothing", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCode);

		// Use loadExtensions directly with empty paths
		const result = await loadExtensions([], tempDir.path());

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});
	it("discoverExtensionPaths only invokes the native extension-module provider (#4198)", async () => {
		// The extension-module capability has multiple providers
		// (native, claude, codex, gemini, opencode), but discoverExtensionPaths
		// only surfaces native-provider paths. Regression: pre-fix it still
		// invoked every provider's load() and then dropped foreign items,
		// running four unused directory walks per startup (worst on Windows).
		const capability = getCapability<ExtensionModule>(extensionModuleCapability.id);
		expect(capability, "extension-modules capability must be registered").toBeDefined();

		const providers = capability?.providers ?? [];
		const foreignIds = providers.map(p => p.id).filter(id => id !== "native");
		// Guard the invariant this test is defending — without foreign providers
		// the test would trivially pass and hide a future regression.
		expect(foreignIds.length).toBeGreaterThan(0);

		const spies = providers.map(provider => vi.spyOn(provider, "load"));
		try {
			await discoverExtensionPaths([], tempDir.path());

			const callsById = new Map(providers.map((provider, i) => [provider.id, spies[i].mock.calls.length]));
			expect(callsById.get("native")).toBe(1);
			for (const id of foreignIds) {
				expect(callsById.get(id), `foreign provider ${id} must not be walked`).toBe(0);
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
