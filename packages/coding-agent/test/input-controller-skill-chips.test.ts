/**
 * Skill chips: typing `/skill:<name>` of a known skill collapses it into a chip once something
 * follows it, a restored draft collapses its tokens too, and the chip is sent as the token.
 * Unknown skills and another command's text stay literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { Skill } from "../src/extensibility/skills";
import { initTheme } from "../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext } from "./helpers/interactive-mode-context";

const SKILL_FILE = "/tmp/skills/review/SKILL.md";

const restoreTheme = currentTheme();

beforeAll(() => {
	initTheme();
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

function setup() {
	const skill = { name: "review", filePath: SKILL_FILE } as Skill;
	const ctx = createInteractiveModeContext({
		session: { prewarmModelConnection: () => {} },
		skillCommands: new Map([["skill:review", skill]]),
	});
	new InputController(ctx).setupKeyHandlers();
	const submitted: string[] = [];
	ctx.composer.onSubmit = text => {
		submitted.push(text);
	};
	const term = attachTerminal(ctx);
	const chip = `${currentTheme().symbols.symbol("icon.extensionSkill")} review`;
	return { ctx, term, submitted, chip };
}

describe("skill chips", () => {
	it("collapse a typed known skill once it is complete and submit as the token", () => {
		const { ctx, term, submitted, chip } = setup();
		term.type("/skill:review");
		// Still being typed: no chip yet.
		expect(ctx.composer.text()).toBe("/skill:review");
		term.type(" fix it");
		expect(ctx.composer.text()).toBe(`${chip} fix it`);
		expect(ctx.composer.cursor()).toBe(ctx.composer.text().length);
		term.press("enter");
		expect(submitted).toEqual(["/skill:review fix it"]);
	});

	it("leave unknown skills and other commands' text literal", () => {
		const { ctx, term } = setup();
		term.type("/skill:unknown go");
		expect(ctx.composer.text()).toBe("/skill:unknown go");
		ctx.composer.setText("");
		term.type("/plan /skill:review now");
		expect(ctx.composer.text()).toBe("/plan /skill:review now");
	});

	it("collapse in a restored draft; deleting into the chip deletes all of it", () => {
		const { ctx, term, chip } = setup();
		ctx.composer.setDraft("use /skill:review here");
		expect(ctx.composer.text()).toBe(`use ${chip} here`);
		expect(ctx.composer.expandedText()).toBe("use /skill:review here");
		ctx.composer.setCursor(`use ${chip}`.length);
		term.press("backspace");
		expect(ctx.composer.text()).toBe("use  here");
	});
});
