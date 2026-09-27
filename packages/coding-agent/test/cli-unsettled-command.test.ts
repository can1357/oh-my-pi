import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Regression: `omp config set collab.autoStart control` on a fresh Windows profile over WinRM
// exited 0 with no output and never wrote config.yml. The CLI entry is a floating `runCli()`
// call (top-level await breaks `--bytecode` builds), so a one-shot command whose await never
// settles and holds no live handle let the event loop drain, and Bun exited 0: an unfinished
// command reported as success. The process entry now fails that drain with exit 1 and a
// diagnostic. A preload makes `Settings.init` never settle to reach the same state. #12441
// reports the same silent exit 0 for `omp auth-broker token` on a fresh Windows profile; the
// stalled await itself is still unidentified.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const settingsUrl = new URL("../src/config/settings.ts", import.meta.url).href;
const DIAGNOSTIC = "ended before completing";

interface ConfigSetRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	configPath: string;
}

async function runConfigSet(tempDir: TempDir, options: { stallSettingsInit: boolean }): Promise<ConfigSetRun> {
	const home = tempDir.join("home");
	fs.mkdirSync(home);
	const preloadArgs: string[] = [];
	if (options.stallSettingsInit) {
		const preloadPath = tempDir.join("stall-settings-init.ts");
		await Bun.write(
			preloadPath,
			[
				`import { Settings } from ${JSON.stringify(settingsUrl)};`,
				"// Settings initialization never settles and holds no handle.",
				"Settings.init = () => Promise.withResolvers<never>().promise;",
			].join("\n"),
		);
		preloadArgs.push("--preload", preloadPath);
	}
	// The child must resolve its agent dir from the isolated home, not an inherited override or profile.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	const proc = Bun.spawn(
		[process.execPath, ...preloadArgs, cliEntry, "config", "set", "collab.autoStart", "control"],
		{ cwd: tempDir.path(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr, configPath: path.join(home, ".omp", "agent", "config.yml") };
}

// Each case cold-starts the CLI graph in a child process; the budget covers that transpile.
describe("one-shot CLI command settlement", () => {
	it("exits 1 with a diagnostic when the command's work never settles", async () => {
		using tempDir = TempDir.createSync("@omp-cli-unsettled-");
		const run = await runConfigSet(tempDir, { stallSettingsInit: true });

		expect(run.exitCode, run.stderr).toBe(1);
		// Names the stalled subcommand so automation logs show what failed, without its arguments.
		expect(run.stderr).toContain(`\`omp config\` ${DIAGNOSTIC}`);
		expect(run.stderr).not.toContain("collab.autoStart");
		expect(run.stdout).toBe("");
		expect(fs.existsSync(run.configPath)).toBe(false);
	}, 30_000);

	it("keeps a completed command's exit 0 and output", async () => {
		using tempDir = TempDir.createSync("@omp-cli-settled-");
		const run = await runConfigSet(tempDir, { stallSettingsInit: false });

		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stdout).toContain("Set collab.autoStart = control");
		expect(run.stderr).not.toContain(DIAGNOSTIC);
		expect(Bun.YAML.parse(await Bun.file(run.configPath).text())).toMatchObject({ collab: { autoStart: "control" } });
	}, 30_000);
});
