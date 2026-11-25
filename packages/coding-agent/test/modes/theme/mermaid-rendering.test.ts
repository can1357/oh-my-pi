import { afterAll, describe, expect, it } from "bun:test";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { mermaidRows } from "@oh-my-pi/pi-tui/text/markdown/mermaid";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Settings } from "../../../src/config/settings";
import { buildSystemPrompt } from "../../../src/system-prompt";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

await Settings.init({ inMemory: true });

describe("Mermaid rendering setting", () => {
	it("removes the Mermaid prompt note when rendering is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: false,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
			urlRouter: InternalUrlRouter.builtins(),
		});

		expect(systemPrompt.join("\n")).not.toContain("```mermaid");
	});

	it("falls back to a highlighted code fence when rendering is disabled", () => {
		const rows = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", 80, {
			theme: loadThemeSync("dark"),
			mermaid: false,
		});
		const lines = plainRows(rows).join("\n");

		expect(lines).toContain("```mermaid");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
	});

	it("draws Mermaid structure with the muted token and labels with the text token", () => {
		// Titanium's border tokens are near-background, so it exposes a regression to UI-chrome strokes.
		const titanium = loadThemeSync("titanium", { depth: "truecolor" });
		// The foreground a token draws with (terminal-default colors resolved, as the diagram palette does).
		const sgr = (token: "muted" | "text" | "border" | "borderMuted") =>
			/^\x1b\[[0-9;]*m/.exec(titanium.fgResolved(token, "x"))?.[0] ?? "";
		const muted = sgr("muted");
		const text = sgr("text");
		expect(new Set([muted, text, sgr("border"), sgr("borderMuted")]).size).toBe(4);

		const rendered = mermaidRows("stateDiagram-v2\n  [*] --> Capture\n  Capture --> [*]", 80, titanium)?.join("\n");
		if (rendered === undefined) throw new Error("Mermaid diagram did not render");
		expect(rendered).toContain(`${muted}╔`);
		expect(rendered).toContain(`${muted}║`);
		expect(rendered).toContain(`${muted}╚`);
		for (const glyph of "╔═╗║╚╝") expect(rendered).not.toContain(`${text}${glyph}`);
		expect(rendered).not.toContain(sgr("border"));
		expect(rendered).not.toContain(sgr("borderMuted"));
		const labels = mermaidRows("flowchart TD\n  A[x=y]\n  B[status=#1]", 80, titanium)?.join("\n");
		expect(labels).toContain(`${text}x=y`);
		expect(labels).toContain(`${text}status=#1`);
	});
});
