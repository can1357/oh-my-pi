import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const envModulePath = path.resolve(import.meta.dir, "../../src/sandbox/env.ts");

const tempDirs: TempDir[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

interface ContainedEnvProbe {
	/** `containedEnv(process.env)`, restricted to the probe names. */
	live: Record<string, string>;
	/** `containedEnv(process.env, { FOO_API_KEY: <agent value> })`, restricted to the probe names. */
	explicit: Record<string, string>;
	/** The live process environment, restricted to the probe names. */
	process: Record<string, string>;
}

/**
 * The dotenv loader runs at module load, so each case is a fresh process whose HOME, agent dir and
 * project are temp dirs.
 */
async function runProbe(launch: Record<string, string>): Promise<ContainedEnvProbe> {
	const home = TempDir.createSync("@pi-contained-env-");
	tempDirs.push(home);
	const agentDir = home.join("agent");
	const cwd = home.join("project");
	await Promise.all([
		Bun.write(path.join(agentDir, ".env"), "FOO_API_KEY=agent-secret\nOMP_PROBE_TOKEN=omp-token\n"),
		Bun.write(home.join(".omp", ".env"), "CONFIG_ROOT_PROBE_KEY=config-root-secret\n"),
		Bun.write(home.join(".env"), "HOME_PROBE_KEY=home-secret\n"),
		Bun.write(path.join(cwd, ".env"), "PROJECT_PROBE_KEY=project-value\n"),
	]);
	const names = [
		"FOO_API_KEY",
		"OMP_PROBE_TOKEN",
		"PI_PROBE_TOKEN",
		"CONFIG_ROOT_PROBE_KEY",
		"HOME_PROBE_KEY",
		"PROJECT_PROBE_KEY",
		"SHELL_PROBE_KEY",
	];
	const script = [
		`import { containedEnv } from ${JSON.stringify(envModulePath)};`,
		`const names = ${JSON.stringify(names)};`,
		"const pick = env => Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));",
		"process.stdout.write(JSON.stringify({",
		"  live: pick(containedEnv(process.env)),",
		"  explicit: pick(containedEnv(process.env, { FOO_API_KEY: 'agent-secret' })),",
		"  process: pick(process.env),",
		"}));",
	].join("\n");
	const inherited: Record<string, string | undefined> = { ...process.env };
	// Every variable that picks the profile or the dirs, so the probe reads exactly these fixtures.
	for (const name of [
		...names,
		"OMP_PROFILE",
		"PI_PROFILE",
		"PI_CONFIG_DIR",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	]) {
		inherited[name] = undefined;
	}
	const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
		cwd,
		env: {
			...inherited,
			HOME: home.path(),
			USERPROFILE: home.path(),
			PI_CODING_AGENT_DIR: agentDir,
			...launch,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout);
}

describe("containedEnv", () => {
	it.skipIf(process.platform === "win32")(
		"drops values omp loaded from its own .env files and keeps everything else",
		async () => {
			const result = await runProbe({ SHELL_PROBE_KEY: "shell-value" });
			// The loader put every own-file value into the process env (OMP_ mirrored to PI_).
			expect(result.process).toEqual({
				FOO_API_KEY: "agent-secret",
				OMP_PROBE_TOKEN: "omp-token",
				PI_PROBE_TOKEN: "omp-token",
				CONFIG_ROOT_PROBE_KEY: "config-root-secret",
				HOME_PROBE_KEY: "home-secret",
				PROJECT_PROBE_KEY: "project-value",
				SHELL_PROBE_KEY: "shell-value",
			});
			// A contained process sees only the shell export and the project .env.
			expect(result.live).toEqual({ PROJECT_PROBE_KEY: "project-value", SHELL_PROBE_KEY: "shell-value" });
			// An explicit child value survives even when it equals the own-file value.
			expect(result.explicit.FOO_API_KEY).toBe("agent-secret");
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps a shell-exported value that differs from the own .env file",
		async () => {
			const result = await runProbe({ FOO_API_KEY: "shell-key" });
			expect(result.process.FOO_API_KEY).toBe("shell-key");
			expect(result.live.FOO_API_KEY).toBe("shell-key");
		},
		20_000,
	);
});
