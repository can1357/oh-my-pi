import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const plugins = ["a", "b", "c"];
let root: string | undefined;

async function run(
	command: string[],
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const proc = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr}`);
	return stdout;
}

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
	await run(["git", "add", "-A"], marketplace);
	await run(["git", "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", version], marketplace);
}

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

test("plugin upgrade applies every explicit target instead of silently skipping later IDs", async () => {
	const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-upgrade-"));
	root = testRoot;
	const marketplace = path.join(testRoot, "marketplace");
	await fs.mkdir(marketplace);
	await run(["git", "init", "-q", "-b", "main"], marketplace);
	await writeMarketplace(marketplace, "1.0.0");

	const env = {
		...process.env,
		HOME: path.join(testRoot, "home"),
		XDG_CONFIG_HOME: path.join(testRoot, "config"),
		XDG_DATA_HOME: path.join(testRoot, "data"),
		XDG_STATE_HOME: path.join(testRoot, "state"),
		XDG_CACHE_HOME: path.join(testRoot, "cache"),
		XDG_RUNTIME_DIR: path.join(testRoot, "runtime"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: path.join(testRoot, "no-git-config"),
		GIT_TERMINAL_PROMPT: "0",
		NO_COLOR: "1",
		TERM: "dumb",
	};
	const omp = (...args: string[]) => run([process.execPath, cliEntry, "plugin", ...args], testRoot, env);
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
}, 30_000);
