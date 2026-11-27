/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Regression for "the terminal follows the agent while the user reads back"
 * (oh-my-pi#1755). The renderers never probe the user's scroll position, so
 * following has to be an explicit gesture; this file defends the contract that
 * makes the gesture usable:
 *
 * 1. While held, no byte reaches the terminal — streaming rows, spinner frames
 *    and a resize transaction all stop.
 * 2. Nothing is lost: changes made during the hold land on release.
 * 3. A resize during the hold releases as an in-place repaint; a hold must
 *    never cause the scrollback rebuild it exists to prevent.
 * 4. The notice is one sanitized row, so hostile text cannot scroll or erase.
 */
import { describe, expect, it } from "bun:test";
import { createSurface, type JSXNode, settle, signal, startHost, type UiNode } from "@oh-my-pi/pi-tui";
import { type MemoryTerminal, memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

async function openHarness(columns = 40, rows = 10, resizeScrollback: "preserve" | "rebuild" = "preserve") {
	const main = signal<JSXNode[]>([<rows key="live" lines={["live one"]} />]);
	const surface = createSurface(() => ({ main: () => main() }));
	const term = memoryTerminal({ columns, rows, driver: { resizeScrollback } });
	const host = await startHost({ surface, theme: () => loadThemeSync("dark"), native: false, driver: term.options });
	return { host, term, main, surface };
}

const output = (term: MemoryTerminal): string => term.output.join("");

describe("Host.setOutputHold", () => {
	it("writes nothing while held and repaints the newest state on release", async () => {
		const { host, term, main, surface } = await openHarness();
		try {
			expect(host.setOutputHold(true, "held")).toBe(true);
			expect(host.getOutputHold()).toBe(true);
			const mark = term.bytes();

			// Streaming rows keep arriving; not one byte may reach the terminal.
			main.set([<rows key="live" lines={["live one", "live two", "live three"]} />]);
			await Bun.sleep(150);
			expect(term.bytes()).toBe(mark);

			host.setOutputHold(false);
			await Bun.sleep(150);
			expect(term.bytes()).toBeGreaterThan(mark);
			expect(output(term)).toContain("live three");
			expect(host.getOutputHold()).toBe(false);
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("withholds a history batch while held and writes it once on release", async () => {
		const { host, term, main, surface } = await openHarness(40, 6);
		try {
			const history = (
				<rows key="history" lines={Array.from({ length: 10 }, (_, i) => `history-${i}`)} />
			) as UiNode;
			settle(history);
			expect(host.setOutputHold(true)).toBe(true);
			const mark = term.bytes();

			// A settled block that cannot fit must retire into history — but not while held.
			main.set([history, <rows key="live" lines={["live"]} />]);
			await Bun.sleep(150);
			expect(term.bytes()).toBe(mark);
			expect(output(term)).not.toContain("history-0");

			host.setOutputHold(false);
			await Bun.sleep(150);
			const written = output(term);
			expect(written.match(/history-0/g)?.length).toBe(1);
			expect(written).toContain("live");
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("is idempotent", async () => {
		const { host, surface } = await openHarness();
		try {
			expect(host.setOutputHold(true)).toBe(true);
			expect(host.setOutputHold(true, "again")).toBe(false);
			expect(host.setOutputHold(false)).toBe(true);
			expect(host.setOutputHold(false)).toBe(false);
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("holds a resize and repaints in place instead of replaying history", async () => {
		const { host, term, main, surface } = await openHarness(40, 10, "rebuild");
		try {
			await Bun.sleep(80);
			expect(host.setOutputHold(true)).toBe(true);
			const mark = term.bytes();

			// A width change under `rebuild` normally clears and replays history.
			term.resize(24, 10);
			main.set([<rows key="live" lines={["live one", "live two"]} />]);
			// Past the resize settle window: nothing may be written.
			await Bun.sleep(200);
			expect(term.bytes()).toBe(mark);

			host.setOutputHold(false);
			await Bun.sleep(200);
			const after = output(term);
			// `rebuild` would emit ED3 (`\x1b[3J`) plus a full transcript replay.
			expect(after).not.toContain("\x1b[3J");
			expect(after).toContain("live two");
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("sanitizes the notice into one row that cannot erase history", async () => {
		const { host, term, surface } = await openHarness();
		try {
			host.setOutputHold(true, "held\x1b[3J\nIMPOSTOR");
			const written = output(term);
			expect(written).not.toContain("\x1b[3J");
			expect(Bun.stripANSI(written)).toContain("IMPOSTOR");
			// No line terminator: the hint never pushes a row into scrollback.
			expect(written).not.toContain("\n");
			expect(host.getOutputHold()).toBe(true);
		} finally {
			await host.stop();
			surface.dispose();
		}
	});
});
