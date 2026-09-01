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
		await using terminal = new Bun.Terminal({
			cols: COLUMNS,
			rows: ROWS,
			data(_terminal, data) {
				chunks.push(data.slice());
			},
			exit() {
				closed.resolve();
			},
		});
		const proc = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/fatal-tui.ts`], {
			cwd: process.cwd(),
			env: { ...process.env, OMP_TUI_DEBUG: undefined },
			terminal,
		});

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
	}, 15_000);
});
