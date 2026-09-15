import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { SkillMessageComponent } from "../../../src/modes/components/skill-message";
import { skillChipLabel } from "../../../src/modes/composer-attachments";
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
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		Settings.instance.set("tui.hyperlinks", "always");
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	const skillPath = path.join(os.homedir(), ".agent/skills/atomic-commit/SKILL.md");
	const skillUri = url.pathToFileURL(skillPath).href;
	const chip = () => skillChipLabel("atomic-commit");

	it("renders a leading invocation as a railed callout with the chip, meta, and the full multi-line body", () => {
		const component = new SkillMessageComponent(
			makeMessage({
				name: "atomic-commit",
				path: skillPath,
				lineCount: 88,
				args: "stage all\n- then split\n- then push",
				prompt: "/skill:atomic-commit stage all\n- then split\n- then push",
			}),
		);
		const lines = component.render(80);
		const text = strip(lines);

		// Every row carries the rail; the header is the chip, not the raw token.
		const rail = uiTheme.symbol("skill.rail");
		for (const line of lines) expect(Bun.stripANSI(line).startsWith(rail)).toBe(true);
		expect(text).toContain(chip());
		expect(text).not.toContain("/skill:");

		// The chip is the link to SKILL.md; the path itself is never spelled out.
		expect(lines.join("\n")).toContain(skillUri);
		expect(text).not.toContain("SKILL.md");
		expect(text).toContain("88 lines");

		// The body keeps its line structure instead of collapsing onto the header.
		const rows = lines.map(line => Bun.stripANSI(line));
		expect(rows.findIndex(row => row.includes("stage all"))).toBeGreaterThan(
			rows.findIndex(row => row.includes(chip())),
		);
		expect(rows.some(row => row.includes("then split"))).toBe(true);
		expect(rows.some(row => row.includes("then push"))).toBe(true);
		expect(rows.find(row => row.includes("stage all"))).not.toContain("then split");
	});

	it("renders a mid-prompt invocation as a plain user bubble with the chip inline", () => {
		const component = new SkillMessageComponent(
			makeMessage({
				name: "atomic-commit",
				path: skillPath,
				lineCount: 88,
				args: "fix the auth bug then",
				prompt: "fix the auth bug /skill:atomic-commit then",
			}),
		);
		const lines = component.render(80);
		const text = strip(lines);

		expect(text).toContain(`fix the auth bug ${chip()} then`);
		expect(text).not.toContain("/skill:");
		// The inline chip still opens the SKILL.md.
		expect(lines.join("\n")).toContain(skillUri);
		// No rail, no meta line: it reads as an ordinary user turn.
		const rail = uiTheme.symbol("skill.rail");
		expect(lines.some(line => Bun.stripANSI(line).startsWith(rail))).toBe(false);
		expect(text).not.toContain("88 lines");
	});

	it("only chips the invoked skill; a second token the dispatcher ignored stays literal", () => {
		const component = new SkillMessageComponent(
			makeMessage({
				name: "atomic-commit",
				path: skillPath,
				lineCount: 88,
				prompt: "/skill:atomic-commit then /skill:other",
			}),
		);
		const text = strip(component.render(80));
		expect(text).toContain(chip());
		expect(text).toContain("/skill:other");
	});

	it("falls back to a callout built from args for sessions recorded before prompts were stored", () => {
		const component = new SkillMessageComponent(
			makeMessage({ name: "atomic-commit", path: skillPath, lineCount: 1, args: "stage all" }),
		);
		const text = strip(component.render(80));
		expect(text).toContain(chip());
		expect(text).toContain("stage all");
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
