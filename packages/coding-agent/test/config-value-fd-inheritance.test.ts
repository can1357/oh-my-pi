/**
 * `!command` config values must not leak inherited file descriptors into the
 * credential-resolving child, and a timed-out command must not leave
 * descendants running.
 *
 * A launcher can legitimately hand omp an open descriptor (for example a
 * credential bundle) that is meant to stay single-consumer. The child spawned
 * for `auth.broker.url` / header `!command` resolution used to run through the
 * natives brush shell (executeShell), whose children inherit every inheritable
 * descriptor; the models.yml apiKey resolver (execSync) already spawned with
 * stdio pipes only. The fix converges the config-value path on ptree, which
 * keeps piped-only stdio while preserving executeShell's process-tree
 * termination on timeout.
 *
 * Oracle notes: the fd oracle must be an external helper script whose body is
 * `cat <&3` — brush rejects inline `<&3` in the command string while still
 * passing inherited fds to external children. A positive control runs first so
 * the fd assertion cannot pass vacuously (e.g. if the resolver stopped
 * executing commands at all). The tree-kill oracle mirrors the contract pinned
 * by packages/natives/test/native.test.ts for executeShell. No /proc
 * dependency, so both oracles discriminate on every non-Windows platform.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { runShellCommand } from "../src/config/resolve-config-value";

const resolverUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/resolve-config-value.ts")).href;

/**
 * Budget for the descendant-escape oracles below. The command must outlive it
 * (both use `sleep 10`, and the escaped worker `sleep 30`), so the timeout
 * always fires with the descendant alive — but it must also cover starting a
 * `sh` and a worker script on a loaded CI runner, because those oracles wait
 * for the worker *inside* the timed command. 150 ms did not, and the tests
 * flaked whenever the worker lost the race (#10259).
 */
const ESCAPE_TIMEOUT_MS = 3000;

/** How long a killed descendant may take to actually leave `Running`. */
const DEATH_GRACE_MS = 2000;

/**
 * Assert an escaped descendant does not survive the timeout.
 *
 * Sampling `status()` once on the tick `runShellCommand` resolves is racy in
 * the *failing* direction: signal delivery and reaping are asynchronous, so a
 * descendant that is being killed can still read `Running` for a few
 * milliseconds. Poll instead of sampling. This keeps full discriminating
 * power — the worker `sleep 30`s, far beyond this window, so a descendant the
 * product genuinely fails to kill is still `Running` when the grace expires.
 */
async function expectDescendantDead(escaped: Process | null, pid: number, label: string): Promise<void> {
	const deadline = Date.now() + DEATH_GRACE_MS;
	while (Date.now() < deadline && escaped?.status() === ProcessStatus.Running) {
		await Bun.sleep(25);
	}
	expect(escaped?.status(), `${label} descendant ${pid} survived the timeout`).not.toBe(ProcessStatus.Running);
}

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"config !command children cannot read descriptors the launcher passed omp",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-fd-"));
		roots.push(root);
		const canaryPath = path.join(root, "canary.txt");
		await fs.promises.writeFile(canaryPath, "CANARY-THAT-MUST-NOT-RESOLVE");
		const spyPath = path.join(root, "fd3-spy.sh");
		await fs.promises.writeFile(spyPath, "#!/usr/bin/env bash\ncat <&3\n", { mode: 0o755 });

		// The child receives fd 3 the way a launcher would pass one: an extra
		// stdio entry, dup2'd in regardless of close-on-exec state.
		const canary = await fs.promises.open(canaryPath, "r");
		try {
			// The resolver must load in a child process: fd inheritance only exists
			// across a real exec boundary, so the probe runs via --eval in a spawned
			// bun (same pattern as cli-provider-api-keys.test.ts). The positive
			// control asserts command execution works through the same resolver
			// before the fd case requires `undefined`.
			const script = `import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};
const control = await resolveConfigValue("!echo positive-control-ok");
console.log(control === "positive-control-ok" ? "CONTROL-OK" : "CONTROL-BAD:" + control);
const value = await resolveConfigValue("!${spyPath}");
console.log(value === undefined ? "RESOLVED-UNDEFINED" : "LEAKED:" + value);
`;
			const proc = Bun.spawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", canary.fd],
				timeout: 15_000,
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode, stdout).toBe(0);
			const lines = stdout.trim().split("\n");
			expect(lines[0], "positive control: commands must still resolve").toBe("CONTROL-OK");
			expect(lines[1], "fd oracle: the canary must not resolve").toBe("RESOLVED-UNDEFINED");
		} finally {
			await canary.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a timed-out !command leaves no descendant writing after the kill",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-treekill-"));
		roots.push(root);
		const marker = path.join(root, "marker");

		// The backgrounded sleep must never get to write: the timeout kills the
		// whole tree, not just the shell (parity with the executeShell contract).
		// The resolver returns only after termination completes, so the marker
		// delay and poll window only need comfortable margins against scheduler
		// noise — the poll keeps discriminating power if that await is ever lost
		// (an orphan would write at the delay, inside the window).
		const result = await runShellCommand(`{ sleep 1.5; echo done > "${marker}"; } & sleep 10`, 150);
		expect(result).toBeUndefined();
		// Real subprocess timing: fake timers cannot advance a child's clock, and
		// the oracle is "the marker never appears" — poll so a leak fails fast
		// instead of paying the full window on green.
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && !(await Bun.file(marker).exists())) {
			await Bun.sleep(50);
		}
		expect(await Bun.file(marker).exists(), "orphaned descendant wrote the marker after the timeout").toBe(false);
	},
);

