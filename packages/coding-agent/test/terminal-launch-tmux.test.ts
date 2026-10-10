import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTerminalLauncher, type TerminalLaunchResult } from "../src/subprocess/terminal-launch";

const tmuxPath = Bun.which("tmux");

async function runTmux(
	socket: string,
	cwd: string,
	...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([tmuxPath ?? "tmux", "-S", socket, ...args], {
		cwd,
		env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function assertTmuxSuccess(result: { stdout: string; stderr: string; exitCode: number }, operation: string): void {
	if (result.exitCode !== 0) {
		throw new Error(`tmux ${operation} failed (exit ${result.exitCode}): ${result.stderr}`);
	}
}

const captureScript =
	"import * as fs from 'node:fs';\nconst destination = process.argv[2];\nconst temporary = destination + '.' + process.pid + '.tmp';\nawait Bun.write(temporary, JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd() }));\nawait fs.promises.rename(temporary, destination);\n";

function createSocketLauncher(socket: string) {
	return createTerminalLauncher({
		environment: () => ({}),
		runCli: async (argv, processCwd) => {
			const result = await runTmux(socket, processCwd, ...argv.slice(1));
			return { stdout: result.stdout, exitCode: result.exitCode };
		},
	});
}

/** Launch a command that runs {@link captureScript} and return what the pane process recorded. */
async function captureLaunch(
	root: string,
	recordPath: string,
	start: () => Promise<TerminalLaunchResult>,
): Promise<{ result: TerminalLaunchResult; record: unknown }> {
	const captured = Promise.withResolvers<void>();
	const watcher = fs.watch(root, (_event, filename) => {
		if (filename?.toString() === path.basename(recordPath)) captured.resolve();
	});
	watcher.once("error", captured.reject);
	try {
		const result = await start();
		await captured.promise;
		return { result, record: JSON.parse(await Bun.file(recordPath).text()) };
	} finally {
		watcher.close();
	}
}

it.skipIf(!tmuxPath)("preserves literal semicolons in tmux operands and direct command argv", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-tmux-injection-"));
	const socket = path.join(root, "private.sock");
	const seedSession = `tmux-injection-seed-${process.pid}`;
	const targetSession = `tmux-injection-target-${process.pid};`;
	const cwd = path.join(root, "working;");
	const capturePath = path.join(root, "capture.mjs");
	const recordPath = path.join(root, "captured.json");
	const trailingSemicolon = "argument;";
	const escapedTrailingSemicolon = "backslash\\;";
	const escapedCharacters = "left\\;middle\\\\right";
	let serverStarted = false;

	try {
		serverStarted = true;
		await fsp.mkdir(cwd, { recursive: true });
		await Bun.write(capturePath, captureScript);

		const seed = await runTmux(
			socket,
			root,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			seedSession,
			process.execPath,
			"-e",
			"process.stdin.resume()",
		);
		assertTmuxSuccess(seed, "private server setup");
		const namedTarget = await runTmux(
			socket,
			root,
			"new-session",
			"-d",
			"-s",
			targetSession.replace(/;/gu, "\\$&"),
			process.execPath,
			"-e",
			"process.stdin.resume()",
		);
		assertTmuxSuccess(namedTarget, "semicolon target setup");

		const pane = await runTmux(socket, root, "display-message", "-p", "-t", seedSession, "#{pane_id}");
		assertTmuxSuccess(pane, "pane lookup");
		const paneId = pane.stdout.trim();
		const launch = createSocketLauncher(socket);

		const { result: paneResult, record } = await captureLaunch(root, recordPath, () =>
			launch({
				multiplexer: "tmux",
				placement: "pane",
				target: paneId,
				cwd,
				command: [
					process.execPath,
					capturePath,
					recordPath,
					trailingSemicolon,
					escapedTrailingSemicolon,
					escapedCharacters,
				],
			}),
		);
		expect(paneResult).toMatchObject({ multiplexer: "tmux", placement: "pane" });
		expect(record).toEqual({
			argv: [trailingSemicolon, escapedTrailingSemicolon, escapedCharacters],
			cwd,
		});

		const windowResult = await launch({
			multiplexer: "tmux",
			placement: "window",
			target: targetSession,
			cwd,
			command: [process.execPath, "-e", "process.stdin.resume()"],
		});
		expect(windowResult).toMatchObject({ multiplexer: "tmux", placement: "window" });
		if (!windowResult.id) throw new Error("tmux new-window returned no ID");
		const actualTarget = await runTmux(
			socket,
			root,
			"display-message",
			"-p",
			"-t",
			windowResult.id,
			"#{session_name}",
		);
		assertTmuxSuccess(actualTarget, "launched window target lookup");
		expect(actualTarget.stdout.trim()).toBe(targetSession);

		const server = await runTmux(socket, root, "has-session", "-t", seedSession);
		assertTmuxSuccess(server, "private server liveness check");
	} finally {
		if (serverStarted) await runTmux(socket, root, "kill-server").catch(() => undefined);
		await fsp.rm(root, { recursive: true, force: true });
	}
});

it.skipIf(!tmuxPath)("opens a literal # cwd and runs shell mode without the tmux default-shell", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-tmux-format-"));
	const socket = path.join(root, "private.sock");
	const session = `tmux-format-${process.pid}`;
	// Unescaped, tmux runs #(…) as a job and expands #S, opening the pane in $HOME instead.
	const cwd = path.join(root, "d#(touch pwned)x#S##y");
	const capturePath = path.join(root, "capture.mjs");
	const recordPath = path.join(root, "captured.json");
	const argument = "it's $(literal) text";
	let serverStarted = false;

	try {
		serverStarted = true;
		await fsp.mkdir(cwd);
		await Bun.write(capturePath, captureScript);
		const seed = await runTmux(
			socket,
			root,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			session,
			process.execPath,
			"-e",
			"process.stdin.resume()",
		);
		assertTmuxSuccess(seed, "private server setup");
		// Stands in for fish/nu: a single-argument command handed to default-shell never runs.
		assertTmuxSuccess(
			await runTmux(socket, root, "set-option", "-g", "default-shell", "/bin/false"),
			"default-shell setup",
		);
		const pane = await runTmux(socket, root, "display-message", "-p", "-t", session, "#{pane_id}");
		assertTmuxSuccess(pane, "pane lookup");
		const launch = createSocketLauncher(socket);

		const { record } = await captureLaunch(root, recordPath, () =>
			launch({
				multiplexer: "tmux",
				placement: "pane",
				target: pane.stdout.trim(),
				cwd,
				execution: "shell",
				command: [process.execPath, capturePath, recordPath, argument],
			}),
		);
		expect(record).toEqual({ argv: [argument], cwd });
		expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, "pwned"))).toBe(false);
	} finally {
		if (serverStarted) await runTmux(socket, root, "kill-server").catch(() => undefined);
		await fsp.rm(root, { recursive: true, force: true });
	}
});
