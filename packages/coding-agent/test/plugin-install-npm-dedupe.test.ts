/**
 * `PluginManager.install` must be idempotent for npm specs (issue #12296):
 * `bun install` appends a manifest edge rather than replacing it, so
 * reinstalling over a stale entry leaves duplicate keys and the next install
 * dies with DependencyLoop. The manager prunes the edge first; the mocked
 * `bun install` below faithfully appends, so a missing prune surfaces as two
 * keys in the raw manifest text.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) {
		throw new Error("Failed to create empty response stream");
	}
	return body;
}

describe("PluginManager.install npm idempotency", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-npm-dedupe-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		pluginsPkgJson = path.join(pluginsDir, "package.json");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(pluginsPkgJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	/** Mock `bun install` with real append (not replace) manifest semantics. */
	function mockAppendingBunInstall() {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("install");
			const prepare = (async () => {
				// Faithful `bun install` semantics: the new edge is appended,
				// never merged — pre-existing keys survive verbatim.
				const current = (await Bun.file(pluginsPkgJson).json()) as {
					dependencies?: Record<string, string>;
				};
				const edges = Object.entries(current.dependencies ?? {}).map(
					([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
				);
				edges.push(`    "pi-lens": "npm:pi-lens@4.2.0"`);
				await Bun.write(
					pluginsPkgJson,
					`{\n  "name": "omp-plugins",\n  "private": true,\n  "dependencies": {\n${edges.join(",\n")}\n  }\n}\n`,
				);
				const installedDir = path.join(pluginsNodeModules, "pi-lens");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "pi-lens", version: "4.2.0" }),
				);
			})();
			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);
	}

	function keyCount(raw: string): number {
		return raw.split('"pi-lens":').length - 1;
	}

	test("reinstalling the same npm spec leaves exactly one manifest key", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "pi-lens": "v4.1.6" } }, null, 2),
		);
		mockAppendingBunInstall();

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("npm:pi-lens@4.2.0");

		expect(result.name).toBe("pi-lens");
		const raw = await Bun.file(pluginsPkgJson).text();
		expect(keyCount(raw)).toBe(1);
		expect(JSON.parse(raw).dependencies["pi-lens"]).toBe("npm:pi-lens@4.2.0");
	});

	test("a pre-duplicated manifest collapses to one key", async () => {
		await Bun.write(
			pluginsPkgJson,
			'{\n  "name": "omp-plugins",\n  "private": true,\n  "dependencies": {\n    "pi-lens": "npm:pi-lens",\n    "pi-lens": "v4.1.6"\n  }\n}\n',
		);
		mockAppendingBunInstall();

		const mgr = new PluginManager(tmpRoot);
		await mgr.install("npm:pi-lens@4.2.0");

		const raw = await Bun.file(pluginsPkgJson).text();
		expect(keyCount(raw)).toBe(1);
	});

	test("a malformed full-spec key from an earlier upgrade is removed", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{
					name: "omp-plugins",
					private: true,
					dependencies: {
						"npm:pi-lens@4.1.6": "npm:pi-lens@4.1.6",
						"pi-lens": "npm:pi-lens@4.1.6",
					},
				},
				null,
				2,
			),
		);
		mockAppendingBunInstall();

		const mgr = new PluginManager(tmpRoot);
		await mgr.install("npm:pi-lens@4.2.0");

		const dependencies = (await Bun.file(pluginsPkgJson).json()).dependencies;
		expect(dependencies).toEqual({ "pi-lens": "npm:pi-lens@4.2.0" });
	});
});
