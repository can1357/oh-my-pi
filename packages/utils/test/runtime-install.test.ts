import { afterEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "../src/fs-error";
import {
	ensureRuntimeInstalled,
	installRuntimeModuleResolver,
	resolveRuntimeModule,
	splitBareSpecifier,
	writeRuntimeManifest,
} from "../src/runtime-install";

// Contract under test: runtime-installed packages (fastembed, Transformers.js
// graphs) load inside compiled binaries through resolveRuntimeModule, which
// must honor `exports` (CommonJS conditions), then `main` (including `.node`
// targets without an extension probe match), then `index.js` — the shapes the
// stock compiled-binary resolver gets wrong (Bun #1763).

const tempDirs: string[] = [];
const resolverUninstalls: Array<() => void> = [];

afterEach(async () => {
	// Restore the process-wide module resolver first: a leaked patch breaks
	// `createRequire` relative requires for every later test file (Bun invokes
	// a JS `_resolveFilename` override with `parent === undefined`).
	for (const uninstall of resolverUninstalls.splice(0)) uninstall();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

interface ResolveFilenameModule {
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
}

async function makeNodeModules(packages: Record<string, { manifest: Record<string, unknown>; files: string[] }>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-install-"));
	tempDirs.push(root);
	const nodeModules = path.join(root, "node_modules");
	for (const name in packages) {
		const pkg = packages[name];
		const pkgDir = path.join(nodeModules, ...name.split("/"));
		await Bun.write(path.join(pkgDir, "package.json"), JSON.stringify({ name, ...pkg.manifest }));
		for (const file of pkg.files) {
			await Bun.write(path.join(pkgDir, file), "");
		}
	}
	return nodeModules;
}

describe("splitBareSpecifier", () => {
	test("splits scoped and unscoped specifiers with subpaths", () => {
		expect(splitBareSpecifier("fastembed")).toEqual({ packageName: "fastembed", subpath: undefined });
		expect(splitBareSpecifier("tar/lib/extract")).toEqual({ packageName: "tar", subpath: "lib/extract" });
		expect(splitBareSpecifier("@anush008/tokenizers")).toEqual({
			packageName: "@anush008/tokenizers",
			subpath: undefined,
		});
		expect(splitBareSpecifier("@huggingface/transformers/types")).toEqual({
			packageName: "@huggingface/transformers",
			subpath: "types",
		});
	});
});

describe("resolveRuntimeModule", () => {
	test("resolves conditional exports preferring require over import", async () => {
		const nodeModules = await makeNodeModules({
			fastembed: {
				manifest: {
					exports: {
						".": {
							import: { default: "./lib/esm/index.js" },
							require: { default: "./lib/cjs/index.js" },
						},
					},
					main: "./lib/cjs/index.js",
				},
				files: ["lib/esm/index.js", "lib/cjs/index.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "fastembed")).toBe(
			path.join(nodeModules, "fastembed", "lib", "cjs", "index.js"),
		);
	});

	test("falls back to main pointing at a .node binding (napi-rs platform package)", async () => {
		const nodeModules = await makeNodeModules({
			"@anush008/tokenizers-darwin-arm64": {
				manifest: { main: "tokenizers.darwin-arm64.node" },
				files: ["tokenizers.darwin-arm64.node"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "@anush008/tokenizers-darwin-arm64")).toBe(
			path.join(nodeModules, "@anush008", "tokenizers-darwin-arm64", "tokenizers.darwin-arm64.node"),
		);
	});

	test("probes extensions and directory index for extensionless main", async () => {
		const nodeModules = await makeNodeModules({
			"onnxruntime-node": {
				manifest: { main: "dist/index" },
				files: ["dist/index.js"],
			},
			"onnxruntime-common": {
				manifest: { main: "dist" },
				files: ["dist/index.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "onnxruntime-node")).toBe(
			path.join(nodeModules, "onnxruntime-node", "dist", "index.js"),
		);
		expect(resolveRuntimeModule(nodeModules, "onnxruntime-common")).toBe(
			path.join(nodeModules, "onnxruntime-common", "dist", "index.js"),
		);
	});

	test("resolves subpath requests through the exports map and via plain joining", async () => {
		const nodeModules = await makeNodeModules({
			mapped: {
				manifest: { exports: { ".": "./index.js", "./util": { require: "./lib/util.cjs" } } },
				files: ["index.js", "lib/util.cjs"],
			},
			plain: {
				manifest: { main: "index.js" },
				files: ["index.js", "lib/helper.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "mapped/util")).toBe(
			path.join(nodeModules, "mapped", "lib", "util.cjs"),
		);
		expect(resolveRuntimeModule(nodeModules, "plain/lib/helper")).toBe(
			path.join(nodeModules, "plain", "lib", "helper.js"),
		);
	});

	test("returns null for absent packages and import-only exports", async () => {
		const nodeModules = await makeNodeModules({
			"esm-only": {
				manifest: { exports: { ".": { import: "./index.mjs" } } },
				files: ["index.mjs"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "missing-package")).toBeNull();
		expect(resolveRuntimeModule(nodeModules, "esm-only")).toBeNull();
	});

	test("falls back to index.js when manifest has no usable entry", async () => {
		const nodeModules = await makeNodeModules({
			bare: { manifest: {}, files: ["index.js"] },
		});
		expect(resolveRuntimeModule(nodeModules, "bare")).toBe(path.join(nodeModules, "bare", "index.js"));
	});
});

describe("installRuntimeModuleResolver", () => {
	test("keeps runtime-parent bare requests inside the runtime cache", async () => {
		const nodeModules = await makeNodeModules({
			"@huggingface/transformers": {
				manifest: { main: "dist/transformers.node.cjs" },
				files: ["dist/transformers.node.cjs"],
			},
			"kokoro-js": {
				manifest: { main: "dist/kokoro.cjs" },
				files: ["dist/kokoro.cjs"],
			},
		});
		const runtimeDir = path.dirname(nodeModules);
		const sharpStub = path.join(runtimeDir, "sharp-stub.cjs");
		await Bun.write(sharpStub, "module.exports = {};\n");

		resolverUninstalls.push(
			installRuntimeModuleResolver({ runtimeNodeModules: nodeModules, stubs: { sharp: sharpStub } }),
		);

		const moduleWithResolver = Module as unknown as { default?: ResolveFilenameModule } & ResolveFilenameModule;
		const resolver = moduleWithResolver.default ?? moduleWithResolver;
		const runtimeParent = { filename: path.join(nodeModules, "kokoro-js", "dist", "kokoro.cjs") };
		expect(resolver._resolveFilename("@huggingface/transformers", runtimeParent, false)).toBe(
			path.join(nodeModules, "@huggingface", "transformers", "dist", "transformers.node.cjs"),
		);
		expect(resolver._resolveFilename("sharp", runtimeParent, false)).toBe(sharpStub);
	});

	test("uninstall restores the stock resolver and createRequire relative requires", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-uninstall-"));
		tempDirs.push(root);
		await fs.writeFile(path.join(root, "config.js"), 'module.exports = { value: "config-ok" };\n');
		await fs.writeFile(
			path.join(root, "entry.mjs"),
			[
				'import { createRequire } from "node:module";',
				"const req = createRequire(import.meta.url);",
				'const { value } = req("./config.js");',
				"export { value };",
			].join("\n"),
		);
		const runtimeNodeModules = path.join(root, "runtime", "node_modules");
		await fs.mkdir(runtimeNodeModules, { recursive: true });

		const moduleWithResolver = Module as unknown as { default?: ResolveFilenameModule } & ResolveFilenameModule;
		const resolver = moduleWithResolver.default ?? moduleWithResolver;
		const pristine = resolver._resolveFilename;

		const uninstall = installRuntimeModuleResolver({ runtimeNodeModules });
		expect(resolver._resolveFilename).not.toBe(pristine);
		uninstall();
		expect(resolver._resolveFilename).toBe(pristine);

		// With the stock resolver restored, createRequire-relative requires work.
		// Dynamic import: the module is a runtime-generated temp file, and the test
		// intentionally exercises the module-loading boundary the patch breaks.
		const mod = (await import(path.join(root, "entry.mjs"))) as { value: string };
		expect(mod.value).toBe("config-ok");
	});
});

describe("writeRuntimeManifest", () => {
	async function readManifest(install: Parameters<typeof writeRuntimeManifest>[1]) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-manifest-"));
		tempDirs.push(dir);
		await writeRuntimeManifest(dir, install);
		return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
	}

	test("emits overrides so a transitive pin is forced across the runtime tree", async () => {
		const manifest = await readManifest({
			dependencies: { "kokoro-js": "1.2.1" },
			overrides: { "onnxruntime-node": "1.26.0" },
			trustedDependencies: ["onnxruntime-node"],
		});
		expect(manifest.dependencies).toEqual({ "kokoro-js": "1.2.1" });
		expect(manifest.overrides).toEqual({ "onnxruntime-node": "1.26.0" });
		expect(manifest.trustedDependencies).toEqual(["onnxruntime-node"]);
	});

	test("omits overrides when none are provided or the map is empty", async () => {
		const without = await readManifest({ dependencies: { "kokoro-js": "1.2.1" } });
		expect("overrides" in without).toBe(false);
		const empty = await readManifest({ dependencies: { "kokoro-js": "1.2.1" }, overrides: {} });
		expect("overrides" in empty).toBe(false);
	});
});

// Contract under test: ensureRuntimeInstalled serializes installs with the
// crash-safe OS-backed lock (issue #10120). A lock left behind by a process
// that died mid-install must not wedge later attempts, and the pre-18.x
// `${runtimeDir}.lock` mkdir *directory* must not permanently break the new
// file-backed lock path.
describe("ensureRuntimeInstalled install lock", () => {
	// A local `file:` dependency keeps the real `bun install` offline and
	// deterministic — no registry, no network.
	async function makeFileDependency(): Promise<{ spec: string; probe: string }> {
		const src = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-dep-"));
		tempDirs.push(src);
		await fs.writeFile(
			path.join(src, "package.json"),
			JSON.stringify({ name: "omp-runtime-fixture", version: "1.0.0" }),
		);
		return { spec: `file:${src}`, probe: "omp-runtime-fixture" };
	}

	async function makeRuntimeDir(): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-cache-"));
		tempDirs.push(root);
		return path.join(root, "cache", "fixture-runtime");
	}

	test("a stale legacy .lock directory does not block install and is cleared", async () => {
		const { spec, probe } = await makeFileDependency();
		const runtimeDir = await makeRuntimeDir();
		// A pre-18.x crash orphan, older than any live install: reclaimed at once.
		await fs.mkdir(`${runtimeDir}.lock`, { recursive: true });
		const stale = new Date(Date.now() - 60 * 60_000);
		await fs.utimes(`${runtimeDir}.lock`, stale, stale);

		await ensureRuntimeInstalled({
			runtimeDir,
			install: { dependencies: { [probe]: spec } },
			probePackage: probe,
			lockAttempts: 8,
			lockSleepMs: 50,
		});

		expect(await Bun.file(path.join(runtimeDir, "node_modules", probe, "package.json")).exists()).toBe(true);
		await expect(fs.stat(`${runtimeDir}.lock`)).rejects.toThrow();
	}, 15_000);

	test("a live legacy .lock owner is waited out, never reclaimed on retry exhaustion", async () => {
		const { spec, probe } = await makeFileDependency();
		const runtimeDir = await makeRuntimeDir();
		// A recently created directory may still belong to a live pre-18.x
		// installer. Retry exhaustion must NOT reclaim it — that would race two
		// installs against the same tree — only its owner releasing the lock may
		// let the new install proceed.
		await fs.mkdir(`${runtimeDir}.lock`, { recursive: true });

		const sleepMs = 40;
		const install = ensureRuntimeInstalled({
			runtimeDir,
			install: { dependencies: { [probe]: spec } },
			probePackage: probe,
			lockAttempts: 3,
			lockSleepMs: sleepMs,
		});

		// Integration timing: the reclaim decision runs on the module's own
		// `Bun.sleep` poll loop and a real `bun install` subprocess, so fake
		// timers cannot drive it. Wait past the retry window (lockAttempts x
		// lockSleepMs) — under the old bug the install would have reclaimed the
		// fresh lock and populated node_modules by now; it must not have.
		await Bun.sleep(sleepMs * 8);
		expect((await fs.stat(`${runtimeDir}.lock`)).isDirectory()).toBe(true);
		expect(await Bun.file(path.join(runtimeDir, "node_modules", probe, "package.json")).exists()).toBe(false);

		// The legacy owner finishes and releases; only now does the install proceed.
		await fs.rm(`${runtimeDir}.lock`, { recursive: true, force: true });
		await install;
		expect(await Bun.file(path.join(runtimeDir, "node_modules", probe, "package.json")).exists()).toBe(true);
		await expect(fs.stat(`${runtimeDir}.lock`)).rejects.toThrow();
	}, 15_000);

	test("reserves the legacy namespace before the new install starts", async () => {
		const { spec, probe } = await makeFileDependency();
		const runtimeDir = await makeRuntimeDir();
		let observedDownload = false;

		await ensureRuntimeInstalled({
			runtimeDir,
			install: { dependencies: { [probe]: spec } },
			probePackage: probe,
			lockAttempts: 8,
			lockSleepMs: 50,
			onPhase: phase => {
				if (phase !== "download") return;
				observedDownload = true;
				// A legacy process racing in after the handoff must lose its
				// atomic mkdir before the new process mutates node_modules.
				expect(() => fsSync.mkdirSync(`${runtimeDir}.lock`)).toThrow();
			},
		});

		expect(observedDownload).toBe(true);
		expect(await Bun.file(path.join(runtimeDir, "node_modules", probe, "package.json")).exists()).toBe(true);
		await expect(fs.stat(`${runtimeDir}.lock`)).rejects.toThrow();
	}, 15_000);

	test("a crashed installer does not wedge a later install", async () => {
		const { spec, probe } = await makeFileDependency();
		const runtimeDir = await makeRuntimeDir();
		await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
		const readyPath = `${runtimeDir}.holder-ready`;
		// Enter the real ensureRuntimeInstalled critical section, including its
		// legacy namespace reservation, then die before bun install starts.
		const holder = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/runtime-install-holder.ts"),
				runtimeDir,
				spec,
				readyPath,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			},
		);

		try {
			for (;;) {
				try {
					await fs.access(readyPath);
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
					if (holder.exitCode !== null) {
						throw new Error(
							`runtime installer exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
						);
					}
				}
			}
			expect((await fs.stat(`${runtimeDir}.lock`)).isFile()).toBe(true);

			holder.kill("SIGKILL");
			await holder.exited;

			// The kernel released the OS lock; the identifiable compatibility
			// reservation must not turn this real crash into another long wait.
			await ensureRuntimeInstalled({
				runtimeDir,
				install: { dependencies: { [probe]: spec } },
				probePackage: probe,
				lockAttempts: 20,
				lockSleepMs: 50,
			});
			expect(await Bun.file(path.join(runtimeDir, "node_modules", probe, "package.json")).exists()).toBe(true);
			await expect(fs.stat(`${runtimeDir}.lock`)).rejects.toThrow();
		} finally {
			if (holder.exitCode === null) {
				holder.kill("SIGKILL");
				await holder.exited;
			}
		}
	}, 20_000);
});
