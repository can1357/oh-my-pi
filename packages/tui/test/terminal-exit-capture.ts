/**
 * Observe the terminal's request to end the process, without performing it.
 *
 * `ProcessTerminal` ends the process by one of two routes, chosen at the call
 * site by platform (`src/terminal.ts`, `#markTerminalDisconnected`):
 *
 * - POSIX: `process.kill(process.pid, "SIGHUP")`;
 * - win32: `postmortem.quit(129, { drainStdout: false })`, which is
 *   `process.exit(129)`.
 *
 * A test that drives the disconnect path therefore kills the test runner unless
 * it intercepts both, and the resulting exit status reads as a hangup only
 * because 128+n is the shell's convention for signal n -- nothing delivered
 * that signal. This module intercepts both routes and records them as one
 * shape, so a test can assert that the terminal *asked* to exit without the
 * process going anywhere.
 *
 * `process.kill` is a poor record on its own. Teardown probes liveness with
 * `process.kill(pid, 0)` -- about a thousand times on one disconnect -- so "was
 * kill called" is true whether or not the terminal hung up, and an assertion on
 * the call count passes for the wrong reason. Only signals that can end the
 * process are recorded, which is what makes `requests` mean something.
 *
 * `postmortem.quit` is spied on the deep `@oh-my-pi/pi-utils/postmortem`
 * specifier, because that is what `src/terminal.ts` imports. Spying the
 * `@oh-my-pi/pi-utils` barrel would leave the real `process.exit` in place, and
 * the barrel only re-exports the module as a namespace.
 */
import { expect, vi } from "bun:test";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";

/** One request by the terminal to end the process, normalised across platforms. */
export type TerminalExitRequest =
	| { readonly kind: "signal"; readonly pid: number; readonly signal: string }
	| { readonly kind: "quit"; readonly code: number; readonly drainStdout: boolean | undefined };

/** What the terminal asked for, and how to stop recording. */
export interface TerminalExitCapture {
	/** Every request that can end the process, in order. Liveness probes are not requests. */
	readonly requests: readonly TerminalExitRequest[];
	/** How many of {@link requests} were a hangup signal rather than a quit. */
	readonly hangups: number;
	/** Put the real `process.kill` and `postmortem.quit` back. */
	restore(): void;
}

/**
 * Intercept both exit routes for the duration of a test.
 *
 * Call {@link TerminalExitCapture.restore} (or `vi.restoreAllMocks()`) in
 * teardown: a leaked `process.kill` spy would swallow a real signal, and a
 * leaked `quit` spy would swallow a real exit.
 */
export function captureTerminalExit(): TerminalExitCapture {
	const requests: TerminalExitRequest[] = [];
	const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string | number) => {
		// Signal 0 is a liveness probe, not a request to end the process.
		if (signal !== 0) requests.push({ kind: "signal", pid, signal: String(signal) });
		return true;
	}) as unknown as typeof process.kill);
	const quit = vi.spyOn(postmortem, "quit").mockImplementation(((
		code: number,
		options?: { drainStdout?: boolean },
	) => {
		requests.push({ kind: "quit", code, drainStdout: options?.drainStdout });
		return Promise.resolve();
	}) as unknown as typeof postmortem.quit);
	return {
		requests,
		get hangups() {
			return requests.filter(request => request.kind === "signal").length;
		},
		restore: () => {
			quit.mockRestore();
			kill.mockRestore();
		},
	};
}

/**
 * Assert the terminal asked to exit with this platform's 129 semantics.
 *
 * 129 is the hangup's shell encoding, so the *route* is what differs by
 * platform and the intent does not: the terminal is asking to go away with a
 * hangup, whether it signals one or exits 129 directly.
 */
export function expectExitRequested(requests: readonly TerminalExitRequest[]): void {
	expect(requests.length).toBeGreaterThan(0);
	const request = requests.at(-1);
	if (process.platform === "win32") expect(request).toMatchObject({ kind: "quit", code: 129 });
	else expect(request).toMatchObject({ kind: "signal", signal: "SIGHUP" });
}
