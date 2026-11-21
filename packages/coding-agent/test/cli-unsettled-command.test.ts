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
//
// Regression #13470: on Windows Bun emits `beforeExit` while `omp update` still has I/O in
// flight, then keeps running the loop; the command completed but exited 1 with the diagnostic.
// Preloads that resume work from a `beforeExit` listener reproduce that runtime state.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const settingsUrl = new URL("../src/config/settings.ts", import.meta.url).href;
const DIAGNOSTIC = "ended before completing";

/** How the preload drives `Settings.init`: untouched, stalled forever, or resumed after a drain. */
type SettingsInitMode = "real" | "stall" | "resume-after-drain" | "exit-after-drain";

const SETTINGS_INIT_PRELOADS: Record<Exclude<SettingsInitMode, "real">, string[]> = {
	// Settings initialization never settles and holds no handle.
	stall: ["Settings.init = () => Promise.withResolvers<never>().promise;"],
	// Work is pending with no live handle when `beforeExit` fires, then the loop runs on and completes it.
	"resume-after-drain": [
		"const init = Settings.init;",
		"Settings.init = options => {",
		"\tconst gate = Promise.withResolvers<void>();",
		'\tprocess.once("beforeExit", () => setImmediate(gate.resolve));',
		"\treturn gate.promise.then(() => init.call(Settings, options));",
		"};",
	],
	// The loop runs on after `beforeExit` and the process exits explicitly with the entry pending.
	// The child needs a real ref'd handle here to resume its loop; the short delay only keeps the
	// explicit exit on a later loop turn than the drain, as any resumed command's exit would be.
	"exit-after-drain": [
		"Settings.init = () => {",
		'\tprocess.once("beforeExit", () => setTimeout(() => process.exit(0), 20));',
		"\treturn Promise.withResolvers<never>().promise;",
		"};",
	],
};

interface ConfigSetRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	configPath: string;
}

async function runConfigSet(tempDir: TempDir, settingsInit: SettingsInitMode): Promise<ConfigSetRun> {
	const home = tempDir.join("home");
	fs.mkdirSync(home);
	const preloadArgs: string[] = [];
	if (settingsInit !== "real") {
		const preloadPath = tempDir.join("settings-init.ts");
		await Bun.write(
			preloadPath,
			[`import { Settings } from ${JSON.stringify(settingsUrl)};`, ...SETTINGS_INIT_PRELOADS[settingsInit]].join(
				"\n",
			),
		);
		preloadArgs.push("--preload", preloadPath);
	}
	// The child must resolve its agent dir from the isolated home, not an inherited override or profile.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.XDG_CACHE_HOME;
	delete env.XDG_CONFIG_HOME;
	delete env.XDG_DATA_HOME;
	delete env.XDG_STATE_HOME;
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
		const run = await runConfigSet(tempDir, "stall");

		expect(run.exitCode, run.stderr).toBe(1);
		// Names the stalled subcommand so automation logs show what failed, without its arguments.
		expect(run.stderr).toContain(`\`omp config\` ${DIAGNOSTIC}`);
		expect(run.stderr).not.toContain("collab.autoStart");
		expect(run.stdout).toBe("");
		expect(fs.existsSync(run.configPath)).toBe(false);
	}, 30_000);

	it("keeps a completed command's exit 0 and output", async () => {
		using tempDir = TempDir.createSync("@omp-cli-settled-");
		const run = await runConfigSet(tempDir, "real");

		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stdout).toContain("Set collab.autoStart = control");
		expect(run.stderr).not.toContain(DIAGNOSTIC);
		expect(Bun.YAML.parse(await Bun.file(run.configPath).text())).toMatchObject({ collab: { autoStart: "control" } });
	}, 30_000);

	it("keeps exit 0 when the loop resumes after a premature beforeExit and the command completes", async () => {
		using tempDir = TempDir.createSync("@omp-cli-resumed-");
		const run = await runConfigSet(tempDir, "resume-after-drain");

		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stdout).toContain("Set collab.autoStart = control");
		expect(run.stderr).not.toContain(DIAGNOSTIC);
		expect(Bun.YAML.parse(await Bun.file(run.configPath).text())).toMatchObject({ collab: { autoStart: "control" } });
	}, 30_000);

	it("keeps an explicit exit's code when the loop resumed after a premature beforeExit", async () => {
		using tempDir = TempDir.createSync("@omp-cli-exited-");
		const run = await runConfigSet(tempDir, "exit-after-drain");

		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stderr).not.toContain(DIAGNOSTIC);
	}, 30_000);
});
