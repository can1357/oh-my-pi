import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { UserMessageComponent, getUserMessageShape, setUserMessageShape } from "../src/chat/user-message";
import { initTheme } from "../src/theme";

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

	it("respects process-wide setUserMessageShape", () => {
		setUserMessageShape("box");
		expect(getUserMessageShape()).toBe("box");
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
});
