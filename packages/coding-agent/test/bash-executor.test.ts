import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, type ShellMinimizerSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyDirenvPreflight,
	buildMinimizerOptions,
	executeBash,
	isPersistentShellCdCommand,
} from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import * as direnvModule from "@oh-my-pi/pi-coding-agent/exec/direnv";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import * as shellSnapshot from "@oh-my-pi/pi-coding-agent/utils/shell-snapshot";
import type { Shell, ShellRunResult } from "@oh-my-pi/pi-natives";
import * as piNatives from "@oh-my-pi/pi-natives";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Matches the schema default for `tools.artifactHeadBytes` (20 KB) used by
// OutputSink when bash-executor pulls settings via resolveOutputSinkHeadBytes.
const ARTIFACT_HEAD_BYTES_DEFAULT = 20 * 1024;
const BACKGROUND_COMPLETION_RACE_MS = 750;
// Killed-vs-orphaned proof: the command's marker write is gated on a `release`
// file the test creates only AFTER the cancel has landed. A truly killed process
// never reaches the write; an orphan still polling reacts within one poll
// interval. This replaces the old "sleep a fixed marker delay, then look"
// approach, which paid that delay in wall-clock time on every run.
const KILL_POLL_SECONDS = "0.01"; // a survivor re-checks `release` every ~10ms
const KILL_SETTLE_MS = 25; // let the kill signal land before we touch `release`
const KILL_REACT_MS = 50; // > one poll interval: a survivor would write its marker

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-exec-"));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function configureBashUserShell(homeDir: string): boolean {
	if (process.platform === "win32" || !fs.existsSync("/bin/bash")) return false;
	Settings.instance.set("shellPath", "/bin/bash");
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		env: {
			PATH: Bun.env.PATH ?? "",
			HOME: homeDir,
			SHELL: "/bin/bash",
		},
		prefix: undefined,
	});
	return true;
}

/** Resolve once `predicate()` holds or `deadlineMs` passes, polling every 2ms. */
async function pollUntil(predicate: () => boolean, deadlineMs: number): Promise<void> {
	while (!predicate() && Date.now() < deadlineMs) {
		await Bun.sleep(2);
	}
}

/**
 * Shell that blocks until `release` exists, then writes `marker`. Optionally
 * touches `started` first so a test can wait until the command is actually
 * running before cancelling it.
 */
function releaseGuardedWrite(marker: string, release: string, started?: string): string {
	const touch = started ? `touch ${shellQuote(started)}; ` : "";
	return `${touch}while [ ! -f ${shellQuote(release)} ]; do sleep ${KILL_POLL_SECONDS}; done; echo done > ${shellQuote(marker)}`;
}

/**
 * After a cancel has been observed, prove the command was killed (not orphaned):
 * settle so the kill lands, unblock a would-be survivor via `release`, then give
 * it more than one poll interval to write. A killed command never writes `marker`.
 */
async function expectMarkerNeverWritten(marker: string, release: string): Promise<void> {
	await Bun.sleep(KILL_SETTLE_MS);
	fs.writeFileSync(release, "");
	await Bun.sleep(KILL_REACT_MS);
	expect(fs.existsSync(marker)).toBe(false);
}

