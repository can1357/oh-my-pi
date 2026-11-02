import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { buildHarborEnv, parseArgs, writeModelsYaml } from "../src/runner";
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
): Promise<{ runEnv: Record<string, string>; runCommand: string }> {
	const child = Bun.spawn([PYTHON, HARNESS, JSON.stringify({ agent, root: home, cwd, env })], {
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
	{
		name: "a provider id that gives another provider a command apiKey",
		inputs: m => ({ providers: [hostileValues(m).providerWithApiKey] }),
	},
	{
		name: "a provider id that ends the models.yml heredoc",
		inputs: m => ({ providers: [hostileValues(m).heredoc("openrouter", "OMP_MODELS_EOF")] }),
	},
	{ name: "a gateway URL that adds a command header", inputs: m => ({ url: hostileValues(m).urlWithHeader }) },
	{
		name: "a setting key that ends the config.yml heredoc",
		inputs: m => ({ settingKey: hostileValues(m).heredoc("harmless", "OMP_CONFIG_EOF") }),
	},
];

/** What the guest omp must see for `inputs`: each configured provider keyed by the literal token, nothing run. */
async function expectReadAsData(
	config: ConsumerResult,
	marker: string,
	inputs: GatewayInputs,
	token: string,
	providers: string[],
): Promise<void> {
	expect(await Bun.file(marker).exists()).toBe(false);
	expect(config.modelsError).toBeNull();
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
			const harborEnv = buildHarborEnv(cfg, writeModelsYaml(root, cfg), null, "test");
			const agentEnv = Object.fromEntries(Object.entries(harborEnv).filter(([key]) => key.startsWith("OMP_BENCH_")));
			const home = path.join(root, "home");
			await fs.mkdir(home);

			const { runEnv } = await runHarborAgent("omp_local", home, home, agentEnv);
			const providers = inputs.providers ?? ["openrouter"];
			const config = await consumeOmpConfig(home, [...new Set([...providers, "openrouter"])], runEnv);

			await expectReadAsData(config, marker, inputs, cfg.gatewayToken, providers);
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

			await expectReadAsData(config, marker, inputs, token, providers);
		},
		CASE_TIMEOUT_MS,
	);
});

describe("pi_upstream", () => {
	it(
		"writes a gateway token into models.json in pi's literal form, through no shell",
		async () => {
			const { root, marker } = await scratch("pi-harbor-models-");
			const token = `!printf PWNED > ${marker}; $HOME\nPI_MODELS_EOF\nprintf PWNED > ${marker}\n: <<'PI_MODELS_EOF'`;

			await runHarborAgent("pi_upstream", root, root, {
				OMP_BENCH_GATEWAY_URL: "http://gateway.test",
				OMP_BENCH_GATEWAY_TOKEN: token,
				OMP_BENCH_PI_MODELS: JSON.stringify([{ provider: "openrouter", id: "test-model" }]),
			});

			expect(await Bun.file(marker).exists()).toBe(false);
			const models = await Bun.file(path.join(root, ".pi", "agent", "models.json")).json();
			// pi runs a leading `!` and expands `$NAME`; `$!` and `$$` are its literal `!` and `$`.
			expect(models.providers["gw-openrouter"].apiKey).toBe(
				`$!printf PWNED > ${marker}; $$HOME\nPI_MODELS_EOF\nprintf PWNED > ${marker}\n: <<'PI_MODELS_EOF'`,
			);
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
