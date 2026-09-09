import { afterEach, describe, expect, it } from "bun:test";
import { Box } from "../src/components/box";
import { Editor } from "../src/components/editor";
import { Markdown } from "../src/components/markdown";
import { Text } from "../src/components/text";
import { setTuiTight } from "../src/utils";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";

describe("TUI Tight Layout option", () => {
	afterEach(() => {
		// Reset tight layout after each test
		setTuiTight(false);
	});

	it("removes 1-character horizontal padding from Text component", () => {
		const textComponent = new Text("Hello World", 1, 0);

		// With tight layout disabled: padding is preserved (1 space on left/right)
		setTuiTight(false);
		textComponent.invalidate();
		const linesNormal = textComponent.render(15);
		expect(linesNormal[0]).toBe(" Hello World   ");

		// With tight layout enabled: padding is removed (0 spaces on left/right)
		setTuiTight(true);
		textComponent.invalidate();
		const linesTight = textComponent.render(15);
		expect(linesTight[0]).toBe("Hello World    ");
	});

	it("removes 1-character horizontal padding from Markdown component", () => {
		const mdComponent = new Markdown("Hello *World*", 1, 0, defaultMarkdownTheme);

		setTuiTight(false);
		mdComponent.invalidate();
		const linesNormal = mdComponent.render(15);
		// Normal has 1 char padding (space before Hello)
		expect(linesNormal[0]!.startsWith(" Hello")).toBe(true);

		setTuiTight(true);
		mdComponent.invalidate();
		const linesTight = mdComponent.render(15);
		// Tight has 0 char padding (starts with Hello)
		expect(linesTight[0]!.startsWith("Hello")).toBe(true);
	});

	it("removes 1-character horizontal padding from Box component", () => {
		const boxComponent = new Box(1, 0);
		const textComponent = new Text("Hi", 0, 0); // No inner text padding
		boxComponent.addChild(textComponent);

		setTuiTight(false);
		boxComponent.invalidate();
		const linesNormal = boxComponent.render(10);
		// Box adds 1 char padding on left
		expect(linesNormal[0]).toBe(" Hi       ");

		setTuiTight(true);
		boxComponent.invalidate();
		const linesTight = boxComponent.render(10);
		// Tight Box adds 0 char padding on left
		expect(linesTight[0]).toBe("Hi        ");
	});

	it("does not reduce horizontal padding of Editor component", () => {
		const editor = new Editor(defaultEditorTheme);
		// Set prompt gutter to make it easier to see layout widths
		editor.setPromptGutter(">");

		// Test prompt gutter / content width allocation
		setTuiTight(false);
		const widthNormal = editor.getTopBorderAvailableWidth(20);

		setTuiTight(true);
		const widthTight = editor.getTopBorderAvailableWidth(20);

		expect(widthTight).toBe(widthNormal);
	});

	it("preserves padding on Markdown component if ignoreTight is set", () => {
		const mdComponent = new Markdown("Hello *World*", 1, 0, defaultMarkdownTheme);
		mdComponent.setIgnoreTight(true);

		// With ignoreTight, even when tight layout is enabled:
		setTuiTight(true);
		mdComponent.invalidate();
		const linesTight = mdComponent.render(15);
		// It should still have 1 char padding (space before Hello)
		expect(linesTight[0]!.startsWith(" Hello")).toBe(true);
	});
});
