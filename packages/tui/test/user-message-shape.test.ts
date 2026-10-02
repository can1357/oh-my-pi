import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { UserMessageComponent, setUserMessageShape } from "../src/chat/user-message";
import { initTheme, theme } from "../src/theme";

const W = 60;

beforeEach(async () => {
	await initTheme(false);
	setUserMessageShape("block");
});

afterEach(() => {
	setUserMessageShape("block");
});

describe("UserMessageComponent shapes", () => {
	it("defaults to block shape with padded background", () => {
		const comp = new UserMessageComponent("Hello block");
		const rows = comp.render(W);
		expect(rows.length).toBeGreaterThan(2);
		const plain = rows.map(r => Bun.stripANSI(r));
		// No border glyphs in block mode
		expect(plain[0]).not.toContain("╭");
		expect(plain[plain.length - 1]).not.toContain("╰");
	});

	it("renders boxed border when shape is box", () => {
		const comp = new UserMessageComponent("Hello box", { shape: "box" });
		const rows = comp.render(W);
		expect(rows.length).toBe(3); // top border + 1 content row + bottom border
		const plain = rows.map(r => Bun.stripANSI(r));
		expect(plain[0]).toStartWith("╭");
		expect(plain[0]).toEndWith("╮");
		expect(plain[1]).toStartWith("│");
		expect(plain[1]).toEndWith("│");
		expect(plain[1]).toContain("Hello box");
		expect(plain[2]).toStartWith("╰");
		expect(plain[2]).toEndWith("╯");
		for (const row of plain) {
			expect(Bun.stringWidth(row)).toBe(W);
		}
	});

	it("renders plain transparent text when shape is plain", () => {
		const comp = new UserMessageComponent("Hello plain", { shape: "plain" });
		const rows = comp.render(W);
		const plain = rows.map(r => Bun.stripANSI(r));
		expect(plain[0]).not.toContain("╭");
		expect(plain.join("\n")).toContain("Hello plain");
	});

	it("does not leak userMessageBg background color after chips in plain and box modes", () => {
		const userMsgBg = theme.getBgAnsi("userMessageBg");
		expect(userMsgBg).not.toBe("");
		for (const shape of ["plain", "box"] as const) {
			const comp = new UserMessageComponent('ask <model agent="m1" name="Opus"/> about this please', { shape });
			const rows = comp.render(W);
			for (const row of rows) {
				expect(row).not.toContain(userMsgBg);
			}
		}
	});

	it("respects process-wide setUserMessageShape", () => {
		setUserMessageShape("box");
		const comp = new UserMessageComponent("Global box");
		const rows = comp.render(W);
		const plain = rows.map(r => Bun.stripANSI(r));
		expect(plain[0]).toStartWith("╭");
		expect(plain[plain.length - 1]).toEndWith("╯");
	});

	it("docks reaction badge cleanly into top border in box mode", () => {
		const comp = new UserMessageComponent("Ship it", { shape: "box" });
		comp.setReaction("🚀");
		const rows = comp.render(W);
		const plain = rows.map(r => Bun.stripANSI(r));
		expect(plain[0]).toContain("🚀");
		expect(plain[0]).toStartWith("╭");
		expect(plain[0]).toEndWith("╮");
		expect(Bun.stringWidth(plain[0]!)).toBe(W);
	});
	it("falls back gracefully without synthesizing borders at very narrow widths", () => {
		const comp = new UserMessageComponent("hello world", { shape: "box", liveSteered: true });
		const rows4 = comp.render(4);
		expect(rows4.length).toBeGreaterThan(0);
		// At width 4 or 3, rows must not overflow their given width
		for (const row of rows4) {
			expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(4);
		}
		const rows3 = comp.render(3);
		for (const row of rows3) {
			expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(3);
		}
	});
});
