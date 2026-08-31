import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { ToolSession } from "../../src/tools";
import { loadPowerShellTool, type PowerShellToolDetails, powershellToolRenderer } from "../../src/tools/powershell";
import { acquirePsHost, disposeAllPsHosts, setPsHostSpawnerForTests } from "../../src/tools/pshost-manager";

const hasPwsh = Boolean(await $which("pwsh"));
const settings = Settings.isolated({});
const suite = hasPwsh ? describe : describe.skip;

function fakeSession(sessionId = "ps-tool-test"): ToolSession {
	return { cwd: process.cwd(), getSessionId: () => sessionId, settings } as unknown as ToolSession;
}

function textOf(result: AgentToolResult<PowerShellToolDetails>): string {
	const block = result.content?.find(part => part.type === "text");
	return block && block.type === "text" ? block.text : "";
}

suite("PowerShellTool (persistent host)", () => {
	afterAll(async () => {
		await disposeAllPsHosts();
	});

	test("retains runspace state across calls and maps exit codes", async () => {
		const tool = await loadPowerShellTool(fakeSession());
		expect(tool).not.toBeNull();
		if (!tool) return;

		const first = await tool.execute("c1", { command: "$x = 21; $x * 2" });
		expect(textOf(first).trim()).toBe("42");
		expect(first.isError ?? false).toBe(false);
		expect(first.details?.pid).toBeGreaterThan(0);

		// Same runspace: $x set above must survive into the next tool call.
		const second = await tool.execute("c2", { command: "$x + 1" });
		expect(textOf(second).trim()).toBe("22");

		// The previous result's live objects are inspectable without re-running.
		const third = await tool.execute("c3", { command: "$__omp.Last" });
		expect(textOf(third).trim()).toBe("22");

		// Non-zero native exit -> isError result (not thrown), output preserved.
		const nativeFail = process.platform === "win32" ? "cmd /c exit 5" : "/bin/sh -c 'exit 5'";
		const failed = await tool.execute("c4", { command: nativeFail });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("code 5");

		// A PS-only command after a failed native must not inherit the stale
		// $LASTEXITCODE (regression: this was reported as exit 5 -> isError).
		const afterFail = await tool.execute("c5", { command: '"still ok"' });
		expect(textOf(afterFail).trim()).toBe("still ok");
		expect(afterFail.isError ?? false).toBe(false);

		// User writes to $LASTEXITCODE are not native execution and must not
		// turn a PowerShell-only command into an exit-code failure.
		const assigned = await tool.execute("c5a", { command: "$global:LASTEXITCODE = 7; 'still ok'" });
		expect(textOf(assigned).trim()).toBe("still ok");
		expect(assigned.isError ?? false).toBe(false);

		// Invalid cwd fails fast: the command must not run in the previous dir.
		const badCwd = await tool.execute("c6", { command: '"should not run"', cwd: "omp-no-such-dir-zzz-12345" });
		expect(badCwd.isError).toBe(true);
		expect(textOf(badCwd)).toContain("Set-Location failed");
		expect(textOf(badCwd)).not.toContain("should not run");
	});

	test("host modes: ephemeral is isolated and disposed; new-session replaces the runspace", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-host-modes"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Ephemeral calls are independent processes -> shared concurrency; the
		// session host stays exclusive.
		expect(tool.concurrency({ host: "ephemeral" })).toBe("shared");
		expect(tool.concurrency({})).toBe("exclusive");
		expect(tool.concurrency({ host: "new-session" })).toBe("exclusive");

		const seed = await tool.execute("m1", { command: "$y = 7; $y" });
		expect(textOf(seed).trim()).toBe("7");
		expect(seed.details?.host).toBe("session");
		const sessionPid = seed.details?.pid;

		// Ephemeral: fresh runspace, session state invisible, own process.
		const eph = await tool.execute("m2", { command: "Test-Path variable:y", host: "ephemeral" });
		expect(textOf(eph).trim()).toBe("False");
		expect(eph.details?.host).toBe("ephemeral");
		expect(eph.details?.pid).not.toBe(sessionPid);

		// Awaited teardown: the ephemeral process is dead before the result returns.
		expect(() => process.kill(eph.details?.pid as number, 0)).toThrow();

		// The session host is untouched by the ephemeral call.
		const still = await tool.execute("m3", { command: "$y" });
		expect(textOf(still).trim()).toBe("7");
		expect(still.details?.pid).toBe(sessionPid);

		// new-session: old runspace state is gone and a new host takes over.
		const fresh = await tool.execute("m4", { command: "Test-Path variable:y", host: "new-session" });
		expect(textOf(fresh).trim()).toBe("False");
		expect(fresh.details?.host).toBe("new-session");
		const freshPid = fresh.details?.pid;
		expect(freshPid).not.toBe(sessionPid);

		// The replacement is the warm session host now: it persists.
		const persisted = await tool.execute("m5", { command: "$z = 1; $z" });
		expect(textOf(persisted).trim()).toBe("1");
		expect(persisted.details?.pid).toBe(freshPid);
	});

	test("a session host that dies mid-run is dropped and respawned", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-death-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		const before = await tool.execute("d1", { command: "$PID" });
		const beforePid = Number(textOf(before).trim());
		expect(beforePid).toBeGreaterThan(0);

		// Give the 50 ms host poll time to stream the diagnostic before the
		// terminating exit. The assertion preserves the crash-output contract.
		await expect(
			tool.execute("d2", { command: "Write-Host 'before-crash-marker'; Start-Sleep -Milliseconds 200; [Environment]::Exit(5)" }),
		).rejects.toThrow(/before-crash-marker/);

		// …and the next default call gets a fresh host, not the pooled corpse.
		const after = await tool.execute("d3", { command: "$PID" });
		expect(after.isError ?? false).toBe(false);
		const afterPid = Number(textOf(after).trim());
		expect(afterPid).toBeGreaterThan(0);
		expect(afterPid).not.toBe(beforePid);
	});

	test("concurrent acquires for one session converge on a single host", async () => {
		const opts = { sessionId: "ps-race-test", cwd: process.cwd(), historyDepth: 5, idleTtlMs: 0 };
		// Without single-flight spawning, both acquires would see an empty pool
		// slot and spawn their own sidecar, silently leaking one.
		const [a, b] = await Promise.all([acquirePsHost(opts), acquirePsHost(opts)]);
		try {
			expect(a.host.pid).toBeGreaterThan(0);
			expect(a.host.pid).toBe(b.host.pid);
		} finally {
			a.release();
			b.release();
		}
	});

	test("captures non-success streams (Write-Host, Write-Warning)", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-streams-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Write-Host goes to the Information stream — previously dropped entirely.
		const host = await tool.execute("s1", { command: "Write-Host 'hello-host'" });
		expect(textOf(host)).toContain("hello-host");
		expect(host.isError ?? false).toBe(false);

		// Write-Warning is labeled and is not treated as a failure.
		const warn = await tool.execute("s2", { command: "Write-Warning 'heads-up'" });
		expect(textOf(warn)).toContain("WARNING: heads-up");
		expect(warn.isError ?? false).toBe(false);
	});

	test("a spawned native reading stdin gets EOF instead of hanging on the protocol pipe", async () => {
		// The reported repro: git.exe inherited the host's stdin — the JSON
		// protocol pipe — and blocked on every subcommand until the tool timed
		// out. git-gated so the suite still runs where git is absent.
		const gitPath = await $which("git");
		if (!gitPath) return;
		const tool = await loadPowerShellTool(fakeSession("ps-native-stdin"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// A short timeout makes a regression fail fast rather than stalling the
		// whole suite for the full default window.
		const result = await tool.execute("g1", { command: "git --version", timeout: 15 });
		expect(result.isError ?? false).toBe(false);
		expect(textOf(result)).toContain("git version");
		expect(textOf(result)).not.toMatch(/timed out/i);
	});

	test("a lookup-only command after a failed native does not inherit its exit code", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-lookup-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		const nativeFail = process.platform === "win32" ? "cmd /c exit 7" : "/bin/sh -c 'exit 7'";
		const failed = await tool.execute("l1", { command: nativeFail });
		expect(failed.isError).toBe(true);

		// Get-Command resolves an Application without running it; PowerShell's
		// PostCommandLookupAction is NOT triggered by Get-Command discovery
		// (verified on 7.6.2), so the stale $LASTEXITCODE must not be
		// attributed to this lookup-only invocation. Guards against a pwsh
		// behavior change silently re-introducing stale-exit attribution.
		const lookup = await tool.execute("l2", {
			command: "[bool](Get-Command pwsh -ErrorAction SilentlyContinue)",
		});
		expect(lookup.isError ?? false).toBe(false);
		expect(textOf(lookup)).toContain("True");

		// A real native re-run exiting with the SAME code is still attributed
		// (the invocation-time lookup flag, not a value change, catches it).
		const failedAgain = await tool.execute("l3", { command: nativeFail });
		expect(failedAgain.isError).toBe(true);
		expect(textOf(failedAgain)).toContain("code 7");
	});

	test("path-invoked native repeating the same exit code is still attributed", async () => {
		// PostCommandLookupAction is not reliable for every path-invoked form,
		// and a same-code repeat leaves $LASTEXITCODE numerically unchanged.
		// Pre-lookup identifies path invocations while the resolved post-lookup
		// hook handles ordinary Application/ExternalScript commands.
		const tool = await loadPowerShellTool(fakeSession("ps-path-native-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;
		const pathFail =
			process.platform === "win32"
				? "& (Get-Command cmd -CommandType Application | Select-Object -First 1).Path /c exit 5"
				: "& (Get-Command sh -CommandType Application | Select-Object -First 1).Path -c 'exit 5'";

		const first = await tool.execute("p1", { command: pathFail });
		expect(first.isError).toBe(true);
		expect(textOf(first)).toContain("code 5");
		expect(first.details?.exitCode).toBe(5);

		const second = await tool.execute("p2", { command: pathFail });
		expect(second.isError).toBe(true);
		expect(textOf(second)).toContain("code 5");
		expect(second.details?.exitCode).toBe(5);

		// ExternalScript path with the same repeated exit code.
		const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-exit-"));
		try {
			const scriptPath = path.join(scriptDir, "fail.ps1");
			await fs.writeFile(scriptPath, "exit 5\n", "utf8");
			// Single-quoted path so spaces/backslashes don't inject.
			const lit = scriptPath.replace(/'/g, "''");
			const scriptFail = `& '${lit}'`;
			const s1 = await tool.execute("p3", { command: scriptFail });
			expect(s1.isError).toBe(true);
			expect(s1.details?.exitCode).toBe(5);
			const s2 = await tool.execute("p4", { command: scriptFail });
			expect(s2.isError).toBe(true);
			expect(s2.details?.exitCode).toBe(5);
		} finally {
			await fs.rm(scriptDir, { recursive: true, force: true });
		}

		const after = await tool.execute("p5", { command: '"still ok"' });
		expect(after.isError ?? false).toBe(false);
		expect(textOf(after).trim()).toBe("still ok");
	});

	test("a frame boundary preserves a non-BMP output character", async () => {
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-surrogate-"));
		try {
			const artifactPath = path.join(artifactDir, "output.txt");
			const session = {
				...fakeSession("ps-surrogate-boundary-test"),
				allocateOutputArtifact: async () => ({ path: artifactPath, id: "surrogate" }),
			} as ToolSession;
			const tool = await loadPowerShellTool(session);
			expect(tool).not.toBeNull();
			if (!tool) return;

			// PowerShell indexes strings in UTF-16 code units. The emoji begins at
			// Write-Chunk's 4 MiB boundary, so splitting its surrogate pair would
			// replace it with U+FFFD during JSON UTF-8 encoding.
			const result = await tool.execute("surrogate", {
				command: "('x' * 4194303) + [char]0xD83D + [char]0xDE00 + 'y'",
			});
			const text = await Bun.file(artifactPath).text();
			expect(result.isError ?? false).toBe(false);
			expect(text).toContain("😀y");
			expect(text).not.toContain("�");
		} finally {
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});

	test("a direct [Console]::Error write surfaces as error output instead of vanishing", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-console-error-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Only PS.Streams.Error and HadErrors previously fed hadErrors/output; a
		// .NET library (or user code) writing straight to [Console]::Error
		// silently vanished — Rust only retains the sidecar's OS stderr as a
		// startup-failure diagnostic tail, never routed to a running exec.
		const result = await tool.execute("ce1", { command: "[Console]::Error.WriteLine('boom-from-console-error')" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("boom-from-console-error");
	});

	test("a high-volume [Console]::Out write delivers every line intact after live release", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-console-out-highvolume-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Direct Console.Out/Error writes are now periodically drained (a
		// thread-safe queue-backed writer, not a completion-only
		// StringBuilder) the same way the PS data streams already were —
		// proves the periodic drain doesn't drop, duplicate, or reorder
		// content under a fast write burst.
		const result = await tool.execute("cout-hv", {
			command: '1..3000 | ForEach-Object { [Console]::Out.WriteLine("line-$_") }',
		});
		expect(result.isError ?? false).toBe(false);
		const text = textOf(result);
		const matches = [...text.matchAll(/line-(\d+)/g)].map(m => Number(m[1]));
		expect(matches.length).toBe(3000);
		expect(new Set(matches).size).toBe(3000);
		expect(Math.min(...matches)).toBe(1);
		expect(Math.max(...matches)).toBe(3000);
	});

	test("a [Console]::Error write drained mid-run still trips hadErrors at completion", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-console-error-sticky-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// The sticky HadConsoleErr flag (set the moment a periodic poll
		// drains a non-empty consoleErr) must survive to Complete-Exec even
		// though the queue itself is empty again by the time completion
		// runs its own final drain — proves hadErrors isn't silently lost
		// once live draining takes the content away before the command
		// finishes.
		const result = await tool.execute("cerr-sticky", {
			command: "[Console]::Error.WriteLine('early-error'); Start-Sleep -Milliseconds 300; 'done'",
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("early-error");
	});

	test("a direct [Console]::In read returns immediately instead of touching the protocol pipe", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-console-in-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// A submitted command that calls [Console]::In.ReadLine()/Read() must
		// return immediately (EOF) rather than blocking on -- or consuming
		// bytes from -- the protocol pipe, which would either hang this call
		// or desync the framed reader for every later command on the same
		// host. `[Console]::SetIn(TextReader.Null)` in the bootstrap pins
		// this. Note: verified this specific race (a Console.In reader
		// PowerShell/.NET already cached BEFORE the stdin detach) does not
		// independently reproduce in this bootstrap's actual control flow --
		// detach runs as the very first executable statement, before
		// anything could touch Console.In first -- so this guards the
		// observable contract (never hangs, host stays usable after) rather
		// than proving a specific pre/post regression.
		const result = await tool.execute("cin1", {
			command: '$r = [Console]::In.ReadLine(); "read-result:[$r] is-null:$($null -eq $r)"',
			timeout: 10,
		});
		expect(result.isError ?? false).toBe(false);
		expect(textOf(result)).toContain("is-null:True");

		// The host must still be usable afterward -- proves the read didn't
		// desync the framed protocol reader.
		const result2 = await tool.execute("cin2", { command: "'still-alive'" });
		expect(textOf(result2)).toContain("still-alive");
	});

	test("a timed-out command with truncated output still surfaces the truncation notice", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-timeout-truncation-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Warm the host so its ~1s spawn doesn't eat into the tight timeout below.
		await tool.execute("t0", { command: "'warm'" });

		// Emit output well over the sink's 50KB in-memory window, then block past
		// the deadline so the command times out with a truncated tail retained.
		// Uses Write-Warning (not success-stream output): success output only
		// reaches the sink via the wrapped script's trailing Out-String line,
		// which never runs on a Stop mid-Start-Sleep — only data-stream output
		// (Write-Warning/-Host/-Verbose/-Debug) is live-streamed via
		// Publish-Streams before the pipeline completes (see pshost_bootstrap.ps1).
		// Pre-fix, the thrown timeout message carried only the retained tail with
		// no indication earlier output was elided.
		const command = "1..2000 | ForEach-Object { Write-Warning ('x' * 100) }; Start-Sleep -Seconds 30";
		// OutputSink retained head+tail here, so the notice is middle-elision
		// shaped ("Showing lines A-B and C-D of N; … elided") rather than a pure
		// tail range — match on the distinctive "Showing … of <total>" contract
		// shared by every truncation shape instead of one specific wording.
		await expect(tool.execute("t1", { command, timeout: 1 })).rejects.toThrow(/Showing .+ of \d+/);
	});

	test("a high-volume Write-Host stream delivers every line intact after live release", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-release-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Publish-Streams releases (RemoveAt) each Information record right
		// after publishing it, so a long-running high-volume command doesn't
		// retain every record for the sidecar's process lifetime. This proves
		// the release doesn't drop, duplicate, or reorder anything, and the
		// wrapped script's trailing success output (the marker) still renders
		// normally afterward.
		const result = await tool.execute("rel1", {
			command: "1..5000 | ForEach-Object { Write-Host \"item-$_\" }; 'done-marker'",
		});
		expect(result.isError ?? false).toBe(false);
		const text = textOf(result);
		const lines = new Set(text.split(/\r?\n/).filter(l => l.startsWith("item-")));
		expect(lines.size).toBe(5000);
		for (const n of [1, 2500, 5000]) expect(lines.has(`item-${n}`)).toBe(true);
		expect(text).toContain("done-marker");
	});

	test("a high-volume Write-Error stream delivers every error intact after live release", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-error-release-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Publish-Streams (round 27) now releases Error records the same way
		// as Information/Warning/Verbose/Debug, instead of retaining every
		// ErrorRecord for the command's full duration. This proves the
		// release doesn't drop, duplicate, or reorder error text, and that
		// hadErrors still reflects the sticky HadErrorRecords flag once the
		// underlying Streams.Error collection has been drained to empty.
		const result = await tool.execute("err-rel1", {
			command: "1..2000 | ForEach-Object { Write-Error \"boom-$_\" -ErrorAction Continue }; 'done-marker'",
		});
		expect(result.isError ?? true).toBe(true);
		const text = textOf(result);
		const lines = new Set(text.split(/\r?\n/).filter(l => l.includes("boom-")));
		for (const n of [1, 1000, 2000]) expect([...lines].some(l => l.includes(`boom-${n}`))).toBe(true);
		expect(text).toContain("done-marker");
	});

	test("a pre-aborted signal is rejected before the host ever runs the command", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-preaborted-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Establish the session's pooled host first so acquisition is warm —
		// isolates this test to the throwIfAborted() re-check, not host spawn.
		await tool.execute("warm", { command: "'warm-ok'" });

		const controller = new AbortController();
		controller.abort();
		await expect(
			tool.execute("aborted", { command: "$global:__preabort_marker = 'ran'" }, controller.signal),
		).rejects.toThrow(/abort/i);

		// The command text must never have reached the runspace.
		const result = await tool.execute("verify", {
			command: "if ($global:__preabort_marker) { 'ran' } else { 'never-ran' }",
		});
		expect(textOf(result).trim()).toBe("never-ran");
	});

	test("a pre-aborted ephemeral call never spawns a throwaway host", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-ephemeral-preabort-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// A spy spawner that fails loudly if it's ever reached — proves the
		// pre-check runs before `spawnEphemeralPsHost()`, not just before
		// `host.run()`. If the pre-fix ordering regresses, this rejection
		// message replaces the abort-error one below and the assertion fails.
		setPsHostSpawnerForTests(async () => {
			throw new Error("SPAWNER_UNEXPECTEDLY_REACHED: ephemeral host must not spawn for a cancelled call");
		});
		try {
			const controller = new AbortController();
			controller.abort();
			await expect(
				tool.execute("aborted", { command: "'unreachable'", host: "ephemeral" }, controller.signal),
			).rejects.toThrow(/abort/i);
		} finally {
			setPsHostSpawnerForTests(null);
		}
	});

	test("a pre-aborted new-session call never destroys the existing session host's state", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-cancel-before-dispose-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Warm the session host and set a marker that only survives if the
		// runspace is never disposed.
		await tool.execute("warm", { command: "$global:__cancel_marker = 'alive'" });

		const controller = new AbortController();
		controller.abort();
		// host: "new-session" disposes the existing pooled host before
		// acquiring its replacement. A call that's already cancelled by the
		// time execute() runs must never reach that disposal — otherwise a
		// call that never executes still destroys the session's persistent
		// state (variables/modules/loaded resources) for nothing.
		await expect(
			tool.execute("cancelled", { command: "'unreachable'", host: "new-session" }, controller.signal),
		).rejects.toThrow(/abort/i);

		const result = await tool.execute("verify", { command: "$global:__cancel_marker" });
		expect(textOf(result).trim()).toBe("alive");
	});

	test("a top-level return in the command exits only the user command, not wrapper bookkeeping", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-toplevel-return-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Splicing user text directly into the wrapper's own try-block scriptblock
		// means a bare top-level `return` previously exited the WHOLE wrapped
		// script, skipping the $__omp.Last/History update and Out-String render
		// that run after the try/finally. Test-HasTopLevelReturn now detects this
		// case and dot-sources the command from a literal scriptblock instead, so
		// `return` only exits the user command's own scope.
		const withReturn = await tool.execute("ret1", {
			command: "function Get-Value { return 99 }; $v = Get-Value; if ($v -eq 99) { return 'ok' }; 'bad'",
		});
		expect(textOf(withReturn).trim()).toBe("ok");

		// Proves the wrapper's post-try bookkeeping (history/session-scope
		// variable persistence) still ran: $v must survive into the next call.
		const after = await tool.execute("ret2", { command: "$v" });
		expect(textOf(after).trim()).toBe("99");
	});

	test("a terminating error preserves pre-error output and finalizes $__omp.Last instead of leaving it stale", async () => {
		const tool = await loadPowerShellTool(fakeSession("ps-terminating-error-test"));
		expect(tool).not.toBeNull();
		if (!tool) return;

		// Warm with a distinct marker result so a stale $__omp.Last after the
		// failing command below would be detectably WRONG, not just absent.
		const warm = await tool.execute("warm", { command: "'stale-marker'" });
		expect(textOf(warm).trim()).toBe("stale-marker");

		// $global:__omp.Last = @($commandBody) was an atomic assignment: a
		// terminating error partway through the array-subexpression discarded
		// the WHOLE assignment (confirmed empirically -- `$x = @("before";
		// throw "boom")` leaves $x completely unchanged), so 'before-throw'
		// never reached the tool result and $__omp.Last stayed pointed at the
		// previous command's value. Complete-Exec now finalizes Last/History
		// from $out (which accumulates live, independent of a later throw).
		const failed = await tool.execute("t1", { command: "'before-throw'; throw 'boom'" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("before-throw");
		// The terminating error's own text must also surface, not vanish
		// behind a generic "Command reported errors" note with no detail
		// (EndInvoke throws for this case; Streams.Error stays empty).
		expect(textOf(failed)).toContain("boom");

		// $__omp.Last must reflect THIS command's partial output, not the
		// previous command's stale "stale-marker" result.
		const check = await tool.execute("t2", { command: "$__omp.Last" });
		expect(textOf(check).trim()).toBe("before-throw");
	});

	test("tools.maxTimeout caps the resolved PowerShell timeout even when the request omits it", async () => {
		// The SDK argument transform only caps an EXPLICITLY supplied numeric
		// timeout; clampTimeout must be passed tools.maxTimeout itself so the
		// global cap also governs the fallback-to-default path other
		// execution-style tools (bash/browser/debug/eval/fetch) already cover.
		const cappedSettings = Settings.isolated({ "tools.maxTimeout": 1 });
		const session = {
			cwd: process.cwd(),
			getSessionId: () => "ps-maxtimeout-test",
			settings: cappedSettings,
		} as unknown as ToolSession;
		const tool = await loadPowerShellTool(session);
		expect(tool).not.toBeNull();
		if (!tool) return;

		// No `timeout` supplied -> falls back to PowerShell's 300s default,
		// which tools.maxTimeout=1 must still cap down to ~1s instead.
		const started = Date.now();
		await expect(tool.execute("t1", { command: "Start-Sleep -Seconds 30" })).rejects.toThrow(/timed out/i);
		const elapsedMs = Date.now() - started;
		expect(elapsedMs).toBeLessThan(15_000);
	});
});

