import { describe, expect, it } from "bun:test";
import { Terminal as VirtualTerminal } from "@oh-my-pi/pi-utils/vterm";

const COLUMNS = 120;
const ROWS = 30;

async function writeTerminal(terminal: VirtualTerminal, data: Uint8Array): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(data, resolve);
	await promise;
}

describe.skipIf(process.platform === "win32")("fatal stderr terminal handoff", () => {
	it("keeps the composer boundary intact in a real PTY", async () => {
		const chunks: Uint8Array[] = [];
		const closed = Promise.withResolvers<void>();
		const composerSeen = Promise.withResolvers<void>();
		const decoder = new TextDecoder();
		let decoded = "";
		await using terminal = new Bun.Terminal({
			cols: COLUMNS,
			rows: ROWS,
			data(_terminal, data) {
				chunks.push(data.slice());
				decoded += decoder.decode(data, { stream: true });
				if (decoded.includes("╰─")) composerSeen.resolve();
			},
			exit() {
				closed.resolve();
			},
		});
		const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/fatal-tui.ts`], {
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
			},
			terminal,
		});

		// Trigger the fatal path only after the composer boundary reached the PTY;
		// a fixed post-start delay raced the first paint on slow CI runners.
		await composerSeen.promise;
		terminal.write("\r");

		const exitCode = await proc.exited;
		terminal.close();
		await closed.promise;
		expect(exitCode).toBe(1);

		const screen = new VirtualTerminal({ cols: COLUMNS, rows: ROWS, scrollback: 100 });
		for (const chunk of chunks) await writeTerminal(screen, chunk);
		const buffer = screen.buffer.active;
		const lines = Array.from({ length: buffer.length }, (_, row) =>
			buffer.getLine(row)?.translateToString(true).trimEnd(),
		);
		const composerRow = lines.indexOf("╰─");
		const errorRow = lines.findIndex(line => line?.includes("error: fatal PTY fixture") === true);

		expect(composerRow).toBeGreaterThanOrEqual(0);
		expect(errorRow).toBeGreaterThan(composerRow);
	}, 30_000);
});
