/**
 * Shared scenario protocol for the terminal-output-isolation fixtures.
 *
 * Drives a real TUI through the inherited/captured/handoff/restart scenarios
 * against a live PTY, using single-key input and status-row markers the test
 * driver waits for in the PTY byte stream. Imported by:
 *   - terminal-output-isolation-fixture.ts (plain `bun` child; pump on, or
 *     pump off when launched with PI_TEST_RUNTIME=1 + OMP_ISOLATION_FALLBACK=1
 *     so the fallback render path drives the same contract)
 *   - terminal-output-pipe-smoke.ts        (piped stdout; guard must leave
 *     non-TTY output untouched)
 */
import * as fs from "node:fs";
import { TUI } from "@oh-my-pi/pi-tui";
import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui/terminal";

export const TITLE_SENTINEL = "OMP_ISOLATION_TITLE_CLEAN";
export const OUT_SENTINEL = "OMP_ISOLATION_DIAGNOSTICS_OUT";
export const ERR_SENTINEL = "OMP_ISOLATION_DIAGNOSTICS_ERR";
export const HANDOFF_OUT_SENTINEL = "OMP_ISOLATION_HANDOFF_OUT";
export const HANDOFF_ERR_SENTINEL = "OMP_ISOLATION_HANDOFF_ERR";
export const PARENT_OUT_SENTINEL = "OMP_ISOLATION_PARENT_OUT";
export const PARENT_RAWFD_SENTINEL = "OMP_ISOLATION_PARENT_RAWFD";
export const PARENT_ERR_SENTINEL = "OMP_ISOLATION_PARENT_ERR";
export const PARENT_RAWFD_ERR_SENTINEL = "OMP_ISOLATION_PARENT_FD2_RAW";
export const BUN_OUT_SENTINEL = "OMP_ISOLATION_BUN_OUT";
export const BUN_ERR_SENTINEL = "OMP_ISOLATION_BUN_ERR";
export const EMERGENCY_SENTINEL = "OMP_ISOLATION_EMERGENCY_RESTORED";
// Cache the Bun files before ProcessTerminal.start(), like extension modules do.
const cachedBunStdout = Bun.stdout;
const cachedBunStderr = Bun.stderr;

interface DiagnosticsPayload {
	readonly stdout: string;
	readonly stderr: string;
}

function diagnostics(outSentinel: string, errSentinel: string): DiagnosticsPayload {
	return {
		stdout:
			[
				outSentinel,
				"worker.ts:539: error TS2322: Synthetic compiler diagnostic (stdout).",
				"Found 1 synthetic error. No compiler was executed.",
			].join("\n") + "\n",
		stderr:
			[
				errSentinel,
				"worker.ts:539: error TS2322: Synthetic compiler diagnostic (stderr).",
				"Found 1 synthetic error. No compiler was executed.",
			].join("\n") + "\n",
	};
}

interface ChildOutcome {
	readonly code: number;
}

async function spawnDiagnosticsChild(
	mode: "inherited" | "captured",
	outSentinel: string,
	errSentinel: string,
): Promise<ChildOutcome> {
	const payload = diagnostics(outSentinel, errSentinel);
	const script =
		`process.stdout.write(${JSON.stringify(payload.stdout)});` +
		`process.stderr.write(${JSON.stringify(payload.stderr)});` +
		"process.exitCode = 1;";
	const child = Bun.spawn([process.execPath, "-e", script], {
		stdin: "ignore",
		stdout: mode === "captured" ? "pipe" : "inherit",
		stderr: mode === "captured" ? "pipe" : "inherit",
	});
	if (child.stdout) await child.stdout.text();
	if (child.stderr) await child.stderr.text();
	return { code: await child.exited };
}

/**
 * Install the marker-rendering component and the key protocol on `tui`.
 * `quit` runs when `q` arrives (each entrypoint owns its own exit semantics).
 */
export function installIsolationScenario(tui: TUI, quit: () => void): void {
	let status = "ST_READY";
	let busy = false;

	tui.addChild({
		render(width: number): readonly string[] {
			return [
				TITLE_SENTINEL,
				"Real ProcessTerminal + TUI inside a native PtySession PTY.",
				"c inherited | p captured | e handoff | i post-restart | q quit",
				`STATUS ${status} LIVE_${process.stdout.columns}x${process.stdout.rows}`,
			].map(row => row.slice(0, width));
		},
		invalidate(): void {},
	});

	async function runScenario(key: string): Promise<void> {
		switch (key) {
			case "c": {
				const { code } = await spawnDiagnosticsChild("inherited", OUT_SENTINEL, ERR_SENTINEL);
				// Ordinary in-process writes an extension would make: the
				// cached process streams and a raw fd writer must be covered
				// by the same isolation as inherited child descriptors. Bun
				// queues process.stdout/stderr writes asynchronously, so each
				// write is fenced by its flush callback — the scenario marker
				// (and any later exit/restore) can never race ahead of the
				// bytes actually landing on the redirected fd.
				const outFlushed = Promise.withResolvers<void>();
				process.stdout.write(`${PARENT_OUT_SENTINEL} direct process.stdout.write\n`, () => outFlushed.resolve());
				await outFlushed.promise;
				const errFlushed = Promise.withResolvers<void>();
				process.stderr.write(`${PARENT_ERR_SENTINEL} direct process.stderr.write\n`, () => errFlushed.resolve());
				await errFlushed.promise;
				fs.writeSync(1, `${PARENT_RAWFD_SENTINEL} direct writeSync(1)\n`);
				fs.writeSync(2, `${PARENT_RAWFD_ERR_SENTINEL} direct writeSync(2)\n`);
				await Bun.write(cachedBunStdout, `${BUN_OUT_SENTINEL} cached Bun.stdout\n`);
				await Bun.write(cachedBunStderr, `${BUN_ERR_SENTINEL} cached Bun.stderr\n`);
				status = `ST_INHERITED_${code}`;
				tui.requestRender();
				return;
			}
			case "p": {
				const { code } = await spawnDiagnosticsChild("captured", OUT_SENTINEL, ERR_SENTINEL);
				status = `ST_CAPTURED_${code}`;
				tui.requestRender();
				return;
			}
			case "e": {
				// Editor/suspend handoff: the TUI releases the terminal, an
				// external program owns it (its output must reach the real
				// terminal), then the TUI restarts and must re-acquire
				// exclusive output isolation.
				tui.stop();
				const { code } = await spawnDiagnosticsChild("inherited", HANDOFF_OUT_SENTINEL, HANDOFF_ERR_SENTINEL);
				status = `ST_HANDOFF_${code}`;
				tui.start();
				return;
			}
			case "i": {
				const { code } = await spawnDiagnosticsChild("inherited", OUT_SENTINEL, ERR_SENTINEL);
				status = `ST_RESTART_${code}`;
				tui.requestRender();
				return;
			}
			case "x": {
				emergencyTerminalRestore();
				fs.writeSync(1, `${EMERGENCY_SENTINEL} stdout\n`);
				fs.writeSync(2, `${EMERGENCY_SENTINEL} stderr\n`);
				quit();
				return;
			}
			default:
				return;
		}
	}

	tui.addInputListener((data: string) => {
		if (data === "q") {
			quit();
		}
		if (busy) {
			return { consume: true };
		}
		busy = true;
		void runScenario(data)
			.catch((error: unknown) => {
				tui.stop();
				process.stderr.write(`isolation fixture: scenario ${data} failed: ${String(error)}\n`);
				process.exit(3);
			})
			.finally(() => {
				busy = false;
			});
		return { consume: true };
	});
}