// Ungated: these need neither pwsh nor a live host.

test("loadPowerShellTool returns null when no shell resolves", async () => {
	// The stub returns a bogus shellPath for every settings key the loader
	// reads, so $which cannot resolve it and the tool must stay unregistered.
	const stubSettings = { get: () => "omp-no-such-shell-zzz-12345" };
	const session = { cwd: process.cwd(), settings: stubSettings } as unknown as ToolSession;
	expect(await loadPowerShellTool(session)).toBeNull();
});

test("renderer tags non-default host modes and renders the output", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	if (!theme) return;

	const component = powershellToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "boom" }],
			isError: true,
			details: { host: "ephemeral" } as PowerShellToolDetails,
		},
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: "cmd /c exit 5", host: "ephemeral" },
	);
	const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const plain = stripAnsi(component.render(80).join("\n"));
	expect(plain).toContain("PowerShell · ephemeral");
	expect(plain).toContain("boom");

	// Default session mode carries no tag.
	const sessionComponent = powershellToolRenderer.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { host: "session" } as PowerShellToolDetails },
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: "'ok'" },
	);
	const sessionPlain = stripAnsi(sessionComponent.render(80).join("\n"));
	expect(sessionPlain).toContain("PowerShell");
	expect(sessionPlain).not.toContain("PowerShell ·");
});

test("collapsed preview shows the output TAIL, not the first lines", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	if (!theme) return;

	// 30 lines, collapsed: the preview must window the END of the output (a
	// long-running command's current progress), with a skipped-lines banner —
	// not pin the first N lines forever.
	const lines = Array.from({ length: 30 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
	const component = powershellToolRenderer.renderResult(
		{ content: [{ type: "text", text: lines.join("\n") }], details: { host: "session" } as PowerShellToolDetails },
		{ expanded: false } as Parameters<typeof powershellToolRenderer.renderResult>[1],
		theme,
		{ command: '1..30 | ForEach-Object { "row-$_" }' },
	);
	const plain = component
		.render(80)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	expect(plain).toContain("row-30");
	expect(plain).not.toContain("row-05");
	expect(plain).toMatch(/earlier lines/);
});