test.skipIf(process.platform === "win32")(
	"a timed-out !command kills descendants reparented before the timeout",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-reparented-"));
		roots.push(root);
		const pidFile = path.join(root, "escaped.pid");
		const worker = path.join(root, "escaped-worker.sh");
		await fs.promises.writeFile(worker, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`, { mode: 0o755 });

		let escaped: Process | null = null;
		try {
			// The intermediate shell exits immediately after backgrounding the
			// worker. Waiting for its pid file makes the worker exist before the
			// resolver timeout fires, while PID-tree traversal can no longer find
			// it. The wait sleeps rather than spinning on `:`: a spin burns the
			// core the worker needs, and the wait runs inside the timed command,
			// so it competes with the very budget it must finish within (#10259).
			const command = `sh -c '"${worker}" &' & until [ -s "${pidFile}" ]; do sleep 0.01; done; sleep 10`;
			const result = await runShellCommand(command, ESCAPE_TIMEOUT_MS);
			expect(result).toBeUndefined();

			const pid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
			escaped = Process.fromPid(pid);
			await expectDescendantDead(escaped, pid, "reparented");
		} finally {
			escaped?.killTree(9);
		}
	},
);

test.skipIf(process.platform !== "linux")(
	"a timed-out !command kills descendants that leave the isolated session",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-session-escape-"));
		roots.push(root);
		const pidFile = path.join(root, "escaped.pid");
		const worker = path.join(root, "escaped-worker.sh");
		await fs.promises.writeFile(worker, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });

		let escaped: Process | null = null;
		try {
			// `setsid` moves the intermediate into a new session, then that
			// intermediate backgrounds the worker and exits. The worker is no
			// longer in the resolver shell's PID tree or original process group.
			// Same yielding wait as the reparented oracle above (#10259).
			const command = `setsid sh -c '"${worker}" &' </dev/null >/dev/null 2>&1 & until [ -s "${pidFile}" ]; do sleep 0.01; done; sleep 10`;
			const result = await runShellCommand(command, ESCAPE_TIMEOUT_MS);
			expect(result).toBeUndefined();

			const pid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
			escaped = Process.fromPid(pid);
			await expectDescendantDead(escaped, pid, "session-escaping");
		} finally {
			escaped?.killTree(9);
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a timed-out !command hard-kills descendants that ignore SIGTERM",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-treekill-term-"));
		roots.push(root);
		const marker = path.join(root, "marker");

		// Parity with the executeShell contract (natives native.test.ts "should
		// SIGKILL workloads that ignore SIGTERM on timeout"): the timeout must
		// hard-kill the whole tree, and the resolver must not report the timeout
		// until that kill has completed.
		const result = await runShellCommand(`{ trap '' TERM; sleep 1.5; echo done > "${marker}"; } & sleep 10`, 150);
		expect(result).toBeUndefined();
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && !(await Bun.file(marker).exists())) {
			await Bun.sleep(50);
		}
		expect(await Bun.file(marker).exists(), "SIGTERM-ignoring descendant wrote the marker after the timeout").toBe(
			false,
		);
	},
);

test.skipIf(process.platform === "win32")("resolves !commands when PATH omits the shell entirely", async () => {
	// A launcher may supply a minimal tool-only PATH; the resolver must still
	// find the OS shell. Probing in a subprocess so the stripped PATH cannot
	// affect this test process's own spawns.
	const script = `import { runShellCommand } from ${JSON.stringify(resolverUrl)};
const value = await runShellCommand("echo pathless-ok", 5_000);
console.log(value === "pathless-ok" ? "PATHLESS-OK" : "PATHLESS-BAD:" + value);`;
	const emptyPathDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-no-sh-in-path-"));
	roots.push(emptyPathDir);
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", script],
		cwd: process.cwd(),
		env: { ...Bun.env, PATH: emptyPathDir },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(exitCode, stdout).toBe(0);
	expect(stdout.trim()).toBe("PATHLESS-OK");
});
