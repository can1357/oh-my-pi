import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Markdown } from "@oh-my-pi/pi-tui";
import { getDefault } from "../../../src/config/settings-schema";
import { Settings, settings } from "../../../src/config/settings";
import { createTheme, getBuiltinThemes } from "../../../src/modes/theme/loader";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setMarkdownMermaidSpacing,
	setThemeInstance,
} from "../../../src/modes/theme/theme";
import { buildSystemPrompt } from "../../../src/system-prompt";
import { beginSettingsTest, restoreSettingsTestState } from "../../helpers/settings-test-state";

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
function renderMermaidAscii(source: string, maxWidth = 120): string {
	const resolve = getMarkdownTheme().resolveMermaidAscii;
	if (!resolve) throw new Error("Mermaid renderer unavailable");
	const rendered = resolve(source, maxWidth);
	if (rendered === null) throw new Error("Mermaid renderer returned null");
	return stripAnsi(rendered);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
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

	it("applies settings overrides to rendered diagrams", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		try {
			settings.set("tui.mermaidPaddingX", 0);
			settings.set("tui.mermaidPaddingY", 0);
			settings.set("tui.mermaidBoxBorderPadding", 0);
			const tight = renderMermaidAscii(source);
			expect(tight).not.toBe(baseline);
			expect(tight.length).toBeLessThan(baseline.length);
		} finally {
			settings.set("tui.mermaidPaddingX", 5);
			settings.set("tui.mermaidPaddingY", 5);
			settings.set("tui.mermaidBoxBorderPadding", 1);
		}
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("falls back to defaults for invalid spacing values", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: NaN, paddingY: -3, boxBorderPadding: 1.9 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("falls back to the default for fractional paddingX instead of flooring", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: 1.9, paddingY: 5, boxBorderPadding: 1 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("falls back to the default for oversized spacing instead of hanging", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: 100000, paddingY: 100000, boxBorderPadding: 100000 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("leaves sequence diagrams unaffected by spacing settings", () => {
		const source = "sequenceDiagram\n  A->>B: hello\n  B-->>A: world";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: 0, paddingY: 0, boxBorderPadding: 0 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("applies load-time spacing to rendered diagrams without an interactive session", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-init-spacing-global-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-init-spacing-project-"));
		const settingsState = beginSettingsTest();
		try {
			await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(projectDir, ".claude", "settings.json"),
				JSON.stringify({ tui: { mermaidPaddingX: 0, mermaidPaddingY: 0, mermaidBoxBorderPadding: 0 } }),
			);
			const source = "flowchart TD\n  A[alpha] --> B[beta]";
			setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
			const baseline = renderMermaidAscii(source);

			await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.mermaidPaddingX")).toBe(0);
			const tight = renderMermaidAscii(source);
			expect(tight).not.toBe(baseline);
			expect(tight.length).toBeLessThan(baseline.length);
		} finally {
			setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
			setMarkdownMermaidRendering(true);
			restoreSettingsTestState(settingsState);
			await Settings.init({ inMemory: true });
			await fs.rm(projectDir, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("disables the renderer from load-time config without an interactive session", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-init-render-global-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-init-render-project-"));
		const settingsState = beginSettingsTest();
		try {
			await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(projectDir, ".claude", "settings.json"),
				JSON.stringify({ tui: { renderMermaid: false } }),
			);

			await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.renderMermaid")).toBe(false);
			expect(getMarkdownTheme().resolveMermaidAscii).toBeUndefined();
		} finally {
			setMarkdownMermaidRendering(true);
			restoreSettingsTestState(settingsState);
			await Settings.init({ inMemory: true });
			await fs.rm(projectDir, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("falls back to the live schema defaults for invalid spacing values", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		setMarkdownMermaidSpacing({
			paddingX: getDefault("tui.mermaidPaddingX"),
			paddingY: getDefault("tui.mermaidPaddingY"),
			boxBorderPadding: getDefault("tui.mermaidBoxBorderPadding"),
		});
		const expected = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: NaN, paddingY: -3, boxBorderPadding: 1.9 });
		expect(renderMermaidAscii(source)).toBe(expected);
	});
});
