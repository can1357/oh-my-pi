import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal as VirtualTerminal } from "@oh-my-pi/pi-utils/vterm";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const COLUMNS = 120;
const ROWS = 30;

function terminalLines(terminal: VirtualTerminal): (string | undefined)[] {
	const buffer = terminal.buffer.active;
	return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true).trimEnd());
}

describe.skipIf(process.platform === "win32")("fatal stderr terminal handoff", () => {
	it("closes the native surface and consumes its outstanding ack before reporting a fatal rejection", async () => {
		const home = await mkdtemp(join(tmpdir(), "omp-fatal-tern-"));
		const closed = Promise.withResolvers<void>();
		let output = "";
		let answered = 0;
		let cursor = false;
		let frame: { sf: string; s: number } | undefined;
		let ackSent = false;
		let handedBack = false;
		const decoder = new TextDecoder();
		await using terminal = new Bun.Terminal({
			cols: COLUMNS,
			rows: ROWS,
			data(tty, data) {
				output += decoder.decode(data, { stream: true });
				// A scripted Tern: hold the first frame's ack until the exit fence arrives.
				const queries = output.split("\x1b[c").length - 1;
				while (answered < queries) {
					answered++;
					if (answered === 3) tty.write('\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["text"]}\x1b\\');
					if (frame && output.includes("\x1b_tsp;x;")) {
						tty.write(`\x1b_tsp;e;${JSON.stringify({ ev: "ack", sf: frame.sf, s: frame.s })}\x1b\\`);
						ackSent = true;
					}
					tty.write("\x1b[?62c");
				}
				if (!cursor && output.includes("\x1b[6n")) {
					cursor = true;
					tty.write("\x1b[1;1R");
				}
				if (!frame) {
					const match = /\x1b_tsp;f;([^\x1b]+)\x1b\\/.exec(output);
					if (match) {
						frame = JSON.parse(match[1]!) as { sf: string; s: number };
						tty.write("\r");
					}
				}
				if (!handedBack && output.includes("SHELL-READY")) {
					handedBack = true;
					tty.write("clean\n");
				}
			},
			exit: () => closed.resolve(),
		});
		try {
			// The parent shell checks its actual termios and reads its first command.
			// A queued APC can contaminate that command even if echo never printed it.
			const shell = `initial=$(stty -g) || exit 70
"$@"; code=$?
[ "$(stty -g)" = "$initial" ] || exit 71
printf '\\nSHELL-READY\\n'
IFS= read -r line && [ "$line" = clean ] || exit 72
exit "$code"`;
			const proc = Bun.spawn(
				["sh", "-c", shell, "sh", process.execPath, `${import.meta.dir}/fixtures/fatal-tui.ts`, "--native"],
				{
					env: { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", TERM_PROGRAM: "tern" },
					terminal,
					timeout: 20_000,
				},
			);
			expect(await proc.exited).toBe(1);
			expect(ackSent).toBe(true);
			expect(handedBack).toBe(true);
			const close = output.indexOf("\x1b_tsp;x;");
			const modes = output.indexOf("\x1b[?2004l", close);
			const fence = output.indexOf("\x1b[c", modes);
			const report = output.indexOf("[Unhandled Rejection] Error: unhandled native PTY fixture");
			expect(close).toBeGreaterThan(-1);
			expect(modes).toBeGreaterThan(close);
			expect(fence).toBeGreaterThan(modes);
			expect(report).toBeGreaterThan(fence);
			expect(output).not.toContain('"ev":"ack"');
			expect(output.slice(report)).not.toContain("fatal-tui.ts:");
			const log = /Details: ([^\r\n]+)/.exec(output.slice(report))?.[1];
			expect(log).toStartWith(`${home}/`);
			const persisted = await Bun.file(log!).text();
			expect(persisted).toContain('"message":"Unhandled rejection"');
			expect(persisted).toContain('"stack":"Error: unhandled native PTY fixture\\n');
			expect(persisted).toContain("fatal-tui.ts:");
		} finally {
			terminal.close();
			await closed.promise;
			await rm(home, { recursive: true, force: true });
		}
	}, 30_000);

	it.each(["inline", "fullscreen"] as const)(
		"restores %s mode before showing the fatal report in a real PTY",
		async mode => {
			const screen = new VirtualTerminal({ cols: COLUMNS, rows: ROWS, scrollback: 100 });
			const closed = Promise.withResolvers<void>();
			const composerSeen = Promise.withResolvers<void>();
			let screenWritten = Promise.resolve();
			let wire = "";
			const decoder = new TextDecoder();
			await using terminal = new Bun.Terminal({
				cols: COLUMNS,
				rows: ROWS,
				data(_terminal, data) {
					wire += decoder.decode(data, { stream: true });
					const written = Promise.withResolvers<void>();
					screenWritten = written.promise;
					screen.write(data, () => {
						if (terminalLines(screen).includes("╰─")) composerSeen.resolve();
						written.resolve();
					});
				},
				exit() {
					closed.resolve();
				},
			});
			try {
				const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/fatal-tui.ts`, `--${mode}`], {
					cwd: process.cwd(),
					// This is a real-terminal contract test: shed the test-runtime markers so
					// the fixture's ProcessTerminal paints instead of going headless
					// (ci-test-ts children inherit PI_TEST_RUNTIME=1).
					env: {
						...process.env,
						OMP_TUI_DEBUG: undefined,
						PI_TEST_RUNTIME: undefined,
						BUN_ENV: undefined,
						NODE_ENV: undefined,
						// Bun's PTY and the VT parser do not implement native TSP surfaces.
						// A parent running in Tern must not turn the fixture's rows into APC JSON.
						TERM: "xterm-256color",
						TERM_PROGRAM: undefined,
						OMP_TUI_NATIVE: "0",
						PI_TUI_NATIVE: "0",
					},
					terminal,
				});

				try {
					// Wait for a painted composer row, not merely matching bytes inside an
					// escape payload; a fixed delay also races the first paint on slow CI.
					await Promise.race([
						composerSeen.promise,
						proc.exited.then(code => {
							throw new Error(`Fatal PTY fixture exited before painting the composer (exit ${code})`);
						}),
					]);
					terminal.write("\r");

					const exitCode = await proc.exited;
					terminal.close();
					await closed.promise;
					await screenWritten;
					expect(exitCode).toBe(1);

					const lines = terminalLines(screen);
					const composerRow = lines.indexOf("╰─");
					const errorRow = lines.findIndex(
						line => line?.includes("[Fatal Error] Error: fatal PTY fixture") === true,
					);

					if (mode === "fullscreen") {
						expect(composerRow).toBe(-1);
						expect(lines).not.toContain("safe transcript");
						const report = wire.indexOf("[Fatal Error]");
						for (const restore of ["\x1b[?1049l", "\x1b[?1002l", "\x1b[?1004l"]) {
							const at = wire.indexOf(restore);
							expect(at).toBeGreaterThanOrEqual(0);
							expect(at).toBeLessThan(report);
						}
					} else expect(composerRow).toBeGreaterThanOrEqual(0);
					expect(errorRow).toBeGreaterThan(composerRow);
				} finally {
					if (proc.exitCode === null) proc.kill();
					await proc.exited;
				}
			} finally {
				terminal.close();
				await closed.promise;
				await screenWritten;
				screen.dispose();
			}
		},
		30_000,
	);
});
