/**
 * Contract: a launch whose config file names an unknown path token exits 1 with one
 * `Error:` line naming the file and the setting. No raw fatal dump (stack frames) is written,
 * and the process exits even when RPC mode holds stdin open.
 * A missing `--config` overlay exits 1 naming the overlay path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

/** Stack frames, the shape of postmortem's raw fatal dump; a clean error has none. */
const STACK_FRAME_RE = /(?:^|\n)\s+at [^\n]*:\d+:\d+/;

/**
 * Upper bound for one launch; a launch that hangs is killed so the test fails instead of stalling.
 * A real watchdog on a child process: fake timers cannot reach the child's clock.
 */
const LAUNCH_TIMEOUT_MS = 25_000;

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * Launches the CLI in an isolated home and environment (as cli-non-tty-launch.test.ts does), with
 * `PI_CODING_AGENT_DIR` set to `<root>/agent` and `<root>/workspace` as the working directory.
 */
async function launch(
	root: string,
	args: string[],
	options: { holdStdinOpen?: boolean } = {},
): Promise<{ agentDir: string; exitCode: number; stdout: string; stderr: string }> {
	const agentDir = path.join(root, "agent");
	const workspace = path.join(root, "workspace");
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		NO_COLOR: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", "--no-extensions", ...args], {
		cwd: workspace,
		env,
		stdin: options.holdStdinOpen ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const killTimer = setTimeout(() => proc.kill(), LAUNCH_TIMEOUT_MS);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { agentDir, exitCode, stdout, stderr };
	} finally {
		clearTimeout(killTimer);
		proc.kill();
	}
}

/** A scratch root with the agent and workspace directories created. */
function scratchRoot(): string {
	const dir = TempDir.createSync("@omp-cli-config-load-error-");
	tempDirs.push(dir);
	const root = fs.realpathSync(dir.path());
	fs.mkdirSync(path.join(root, "agent"));
	fs.mkdirSync(path.join(root, "workspace"));
	return root;
}

describe("CLI launch with an unknown path token in config.yml", () => {
	it("exits 1 with a one-line error naming the config file and setting, and no stack", async () => {
		const root = scratchRoot();
		fs.writeFileSync(
			path.join(root, "agent", "config.yml"),
			'sandbox:\n  filesystem:\n    allowWrite:\n      - "${HOME}/x"\n',
		);

		const { agentDir, exitCode, stdout, stderr } = await launch(root, ["--print", "hello"]);

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain(
			`Error: Failed to load config file ${path.join(agentDir, "config.yml")}, Validate(sandbox.filesystem.allowWrite) error: sandbox.filesystem.allowWrite: unknown path token \${HOME} in "\${HOME}/x"`,
		);
		expect(stderr).not.toMatch(STACK_FRAME_RE);
	}, 30_000);

	it("exits 1 under --mode rpc while stdin stays open, with exactly one Error line", async () => {
		const root = scratchRoot();
		fs.writeFileSync(
			path.join(root, "agent", "config.yml"),
			'sandbox:\n  filesystem:\n    allowWrite:\n      - "${HOME}/x"\n',
		);

		// RPC mode holds a pending stdin read; a launch that only sets the exit code would hang here until killed.
		const { exitCode, stderr } = await launch(root, ["--mode", "rpc"], { holdStdinOpen: true });

		expect(exitCode).toBe(1);
		expect(stderr.match(/^Error: /gm)).toHaveLength(1);
		expect(stderr).toContain("Validate(sandbox.filesystem.allowWrite) error:");
		expect(stderr).not.toMatch(STACK_FRAME_RE);
	}, 30_000);

	it("exits 1 naming the overlay when a --config overlay is missing", async () => {
		const root = scratchRoot();
		const missingOverlay = path.join(root, "missing.yml");

		const { exitCode, stderr } = await launch(root, ["--config", missingOverlay, "--print", "hello"]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain(`Config overlay not found: ${missingOverlay}`);
	}, 30_000);
});