describe("executeBash", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("omits minimizer options when the feature is disabled", () => {
		const group: ShellMinimizerSettings = {
			enabled: false,
			settingsPath: undefined,
			only: [],
			except: [],
			maxCaptureBytes: 4096,
			sourceOutlineLevel: "default",
			legacyFilters: undefined,
		};
		expect(buildMinimizerOptions(group)).toBeUndefined();
	});

	it.each([
		["cd", true],
		[" cd child ", true],
		["cd\tchild", true],
		["cd -", true],
		["cd --", true],
		["cd -- -P", true],
		['cd "#note"', true],
		['cd "two words"', true],
		["cd '~/literal'", true],
		["cd +1", false],
		['cd "+1"', false],
		["cd -- -1", false],
		["cd -- '+2'", false],
		["cd\npwd", false],
		["cd\rpwd", false],
		["cd -P", false],
		["cd -L /tmp", false],
		["cd #note", false],
		["cd child && pwd", false],
		["cd two words", false],
		['cd ""', false],
		["cd ~other", false],
		["echo cd child", false],
	] as const)("classifies persistent-shell cd routing for %j", (command, expected) => {
		expect(isPersistentShellCdCommand(command)).toBe(expected);
	});
	it("returns non-zero exit codes without cancellation", async () => {
		const result = await executeBash("exit 7", { cwd: tempDir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
	});

	it("honors cwd", async () => {
		const result = await executeBash("pwd", { cwd: tempDir, timeout: 5000 });
		expect(result.output.trim()).toBe(tempDir);
	});

	it("passes the full direnv-load budget when the command deadline is disabled (timeout: 0)", async () => {
		// A disabled command deadline (`timeout: 0`) must NOT collapse the direnv
		// export window to 0 ms — that would make AbortSignal.timeout(0) abort the
		// load instantly, silently dropping the repo's direnv env. The load keeps
		// its full `bash.direnvLoadTimeoutMs` budget. Spying on loadDirenvEnv both
		// captures the timeoutMs and short-circuits real direnv (null diff = no-op).
		const budget = (await Settings.init()).get("bash.direnvLoadTimeoutMs");
		const spy = vi.spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue(null);

		await executeBash("true", { cwd: tempDir, timeout: 0 });

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.timeoutMs).toBe(budget);
		expect(spy.mock.calls[0][1]?.timeoutMs).not.toBe(0);
	});

	it("clamps the direnv-load budget to a positive command timeout smaller than it", async () => {
		// A positive caller timeout below the budget DOES clamp the direnv window,
		// proving the fix only relaxes the `timeout: 0` case and did not disable
		// clamping wholesale. Setting and options.timeout are both milliseconds.
		const budget = (await Settings.init()).get("bash.direnvLoadTimeoutMs");
		const callerTimeout = 5;
		expect(callerTimeout).toBeLessThan(budget);
		const spy = vi.spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue(null);

		await executeBash("true", { cwd: tempDir, timeout: callerTimeout });

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.timeoutMs).toBe(Math.min(budget, callerTimeout));
	});

	it("honors symlinked cwd requests in persistent shells", async () => {
		if (process.platform === "win32") {
			return;
		}
		if (!configureBashUserShell(tempDir)) return;

		const realDir = path.join(tempDir, "real");
		const linkDir = path.join(tempDir, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");
		const sessionKey = `cwd-symlink-${Date.now()}`;

		await executeBash("pwd", { sessionKey, cwd: realDir, timeout: 5000, useUserShell: true });
		const result = await executeBash("pwd", { sessionKey, cwd: linkDir, timeout: 5000, useUserShell: true });

		expect(result.output.trim()).toBe(linkDir);
		expect(result.workingDir).toBe(linkDir);
	});

	it("passes env vars", async () => {
		const result = await executeBash("echo $PI_TEST_ENV", {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("hello");
	});

	it("applies non-interactive environment defaults", async () => {
		const result = await executeBash('echo "$AGENT:$GIT_TERMINAL_PROMPT:$PI_TEST_ENV"', {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("1:0:hello");
	});

	it("runs non-bash shellPath commands through the configured shell", async () => {
		if (process.platform === "win32") {
			return;
		}

		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shellpath-"));
		const marker = path.join(shellDir, "fake-shell-ran");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const fakeShell = path.join(shellDir, "fake-shell");
		fs.writeFileSync(
			fakeShell,
			`#!/bin/sh
printf '%s\\n' "$*" > '${markerEscaped}'
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-c" ]; then
		shift
		exec /bin/sh -c "$1"
	fi
	shift
done
exit 64
`,
		);
		fs.chmodSync(fakeShell, 0o755);
		Settings.instance.set("shellPath", fakeShell);

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: fakeShell,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		try {
			const result = await executeBash("printf 'shell-ok\\n'", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "custom-shell-path",
				useUserShell: true,
			});

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("shell-ok");
			expect(fs.readFileSync(marker, "utf8")).toContain("-l -c");
		} finally {
			removeSyncWithRetries(shellDir);
		}
	});

	it("persists cd, bare cd, and cd - when shortcut commands use a non-bash user shell", async () => {
		if (process.platform === "win32") return;

		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cd-shellpath-"));
		const marker = path.join(shellDir, "fake-shell-ran");
		const fakeShell = path.join(shellDir, "fake-shell");
		const childDir = path.join(tempDir, "child");
		fs.mkdirSync(childDir);
		fs.writeFileSync(
			fakeShell,
			`#!/bin/sh
printf '%s\\n' "$*" > ${shellQuote(marker)}
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-c" ]; then
		shift
		exec /bin/sh -c "$1"
	fi
	shift
done
exit 64
`,
		);
		fs.chmodSync(fakeShell, 0o755);
		Settings.instance.set("shellPath", fakeShell);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: fakeShell,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		try {
			const sessionKey = `persistent-cd-${Date.now()}`;
			const moved = await executeBash("cd child", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey,
				useUserShell: true,
			});

			expect(moved.exitCode).toBe(0);
			expect(moved.workingDir).toBe(childDir);
			expect(fs.existsSync(marker)).toBe(false);

			const home = await executeBash("cd", {
				cwd: childDir,
				timeout: 5000,
				sessionKey,
				useUserShell: true,
			});

			expect(home.exitCode).toBe(0);
			expect(home.workingDir).toBe(tempDir);
			expect(fs.existsSync(marker)).toBe(false);

			const returned = await executeBash("cd -", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey,
				useUserShell: true,
			});

			expect(returned.exitCode).toBe(0);
			expect(returned.workingDir).toBe(childDir);
			expect(fs.existsSync(marker)).toBe(false);

			const pwd = await executeBash("pwd", {
				cwd: childDir,
				timeout: 5000,
				sessionKey,
				useUserShell: true,
			});
			expect(pwd.output.trim()).toBe(childDir);
			expect(fs.existsSync(marker)).toBe(true);
		} finally {
			removeSyncWithRetries(shellDir);
		}
	});

	it("uses executable SHELL for user-shell shortcut commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const originalShell = Bun.env.SHELL;
		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-env-shell-"));
		const marker = path.join(shellDir, "env-shell-ran");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const fakeShell = path.join(shellDir, "fish");
		fs.writeFileSync(
			fakeShell,
			`#!/bin/sh
printf '%s\\n' "$*" > '${markerEscaped}'
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-c" ]; then
		shift
		exec /bin/sh -c "$1"
	fi
	shift
done
exit 64
`,
		);
		fs.chmodSync(fakeShell, 0o755);
		Bun.env.SHELL = fakeShell;

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
				SHELL: "/bin/bash",
			},
			prefix: undefined,
		});

		try {
			const result = await executeBash("printf 'env-shell-ok\\n'", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "env-user-shell",
				useUserShell: true,
			});

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("env-shell-ok");
			// fish gets `-i` (interactive loads config.fish too) instead of `-l`,
			// so `status is-login` blocks in user config don't fire on `!` commands.
			expect(fs.readFileSync(marker, "utf8")).toContain("-i -c");
			expect(fs.readFileSync(marker, "utf8")).not.toContain("-l");
		} finally {
			if (originalShell === undefined) {
				delete Bun.env.SHELL;
			} else {
				Bun.env.SHELL = originalShell;
			}
			removeSyncWithRetries(shellDir);
		}
	});

	it("loads zshrc aliases for user-shell shortcut commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const zshPath = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"].find(candidate =>
			fs.existsSync(candidate),
		);
		if (!zshPath) {
			return;
		}

		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-zsh-shellpath-"));
		fs.writeFileSync(path.join(shellDir, ".zshrc"), "alias pi_shell_alias='printf zsh-alias-ok\\\\n'\n");
		Settings.instance.set("shellPath", zshPath);

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: zshPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: shellDir,
				// The command runs through an interactive login zsh, which loads the
				// system `/etc/zshrc`. On macOS that pulls in
				// `/etc/zshrc_Apple_Terminal`, and under Apple Terminal it appends
				// "Saving session..." lines to the captured output on exit. `HOME`
				// does not isolate a system-level file; this is the opt-out Apple
				// documents in that script.
				SHELL_SESSIONS_DISABLE: "1",
			},
			prefix: undefined,
		});

		try {
			const result = await executeBash("pi_shell_alias", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "zsh-shell-path",
				useUserShell: true,
			});

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("zsh-alias-ok");
		} finally {
			removeSyncWithRetries(shellDir);
		}
	});

	it("runs fish user-shell commands without login-shell side effects", async () => {
		if (process.platform === "win32") {
			return;
		}

		const fishPath = ["/usr/bin/fish", "/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"].find(candidate =>
			fs.existsSync(candidate),
		);
		if (!fishPath) {
			return;
		}

		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fish-shellpath-"));
		const configDir = path.join(shellDir, ".config", "fish");
		fs.mkdirSync(path.join(configDir, "conf.d"), { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.fish"), "function pi_fish_fn; echo fish-fn-ok; end\n");
		// Login-gated snippet: fires only when the spawned fish is a login shell.
		fs.writeFileSync(
			path.join(configDir, "conf.d", "pi-login.fish"),
			"if status is-login; echo fish-login-side-effect; end\n",
		);
		Settings.instance.set("shellPath", fishPath);

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: fishPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: shellDir,
			},
			prefix: undefined,
		});

		try {
			const result = await executeBash("pi_fish_fn", {
				cwd: tempDir,
				timeout: 5000,
				sessionKey: "fish-shell-path",
				useUserShell: true,
			});

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			// config.fish must still load (#1816 contract)…
			expect(result.output).toContain("fish-fn-ok");
			// …but the shell must not be a login shell.
			expect(result.output).not.toContain("fish-login-side-effect");
		} finally {
			removeSyncWithRetries(shellDir);
		}
	});

	it("runs zsh shortcut commands on a headless PTY with a color-capable TTY", async () => {
		if (process.platform === "win32" || Bun.env.PI_NO_PTY === "1") {
			return;
		}
		const zshPath = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"].find(candidate =>
			fs.existsSync(candidate),
		);
		if (!zshPath) {
			return;
		}

		const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-zsh-pty-"));
		fs.writeFileSync(path.join(shellDir, ".zshrc"), "alias pi_pty_alias='printf pty-alias-ok'\n");
		Settings.instance.set("shellPath", zshPath);

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: zshPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: shellDir,
				SHELL_SESSIONS_DISABLE: "1",
			},
			prefix: undefined,
		});

		const rawChunks: string[] = [];
		try {
			const result = await executeBash(
				"pi_pty_alias; [ -t 1 ] && printf ' is-tty'; printf ' \\033[31mred\\033[0m'",
				{
					cwd: tempDir,
					timeout: 15000,
					sessionKey: "zsh-pty",
					useUserShell: true,
					pty: { cols: 80, rows: 24, onChunk: chunk => rawChunks.push(chunk) },
				},
			);

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			// Interactive rc loaded (alias expanded) AND stdout was a real TTY.
			expect(result.output).toContain("pty-alias-ok");
			expect(result.output).toContain("is-tty");
			// The captured output stays sanitized while raw ANSI reaches the
			// renderer callback for vterm replay.
			expect(result.output).not.toContain("\u001b[31m");
			expect(rawChunks.join("")).toContain("\u001b[31mred\u001b[0m");
		} finally {
			removeSyncWithRetries(shellDir);
		}
	});

	it("invokes onChunk with command output", async () => {
		let seenChunk: string | null = null;
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				if (seenChunk === null) {
					seenChunk = chunk;
				}
			},
		});
		expect(result.output.trim()).toBe("hello");
		expect(seenChunk).not.toBeNull();
		expect(seenChunk ?? "").toContain("hello");
	});

	it("returns a real PID for background external commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		// Redirect the backgrounded job's stdout so it doesn't hold the executor's
		// output pipe open (which would add the ~250ms background-drain grace);
		// `$!` still reports the real external PID, which is all this test checks.
		const sleepBin = fs.existsSync("/bin/sleep") ? "/bin/sleep" : "sleep";
		const result = await executeBash(`${sleepBin} 30 >/dev/null 2>&1 & echo $!`, {
			cwd: tempDir,
			timeout: 5000,
		});
		const pid = Number.parseInt(result.output.trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(() => process.kill(pid, "SIGKILL")).not.toThrow();
	});

	it("times out commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
	});

	it("times out before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10; echo done", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		expect(result.output).not.toContain("done");
	});

	it("does not arm a deadline when timeout is zero", async () => {
		if (process.platform === "win32") {
			return;
		}
		// Compress any accidentally armed one-second deadline. The real command
		// runs longer than that compressed window, so the success result proves
		// timeout:0 left the execution deadline disabled without a 1.2s sleep.
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) =>
			realSetTimeout(
				handler,
				typeof ms === "number" && ms >= 1000 ? 5 : ms,
				...rest,
			)) as typeof globalThis.setTimeout);
		const result = await executeBash("sleep 0.03; echo done", { cwd: tempDir, timeout: 0 });
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("done");
	});

	it("aborts commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const promise = executeBash("echo started; sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			onChunk: () => started.resolve(),
		});
		await started.promise;
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
	});

	it("returns promptly and quarantines the session key when native abort cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		const originalRun = piNatives.Shell.prototype.run;
		let runCalls = 0;
		const dispatched = Promise.withResolvers<void>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			runCalls++;
			if (runCalls === 1) {
				onChunk?.(null, "started\n");
				dispatched.resolve();
				return new Promise(() => {});
			}
			return originalRun.call(this, options, onChunk);
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "hung-native-abort",
		});
		await dispatched.promise;
		controller.abort();

		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(750).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command cancelled");
		}
		expect(abortSpy).toHaveBeenCalled();

		const next = await executeBash("echo next", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "hung-native-abort",
		});
		expect(next.output.trim()).toBe("next");
		expect(runCalls).toBe(2);
	});

	it("restores persistent sessions after native abort cleanup settles", async () => {
		if (process.platform === "win32") {
			return;
		}

		const nativeResult = Promise.withResolvers<{ exitCode: undefined; cancelled: true; timedOut: false }>();
		const dispatched = Promise.withResolvers<void>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			dispatched.resolve();
			return nativeResult.promise;
		});
		vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "settled-native-abort",
		});
		await dispatched.promise;
		controller.abort();
		await promise;

		nativeResult.resolve({ exitCode: undefined, cancelled: true, timedOut: false });
		await Bun.sleep(0);
		vi.restoreAllMocks();

		await executeBash("export PI_AFTER_ABORT=still_persistent", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		const next = await executeBash("printf '%s\n' \"$PI_AFTER_ABORT\"", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		expect(next.output.trim()).toBe("still_persistent");
	});

	it("aborts the shell without aborting its native signal when the JavaScript timeout fallback wins", async () => {
		// Compress the JS-side fallback timer (floored at 1000ms in the source) so
		// the safety-net fires deterministically without a real 1s wait. Only long
		// timers are shrunk — fs/subprocess setup keeps real scheduling — and the
		// reported "1 seconds" derives from the configured timeout, not the timer.
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) =>
			realSetTimeout(
				handler,
				typeof ms === "number" && ms >= 1000 ? 5 : ms,
				...rest,
			)) as typeof globalThis.setTimeout);

		let nativeSignal: AbortSignal | undefined;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((options, onChunk) => {
			if (options.signal instanceof AbortSignal) {
				nativeSignal = options.signal;
			}
			onChunk?.(null, "streamed-before-timeout\n");
			return Promise.withResolvers<never>().promise;
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const result = await executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "explicit-timeout-keeps-native-signal",
		});

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("streamed-before-timeout");
		expect(result.output).toContain("Command timed out after 1 seconds");
		expect(nativeSignal?.aborted).toBe(false);
		expect(abortSpy).toHaveBeenCalledTimes(1);
	});

	it("explicitly aborts an overlapping one-shot shell when timeout cleanup stalls", async () => {
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) =>
			realSetTimeout(
				handler,
				typeof ms === "number" && ms >= 1000 ? 5 : ms,
				...rest,
			)) as typeof globalThis.setTimeout);

		const ownerResult = Promise.withResolvers<ShellRunResult>();
		const isolatedResult = Promise.withResolvers<ShellRunResult>();
		const ownerDispatched = Promise.withResolvers<void>();
		const isolatedDispatched = Promise.withResolvers<void>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(options => {
			if (options.command === "owner") {
				ownerDispatched.resolve();
				return ownerResult.promise;
			}
			isolatedDispatched.resolve();
			return isolatedResult.promise;
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const owner = executeBash("owner", {
			cwd: tempDir,
			timeout: 0,
			sessionKey: "stalled-one-shot-timeout",
		});
		await ownerDispatched.promise;
		const overlapping = executeBash("isolated", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "stalled-one-shot-timeout",
		});
		await isolatedDispatched.promise;

		const result = await overlapping;
		expect(result.cancelled).toBe(true);
		expect(abortSpy).toHaveBeenCalledTimes(1);

		isolatedResult.resolve({ exitCode: undefined, cancelled: true, timedOut: true });
		ownerResult.resolve({ exitCode: 0, cancelled: false, timedOut: false });
		await owner;
	});

	it("aborts before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const promise = executeBash("echo started; sleep 10; echo done", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			onChunk: () => started.resolve(),
		});
		await started.promise;
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("done");
	});

	it("resets persistent session state after abort", async () => {
		if (process.platform === "win32") {
			return;
		}

		const sessionKey = "reset-on-abort";
		await executeBash("export PI_RESET_VAR=alive", { cwd: tempDir, timeout: 5000, sessionKey });
		const beforeAbort = await executeBash("echo $PI_RESET_VAR", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(beforeAbort.output.trim()).toBe("alive");

		const controller = new AbortController();
		// Abort only once the command is actually running in the persistent
		// session. Aborting on a fixed timer races executeBash's async setup
		// (settings + snapshot load); under load the abort can land in the
		// early-abort short-circuit before the shell ever runs, leaving the
		// session unreset — the source of the flaky "alive" result here.
		const startMarker = path.join(tempDir, "reset-on-abort.started");
		const abortPromise = executeBash(`touch ${startMarker}; sleep 10`, {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey,
		});
		const startDeadline = Date.now() + 4000;
		while (!fs.existsSync(startMarker) && Date.now() < startDeadline) {
			await Bun.sleep(2);
		}
		controller.abort();
		const aborted = await abortPromise;
		expect(aborted.cancelled).toBe(true);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash variable expansion
		const afterAbort = await executeBash("echo ${PI_RESET_VAR:-unset}", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(afterAbort.output.trim()).toBe("unset");
	});

	it("runs overlapping calls on the same session key concurrently", async () => {
		if (process.platform === "win32") return;

		const sessionKey = "parallel-overlap";
		const order: string[] = [];
		const slow = executeBash('sleep 0.15 && echo "A-done"', { cwd: tempDir, timeout: 5000, sessionKey }).then(
			result => {
				order.push("slow");
				return result;
			},
		);
		const fast = executeBash('echo "B-done"', { cwd: tempDir, timeout: 5000, sessionKey }).then(result => {
			order.push("fast");
			return result;
		});

		const [slowResult, fastResult] = await Promise.all([slow, fast]);
		expect(slowResult.exitCode).toBe(0);
		expect(slowResult.output).toContain("A-done");
		expect(fastResult.exitCode).toBe(0);
		expect(fastResult.output).toContain("B-done");
		// If the second call had queued behind the persistent session it could
		// not finish before the 150ms sleep of the first.
		expect(order).toEqual(["fast", "slow"]);
	});

	it("keeps the owner session usable when an overlapping call times out", async () => {
		if (process.platform === "win32") return;

		const sessionKey = "parallel-timeout-isolation";
		const started = path.join(tempDir, "owner.started");
		const release = path.join(tempDir, "owner.release");
		// The owner holds the persistent session open (blocked on `release`) so the
		// overlapping call is guaranteed to find the session busy and degrade to an
		// isolated one-shot shell — the path whose timeout cleanup must NOT touch
		// the owner's persistent session.
		const owner = executeBash(
			`touch ${shellQuote(started)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.02; done; echo "owner-done"`,
			{ cwd: tempDir, timeout: 5000, sessionKey },
		);
		await pollUntil(() => fs.existsSync(started), Date.now() + 4000);
		expect(fs.existsSync(started)).toBe(true);

		// Overlaps the owner; degrades to an isolated shell and times out there.
		const overlapping = await executeBash("sleep 5", { cwd: tempDir, timeout: 100, sessionKey });
		expect(overlapping.cancelled).toBe(true);

		// The overlapping timeout must not quarantine or delete the persistent
		// session owned by the first call: release it and confirm it completes.
		fs.writeFileSync(release, "");
		const ownerResult = await owner;
		expect(ownerResult.exitCode).toBe(0);
		expect(ownerResult.output).toContain("owner-done");

		const after = await executeBash('echo "still-ok"', { cwd: tempDir, timeout: 5000, sessionKey });
		expect(after.exitCode).toBe(0);
		expect(after.output).toContain("still-ok");
	});
	it("streams output chunks", async () => {
		const chunks: string[] = [];
		const result = await executeBash("i=1; while [ $i -le 20 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				chunks.push(chunk);
			},
		});
		// At least one chunk should have been delivered to onChunk
		const combined = chunks.join("");
		expect(combined).toContain("line1");
		// Final result always has the complete output regardless of chunk throttle
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line20");
	});

	it("streams large output without exhausting memory", async () => {
		if (process.platform === "win32") {
			return;
		}
		let sawChunk = false;
		const result = await executeBash("awk 'BEGIN { for (i = 0; i < 100000; i++) printf \"a\" }'", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: () => {
				sawChunk = true;
			},
		});
		expect(sawChunk).toBe(true);
		expect(result.totalBytes).toBe(100000);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).toContain("a");
	});

	it("handles large output without freeze or OOM", async () => {
		if (process.platform === "win32") return;

		// Once raw output exceeds the truncation cap, the streaming + middle-elision
		// path is volume-independent, so a few hundred KB exercises the same
		// no-freeze / no-OOM contract the original 40MB did without paying several
		// seconds to generate it. 100k lines of `seq` is ~690KB — an order of
		// magnitude past the ~71KB head+tail cap asserted below.
		const lineCount = 100_000;
		let chunkCount = 0;
		const start = Date.now();
		const result = await executeBash(`seq 1 ${lineCount}`, {
			cwd: tempDir,
			timeout: 10_000,
			onChunk: () => {
				chunkCount++;
			},
		});
		const elapsed = Date.now() - start;

		// Should complete, not hang or OOM
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);

		// Output summary reflects every line even though the visible text is capped.
		expect(result.totalLines).toBeGreaterThanOrEqual(lineCount);

		// Truncated output stays bounded by head + tail + marker overhead
		// (middle-elision keeps the head budget plus the tail spill window) — proof
		// the full ~690KB stream was never accumulated in the visible buffer.
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + ARTIFACT_HEAD_BYTES_DEFAULT + 1024);

		// The tail should still contain numeric values near the end of the range.
		// BSD `seq` on macOS formats large numbers in scientific notation, so parse
		// the final lines numerically instead of matching one exact decimal string.
		const tailValues = result.output
			.split("\n")
			.slice(-1000)
			.map(line => Number(line.trim()))
			.filter(Number.isFinite);
		expect(tailValues.some(value => value >= lineCount - 500 && value <= lineCount)).toBe(true);

		// Chunks are coalesced by the read buffer, so onChunk fires orders of
		// magnitude less often than once per line — the proof the stream is neither
		// delivered line-by-line nor buffered whole.
		expect(chunkCount).toBeLessThan(lineCount / 100);

		// Should complete promptly (not frozen).
		expect(elapsed).toBeLessThan(10_000);
	}, 15_000);

	it("sources snapshot env vars across session commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
		const sessionKey = "snapshot-test";
		await executeBash("true", { cwd: tempDir, timeout: 5000, sessionKey });
		const result = await executeBash("echo $PI_SNAPSHOT_TEST", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(result.output.trim()).toBe("from_snapshot");
	});

	it("sources large bash functions without base64 eval wrappers", async () => {
		if (process.platform === "win32") {
			return;
		}
		const realBashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(realBashPath)) {
			return;
		}

		const bashPath = path.join(tempDir, "test-bash");
		fs.symlinkSync(realBashPath, bashPath);
		const largeBody = Array.from({ length: 200 }, (_, index) => `    echo "snapshot ${index}"`).join("\n");
		fs.writeFileSync(path.join(tempDir, ".bashrc"), `pi_snapshot_large_function ()\n{\n${largeBody}\n}\n`);

		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		const snapshotPath = await shellSnapshot.getOrCreateSnapshot(bashPath, {
			PATH: Bun.env.PATH ?? "",
			HOME: tempDir,
		});
		const snapshot = fs.readFileSync(snapshotPath!, "utf8");
		expect(snapshot).toContain("pi_snapshot_large_function");
		expect(snapshot).not.toContain("base64 -d");

		const result = await executeBash("printf 'snapshot_ok\\n'", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "large-function-snapshot",
		});
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("snapshot_ok");
	});

	it("survives compound aliases from the user's shell snapshot (issue #3234)", async () => {
		if (process.platform === "win32") return;
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) return;

		// Pre-seed a snapshot that mirrors Fedora's default `which` alias.
		// Without the brush-compat scrub, brush's whitespace-only alias
		// expander turns `(alias;` into the command name and `which` fails
		// with `command not found: (alias;`. With the scrub, the broken
		// alias is dropped and brush falls through to `$PATH`.
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(
			snapshotPath,
			[
				"unalias -a 2>/dev/null || true",
				"alias -- which='(alias; declare -f) | /usr/bin/which --tty-only --read-alias --show-dot --show-tilde'",
				"alias -- ll='ls -l'",
				"",
			].join("\n"),
		);
		const rawSnapshot = fs.readFileSync(snapshotPath, "utf8");
		const { content: scrubbed, dropped } = shellSnapshot.sanitizeSnapshotForBrush(rawSnapshot);
		fs.writeFileSync(snapshotPath, scrubbed);
		expect(dropped).toEqual(["which"]);
		// Compatible aliases must still be installed in brush.
		expect(scrubbed).toContain("alias -- ll='ls -l'");

		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? tempDir },
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);

		const result = await executeBash("which sh", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "brush-compound-alias-which",
		});

		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("command not found");
		expect(result.output.trim()).toMatch(/\/sh$/);
	});

	it("does not allow exec to replace the host", async () => {
		const result = await executeBash("exec echo hi", { cwd: tempDir, timeout: 5000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).not.toBeUndefined();
		if (!result.output.includes("hi")) {
			expect(result.output.toLowerCase()).toContain("exec");
		}
	});

	it("completes even when background job keeps stdout pipe open", async () => {
		if (process.platform === "win32") return;

		const runPromise = executeBash("{ sleep 2; echo late; } & echo immediate", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);

		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.cancelled).toBe(false);
			expect(timed.result.exitCode).toBe(0);
			expect(timed.result.output).toContain("immediate");
		}
	});
	it("kills spawned process on timeout (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const release = path.join(tempDir, "marker.release");

		// The foreground command can only write its marker once `release` exists,
		// which we never create until after the timeout fires. A killed process
		// never reaches the write; an un-killed one would the moment we release it.
		const result = await executeBash(releaseGuardedWrite(marker, release), {
			cwd: tempDir,
			timeout: 50,
		});

		expect(result.cancelled).toBe(true);
		await expectMarkerNeverWritten(marker, release);
	});

	it("kills background jobs on timeout", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg.txt");
		const release = path.join(tempDir, "marker-bg.release");

		// The marker writer is a backgrounded subshell that survives the foreground
		// `sleep` unless the whole process group is killed on timeout.
		const result = await executeBash(`{ ${releaseGuardedWrite(marker, release)}; } & sleep 10`, {
			cwd: tempDir,
			timeout: 50,
		});

		expect(result.cancelled).toBe(true);
		await expectMarkerNeverWritten(marker, release);
	});

	it("kills background jobs on abort", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg-abort.txt");
		const release = path.join(tempDir, "marker-bg-abort.release");
		const started = path.join(tempDir, "marker-bg-abort.started");
		const controller = new AbortController();

		const promise = executeBash(`{ ${releaseGuardedWrite(marker, release, started)}; } & sleep 10`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort only once the backgrounded subshell is actually running.
		await pollUntil(() => fs.existsSync(started), Date.now() + 4000);
		expect(fs.existsSync(started)).toBe(true);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		await expectMarkerNeverWritten(marker, release);
	});

	it("kills spawned process on abort (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const release = path.join(tempDir, "marker.release");
		const started = path.join(tempDir, "marker.started");
		const controller = new AbortController();

		const promise = executeBash(releaseGuardedWrite(marker, release, started), {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort only once the foreground command is actually running.
		await pollUntil(() => fs.existsSync(started), Date.now() + 4000);
		expect(fs.existsSync(started)).toBe(true);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		await expectMarkerNeverWritten(marker, release);
	});
	it("waits for native timeout teardown to flush piped output", async () => {
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) =>
			realSetTimeout(
				handler,
				ms === 1000 ? 5 : typeof ms === "number" && ms > 1000 ? 50 : ms,
				...rest,
			)) as typeof globalThis.setTimeout);

		let nativeSignal: AbortSignal | undefined;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((options, onChunk) => {
			if (options.signal instanceof AbortSignal) {
				nativeSignal = options.signal;
			}
			const nativeResult = Promise.withResolvers<piNatives.ShellRunResult>();
			realSetTimeout(() => {
				onChunk?.(null, "flushed-during-timeout\n");
				nativeResult.resolve({ exitCode: undefined, cancelled: false, timedOut: true });
			}, 20);
			return nativeResult.promise;
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const result = await executeBash("producer | tail -5", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "native-timeout-flushes-pipeline",
		});

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("flushed-during-timeout");
		expect(result.output).toContain("Command timed out after 1 seconds");
		expect(nativeSignal?.aborted).toBe(false);
		expect(abortSpy).not.toHaveBeenCalled();
	});
});

