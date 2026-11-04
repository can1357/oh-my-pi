import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { buildHarborEnv, collectForwardEnv, parseArgs, writeGatewayTokenFile, writeModelsYaml } from "../src/runner";
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
		name: "a provider id that gives another provider a command apiKey",
		inputs: m => ({ providers: [hostileValues(m).providerWithApiKey] }),
	},
	{
		name: "a provider id that ends the models.yml heredoc",
		inputs: m => ({ providers: [hostileValues(m).heredoc("openrouter", "OMP_MODELS_EOF")] }),
	},
	{
		name: "custom provider ids holding +, @ and :",
		inputs: () => ({ providers: ["tenant+prod", "my@team", "tenant:prod"] }),
	},
	{
		name: "a setting key that ends the config.yml heredoc",
		inputs: m => ({ settingKey: hostileValues(m).heredoc("harmless", "OMP_CONFIG_EOF") }),
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
			]);
			const harborEnv = buildHarborEnv(
				cfg,
				writeModelsYaml(root, cfg),
				null,
				"test",
				null,
				writeGatewayTokenFile(root, cfg),
			);
			// Harbor expands `${NAME}` from its own environment in task files: the token travels as a file.
			expect(harborEnv.OMP_BENCH_GATEWAY_TOKEN).toBeUndefined();
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

	it.each([
		{ name: "--env names the token variable", argv: ["--env", "METAHARNESS_GATEWAY_TOKEN"], hostEnv: {} },
		{ name: "--env holds the token", argv: ["--env", "PI_ALIAS=same-env-secret"], hostEnv: {} },
		{ name: "--setting repeats the token", argv: ["--setting", "note=same-env-secret"], hostEnv: {} },
		{ name: "--agent-arg repeats the token", argv: ["--agent-arg", "same-env-secret"], hostEnv: {} },
		{
			name: "forwarded host PI_* variable holds the token",
			argv: [],
			hostEnv: { PI_TEST_ALIAS: "same-env-secret" },
		},
	])("refuses a run whose $name", ({ argv, hostEnv }) => {
		const saved = { ...process.env };
		Object.assign(process.env, { METAHARNESS_GATEWAY_TOKEN: "same-env-secret" }, hostEnv);
		try {
			// The runner's parser checks --env entries; the forwarding step checks host PI_* too.
			const build = () => collectForwardEnv(parseArgs(["--model", "openrouter/test-model", ...argv]));
			expect(build).toThrow(/gateway token/);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});

	it.each([
		{
			name: "a numeric --setting equal to a numeric token",
			token: "314159265358979",
			argv: ["--setting", "note=314159265358979"],
			hostEnv: {},
		},
		{
			name: "a Harbor agent-env entry that refers to the token variable",
			token: "same-env-secret",
			argv: ["--", "--ae", "PI_ALIAS=$" + "{METAHARNESS_GATEWAY_TOKEN}"],
			hostEnv: {},
		},
		{
			name: "an inherited OMP_BENCH_* variable holding the token",
			token: "same-env-secret",
			argv: [],
			hostEnv: { OMP_BENCH_EXTRA_NOTE: "same-env-secret" },
		},
		{
			name: "an inherited host variable holding the token, which Harbor could expand",
			token: "same-env-secret",
			argv: ["--", "--ae", "PI_ALIAS=$" + "{ALIAS_TOKEN}"],
			hostEnv: { ALIAS_TOKEN: "same-env-secret" },
		},
		{
			name: "an inherited PYTHONPATH holding the token",
			token: "same-env-secret",
			argv: [],
			hostEnv: { PYTHONPATH: "/opt/same-env-secret" },
		},
		{
			name: "an inherited variable holding the value of an inherited OMP_BENCH_GATEWAY_TOKEN",
			token: "same-env-secret",
			argv: [],
			hostEnv: { OMP_BENCH_GATEWAY_TOKEN: "legacy-runner-bearer", REVIEW_ALIAS: "legacy-runner-bearer" },
		},
	])("refuses a run with $name before anything prints or starts", ({ token, argv, hostEnv }) => {
		const saved = { ...process.env };
		Object.assign(process.env, { METAHARNESS_GATEWAY_TOKEN: token }, hostEnv);
		try {
			// Harbor expands `${NAME}` in agent env from its own environment and hands the agent every OMP_BENCH_* variable.
			const build = () =>
				buildHarborEnv(parseArgs(["--model", "openrouter/test-model", ...argv]), "/dev/null", null, "test");
			expect(build).toThrow(/gateway token/);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});

	it("passes no gateway token variable to Harbor, an inherited OMP_BENCH_GATEWAY_TOKEN included", () => {
		const saved = { ...process.env };
		Object.assign(process.env, {
			METAHARNESS_GATEWAY_TOKEN: "same-env-secret",
			OMP_BENCH_GATEWAY_TOKEN: "legacy-runner-bearer",
		});
		try {
			// Harbor expands ${NAME} in task files from its own environment; the agent reads its token file.
			const env = buildHarborEnv(parseArgs(["--model", "openrouter/test-model"]), "/dev/null", null, "test");
			expect(env.OMP_BENCH_GATEWAY_TOKEN).toBeUndefined();
			expect(env.METAHARNESS_GATEWAY_TOKEN).toBeUndefined();
			expect(Object.values(env)).not.toContain("legacy-runner-bearer");
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
	it.each([
		{ name: "an --env entry naming the token variable", argv: ["--env", "METAHARNESS_GATEWAY_TOKEN"] },
		{
			name: "a Harbor agent-env entry referring to it",
			argv: ["--", "--ae", "PI_ALIAS=$" + "{METAHARNESS_GATEWAY_TOKEN}"],
		},
	])("refuses $name after --help, as it does without it", ({ argv }) => {
		// The manager parses a launch's arguments to check them; --help must not end that early.
		expect(() => parseArgs(["--model", "openrouter/test-model", "--help", ...argv])).toThrow(
			/METAHARNESS_GATEWAY_TOKEN/,
		);
	});

	it("gives each run its own private token file, so a concurrent run of the job cannot remove it", async () => {
		const { root } = await scratch("runner-token-file-");
		const cfg = parseArgs(["--model", "openrouter/test-model", "--gateway-token", "file-bearer"]);

		const active = writeGatewayTokenFile(root, cfg);
		const concurrent = writeGatewayTokenFile(root, cfg);
		await fs.rm(concurrent);

		expect(concurrent).not.toBe(active);
		expect(await Bun.file(active).text()).toBe("file-bearer");
		expect((await fs.stat(active)).mode & 0o777).toBe(0o600);
	});

	it("refuses an inherited variable whose name holds the token without printing the name", () => {
		const saved = { ...process.env };
		Object.assign(process.env, { METAHARNESS_GATEWAY_TOKEN: "same-env-secret", "OMP_BENCH_same-env-secret": "x" });
		try {
			let message = "";
			try {
				buildHarborEnv(parseArgs(["--model", "openrouter/test-model"]), "/dev/null", null, "test");
			} catch (error) {
				message = String(error);
			}
			expect(message).toMatch(/gateway token in its name/);
			expect(message).not.toContain("same-env-secret");
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});

	it.each(["omp_local", "pi_upstream"] as const)(
		"%s refuses forwarded env that holds the gateway token, whatever its spelling",
		async agent => {
			const { root } = await scratch("harbor-forward-token-");

			// "no-auth-dummy" is omp_local's placeholder when no token is supplied; supplied, it is a token.
			const install = runHarborAgent(agent, root, root, {
				OMP_BENCH_GATEWAY_TOKEN: "no-auth-dummy",
				OMP_BENCH_FORWARD_ENV: JSON.stringify({ PI_ALIAS: "Bearer no-auth-dummy" }),
				OMP_BENCH_PI_MODELS: "[]",
			});

			await expect(install).rejects.toThrow(/PI_ALIAS names or holds the gateway token/);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"omp_local refuses settings that repeat the gateway token",
		async () => {
			const { root } = await scratch("harbor-setting-token-");

			const install = runHarborAgent("omp_local", root, root, {
				OMP_BENCH_GATEWAY_TOKEN: "same-env-secret",
				OMP_BENCH_SETTINGS: JSON.stringify({ note: "same-env-secret" }),
			});

			await expect(install).rejects.toThrow(/OMP_BENCH_SETTINGS holds the gateway token/);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"omp_local refuses settings that hold the gateway token behind a JSON escape",
		async () => {
			const { root } = await scratch("harbor-setting-escaped-");

			const install = runHarborAgent("omp_local", root, root, {
				OMP_BENCH_GATEWAY_TOKEN: "same-env-secret",
				OMP_BENCH_SETTINGS: '{"note": "\\u0073ame-env-secret"}',
			});

			await expect(install).rejects.toThrow(/OMP_BENCH_SETTINGS holds the gateway token/);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"omp_local refuses a forwarded variable whose name holds the token without repeating it",
		async () => {
			const { root } = await scratch("harbor-forward-name-");

			const install = runHarborAgent("omp_local", root, root, {
				OMP_BENCH_GATEWAY_TOKEN: "same-env-secret",
				OMP_BENCH_FORWARD_ENV: JSON.stringify({ PI_same_env_secret: "x", "PI_same-env-secret": "x" }),
			});

			const error = await install.then(
				() => "",
				(failure: unknown) => String(failure),
			);
			expect(error).toMatch(/names or holds the gateway token/);
			expect(error).not.toContain("same-env-secret");
		},
		CASE_TIMEOUT_MS,
	);

	it("refuses the provider id <<, which omp's YAML reader takes as a merge key, in the runner's models.yml", async () => {
		const { root } = await scratch("omp-harbor-provider-");
		const cfg = parseArgs(["--model", "openrouter/test-model", "--providers", "openrouter,<<"]);

		expect(() => writeModelsYaml(root, cfg)).toThrow(/merge key/);
		expect(await Bun.file(path.join(root, "models.yml")).exists()).toBe(false);
	});

	it(
		"refuses the provider id <<, which omp's YAML reader takes as a merge key, in its own models.yml",
		async () => {
			const { root } = await scratch("omp-harbor-provider-fallback-");

			const install = runHarborAgent("omp_local", root, root, {
				OMP_BENCH_GATEWAY_URL: "http://gateway.test",
				OMP_BENCH_GATEWAY_PROVIDERS: "openrouter,<<",
			});

			await expect(install).rejects.toThrow(/merge key/);
			expect(await Bun.file(path.join(root, ".omp", "agent", "models.yml")).exists()).toBe(false);
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

			expect(dryRun).toContain("OMP_BENCH_GATEWAY_TOKEN_FILE=");
			expect(dryRun).not.toContain(token);
			expect(launch).toContain("no tarball found");
			const snapshot = path.join(root, "jobs", "_bench", "review", "runner-config.json");
			expect(await Bun.file(snapshot).text()).not.toContain(token);
			expect((await fs.stat(snapshot)).mode & 0o777).toBe(0o600);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"refuses a generated job name that holds the token before it writes the launch snapshot",
		async () => {
			const { root } = await scratch("runner-token-slug-");
			const bin = path.join(root, "bin");
			for (const tool of ["harbor", "docker"]) await stubTool(path.join(bin, tool));
			// The model `openrouter/slugtok.bearer` never holds the token, but its slug does.
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "..", "src", "runner.ts"),
					"--model",
					"openrouter/slugtok.bearer",
					"--gateway-token",
					"slugtok-bearer",
					"--gateway-url",
					"http://127.0.0.1:1",
					"--jobs-dir",
					path.join(root, "jobs"),
					"--install",
					"local",
					"--no-build",
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

			expect(stdout + stderr).toContain("the job name holds the gateway token");
			expect(await fs.readdir(path.join(root, "jobs")).catch(() => [])).toEqual([]);
		},
		CASE_TIMEOUT_MS,
	);
});

describe("manager", () => {
	const token = "review-manager-bearer";

	/** A real manager with one launch POSTed and run to completion, and every place it records the run. */
	async function launchThroughManager(
		root: string,
		port: number,
		body: Record<string, unknown>,
	): Promise<{ status: number; responses: string; recorded: Buffer }> {
		const launched = await fetch(`http://127.0.0.1:${port}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openrouter/test-model",
				jobName: "token-probe",
				environment: "docker",
				...body,
				extraArgs: [
					...((body.extraArgs as string[] | undefined) ?? []),
					"--dry-run",
					"--binary",
					path.join(root, "omp-linux-x64"),
					"--gateway-url",
					"http://127.0.0.1:1",
				],
			}),
		});
		const launchText = await launched.text();
		// The runner is a real detached process; the manager exposes no completion
		// promise, so poll the runs API until it has exited and its log is complete.
		let runs = "";
		for (let attempt = 0; attempt < 200; attempt++) {
			runs = await fetch(`http://127.0.0.1:${port}/api/runs`).then(response => response.text());
			if (!runs.includes('"status":"running"')) break;
			await Bun.sleep(100);
		}
		const files = [
			"token-probe/manager.json",
			"_manager/metaharness.sqlite",
			"_manager/metaharness.sqlite-wal",
			"_manager/logs/token-probe.log",
		];
		const recorded = Buffer.concat(
			await Promise.all(files.map(file => fs.readFile(path.join(root, file)).catch(() => Buffer.alloc(0)))),
		);
		return { status: launched.status, responses: launchText + runs, recorded };
	}

	it(
		"keeps a launch's gatewayToken out of its stored record, the runs API and the runner's output",
		async () => {
			const { root } = await scratch("manager-token-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			const spawn = spyOn(Bun, "spawn");
			try {
				const result = await launchThroughManager(root, server.port ?? 0, { gatewayToken: token });

				expect(result.status).toBe(201);
				// The runner process gets the token in its environment, and nowhere else does.
				expect(spawn.mock.calls.at(-1)?.[1]?.env?.METAHARNESS_GATEWAY_TOKEN).toBe(token);
				expect(result.responses).not.toContain(token);
				expect(result.recorded.includes(Buffer.from(token))).toBe(false);
			} finally {
				spawn.mockRestore();
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it.each([
		{ form: "--gateway-token <value>", extraArgs: ["--gateway-token", token] },
		{ form: "--gateway-token=<value>", extraArgs: [`--gateway-token=${token}`] },
		{
			form: "--gateway-token=<value> after a flag whose value is --",
			extraArgs: ["--include", "--", `--gateway-token=${token}`],
		},
		{
			form: "--gateway-token <value> after a flag whose value is --gateway-token",
			extraArgs: ["--agent-arg", "--gateway-token", "--gateway-token", token],
		},
		{ form: "--env naming the token variable", extraArgs: ["--env", `METAHARNESS_GATEWAY_TOKEN=${token}`] },
		{ form: "--env holding the token", extraArgs: ["--env", `PI_ALIAS=${token}`], gatewayToken: token },
		{
			form: "a bare --env of the token variable",
			extraArgs: ["--env", "METAHARNESS_GATEWAY_TOKEN"],
			gatewayToken: token,
		},
		{ form: "--setting repeating the token", extraArgs: ["--setting", `note=${token}`], gatewayToken: token },
		{ form: "--agent-arg repeating the token", extraArgs: ["--agent-arg", token], gatewayToken: token },
	])(
		"refuses a launch whose extraArgs carry the token as $form and records nothing",
		async ({ extraArgs, gatewayToken }) => {
			const { root } = await scratch("manager-token-refused-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				const result = await launchThroughManager(root, server.port ?? 0, { extraArgs, gatewayToken });

				expect(result.status).toBe(400);
				expect(result.responses).not.toContain(token);
				expect(result.recorded.includes(Buffer.from(token))).toBe(false);
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"keeps serving after a launch whose extraArgs ask the runner for --help",
		async () => {
			const { root } = await scratch("manager-help-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			// A parser that exits the process would end this test run with a passing status,
			// so an exit is turned into an error the launch reports.
			const exit = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
				throw new Error(`process.exit(${code}) called while checking a launch`);
			});
			try {
				// The manager parses the runner's arguments in its own process to check them.
				const result = await launchThroughManager(root, server.port ?? 0, { extraArgs: ["--help"] });

				expect(exit).not.toHaveBeenCalled();
				expect(result.status).toBe(201);
				expect((await fetch(`http://127.0.0.1:${server.port}/api/runs`)).status).toBe(200);
			} finally {
				exit.mockRestore();
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	/** The error a refused POST reports; an accepted one reports its status instead. */
	async function refusal(port: number, route: string, body: unknown): Promise<string> {
		const response = await fetch(`http://127.0.0.1:${port}${route}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return response.status === 400 ? await response.text() : `status ${response.status}`;
	}

	it(
		"refuses experiment metadata, arm launches and resume arguments that repeat a token it knows",
		async () => {
			const { root } = await scratch("manager-token-metadata-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			const send = (route: string, body: unknown, method: "POST" | "PUT" = "POST") =>
				fetch(`http://127.0.0.1:${server.port}${route}`, {
					method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}).then(response => response.status);
			try {
				await launchThroughManager(root, server.port ?? 0, { gatewayToken: token });
				await Bun.write(path.join(root, "token-probe", "config.json"), '{"environment":{"type":"docker"}}');

				expect(await send("/api/experiments", { id: "tokenexp", goal: token })).toBe(400);
				expect(await send("/api/experiments/token", { goal: token }, "PUT")).toBe(400);
				// The experiment id comes from the URL and is stored too.
				expect(await send(`/api/experiments/${token}`, { goal: "ordinary goal" }, "PUT")).toBe(400);
				// A body id must not stand in for the URL id the update is stored under.
				expect(await send(`/api/experiments/${token}`, { id: "safe-id", goal: "ordinary goal" }, "PUT")).toBe(400);
				expect(await send("/api/runs/token-probe/resume", { filterErrorTypes: [token] })).toBe(400);
				// The resume command line names the job; a token equal to it must not reach the process list.
				expect(await send("/api/runs/token-probe/resume", { gatewayToken: "token-probe" })).toBe(400);
				// Choosing another token for the request does not let it store a known one.
				const otherToken = "review-other-bearer";
				expect(
					await send("/api/runs/token-probe/resume", { gatewayToken: otherToken, filterErrorTypes: [token] }),
				).toBe(400);
				expect(
					await send("/api/runs", {
						model: "openrouter/test-model",
						jobName: "token-other",
						environment: "docker",
						gatewayToken: otherToken,
						note: token,
						extraArgs: [
							"--dry-run",
							"--binary",
							path.join(root, "omp-linux-x64"),
							"--gateway-url",
							"http://127.0.0.1:1",
						],
					}),
				).toBe(400);
				const launchOnly = (extra: Record<string, unknown>) =>
					send("/api/runs", {
						model: "openrouter/test-model",
						environment: "docker",
						extraArgs: [
							"--dry-run",
							"--binary",
							path.join(root, "omp-linux-x64"),
							"--gateway-url",
							"http://127.0.0.1:1",
						],
						...extra,
					});
				// A generated job name comes from the model slug: `slugtok.bearer` is not the token, its slug is.
				expect(await launchOnly({ model: "openrouter/slugtok.bearer", gatewayToken: "slugtok-bearer" })).toBe(400);
				// The jobs dir is on the command line: a token inside its path must not reach the process list.
				expect(await launchOnly({ jobName: "token-dir", gatewayToken: path.basename(root) })).toBe(400);
				// A forwarded host variable holding an earlier launch's token must not reach a later run's omp.
				process.env.REVIEW_RETAINED_ALIAS = token;
				try {
					const forwarded = await launchOnly({
						jobName: "token-forward",
						gatewayToken: otherToken,
						extraArgs: [
							"--env",
							"REVIEW_RETAINED_ALIAS",
							"--dry-run",
							"--binary",
							path.join(root, "omp-linux-x64"),
							"--gateway-url",
							"http://127.0.0.1:1",
						],
					});
					expect(forwarded).toBe(400);
				} finally {
					delete process.env.REVIEW_RETAINED_ALIAS;
				}
				const armToken = "review-arm-bearer";
				expect(
					await send("/api/experiments/token/arms", {
						arm: "b",
						model: "openrouter/test-model",
						note: armToken,
						gatewayToken: armToken,
					}),
				).toBe(400);
				const stored = Buffer.concat(
					await Promise.all(
						[
							"_manager/metaharness.sqlite",
							"_manager/metaharness.sqlite-wal",
							"token-b/manager.json",
							"token-other/manager.json",
							"token-forward/manager.json",
						].map(file => fs.readFile(path.join(root, file)).catch(() => Buffer.alloc(0))),
					),
				);
				expect(stored.includes(Buffer.from(token))).toBe(false);
				expect(stored.includes(Buffer.from(armToken))).toBe(false);
				expect(stored.includes(Buffer.from("slugtok-bearer"))).toBe(false);
				// Refused before the job directory is made.
				expect(
					(await fs.readdir(root)).filter(
						name => name.includes("slugtok") || ["token-dir", "token-forward", "token-inherited"].includes(name),
					),
				).toEqual([]);
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);
	it(
		"refuses a launch while its own environment holds another token it knows, after its job name was reused",
		async () => {
			const { root } = await scratch("manager-token-inherited-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				await launchThroughManager(root, server.port ?? 0, { gatewayToken: token });
				// Launching the same job name with another token stops its resume using the first,
				// but the first is still a live bearer the manager was given.
				await launchThroughManager(root, server.port ?? 0, { gatewayToken: "review-second-bearer" });
				// The runner forwards host PI_* variables to omp and hands the rest of its environment
				// to Harbor, which expands ${NAME} from it; it knows only its own token, so a host
				// variable holding another token the manager knows is refused here, with no --env.
				for (const variable of ["PI_RETAINED_ALIAS", "REVIEW_RETAINED_ALIAS"]) {
					process.env[variable] = token;
					try {
						const reason = await refusal(server.port ?? 0, "/api/runs", {
							model: "openrouter/test-model",
							environment: "docker",
							jobName: "token-inherited",
							gatewayToken: "review-other-bearer",
							extraArgs: [
								"--dry-run",
								"--binary",
								path.join(root, "omp-linux-x64"),
								"--gateway-url",
								"http://127.0.0.1:1",
							],
						});
						expect(reason).toContain(`the manager's environment.${variable} holds the gateway token`);
					} finally {
						delete process.env[variable];
					}
				}
				expect(await Bun.file(path.join(root, "token-inherited", "manager.json")).exists()).toBe(false);
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);
	it(
		"gives edit and snapcompact runs no gateway token, and refuses one for them",
		async () => {
			const { root } = await scratch("manager-token-edit-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			// These adapters run omp in their own process, so a token in their environment would
			// reach every tool call. Capture the environment each would start with; run `true`.
			const realSpawn = Bun.spawn;
			const spawned: Array<Record<string, string | undefined>> = [];
			const spawn = spyOn(Bun, "spawn").mockImplementation(((
				_cmd: string[],
				options: { env?: Record<string, string | undefined> },
			) => {
				spawned.push(options.env ?? {});
				return realSpawn(["true"], options as Parameters<typeof realSpawn>[1]);
			}) as unknown as typeof Bun.spawn);
			process.env.METAHARNESS_GATEWAY_TOKEN = "review-host-bearer";
			process.env.OMP_BENCH_GATEWAY_TOKEN = "review-legacy-bearer";
			try {
				for (const benchmark of ["edit", "snapcompact"]) {
					const refused = await refusal(server.port ?? 0, "/api/runs", {
						benchmark,
						model: "openrouter/test-model",
						jobName: `${benchmark}-with-token`,
						gatewayToken: "review-edit-bearer",
					});
					expect(refused).toContain("gatewayToken applies only to harbor runs");
					const accepted = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ benchmark, model: "openrouter/test-model", jobName: `${benchmark}-plain` }),
					});
					expect(accepted.status).toBe(201);
				}
				expect(spawned).toHaveLength(2);
				for (const env of spawned) {
					expect(env.METAHARNESS_GATEWAY_TOKEN).toBeUndefined();
					expect(env.OMP_BENCH_GATEWAY_TOKEN).toBeUndefined();
					expect(Object.values(env)).not.toContain("review-host-bearer");
					expect(Object.values(env)).not.toContain("review-legacy-bearer");
				}
				// A token given to a refused launch is still a bearer the manager was given, and the
				// value of either host token variable is a token too: neither may be stored or copied.
				for (const known of ["review-edit-bearer", "review-legacy-bearer"]) {
					expect(await refusal(server.port ?? 0, "/api/experiments", { id: "edit-goal", goal: known })).toContain(
						"holds the gateway token",
					);
					process.env.REVIEW_ALIAS = known;
					try {
						const aliased = await refusal(server.port ?? 0, "/api/runs", {
							benchmark: "edit",
							model: "openrouter/test-model",
							jobName: "edit-aliased",
						});
						expect(aliased).toContain("the manager's environment.REVIEW_ALIAS holds the gateway token");
					} finally {
						delete process.env.REVIEW_ALIAS;
					}
				}
				expect(spawned).toHaveLength(2);
			} finally {
				delete process.env.METAHARNESS_GATEWAY_TOKEN;
				delete process.env.OMP_BENCH_GATEWAY_TOKEN;
				spawn.mockRestore();
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"refuses a resume whose recorded launch holds another token it knows",
		async () => {
			const { root } = await scratch("manager-token-recovered-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				await launchThroughManager(root, server.port ?? 0, { gatewayToken: token });
				await Bun.write(path.join(root, "token-probe", "config.json"), '{"environment":{"type":"docker"}}');
				// A resume rebuilds the run's recorded launch; one holding a token the manager knows
				// must not reach a runner that knows only the resume's own token.
				await Bun.write(
					path.join(root, "_bench", "token-probe", "runner-config.json"),
					JSON.stringify({
						models: ["openrouter/test-model"],
						settings: { "review.retained": token },
						gatewayTokenRequired: false,
					}),
				);

				const reason = await refusal(server.port ?? 0, "/api/runs/token-probe/resume", {
					gatewayToken: "review-resume-bearer",
				});

				expect(reason).toContain("the resume.recovered.settings.review.retained holds the gateway token");
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"refuses a resume whose selected token is already in the record it rewrites",
		async () => {
			const { root } = await scratch("manager-token-note-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				const noteToken = "resume-note-bearer";
				expect((await launchThroughManager(root, server.port ?? 0, { note: noteToken })).status).toBe(201);
				await Bun.write(path.join(root, "token-probe", "config.json"), '{"environment":{"type":"docker"}}');

				const reason = await refusal(server.port ?? 0, "/api/runs/token-probe/resume", { gatewayToken: noteToken });

				// The record keeps the note twice (its own field and the launch request it stores).
				expect(reason).toMatch(/the resume\.record\.(config\.)?note holds the gateway token/);
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"does not resume a reused job name with an earlier launch's token",
		async () => {
			const { root } = await scratch("manager-token-reuse-");
			const manager = new ManagerServer(root);
			const server = manager.start(0);
			try {
				await launchThroughManager(root, server.port ?? 0, { gatewayToken: "stale-token" });
				await launchThroughManager(root, server.port ?? 0, {});
				await Bun.write(path.join(root, "token-probe", "config.json"), '{"environment":{"type":"docker"}}');

				const resumed = await fetch(`http://127.0.0.1:${server.port}/api/runs/token-probe/resume`, {
					method: "POST",
				});

				// With no token of its own, the resume is refused for want of one rather than run
				// with the token of the launch the second one replaced.
				expect(resumed.status).toBe(400);
				expect(await resumed.text()).toContain("gateway token, which is not recorded");
			} finally {
				await manager.stop();
			}
		},
		CASE_TIMEOUT_MS,
	);
});
