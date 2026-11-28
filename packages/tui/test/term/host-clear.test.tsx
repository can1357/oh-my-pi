/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `HostOptions.clear`: a program started below another one's screen (a restart, a fresh
 * launch) erases the display in the same write as its first frame, never drawing it below.
 */
import { describe, expect, it } from "bun:test";
import { createSurface, startHost } from "@oh-my-pi/pi-tui";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const ERASE_SCREEN = "\x1b[2J";

describe("startHost clear", () => {
	it("erases the display in the write that draws the first frame", async () => {
		const term = memoryTerminal({ columns: 20, rows: 6, cursor: () => ({ x: 0, y: 3 }) });
		const surface = createSurface(() => ({ main: <rows lines={["welcome"]} /> }));
		const host = await startHost({
			surface,
			theme: () => loadThemeSync("dark"),
			native: false,
			driver: term.options,
			clear: true,
		});
		try {
			const first = term.output.find(chunk => chunk.includes("welcome"));
			expect(first).toBeDefined();
			expect(first!.indexOf(ERASE_SCREEN)).toBeGreaterThanOrEqual(0);
			expect(first!.indexOf(ERASE_SCREEN)).toBeLessThan(first!.indexOf("welcome"));
		} finally {
			await host.stop();
			surface.dispose();
		}
	});
});
