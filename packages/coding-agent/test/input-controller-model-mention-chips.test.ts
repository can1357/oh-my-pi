/**
 * Model-mention chips: `^provider/id` of a taggable model collapses into a chip once something
 * follows it (prose punctuation after it stays text) and is sent as the canonical `^selector`;
 * submitted `<model agent=…/>` tags of known pseudonyms come back as chips in restored drafts.
 * Unknown models, a label already standing for another model and local-execution drafts stay literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { initTheme } from "../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext } from "./helpers/interactive-mode-context";

const restoreTheme = currentTheme();

beforeAll(() => {
	initTheme();
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

/** Mentionable models by the selectors that name them. */
const MODELS: Record<string, { selector: string; name: string }> = {
	"anthropic/opus": { selector: "anthropic/opus", name: "Opus" },
	opus: { selector: "anthropic/opus", name: "Opus" },
	"other/opus": { selector: "other/opus", name: "Opus" },
};

function setup() {
	const ctx = createInteractiveModeContext({
		session: {
			prewarmModelConnection: () => {},
			resolveModelMention: (selector: string) => MODELS[selector],
			modelMentions: [{ agent: "m1", selector: "anthropic/opus", name: "Opus" }],
		},
	});
	new InputController(ctx).setupKeyHandlers();
	const submitted: string[] = [];
	ctx.composer.onSubmit = text => {
		submitted.push(text);
	};
	const term = attachTerminal(ctx);
	const chip = `${currentTheme().symbols.symbol("mention.model")} Opus`;
	return { ctx, term, submitted, chip };
}

describe("model mention chips", () => {
	it("collapse a typed mention once complete and submit its canonical selector", () => {
		const { ctx, term, submitted, chip } = setup();
		term.type("ask ^opus");
		expect(ctx.composer.text()).toBe("ask ^opus");
		term.type(" to review");
		expect(ctx.composer.text()).toBe(`ask ${chip} to review`);
		term.press("enter");
		expect(submitted).toEqual(["ask ^anthropic/opus to review"]);
	});

	it("leave prose punctuation after a mention as text", () => {
		const { ctx, term, chip } = setup();
		term.type("ask ^anthropic/opus,");
		expect(ctx.composer.text()).toBe("ask ^anthropic/opus,");
		term.type(" then");
		expect(ctx.composer.text()).toBe(`ask ${chip}, then`);
		term.press("backspace");
		expect(ctx.composer.expandedText()).toBe("ask ^anthropic/opus, the");
	});

	it("leave unknown models, a taken label and local-execution drafts literal", () => {
		const { ctx, chip } = setup();
		ctx.composer.setDraft("^anthropic/opus and ^other/opus and ^nobody/x go");
		expect(ctx.composer.text()).toBe(`${chip} and ^other/opus and ^nobody/x go`);
		ctx.composer.setDraft("!echo ^anthropic/opus go");
		expect(ctx.composer.text()).toBe("!echo ^anthropic/opus go");
	});

	it("restore submitted tags of known pseudonyms as chips", () => {
		const { ctx, chip } = setup();
		ctx.composer.setDraft('<model agent="m1" name="Opus"/> review <model agent="m9" name="X"/>');
		expect(ctx.composer.text()).toBe(`${chip} review <model agent="m9" name="X"/>`);
		expect(ctx.composer.expandedText()).toBe('^anthropic/opus review <model agent="m9" name="X"/>');
	});
});
