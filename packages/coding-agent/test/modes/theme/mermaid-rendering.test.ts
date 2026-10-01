import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { fgAnsi } from "@oh-my-pi/pi-tui/theme/color";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setThemeInstance,
} from "@oh-my-pi/pi-tui/theme";
import { buildSystemPrompt } from "../../../src/system-prompt";

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidRendering(true);
});

describe("Mermaid rendering setting", () => {
	it("removes the Mermaid prompt note when rendering is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: false,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
		});

		expect(systemPrompt.join("\n")).not.toContain("```mermaid");
	});

	it("falls back to a highlighted code fence when rendering is disabled", () => {
		setMarkdownMermaidRendering(false);

		const markdown = new Markdown("```mermaid\ngraph TD\n  A --> B\n```", 0, 0, getMarkdownTheme());
		const lines = stripAnsi(markdown.render(80).join("\n"));

		expect(lines).toContain("```mermaid");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
	});

	it("draws Mermaid structure with the muted token and labels with the text token", async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("fallback theme unavailable");
		const titaniumJson = getBuiltinThemes().titanium;
		if (!titaniumJson) throw new Error("Titanium theme unavailable");

		try {
			// Titanium's border tokens are near-background, so it exposes a regression to UI-chrome strokes.
			const titanium = createTheme(titaniumJson, { mode: "truecolor" });
			setThemeInstance(titanium);
			const sgr = (token: "muted" | "text" | "border" | "borderMuted") =>
				fgAnsi(titanium.getColorHex(token), "truecolor");
			const renderer = getMarkdownTheme().resolveMermaidAscii;
			if (!renderer) throw new Error("Mermaid renderer unavailable");
			const rendered = renderer("stateDiagram-v2\n  [*] --> Capture\n  Capture --> [*]", 80);
			const muted = sgr("muted");
			const text = sgr("text");
			expect(new Set([muted, text, sgr("border"), sgr("borderMuted")]).size).toBe(4);

			expect(rendered).toContain(`${muted}╔`);
			expect(rendered).toContain(`${muted}║`);
			expect(rendered).toContain(`${muted}╚`);
			for (const glyph of "╔═╗║╚╝") expect(rendered).not.toContain(`${text}${glyph}`);
			expect(rendered).not.toContain(sgr("border"));
			expect(rendered).not.toContain(sgr("borderMuted"));
			const labels = renderer("flowchart TD\n  A[x=y]\n  B[status=#1]", 80);
			expect(labels).toContain(`${text}x=y`);
			expect(labels).toContain(`${text}status=#1`);
		} finally {
			setThemeInstance(dark);
		}
	});
});
