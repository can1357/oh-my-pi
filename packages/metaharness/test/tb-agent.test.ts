import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Sandbox } from "@stencil-hq/vibemon";
import { writeAgentConfig } from "../src/tb/agent";
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
const hostileGateways: Array<{ name: string; gateway: (marker: string) => Partial<GatewayConfig> }> = [
	{ name: "a --gateway-token holding a quoted !command", gateway: m => ({ token: hostileValues(m).quotedCommand }) },
	{ name: "a --gateway-token holding a bare !command", gateway: m => ({ token: hostileValues(m).bareCommand }) },
	{ name: "a --gateway-token spelled like a variable omp's environment sets", gateway: () => ({ token: "HOME" }) },
	{
		name: "a --gateway-token that ends a heredoc",
		gateway: m => ({ token: hostileValues(m).heredoc("gateway-token", "OMP_MODELS_EOF") }),
	},
	{
		name: "a provider id that gives another provider a command apiKey",
		gateway: m => ({ providers: [hostileValues(m).providerWithApiKey] }),
	},
	{
		name: "a provider id that ends a heredoc",
		gateway: m => ({ providers: [hostileValues(m).heredoc("openrouter", "OMP_MODELS_EOF")] }),
	},
	{ name: "a gateway URL that adds a command header", gateway: m => ({ url: hostileValues(m).urlWithHeader }) },
];

describe("writeAgentConfig", () => {
	// Each case starts a separate omp config reader process.
	it.each(hostileGateways)(
		"makes the guest omp read $name as data and run nothing",
		async ({ gateway: hostile }) => {
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

			const launchEnv = await writeAgentConfig(vm, gateway, { tools: ["read"], env: {} });
			const queried = [...new Set([...gateway.providers, "openrouter"])];
			const config = await consumeOmpConfig(home, queried, launchEnv);

			expect(await Bun.file(marker).exists()).toBe(false);
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
});
