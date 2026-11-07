import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

// `omp token` loads read-only settings and never calls Settings.init; the configured
// `!command` time limit must still bound the key command it runs.
it.skipIf(process.platform === "win32")(
	"omp token applies providers.commandTimeoutSeconds to a !command apiKey",
	async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-token-timeout-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const projectDir = path.join(tempDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "providers:\n  commandTimeoutSeconds: 1\n");
		await Bun.write(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  custom-proxy:",
				"    baseUrl: https://custom-proxy.example.com/v1",
				"    api: openai-completions",
				'    apiKey: "!sleep 4; printf %s slow-key"',
				"    models:",
				"      - id: custom-model",
				"        name: Custom Model",
				"",
			].join("\n"),
		);
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_CONFIG_FILES;
		delete env.PI_SHELL_PREFIX;
		delete env.PI_PROFILE;
		const proc = Bun.spawn([process.execPath, cliEntry, "token", "custom-proxy"], {
			cwd: projectDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		// The 1 s limit stops the 4 s helper, so no key comes out. With the 10 s default
		// the helper finishes and the command prints `slow-key`.
		expect(stdout).not.toContain("slow-key");
		expect(stderr).toContain('No active credential found for provider "custom-proxy"');
		expect(exitCode).toBe(1);
	},
	60_000,
);

// The settings a one-shot command binds must stop driving effects when the command
// ends on any path, including a credential discovery that throws.
it.skipIf(process.platform === "win32").each(["token", "usage"])(
	"omp %s releases its settings when credential discovery fails",
	async mode => {
		tempDir = path.join(os.tmpdir(), `pi-test-effects-release-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const projectDir = path.join(tempDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "providers:\n  commandTimeoutSeconds: 0.2\n");
		const requests: string[] = [];
		using broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({ error: "rejected" }, { status: 401 });
			},
		});
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			OMP_AUTH_BROKER_URL: `http://127.0.0.1:${broker.port}`,
			OMP_AUTH_BROKER_TOKEN: "test-token",
			OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
		};
		delete env.PI_CONFIG_FILES;
		delete env.PI_SHELL_PREFIX;
		delete env.PI_PROFILE;
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/effects-hold-discovery-failure.ts"), mode],
			{ cwd: projectDir, env, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		// Discovery really failed at the broker.
		expect(requests.length).toBeGreaterThan(0);
		expect(result.error).toContain("401");
		// The outer 30 s settings drive effects again, so the 1 s helper is not cut at 0.2 s.
		expect(result.restored).toBe(true);
		expect(result.value).toBe("after-command");
	},
	60_000,
);

// Releasing the hold was tested; taking it was not. A one-shot command that does not
// bind its own settings leaves whatever already drives effects in charge, and settings
// that drive effects outrank the operation's own scope — so the user's limit is the one
// thing that stops applying, which is invisible unless something else is bound.
it.skipIf(process.platform === "win32").each(["token", "usage"])(
	"omp %s binds its own settings, so an outer scope's limit does not run its broker token",
	async mode => {
		tempDir = path.join(os.tmpdir(), `pi-test-effects-bind-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const projectDir = path.join(tempDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		const requests: string[] = [];
		using broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({ error: "rejected" }, { status: 401 });
			},
		});
		await Bun.write(
			path.join(agentDir, "config.yml"),
			[
				"providers:",
				"  commandTimeoutSeconds: 0.2",
				"auth:",
				"  broker:",
				`    url: http://127.0.0.1:${broker.port}`,
				`    token: ${JSON.stringify("!sleep 1; printf %s broker-token")}`,
				"",
			].join("\n"),
		);
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_CONFIG_FILES;
		delete env.PI_SHELL_PREFIX;
		delete env.PI_PROFILE;
		delete env.OMP_AUTH_BROKER_URL;
		delete env.OMP_AUTH_BROKER_TOKEN;
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/effects-bound-command-timeout.ts"), mode],
			{ cwd: projectDir, env, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		// The 0.2 s limit the user configured cut the 1 s token helper, so there was no
		// token to connect with and the broker was never reached.
		expect(result.error).toContain("timed out after 0.2 s");
		expect(requests).toEqual([]);
	},
	60_000,
);
