import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Launch-mode selection without a terminal on stdin (scripts, CI, `</dev/null`).
// Before: a bare or prompt-carrying launch chose interactive mode, booted the TUI
// against a closed stdin, and exited 129 with no output.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const TTY_ERROR = "interactive mode requires a terminal";
/** Credential-bearing variables that could hand the child a usable model. */
const CREDENTIAL_ENV =
	/(_API_KEY|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_CREDENTIALS|^AWS_PROFILE|^GOOGLE_CLOUD_PROJECT)$/;

interface LaunchRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function launchWithoutTerminal(
	tempDir: TempDir,
	args: string[],
	{ extensionDiscovery = false }: { extensionDiscovery?: boolean } = {},
): Promise<LaunchRun> {
	const home = tempDir.join("home");
	fs.mkdirSync(home, { recursive: true });
	// Isolated home and no credentials: print mode can only end at the headless
	// "No models available" exit, which the interactive path never reaches.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (CREDENTIAL_ENV.test(key)) delete env[key];
	}
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"PI_CONFIG_FILES",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
	]) {
		delete env[key];
	}
	const discoveryArgs = extensionDiscovery ? [] : ["--no-extensions"];
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", ...discoveryArgs, ...args], {
		cwd: tempDir.path(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Write an extension registering flag `name` that reports the value it received
 * on exit — usage failures exit before any session event fires.
 */
async function writeFlagExtension(
	tempDir: TempDir,
	name: string,
	type: "string" | "boolean" = "string",
): Promise<string> {
	const extensionPath = tempDir.join(`${name}-extension.ts`);
	await Bun.write(
		extensionPath,
		[
			"export default function (pi) {",
			`\tpi.registerFlag(${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });`,
			`\tprocess.once("exit", () => process.stderr.write("EXT_FLAG=" + pi.getFlag(${JSON.stringify(name)}) + "\\n"));`,
			"}",
		].join("\n"),
	);
	return extensionPath;
}

// Each case cold-starts the CLI graph in a child process; the budget covers that transpile.
describe("launch without a terminal on stdin", () => {
	it("fails a bare launch with a usage error and exit 2", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bare-");
		const run = await launchWithoutTerminal(tempDir, []);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stdout).toBe("");
	}, 30_000);

	it("runs a prompt argument headless in print mode instead of the TUI", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-prompt-");
		const run = await launchWithoutTerminal(tempDir, ["say ok"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).toContain("No models available.");
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);

	it("reports an invalid enum value before the terminal requirement", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bad-mode-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --mode value: "bogus"');
		expect(run.stderr).not.toContain(TTY_ERROR);
	}, 30_000);

	it("delivers an extension-owned --mode before failing on the missing terminal", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-mode-");
		const extensionPath = await writeFlagExtension(tempDir, "mode");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "compact"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).not.toContain("Invalid --mode value");
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stderr).toContain("EXT_FLAG=compact");
	}, 30_000);

	it("treats an extension flag value as a flag value, not a prompt, on a bare launch", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-value-");
		const extensionPath = await writeFlagExtension(tempDir, "spawn-peer");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--spawn-peer", "reviewer"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stderr).not.toContain("No models available.");
		expect(run.stderr).toContain("EXT_FLAG=reviewer");
	}, 30_000);

	it("still runs a real prompt after an extension flag value in print mode", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-prompt-");
		const extensionPath = await writeFlagExtension(tempDir, "spawn-peer");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--spawn-peer", "reviewer", "say ok"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).toContain("No models available.");
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);

	it("runs the prompt a boolean extension flag shadowing --mode leaves behind", async () => {
		// Bootstrap reads `--mode compact` as an invalid built-in mode; with the
		// extension's boolean `mode`, `compact` is the prompt.
		using tempDir = TempDir.createSync("@omp-non-tty-ext-bool-");
		const extensionPath = await writeFlagExtension(tempDir, "mode", "boolean");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "compact"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).not.toContain("Invalid --mode value");
		expect(run.stderr).toContain("No models available.");
		expect(run.stderr).toContain("EXT_FLAG=true");
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);
});

describe("mode-dependent guards defer to flag-value errors", () => {
	it("starts rpc-ui with headless extensions instead of rejecting --no-ui", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-rpc-ui-");
		// An explicit catalog model starts RPC without credentials, so the result
		// does not depend on which keyless local models the host provides.
		const run = await launchWithoutTerminal(tempDir, [
			"--mode",
			"rpc-ui",
			"--no-ui",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		]);

		expect(run.stderr).not.toContain("--no-ui requires --mode rpc");
		expect(run.exitCode, run.stderr).toBe(0);
		expect(
			run.stdout
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line)),
		).toContainEqual(expect.objectContaining({ type: "ready" }));
	}, 30_000);

	it("reports an invalid --mode (exit 2) before judging --no-ui against it", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-bad-mode-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "bogus", "--no-ui"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --mode value: "bogus"');
		expect(run.stderr).not.toContain("--no-ui requires --mode rpc");
	}, 30_000);

	it("still rejects --no-ui outside rpc mode when the flags are otherwise valid", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-text-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "json", "--no-ui"]);

		expect(run.exitCode, run.stderr).toBe(1);
		expect(run.stderr).toContain("Error: --no-ui requires --mode rpc");
	}, 30_000);
});

describe("ACP launch flag validation", () => {
	it("fails an invalid --thinking before serving when no session can load an extension", async () => {
		using tempDir = TempDir.createSync("@omp-acp-bad-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "acp", "--thinking", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --thinking value: "bogus"');
		expect(run.stdout).toBe("");
	}, 30_000);

	it("serves without binding an explicit extension that may own the rejected flag", async () => {
		using tempDir = TempDir.createSync("@omp-acp-ext-thinking-");
		const extensionPath = await writeFlagExtension(tempDir, "thinking");
		// Closed stdin ends the ACP transport right after startup, so a served launch exits 0.
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "acp", "--thinking", "bogus"]);

		expect(run.stderr).not.toContain("Invalid --thinking value");
		expect(run.exitCode, run.stderr).toBe(0);
		// The extension reports at exit only if its factory ran: no session opened,
		// so validation must not have bound it either.
		expect(run.stderr).not.toContain("EXT_FLAG=");
	}, 30_000);

	it("leaves the verdict to each session/new when discovery can load per-cwd extensions", async () => {
		// A session cwd's own extension may own `--thinking`; the launch cwd cannot rule it out.
		using tempDir = TempDir.createSync("@omp-acp-discovery-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "acp", "--thinking", "bespoke"], {
			extensionDiscovery: true,
		});

		expect(run.stderr).not.toContain("Invalid --thinking value");
		expect(run.exitCode, run.stderr).toBe(0);
	}, 30_000);
});

describe("--export flag validation", () => {
	it("reports an invalid enum value instead of exporting", async () => {
		using tempDir = TempDir.createSync("@omp-export-bad-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--export", "missing.jsonl", "--thinking", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --thinking value: "bogus"');
		expect(run.stdout).not.toContain("Exported to:");
	}, 30_000);
});
