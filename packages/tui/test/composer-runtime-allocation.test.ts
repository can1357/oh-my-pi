import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class Rows implements Component {
	reads = 0;
	constructor(
		readonly label: string,
		public count: number,
	) {}
	render(): readonly string[] {
		this.reads++;
		return Array.from({ length: this.count }, (_, index) => `${this.label} ${index}`);
	}
}

beforeAll(initTheme);

describe("Composer runtime allocation", () => {
	// (12, 8) exercises the constrained branch (the HUD gets fewer than 6 rows); (27, 3) the capped one.
	for (const [rows, inputRows] of [
		[12, 8],
		[27, 3],
	] as const) {
		it(`shares the ${rows}-row viewport with a ${inputRows}-row input without rendering siblings twice`, () => {
			const terminal = new VirtualTerminal(80, rows);
			const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
			const transcript = new TranscriptContainer();
			const chrome = new Rows("QUEUE", 2);
			const hud = new Rows("HUD", 20);
			const input = new Rows("INPUT", inputRows);
			let available = 0;
			let allocations = 0;
			composer.setRuntimeChildren([transcript, chrome, hud, input], {
				allocation: {
					hud,
					input,
					apply: (viewport, chromeRows, renderInput) => {
						allocations++;
						expect(viewport).toEqual({ columns: 80, rows });
						expect(renderInput()).toBe(inputRows);
						expect(renderInput()).toBe(inputRows);
						available = Math.max(0, viewport.rows - chromeRows - inputRows);
						hud.count = Math.min(6, available);
					},
				},
			});
			composer.start({ playWelcomeIntro: false });
			try {
				const frame = composer.renderFrame({ columns: 80, rows });
				expect(allocations).toBe(1);
				expect(chrome.reads).toBe(1);
				expect(input.reads).toBe(1);
				expect(hud.reads).toBe(1);
				expect(frame.viewport.filter(line => line.includes("HUD "))).toHaveLength(Math.min(6, available));
				expect(frame.viewport.filter(line => line.includes("INPUT "))).toHaveLength(inputRows);
				expect(frame.viewport.length).toBeLessThanOrEqual(rows);
			} finally {
				composer.stop();
			}
		});
	}

	it("does not allocate absent roots and preserves the ordinary runtime rendering", () => {
		const terminal = new VirtualTerminal(80, 18);
		const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const transcript = new TranscriptContainer();
		const hud = new Rows("HUD", 2);
		const input = new Rows("INPUT", 3);
		let allocated = false;
		composer.setRuntimeChildren([transcript, hud, input], {
			allocation: {
				hud: new Rows("ABSENT", 1),
				input,
				apply: () => {
					allocated = true;
				},
			},
		});
		composer.start({ playWelcomeIntro: false });
		try {
			const frame = composer.renderFrame({ columns: 80, rows: 18 });
			expect(allocated).toBe(false);
			expect(frame.viewport.filter(line => line.includes("HUD "))).toHaveLength(2);
			expect(frame.viewport.filter(line => line.includes("INPUT "))).toHaveLength(3);
		} finally {
			composer.stop();
		}
	});
});
