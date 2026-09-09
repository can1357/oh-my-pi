/**
 * Regression for #4232: `runSshSync` / `runSshCaptureSync` sit on the
 * `ensureHostInfo` → `probeHostInfo` / `ensureConnection` path that runs before
 * `SshTool.execute` applies the user's command timeout. Previously they invoked
 * `ssh` through `$`ssh ${args}`.quiet().nothrow()` with no timeout and no
 * abort signal, so an unreachable host or wedged control-master hung forever.
 *
 * The contract now is: each helper is bounded by `timeoutMs`, aborts a stalled
 * child, and returns a failure result (`exitCode !== 0`, non-empty
 * `stderr`) instead of throwing or blocking.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _sshHelpersForTests } from "../../src/ssh/connection-manager";

const { runSshSync, runSshCaptureSync } = _sshHelpersForTests;

let binDir: string;
let originalPath: string | undefined;

beforeAll(async () => {
	binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-timeout-"));
	// Fake `ssh` that traps SIGTERM and sleeps far past any test bound.
	// Simulates a wedged control-master / unreachable host.
	const fake = path.join(binDir, "ssh");
	await fs.writeFile(fake, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 300\n", { mode: 0o755 });
	originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(async () => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	await fs.rm(binDir, { recursive: true, force: true });
});

describe("SSH pre-command helpers bound their own runtime (#4232)", () => {
	it("runSshSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		// timeout → aborted child, so exit code is null (aborted) or non-zero.
		expect(result.exitCode).not.toBe(0);
	}, 10_000);

	it("runSshCaptureSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshCaptureSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
	}, 10_000);
});
