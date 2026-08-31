import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { createTheme, getBuiltinThemes } from "../../../src/modes/theme/loader";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setThemeInstance,
} from "../../../src/modes/theme/theme";
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

		expect(lines).toContain("[mermaid]");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
		expect(lines).not.toContain("```");
	});

	it("uses content-visible Titanium colors for Mermaid structure", async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("fallback theme unavailable");
		const titaniumJson = getBuiltinThemes().titanium;
		if (!titaniumJson) throw new Error("Titanium theme unavailable");

		try {
			setThemeInstance(createTheme(titaniumJson, { mode: "truecolor" }));
			const renderer = getMarkdownTheme().resolveMermaidAscii;
			if (!renderer) throw new Error("Mermaid renderer unavailable");
			const rendered = renderer("stateDiagram-v2\n  [*] --> Capture\n  Capture --> [*]", 80);
			const muted = "\x1b[38;2;156;163;176m";

			expect(rendered).toContain(`${muted}╔`);
			expect(rendered).toContain(`${muted}║`);
			expect(rendered).toContain(`${muted}╚`);
			expect(rendered).not.toMatch(/\x1b\[38;2;229;229;231m[╔═╗║╚╝]/);
			expect(rendered).not.toContain("\x1b[38;2;42;48;56m");
			expect(rendered).not.toContain("\x1b[38;2;31;37;45m");
			const labels = renderer("flowchart TD\n  A[x=y]\n  B[status=#1]", 80);
			const text = "\x1b[38;2;229;229;231m";
			expect(labels).toContain(`${text}x=y`);
			expect(labels).toContain(`${text}status=#1`);
		} finally {
			setThemeInstance(dark);
		}
	});
});
