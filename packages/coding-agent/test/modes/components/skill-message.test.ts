import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../../src/config/settings";
import { SkillMessageComponent } from "../../../src/modes/components/skill-message";
import { getThemeByName, setThemeInstance, type Theme } from "../../../src/modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../../src/session/messages";

// Drop SGR colors and OSC 8 hyperlink wrappers so assertions see the visible text only.
const strip = (lines: readonly string[]): string =>
	lines
		.join("\n")
		.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");

function makeMessage(
	details: SkillPromptDetails,
	content = "Use the atomic-commit workflow.",
): CustomMessage<SkillPromptDetails> {
	return { role: "custom", customType: "skill-prompt", content, display: true, details, timestamp: Date.now() };
}

describe("SkillMessageComponent", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	const skillPath = path.join(os.homedir(), ".agent/skills/atomic-commit/SKILL.md");

	it("renders a compact, outlined card instead of the archaic key:value dump", () => {
		const component = new SkillMessageComponent(
			makeMessage({ name: "atomic-commit", path: skillPath, lineCount: 88 }),
		);
		const text = strip(component.render(80));

		// New look: an icon-tagged "skill" header with the name and a single meta line.
		expect(text).toContain("skill");
		expect(text).toContain("atomic-commit");
		expect(text).toContain("skill atomic-commit");
		expect(text).not.toContain("skill  atomic-commit");
		expect(text).toContain("88 lines");

		// The card is drawn with an outline.
		expect(text).toContain(uiTheme.boxRound.topLeft);
		expect(text).toContain(uiTheme.boxRound.bottomRight);

		// Path is home-shortened and never leaks the absolute home dir.
		expect(text).toContain("~/.agent/skills/atomic-commit/SKILL.md");
		expect(text).not.toContain(os.homedir());

		// The old archaic framing is gone.
		expect(text).not.toContain("[skill]");
		expect(text).not.toContain("Skill:");
		expect(text).not.toContain("Path:");
		expect(text).not.toContain("Prompt:");
	});

	it("flattens multi-line args onto the single-line header", () => {
		const component = new SkillMessageComponent(
			makeMessage({ name: "atomic-commit", path: skillPath, lineCount: 88, args: "stage all\nthen split" }),
		);
		const text = strip(component.render(80));
		// Whitespace (including the newline) collapsed to single spaces so the header can't break.
		expect(text).toContain("stage all then split");
		expect(text).not.toContain("stage all\nthen split");
	});

	it("uses a singular unit for a one-line prompt", () => {
		const component = new SkillMessageComponent(makeMessage({ name: "tiny", path: skillPath, lineCount: 1 }));
		const text = strip(component.render(80));
		expect(text).toContain("1 line");
		expect(text).not.toContain("1 lines");
	});

	it("reveals the prompt body under a calm subheader only when expanded", () => {
		const details: SkillPromptDetails = { name: "atomic-commit", path: skillPath, lineCount: 88 };
		const body = "Step one: stage hunks.";

		const collapsed = new SkillMessageComponent(makeMessage(details, body));
		expect(strip(collapsed.render(80))).not.toContain(body);

		const expanded = new SkillMessageComponent(makeMessage(details, body));
		expanded.setExpanded(true);
		const text = strip(expanded.render(80));
		expect(text).toContain("prompt");
		expect(text).toContain(body);
	});
});
