import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Sandbox } from "@stencil-hq/vibemon";
import { writeAgentConfig } from "../src/tb/agent";
import type { GatewayConfig } from "../src/tb/types";
import { TrialVm } from "../src/tb/vmon";

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

/** A value that, if a shell reads it as script text, ends the heredoc and writes `PWNED` to `marker`. */
function heredocBreakout(prefix: string, marker: string): string {
	return `${prefix}\nOMP_MODELS_EOF\nprintf PWNED > ${marker}\n: <<'OMP_MODELS_EOF'`;
}

describe("writeAgentConfig", () => {
	it.each([
		{ origin: "--model provider", field: "providers" },
		{ origin: "--gateway-token", field: "token" },
	] as const)("writes a $origin value into models.yml as data", async ({ field }) => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tb-agent-"));
		scratchDirs.push(home);
		const marker = path.join(home, "marker");
		const value = heredocBreakout(field === "providers" ? "openrouter" : "gateway-token", marker);
		const gateway: GatewayConfig = {
			url: "http://gateway.test",
			token: field === "token" ? value : "no-auth",
			providers: field === "providers" ? [value] : ["openrouter"],
			openrouterVariant: "floor",
		};
		const vm = new TrialVm(localSandbox(home), "local", "x64", "/", {});

		await writeAgentConfig(vm, gateway, { tools: ["read"], env: {} });

		expect(await Bun.file(marker).exists()).toBe(false);
		const models = await Bun.file(path.join(home, ".omp/agent/models.yml")).text();
		expect(models).toContain(`printf PWNED > ${marker}\n`);
		expect(await Bun.file(path.join(home, ".omp/agent/config.yml")).text()).toContain("openrouterVariant: floor\n");
	});
});
