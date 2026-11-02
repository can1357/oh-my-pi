/**
 * `omp plugin upgrade a@m b@m c@m` used to upgrade only the first id and
 * silently skip the rest (#16829).
 *
 * Runs the `omp plugin` command in-process from argv against a local
 * marketplace: the pi-utils path getters are spied onto a temp tree (the
 * pattern of plugin-install-git.test.ts), and `process.exit` throws so a
 * failing handler surfaces its error instead of ending the runner.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Plugin from "@oh-my-pi/pi-coding-agent/commands/plugin";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const CLI_CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

const plugins = ["a", "b", "c"];
let root: string;
let stdout: string[];
let stderr: string[];

async function writeMarketplace(marketplace: string, version: string): Promise<void> {
	for (const name of plugins) {
		const pluginDir = path.join(marketplace, "plugins", name);
		await Bun.write(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
		await Bun.write(path.join(pluginDir, "package.json"), JSON.stringify({ name, version, private: true }));
	}
	await Bun.write(
		path.join(marketplace, ".omp-plugin", "marketplace.json"),
		JSON.stringify({
			name: "m",
			owner: { name: "repro" },
			plugins: plugins.map(name => ({ name, source: `./plugins/${name}`, version })),
		}),
	);
}

/** Run `omp plugin <argv>`; returns what it printed to stdout. */
async function omp(...argv: string[]): Promise<string> {
	stdout.length = 0;
	stderr.length = 0;
	try {
		await new Plugin(argv, CLI_CONFIG).run();
	} catch (err) {
		throw new Error(`omp plugin ${argv.join(" ")} failed: ${err}\n${stderr.join("\n")}`);
	}
	return stdout.join("\n");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-upgrade-"));
	stdout = [];
	stderr = [];
	vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(path.join(root, "plugins"));
	vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(root, "plugins", "node_modules"));
	vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(root, "plugins", "package.json"));
	vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(root, "plugins", "omp-plugins.lock.json"));
	vi.spyOn(piUtils, "getMarketplacesRegistryPath").mockReturnValue(path.join(root, "marketplaces.json"));
	vi.spyOn(piUtils, "getProjectDir").mockReturnValue(path.join(root, "project"));
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void stdout.push(args.map(String).join(" ")));
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.map(String).join(" ")));
	vi.spyOn(process, "exit").mockImplementation(code => {
		throw new Error(`process.exit(${code})`);
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

test("plugin upgrade applies every explicit target instead of silently skipping later IDs", async () => {
	const marketplace = path.join(root, "marketplace");
	await fs.mkdir(path.join(root, "project"), { recursive: true });
	await writeMarketplace(marketplace, "1.0.0");

	await omp("marketplace", "add", marketplace);
	for (const name of plugins) await omp("install", `${name}@m`);

	await writeMarketplace(marketplace, "1.0.1");
	await omp("marketplace", "update", "m");
	await omp("upgrade", "a@m", "b@m", "c@m");

	const installed = JSON.parse(await omp("list", "--json"));
	expect(
		installed.marketplace
			.map((item: { id: string; entries: { version: string }[] }) => [item.id, item.entries[0]?.version])
			.sort(),
	).toEqual([
		["a@m", "1.0.1"],
		["b@m", "1.0.1"],
		["c@m", "1.0.1"],
	]);
});
