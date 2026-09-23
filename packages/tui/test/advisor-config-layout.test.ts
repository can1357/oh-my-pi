import { describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type AdvisorConfigDeps,
	AdvisorConfigOverlayComponent,
	type WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

describe("AdvisorConfigOverlayComponent", () => {
	const deps: AdvisorConfigDeps = {
		getAvailableModels: () => [],
		browserSource: {
			defaultThinkingLevel: "high",
			modelProviderOrder: [],
			knownRoleIds: [],
			mruOrder: [],
			modelPerf: new Map(),
			getModelRole: () => undefined,
			getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
			defaultRoleChain: () => [],
			resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
		},
		defaultToolNames: new Set(["read", "grep", "glob"]),
		scopedModels: [],
		availableToolNames: ["read", "grep", "glob", "lsp", "web_search"],
	};
	const callbacks = {
		loadDoc: async () => ({ advisors: [] }),
		save: async () => {},
		close: () => {},
		requestRender: () => {},
		notify: () => {},
	};
	const strip = (lines: readonly string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const make = (doc: WatchdogConfigDoc, extra?: Partial<AdvisorConfigDeps>): AdvisorConfigOverlayComponent =>
		new AdvisorConfigOverlayComponent({} as unknown as TUI, { ...deps, ...extra }, "project", doc, callbacks);
	const fullHeight = Math.max(14, process.stdout.rows || 40);

	it("paints a full-screen split frame: roster sidebar + selected-advisor preview", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			instructions: "shared baseline",
			advisors: [
				{ name: "Architecture", model: "x-ai/grok-code-fast:high" },
				{ name: "Security", tools: ["read", "web_search"] },
			],
		});
		const frame = overlay.render(200);
		// Fills the screen top-to-bottom (the fix for the bottom-anchored frame
		// whose offset broke mouse hit-testing and wasted the upper space).
		expect(frame.length).toBe(fullHeight);
		const text = strip(frame);
		expect(text).toContain("Advisor configuration");
		expect(text).toContain("project");
		expect(text).toContain("Architecture");
		expect(text).toContain("Security");
		expect(text).toContain("+ Add advisor");
		expect(text).toContain("Save & apply");
		// Right preview reflects the highlighted (first) advisor.
		expect(text).toContain("x-ai/grok-code-fast:high");
		expect(text).toContain("read, grep, glob (default)");
	});

	it("renders an explicit no-tools advisor distinctly from the omitted default", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [{ name: "Blank", tools: [] }],
		});

		const text = strip(overlay.render(200));
		expect(text.toLowerCase()).toContain("no tools");
		expect(text).not.toContain("read, grep, glob (default)");
	});

	it("moves the preview with keyboard selection and preserves an explicit tool set", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [{ name: "Architecture" }, { name: "Security", tools: ["read", "web_search"] }],
		});
		overlay.render(200);
		overlay.handleInput("\x1b[B"); // arrow down → highlight Security
		expect(strip(overlay.render(200))).toContain("read, web_search");
	});

	it("opens an advisor's detail editor on a left click in the sidebar", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({ advisors: [{ name: "Architecture" }, { name: "Security" }] });
		// Render once so the frame geometry is recorded; the first advisor sits on
		// the first body row (0-based screen row 1 → SGR 1-based row 2).
		overlay.render(120);
		overlay.handleInput("\x1b[<0;4;2M"); // left-button press, col 4, row 2
		const text = strip(overlay.render(120));
		expect(text).toContain("Editing");
		expect(text).toContain("Architecture");
	});

	it("shows disabled advisors with a dim circle marker and toggles them in the detail editor", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [
				{ name: "Active", model: "x-ai/grok-code-fast:high" },
				{ name: "Disabled", model: "openai/gpt-4", enabled: false },
			],
		});
		const text = strip(overlay.render(200));
		// The list shows ● for enabled and ○ for disabled.
		expect(text).toContain("● Active");
		expect(text).toContain("○ Disabled");
		// The preview of the highlighted (first) advisor shows its enabled status.
		expect(text).toContain("● on");
	});
});