describe("executeBash :async: background retention", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = makeTempDir();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tmp });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tmp)) removeSyncWithRetries(tmp);
	});

	it.skipIf(process.platform === "win32")(
		"keeps a per-job :async: shell's plain-`&` background process alive across turns",
		async () => {
			const pidFile = path.join(tmp, "pid");
			const sleepBin = fs.existsSync("/bin/sleep") ? "/bin/sleep" : "sleep";
			let pid: number | undefined;
			try {
				// A per-job `:async:` key: its shell is removed from the reuse map at
				// teardown, which would SIGKILL the backgrounded child (kill-on-drop).
				// A plain `&` job stays a child of the shell, so `liveBackgroundJobCount`
				// sees it and the retain logic keeps the shell alive while the child
				// runs. `$!` is the external child's own pid (no transparent wrapper to
				// unwrap), so it is the process we assert on.
				const res = await executeBash(`${sleepBin} 30 >/dev/null 2>&1 & echo $! > ${shellQuote(pidFile)}`, {
					sessionKey: "retain-probe:async:job1",
					cwd: tmp,
				});
				expect(res.cancelled).toBe(false);
				pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
				expect(Number.isInteger(pid)).toBe(true);

				// A later turn on a different per-job shell must not have killed it.
				await executeBash("true", { sessionKey: "retain-probe:async:job2", cwd: tmp });

				let alive = true;
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
				}
				expect(alive).toBe(true);
			} finally {
				if (pid !== undefined) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps a nohup-detached background process alive across turns (reparenting)",
		async () => {
			const pidFile = path.join(tmp, "nohup-pid");
			const sleepBin = fs.existsSync("/bin/sleep") ? "/bin/sleep" : "sleep";
			let pid: number | undefined;
			try {
				// `nohup cmd &` is a transparent background wrapper: brush unwraps it and
				// double-forks the operand so it reparents to init and survives teardown
				// independently of the retain map. The shell only ever tracked the
				// short-lived intermediate fork, so `$!` is NOT the surviving process —
				// the operand writes its own pid before `exec`ing the long sleep, and
				// that pid (unchanged across exec) is the one we assert stays alive.
				const operand = `echo $$ > ${pidFile}; exec ${sleepBin} 30`;
				const res = await executeBash(`nohup sh -c ${shellQuote(operand)} >/dev/null 2>&1 &`, {
					sessionKey: "reparent-probe:async:job1",
					cwd: tmp,
				});
				expect(res.cancelled).toBe(false);

				let observedPid = Number.NaN;
				await pollUntil(() => {
					if (!fs.existsSync(pidFile)) return false;
					observedPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
					return Number.isInteger(observedPid);
				}, Date.now() + 4000);
				if (!Number.isInteger(observedPid)) {
					throw new Error(`Timed out waiting for a valid PID in ${pidFile}`);
				}
				pid = observedPid;

				// A later turn on a different per-job shell must not have killed it.
				await executeBash("true", { sessionKey: "reparent-probe:async:job2", cwd: tmp });

				let alive = true;
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
				}
				expect(alive).toBe(true);
			} finally {
				if (pid !== undefined) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			}
		},
	);
});

