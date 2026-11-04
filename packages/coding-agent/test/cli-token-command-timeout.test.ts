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
