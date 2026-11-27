/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `tui.screen: fullscreen` on a real terminal core: the session draws on the alternate screen with
 * the composer pinned to the bottom, PageUp/the wheel scroll the transcript while the composer
 * stays editable, Enter follows the tail again, and stopping leaves the transcript on the normal
 * screen without erasing the shell's scrollback.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

const ERASE_SCROLLBACK = "\x1b[3J";

describe("fullscreen screen mode", () => {
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		term = createModeTerminal({ columns: 60, rows: 16 });
		term.frame.screen.set("fullscreen");
		await term.start();
		for (let i = 0; i < 40; i++) term.frame.shell.transcript.append(() => <rows lines={[`line ${i}`]} />);
		await term.waitFor(rows => rows.some(row => row.includes("line 39")));
	});

	afterEach(async () => {
		await term.frame.shell.stop();
		term.dispose();
		resetSettingsForTest();
	});

	it("scrolls the transcript above a pinned, editable composer and follows again on Enter", async () => {
		expect(term.engine.isMainScreen).toBe(false);
		const bottom = term.screen().at(-1);
		term.press("pageup");
		await term.waitFor(rows => !rows.some(row => row.includes("line 39")));
		expect(term.screen().some(row => row.includes("line 39"))).toBe(false);
		// The dock did not move, and typing lands in the composer without leaving the scrolled view.
		expect(term.screen().at(-1)).toBe(bottom);
		term.type("draft");
		await term.waitFor(() => term.frame.composer.text() === "draft");
		expect(!term.screen().some(row => row.includes("line 39"))).toBe(true);
		term.press("enter");
		await term.waitFor(rows => rows.some(row => row.includes("line 39")));
		expect(term.screen().some(row => row.includes("lines below"))).toBe(false);
	});

	it("finds older transcript text without editing or submitting the draft", async () => {
		term.type("unsent");
		term.feed("\x1b/");
		term.type("line 12");
		await term.waitFor(rows => rows.some(row => row.includes("line 12")) && rows.some(row => row.includes("1/1")));
		expect(term.frame.composer.text()).toBe("unsent");
		term.press("escape");
		await term.waitFor(rows => rows.some(row => row.includes("line 39")));
		term.type("!");
		expect(term.frame.composer.text()).toBe("unsent!");
	});

	it("jumps between user prompts, skipping intervening output", async () => {
		for (let i = 0; i < 3; i++) {
			term.frame.shell.transcript.append(() => <text>{`prompt ${i}`}</text>, { prompt: true });
			term.frame.shell.transcript.append(() => (
				<rows lines={Array.from({ length: 20 }, (_, j) => `reply ${i}:${j}`)} />
			));
		}
		await term.waitFor(rows => rows.some(row => row.includes("reply 2:19")));
		term.press("alt+pageup");
		await term.waitFor(rows => rows.slice(0, 2).some(row => row.includes("prompt 2")));
		term.press("alt+pageup");
		await term.waitFor(rows => rows.slice(0, 2).some(row => row.includes("prompt 1")));
		term.press("alt+pagedown");
		await term.waitFor(rows => rows.slice(0, 2).some(row => row.includes("prompt 2")));
	});

	it("reports the wheel and scrolls with it", async () => {
		term.mouse({ x: 2, y: 2, button: "wheel-up" });
		await term.waitFor(rows => !rows.some(row => row.includes("line 39")));
		term.mouse({ x: 2, y: 2, button: "wheel-down" });
		await term.waitFor(rows => rows.some(row => row.includes("line 39")));
	});

	it("leaves the whole transcript on the normal screen at exit without erasing scrollback", async () => {
		await term.frame.shell.stop();
		expect(term.engine.isMainScreen).toBe(true);
		const text = term.text();
		expect(text).toContain("line 0");
		expect(text).toContain("line 39");
		expect(term.memory.output.join("")).not.toContain(ERASE_SCROLLBACK);
	});
});
