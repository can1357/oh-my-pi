import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTerminalLauncher } from "../src/subprocess/terminal-launch";

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
		await Bun.write(
			capturePath,
			"import * as fs from 'node:fs';\nconst destination = process.argv[2];\nconst temporary = destination + '.' + process.pid + '.tmp';\nawait Bun.write(temporary, JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd() }));\nawait fs.promises.rename(temporary, destination);\n",
		);

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
		const launch = createTerminalLauncher({
			environment: () => ({}),
			runCli: async (argv, processCwd) => {
				const result = await runTmux(socket, processCwd, ...argv.slice(1));
				return { stdout: result.stdout, exitCode: result.exitCode };
			},
		});

		const captured = Promise.withResolvers<void>();
		const watcher = fs.watch(root, (_event, filename) => {
			if (filename?.toString() === path.basename(recordPath)) captured.resolve();
		});
		watcher.once("error", captured.reject);
		try {
			const paneResult = await launch({
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
			});
			expect(paneResult).toMatchObject({ multiplexer: "tmux", placement: "pane" });
			await captured.promise;
			expect(JSON.parse(await Bun.file(recordPath).text())).toEqual({
				argv: [trailingSemicolon, escapedTrailingSemicolon, escapedCharacters],
				cwd,
			});
		} finally {
			watcher.close();
		}

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
