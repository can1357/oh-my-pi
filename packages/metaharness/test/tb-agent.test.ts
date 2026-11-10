import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Sandbox } from "@stencil-hq/vibemon";
import { writeAgentConfig } from "../src/tb/agent";
import { runTrial } from "../src/tb/trial";
import type { GatewayConfig } from "../src/tb/types";
import { TrialVm } from "../src/tb/vmon";
import { consumeOmpConfig, hostileValues } from "./fixtures/omp-config";

const scratchDirs: string[] = [];

afterEach(async () => {
	for (const dir of scratchDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Stands in for a Vibemon guest by running each command on this host with
 * `home` as `$HOME`, so `TrialVm`'s real shell commands run unchanged.
 */
function localSandbox(home: string): Sandbox {
	const spawnLocal = (argv: string[], env: Record<string, string> | undefined) =>
		Bun.spawn(argv, {
			env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", ...env, HOME: home },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	const sandbox = {
		async run(argv: string[], options?: { env?: Record<string, string> }) {
			const child = spawnLocal(argv, options?.env);
			await child.stdin.end();
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).bytes(),
				new Response(child.stderr).bytes(),
				child.exited,
			]);
			return { exit, stdout_b64: stdout.toBase64(), stderr_b64: stderr.toBase64() };
		},
		async exec(argv: string[], options?: { env?: Record<string, string> }) {
			const child = spawnLocal(argv, options?.env);
			return {
				stdin: {
					write: (data: Uint8Array) => child.stdin.write(data),
					close: () => child.stdin.end(),
				},
				async *[Symbol.asyncIterator]() {
					for await (const data of child.stdout) yield { stream: "stdout", data };
					for await (const data of child.stderr) yield { stream: "stderr", data };
				},
				wait: async () => ({ code: await child.exited }),
			};
		},
	};
	return sandbox as unknown as Sandbox;
}

/** Each case swaps one caller-supplied gateway field for a value that runs a command if any reader treats it as code. */
const hostileGateways: Array<{
	name: string;
	gateway: (marker: string) => Partial<GatewayConfig>;
	/** `--env` entries the guest omp is started with. */
	env?: Record<string, string>;
}> = [
	{ name: "a --gateway-token holding a quoted !command", gateway: m => ({ token: hostileValues(m).quotedCommand }) },
	{ name: "a --gateway-token holding a bare !command", gateway: m => ({ token: hostileValues(m).bareCommand }) },
	{ name: "a --gateway-token spelled like a variable omp's environment sets", gateway: () => ({ token: "HOME" }) },
	{
		name: "a --gateway-token that ends a heredoc",
		gateway: m => ({ token: hostileValues(m).heredoc("gateway-token", "OMP_MODELS_EOF") }),
	},
	{ name: "a gateway URL that adds a command header", gateway: m => ({ url: hostileValues(m).urlWithHeader }) },
	{
		name: "a provider id that gives another provider a command apiKey",
		gateway: m => ({ providers: [hostileValues(m).providerWithApiKey] }),
	},
	{
		name: "a provider id that ends a heredoc",
		gateway: m => ({ providers: [hostileValues(m).heredoc("openrouter", "OMP_MODELS_EOF")] }),
	},
	{
		name: "custom provider ids holding +, @ and :",
		gateway: () => ({ providers: ["tenant+prod", "my@team", "tenant:prod"] }),
	},
	{
		name: "an --env entry that names a gateway token variable",
		gateway: () => ({ token: "intended-token" }),
		env: { METAHARNESS_GATEWAY_TOKEN: "other-token" },
	},
];

describe("writeAgentConfig", () => {
	// Each case starts a separate omp config reader process.
	it.each(hostileGateways)(
		"makes the guest omp read $name as data and run nothing",
		async ({ gateway: hostile, env = {} }) => {
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tb-agent-"));
			scratchDirs.push(home);
			const marker = path.join(home, "marker");
			const gateway: GatewayConfig = {
				url: "http://gateway.test",
				token: "no-auth",
				providers: ["openrouter"],
				openrouterVariant: "floor",
				...hostile(marker),
			};
			const vm = new TrialVm(localSandbox(home), "local", "x64", "/", {});

			// `trial.ts` starts the guest omp with the service grace and `--env` entries only.
			const agent = { tools: ["read"], env };
			await writeAgentConfig(vm, gateway, agent);
			const queried = [...new Set([...gateway.providers, "openrouter"])];
			const config = await consumeOmpConfig(home, queried, agent.env);

			expect(await Bun.file(marker).exists()).toBe(false);
			expect((await fs.stat(path.join(home, ".omp", "agent", "gateway-token"))).mode & 0o777).toBe(0o600);
			expect(config.modelsError).toBeNull();
			for (const provider of queried) {
				expect(config.keys[provider]).toBe(gateway.providers.includes(provider) ? gateway.token : null);
				expect(config.headers[provider]?.["X-Review"]).toBeUndefined();
			}
			// omp reads the generated `find.enabled: false` as its "off" mode.
			expect(config.settings).toMatchObject({ providers: { openrouterVariant: "floor" }, find: { enabled: "off" } });
		},
		60_000,
	);

	it("refuses the provider id <<, which omp's YAML reader takes as a merge key, and writes nothing", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tb-agent-"));
		scratchDirs.push(home);
		const gateway: GatewayConfig = {
			url: "http://gateway.test",
			token: "no-auth",
			providers: ["openrouter", "<<"],
			openrouterVariant: "floor",
		};
		const vm = new TrialVm(localSandbox(home), "local", "x64", "/", {});

		await expect(writeAgentConfig(vm, gateway, { tools: ["read"], env: {} })).rejects.toThrow(/merge key/);
		expect(await Bun.file(path.join(home, ".omp", "agent", "models.yml")).exists()).toBe(false);
	});
});

describe("runTrial", () => {
	it.each([
		{ section: "[environment.env]", environmentEnv: { PI_ALIAS: "tb-task-env-bearer" }, verifierEnv: {} },
		{ section: "[verifier.env]", environmentEnv: {}, verifierEnv: { PI_ALIAS: "tb-task-env-bearer" } },
	])(
		"refuses a task whose $section holds the gateway token before it boots anything",
		async ({ environmentEnv, verifierEnv }) => {
			const trialDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tb-trial-"));
			scratchDirs.push(trialDir);
			const token = "tb-task-env-bearer";

			// vmond at a closed port: any boot attempt fails with a connection error instead.
			const result = await runTrial({
				task: {
					name: "token-task",
					dir: trialDir,
					instruction: "noop",
					image: "example.invalid/task:latest",
					cpus: 1,
					memoryMb: 512,
					storageMb: 1024,
					agentTimeoutSec: 5,
					verifierTimeoutSec: 5,
					environmentEnv,
					verifierEnv,
					difficulty: "",
					category: "",
				},
				model: "openrouter/test-model",
				binaries: {},
				agent: { tools: ["read"], env: {} },
				gateway: { url: "http://127.0.0.1:1", token, providers: ["openrouter"], openrouterVariant: "floor" },
				vmon: { url: "http://127.0.0.1:1", token: "", arch: "x64" },
				trialDir,
			});

			expect(result.status).toBe("error");
			expect(result.error).toMatch(/holds the gateway token/);
		},
	);
});