describe("applyDirenvPreflight direnv-load clamp", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	it("clamps the direnv load to a positive caller timeout below the full budget", async () => {
		// The clamp lives INSIDE the helper, so every backend that routes through
		// applyDirenvPreflight (executeBash, ACP terminal, PTY) inherits it. A
		// positive callerTimeoutMs smaller than the full load budget must win, so a
		// short-timeout command can't hand a cold `.envrc` the full 30s window.
		// Reverting the clamp to executeBash-only leaves the ACP/PTY backend
		// passing the full budget here, reddening this assertion.
		const spy = vi.spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue(null);

		await applyDirenvPreflight("true", tempDir, {
			direnvSetting: "auto",
			timeoutMs: 30_000,
			callerTimeoutMs: 5,
		});

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.timeoutMs).toBe(5);
	});

	it("keeps the full direnv-load budget when the caller deadline is disabled (callerTimeoutMs: 0)", async () => {
		// A disabled command deadline (`0`) is NOT a 0 ms load — it means "no caller
		// clamp", so the load keeps its full `timeoutMs` budget. Collapsing it to 0
		// would make AbortSignal.timeout(0) abort instantly and silently drop the
		// repo's direnv env.
		const spy = vi.spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue(null);

		await applyDirenvPreflight("true", tempDir, {
			direnvSetting: "auto",
			timeoutMs: 30_000,
			callerTimeoutMs: 0,
		});

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.timeoutMs).toBe(30_000);
	});

	it("keeps the full direnv-load budget when no caller deadline is supplied (callerTimeoutMs: undefined)", async () => {
		// An omitted caller deadline behaves like a disabled one: no clamp, full
		// budget. Guards the `!== undefined` half of the clamp condition.
		const spy = vi.spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue(null);

		await applyDirenvPreflight("true", tempDir, {
			direnvSetting: "auto",
			timeoutMs: 30_000,
		});

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.timeoutMs).toBe(30_000);
	});
});
