/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `Host.setMouse`: sets the driver's mouse reporting, and turning it off forgets the hovered hit
 * (no report would clear its band anymore).
 */
import { describe, expect, it } from "bun:test";
import { createSurface, startHost } from "@oh-my-pi/pi-tui";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { settle } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

describe("Host.setMouse", () => {
	it("routes clicks and hover below visible history and ignores reports over that history", async () => {
		const memory = memoryTerminal({ columns: 20, rows: 6, driver: { resizeScrollback: "preserve" } });
		const driver = createTerminalDriver(memory.options);
		const selected: string[] = [];
		defineRolePainter("canvas", "test.history-hits", (node, cx) => {
			const hover = cx.hovered(node)?.item;
			return {
				rows: ["a", "b"].map(item => (item === hover ? `> ${item}` : item)),
				hits: ["a", "b"].map((item, row) => ({ row, col: 0, width: cx.width, height: 1, node, item })),
			};
		});
		const surface = createSurface(() => ({
			main: <rows lines={["1", "2", "3", "4", "5"]} />,
			dock: <canvas role="test.history-hits" paint={() => []} onSelect={item => selected.push(item)} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => loadThemeSync("dark") });
		await driver.start();
		try {
			backend.start();
			settle(surface.main()[0]!);
			backend.renderNow();
			expect(backend.retired(surface.main()[0]!)).toBe(true);
			// The whole settled block retired; the last four history rows remain above the two live rows.
			memory.feed("\x1b[<35;1;6M");
			expect(backend.environment.hover?.()?.item).toBe("b");
			memory.feed("\x1b[<0;1;5M");
			memory.feed("\x1b[<0;1;1M");
			expect(selected).toEqual(["a"]);
			expect(backend.environment.hover?.()).toBeNull();
		} finally {
			backend.stop();
			await driver.stop();
			surface.dispose();
		}
	});

	it("forgets the hovered hit when pointer tracking turns off", async () => {
		const seen: (string | undefined)[] = [];
		defineRolePainter("canvas", "test.host-hover", (node, cx) => {
			const hover = cx.hovered(node)?.item;
			seen.push(hover);
			return {
				rows: ["a", "b"],
				hits: [0, 1].map(i => ({ row: i, col: 0, width: cx.width, height: 1, node, item: `r${i}` })),
			};
		});
		const term = memoryTerminal({ columns: 20, rows: 6 });
		const surface = createSurface(() => ({ main: <canvas role="test.host-hover" paint={() => []} /> }));
		const host = await startHost({
			surface,
			theme: () => loadThemeSync("dark"),
			native: false,
			driver: term.options,
		});
		try {
			host.setMouse("any");
			const lastSeen = async (): Promise<string | undefined> => {
				await Bun.sleep(40);
				return seen.at(-1);
			};
			// SGR motion (no button) over the second row of the canvas, wherever it is on screen.
			for (let row = 1; row <= 6 && (await lastSeen()) === undefined; row++) term.feed(`\x1b[<35;1;${row}M`);
			expect(seen.at(-1)).toMatch(/^r[01]$/);

			host.setMouse("off");
			expect(await lastSeen()).toBeUndefined();
		} finally {
			await host.stop();
			surface.dispose();
		}
	});
});
