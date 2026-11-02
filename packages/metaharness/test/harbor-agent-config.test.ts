import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { buildHarborEnv, parseArgs, writeModelsYaml } from "../src/runner";
import { ManagerServer } from "../src/server";
import type { ConsumerResult } from "./fixtures/omp-config-consumer";
import { consumeOmpConfig, hostileValues } from "./fixtures/omp-config";

const PYTHON = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const HARNESS = path.join(import.meta.dir, "fixtures", "harbor_agent_harness.py");
const PI_SYSTEM_PROMPT = path.join(import.meta.dir, "..", "agent", "pi-upstream-system.md");
// Every case starts a Python harness and, for omp, a separate omp config reader process.
const CASE_TIMEOUT_MS = 60_000;

const scratchDirs: string[] = [];

afterEach(async () => {
	for (const dir of scratchDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<{ root: string; marker: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	scratchDirs.push(root);
	return { root, marker: path.join(root, "marker") };
}

/**
 * Run a Harbor agent's config writers and `run()` through the Python harness: container
 * commands run on this host with HOME at `home`; the agent's own launch is only recorded.
 */
async function runHarborAgent(
	agent: "omp_local" | "pi_upstream",
	home: string,
	cwd: string,
	env: Record<string, string>,
	options: { install?: boolean; rootRefused?: boolean } = {},
): Promise<{ runEnv: Record<string, string>; runCommand: string }> {
	const child = Bun.spawn([PYTHON, HARNESS, JSON.stringify({ agent, root: home, cwd, env, ...options })], {
		env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`harbor agent harness exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout) as { runEnv: Record<string, string>; runCommand: string };
}

/** The caller-supplied gateway inputs one case sets; unset fields keep benign defaults. */
interface GatewayInputs {
	token?: string;
	providers?: string[];
	url?: string;
	/** A `--setting` / `OMP_BENCH_SETTINGS` key, set to `"value"`. */
	settingKey?: string;
	/** `--env` entries (`OMP_BENCH_FORWARD_ENV`) for the omp run. */
	forwardEnv?: Record<string, string>;
}

const hostileInputs: Array<{ name: string; inputs: (marker: string) => GatewayInputs }> = [
	{ name: "a gateway token holding a quoted !command", inputs: m => ({ token: hostileValues(m).quotedCommand }) },
	{ name: "a gateway token holding a bare !command", inputs: m => ({ token: hostileValues(m).bareCommand }) },
	{ name: "a gateway token spelled like a variable omp's environment sets", inputs: () => ({ token: "HOME" }) },
	{
		name: "a gateway token that ends the models.yml heredoc",
		inputs: m => ({ token: hostileValues(m).heredoc("gateway-token", "OMP_MODELS_EOF") }),
	},
	{ name: "a gateway URL that adds a command header", inputs: m => ({ url: hostileValues(m).urlWithHeader }) },
	{
		name: "a setting key that ends the config.yml heredoc",
		inputs: m => ({ settingKey: hostileValues(m).heredoc("harmless", "OMP_CONFIG_EOF") }),
	},
	{
		name: "an --env entry that names a gateway token variable",
		inputs: () => ({ token: "intended-token", forwardEnv: { METAHARNESS_GATEWAY_TOKEN: "other-token" } }),
	},
];

/**
 * What the guest omp must see for `inputs`: each configured provider keyed by the literal
 * token, nothing run, and the token only in its private file, not in omp's environment.
 */
async function expectReadAsData(
	config: ConsumerResult,
	marker: string,
	inputs: GatewayInputs,
	token: string,
	providers: string[],
	home: string,
	runEnv: Record<string, string>,
): Promise<void> {
	expect(await Bun.file(marker).exists()).toBe(false);
	expect(config.modelsError).toBeNull();
	expect(Object.values(runEnv)).not.toContain(token);
	expect((await fs.stat(path.join(home, ".omp", "agent", "gateway-token"))).mode & 0o777).toBe(0o600);
	// Every staging copy the agent uploaded is gone once its file is in place.
	expect(await fs.readdir(path.join(home, "staging"))).toEqual([]);
	for (const [provider, key] of Object.entries(config.keys)) {
		expect(key).toBe(providers.includes(provider) ? token : null);
		expect(config.headers[provider]?.["X-Review"]).toBeUndefined();
	}
	// omp reads the generated `find.enabled: false` as its "off" mode.
	expect(config.settings).toMatchObject({ find: { enabled: "off" } });
	if (inputs.settingKey !== undefined) {
		// A dotted `--setting` key names a nested setting, so follow it the same way.
		const value = inputs.settingKey
			.split(".")
			.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], config.settings);
		expect(value).toBe("value");
	}
}

describe("omp_local", () => {
	it.each(hostileInputs)(
		"makes omp read $name from the runner's models.yml as data and run nothing",
		async ({ inputs: hostile }) => {
			const { root, marker } = await scratch("omp-harbor-runner-");
			const inputs = hostile(marker);
			const cfg = parseArgs([
				"--model",
				"openrouter/test-model",
				"--jobs-dir",
				path.join(root, "jobs"),
				...(inputs.token === undefined ? [] : ["--gateway-token", inputs.token]),
				...(inputs.providers === undefined ? [] : ["--providers", inputs.providers.join(",")]),
				...(inputs.url === undefined ? [] : ["--gateway-url", inputs.url]),
				...(inputs.settingKey === undefined ? [] : ["--setting", `${inputs.settingKey}=value`]),
				...Object.entries(inputs.forwardEnv ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
			]);
			const harborEnv = buildHarborEnv(cfg, writeModelsYaml(root, cfg), null, "test");
			const agentEnv = Object.fromEntries(Object.entries(harborEnv).filter(([key]) => key.startsWith("OMP_BENCH_")));
			const home = path.join(root, "home");
			await fs.mkdir(home);

			const { runEnv } = await runHarborAgent("omp_local", home, home, agentEnv);
			const providers = inputs.providers ?? ["openrouter"];
			const config = await consumeOmpConfig(home, [...new Set([...providers, "openrouter"])], runEnv);

			await expectReadAsData(config, marker, inputs, cfg.gatewayToken, providers, home, runEnv);
		},
		CASE_TIMEOUT_MS,
	);

	it.each(hostileInputs)(
		"makes omp read $name from its own models.yml as data and run nothing",
		async ({ inputs: hostile }) => {
			const { root, marker } = await scratch("omp-harbor-fallback-");
			const inputs = hostile(marker);
			const token = inputs.token ?? "no-auth";
			const providers = inputs.providers ?? ["openrouter"];
			const agentEnv: Record<string, string> = {
				OMP_BENCH_GATEWAY_URL: inputs.url ?? "http://gateway.test",
				OMP_BENCH_GATEWAY_TOKEN: token,
				OMP_BENCH_GATEWAY_PROVIDERS: providers.join(","),
			};
			if (inputs.settingKey !== undefined) {
				agentEnv.OMP_BENCH_SETTINGS = JSON.stringify({ [inputs.settingKey]: "value" });
			}
			if (inputs.forwardEnv !== undefined) agentEnv.OMP_BENCH_FORWARD_ENV = JSON.stringify(inputs.forwardEnv);

			const { runEnv } = await runHarborAgent("omp_local", root, root, agentEnv);
			const config = await consumeOmpConfig(root, [...new Set([...providers, "openrouter"])], runEnv);

			await expectReadAsData(config, marker, inputs, token, providers, root, runEnv);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"forwards an --env variable named __proto__ to omp instead of dropping it",
		async () => {
			const { root } = await scratch("omp-harbor-proto-");
			const cfg = parseArgs(["--model", "openrouter/test-model", "--env", "__proto__=key-value"]);
			const harborEnv = buildHarborEnv(cfg, writeModelsYaml(root, cfg), null, "test");
			const agentEnv = Object.fromEntries(Object.entries(harborEnv).filter(([key]) => key.startsWith("OMP_BENCH_")));

			const { runEnv } = await runHarborAgent("omp_local", root, root, agentEnv);

			expect(Object.getOwnPropertyDescriptor(runEnv, "__proto__")?.value).toBe("key-value");
		},
		CASE_TIMEOUT_MS,
	);

	const hostileProviderIds = [
		{ name: "gives another provider a command apiKey", id: (m: string) => hostileValues(m).providerWithApiKey },
		{
			name: "ends the models.yml heredoc",
			id: (m: string) => hostileValues(m).heredoc("openrouter", "OMP_MODELS_EOF"),
		},
		{ name: "is the YAML merge key <<", id: () => "<<" },
	];

	it.each(hostileProviderIds)("refuses a provider id that $name in the runner's models.yml", async ({ id }) => {
		const { root, marker } = await scratch("omp-harbor-provider-");
		const cfg = parseArgs(["--model", "openrouter/test-model", "--providers", `openrouter,${id(marker)}`]);

		expect(() => writeModelsYaml(root, cfg)).toThrow(/provider id/);
		expect(await Bun.file(path.join(root, "models.yml")).exists()).toBe(false);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it.each(hostileProviderIds)(
		"refuses a provider id that $name in its own models.yml",
		async ({ id }) => {
			const { root, marker } = await scratch("omp-harbor-provider-fallback-");

			const install = runHarborAgent("omp_local", root, root, {
				OMP_BENCH_GATEWAY_URL: "http://gateway.test",
				OMP_BENCH_GATEWAY_PROVIDERS: `openrouter,${id(marker)}`,
			});

			await expect(install).rejects.toThrow(/provider id/);
			expect(await Bun.file(path.join(root, ".omp", "agent", "models.yml")).exists()).toBe(false);
			expect(await Bun.file(marker).exists()).toBe(false);
		},
		CASE_TIMEOUT_MS,
	);

	it.each(["omp_local", "pi_upstream"] as const)(
		"%s removes the staged token when the environment refuses to run anything as root",
		async agent => {
			const { root } = await scratch("harbor-root-refused-");

			const install = runHarborAgent(
				agent,
				root,
				root,
				{
					OMP_BENCH_GATEWAY_URL: "http://gateway.test",
					OMP_BENCH_GATEWAY_TOKEN: "staged-token",
					OMP_BENCH_PI_MODELS: JSON.stringify([{ provider: "openrouter", id: "test-model" }]),
				},
				{ rootRefused: true },
			);

			await expect(install).rejects.toThrow(/exec as root refused/);
			expect(await fs.readdir(path.join(root, "staging"))).toEqual([]);
		},
		CASE_TIMEOUT_MS,
	);
});

/** A tool the install commands call, stubbed to do nothing. */
async function stubTool(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, "#!/bin/sh\nexit 0\n");
	await fs.chmod(file, 0o755);
}

/** Runs `printf PWNED > marker` in the working directory if a shell re-reads the value as code. */
const SUBSTITUTION = "$(printf PWNED > marker)";

const hostileInstalls: Array<{
	name: string;
	agent: "omp_local" | "pi_upstream";
	/** Suffix for the task's HOME directory name. */
	home?: string;
	env: (dir: string) => Record<string, string>;
}> = [
	{ name: "omp_local with a HOME holding $(...)", agent: "omp_local", home: SUBSTITUTION, env: () => ({}) },
	{
		name: "omp_local with a Bun version holding $(...)",
		agent: "omp_local",
		env: () => ({ OMP_BENCH_BUN_VERSION: `1.4.4${SUBSTITUTION}` }),
	},
	{
		name: "omp_local with a source-mode Bun path holding $(...)",
		agent: "omp_local",
		env: dir => ({
			OMP_BENCH_INSTALL: "source",
			OMP_BENCH_SOURCE_BUN: path.join(dir, `runtime${SUBSTITUTION}`, "bun"),
			OMP_BENCH_SOURCE_DIR: path.join(dir, "source"),
		}),
	},
	{ name: "pi_upstream with a HOME holding $(...)", agent: "pi_upstream", home: SUBSTITUTION, env: () => ({}) },
	{
		name: "pi_upstream with a Node version holding $(...)",
		agent: "pi_upstream",
		env: () => ({ OMP_BENCH_NODE_VERSION: `22.14.0${SUBSTITUTION}` }),
	},
];

describe("install commands", () => {
	it.each(hostileInstalls)(
		"run nothing from $name",
		async ({ agent, home: homeSuffix, env }) => {
			const { root: dir } = await scratch("harbor-install-");
			const home = path.join(dir, `home${homeSuffix ?? ""}`);
			const bin = path.join(dir, "bin");
			for (const tool of ["apt-get", "curl", "tar", "npm", "bun", "node"]) await stubTool(path.join(bin, tool));
			await stubTool(path.join(home, ".bun", "bin", "bun"));
			await stubTool(path.join(home, ".pi-bench", "node", "bin", "node"));
			const agentEnv = { OMP_BENCH_INSTALL: "published", ...env(dir), PATH: `${bin}:/usr/bin:/bin` };
			if (agentEnv.OMP_BENCH_SOURCE_BUN) {
				await stubTool(agentEnv.OMP_BENCH_SOURCE_BUN);
				const source = path.join(dir, "source");
				await fs.mkdir(path.join(source, "node_modules", "@oh-my-pi"), { recursive: true });
				await Bun.write(path.join(source, "packages", "coding-agent", "src", "cli.ts"), "");
			}

			await runHarborAgent(agent, home, dir, agentEnv, { install: true });

			expect(await Bun.file(path.join(dir, "marker")).exists()).toBe(false);
		},
		CASE_TIMEOUT_MS,
	);
});

describe("pi_upstream", () => {
	it(
		"keeps the gateway token out of models.json, in a private file pi reads through a fixed command",
		async () => {
			const { root, marker } = await scratch("pi-harbor-models-");
			const token = `!printf PWNED > ${marker}; $HOME\nPI_MODELS_EOF\nprintf PWNED > ${marker}\n: <<'PI_MODELS_EOF'`;

			await runHarborAgent("pi_upstream", root, root, {
				OMP_BENCH_GATEWAY_URL: "http://gateway.test",
				OMP_BENCH_GATEWAY_TOKEN: token,
				OMP_BENCH_PI_MODELS: JSON.stringify([{ provider: "openrouter", id: "test-model" }]),
			});

			expect(await Bun.file(marker).exists()).toBe(false);
			const modelsText = await Bun.file(path.join(root, ".pi", "agent", "models.json")).text();
			expect(modelsText).not.toContain("PWNED");
			// pi runs an apiKey that starts with `!`; this one only reads the private file.
			expect(JSON.parse(modelsText).providers["gw-openrouter"].apiKey).toBe('!cat "$HOME/.pi/agent/gateway-token"');
			const tokenFile = path.join(root, ".pi", "agent", "gateway-token");
			expect(await Bun.file(tokenFile).text()).toBe(token);
			expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
			expect(await fs.readdir(path.join(root, "staging"))).toEqual([]);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"renders the trial directory into SYSTEM.md verbatim, sed metacharacters included",
		async () => {
			const { root } = await scratch("pi-harbor-prompt-");
			// `|...|e` would make sed run the rendered line as a command, `&` and `\1` are sed
			// replacement syntax, and `$(...)` runs if a shell re-reads the directory name.
			const cwd = path.join(root, "work & \\1 |e;s|x|y $(printf PWNED > marker)");
			await fs.mkdir(cwd);

			await runHarborAgent("pi_upstream", root, cwd, {
				OMP_BENCH_PI_MODELS: "[]",
				OMP_BENCH_PI_SYSTEM_PROMPT: PI_SYSTEM_PROMPT,
			});

			expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
			const prompt = await Bun.file(path.join(root, ".pi", "agent", "SYSTEM.md")).text();
			expect(prompt).toContain(`<cwd>\n${cwd}\n</cwd>`);
			expect(prompt).not.toContain("{{CWD}}");
		},
		CASE_TIMEOUT_MS,
	);
});

describe("runner", () => {
	it(
		"keeps the gateway token out of the dry-run output and the saved launch config",
		async () => {
			const { root } = await scratch("runner-token-");
			const bin = path.join(root, "bin");
			for (const tool of ["harbor", "docker"]) await stubTool(path.join(bin, tool));
			const token = "review-only-bearer";
			const runRunner = async (args: string[]) => {
				const child = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "..", "src", "runner.ts"),
						"--model",
						"openrouter/test-model",
						"--job-name",
						"review",
						"--gateway-token",
						token,
						"--gateway-url",
						"http://127.0.0.1:1",
						"--jobs-dir",
						path.join(root, "jobs"),
						...args,
					],
					{
						env: { PATH: `${bin}:${Bun.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: os.tmpdir() },
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return stdout + stderr;
			};

			const dryRun = await runRunner(["--dry-run", "--binary", path.join(root, "omp-linux-x64")]);
			// A real launch writes the snapshot, then stops here: there is no tarball to install.
			const launch = await runRunner(["--install", "local", "--no-build"]);

			expect(dryRun).toContain("OMP_BENCH_GATEWAY_TOKEN=(hidden)");
			expect(dryRun).not.toContain(token);
			expect(launch).toContain("no tarball found");
			const snapshot = path.join(root, "jobs", "_bench", "review", "runner-config.json");
			expect(await Bun.file(snapshot).text()).not.toContain(token);
			expect((await fs.stat(snapshot)).mode & 0o777).toBe(0o600);
		},
		CASE_TIMEOUT_MS,
	);
});

describe("manager", () => {
	const token = "review-manager-bearer";
	it.each([
		{ form: "--gateway-token <value>", args: ["--gateway-token", token] },
		{ form: "--gateway-token=<value>", args: [`--gateway-token=${token}`] },
	])(
		"keeps a launch's $form out of its stored record, the runs API and the runner's output",
		async ({ args }) => {
			const { root } = await scratch("manager-token-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				const launched = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "openrouter/test-model",
						jobName: "token-probe",
						environment: "docker",
						extraArgs: [
							...args,
							"--dry-run",
							"--binary",
							path.join(root, "omp-linux-x64"),
							"--gateway-url",
							"http://127.0.0.1:1",
						],
					}),
				});
				expect(launched.status).toBe(201);
				expect(await launched.text()).not.toContain(token);
				// The runner is a real detached process; the manager exposes no completion
				// promise, so poll the runs API until it has exited and its log is complete.
				let runs = "";
				for (let attempt = 0; attempt < 200; attempt++) {
					runs = await fetch(`http://127.0.0.1:${server.port}/api/runs`).then(response => response.text());
					if (!runs.includes('"status":"running"')) break;
					await Bun.sleep(100);
				}

				expect(runs).not.toContain(token);
				for (const file of [
					"token-probe/manager.json",
					"_manager/metaharness.sqlite",
					"_manager/metaharness.sqlite-wal",
					"_manager/logs/token-probe.log",
				]) {
					const bytes = await fs.readFile(path.join(root, file)).catch(() => Buffer.alloc(0));
					expect(bytes.includes(Buffer.from(token))).toBe(false);
				}
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);
});
