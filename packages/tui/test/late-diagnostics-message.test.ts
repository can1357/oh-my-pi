import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@oh-my-pi/pi-tui";
import { LateDiagnosticsMessageComponent } from "@oh-my-pi/pi-tui/chat/late-diagnostics-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const darkTheme = await getThemeByName("dark");

/** A describe context with the data-first `tool` node enabled (the head chip lives there). */
const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function plain(component: LateDiagnosticsMessageComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

describe("LateDiagnosticsMessageComponent", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders late diagnostics through the shared tree renderer", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/packages/coding-agent/src/foo.ts",
				summary: "1 error(s)",
				errored: true,
				messages: [
					"packages/coding-agent/src/foo.ts:7804:14 [error] [typescript] Type 'string' is not assignable to type 'number'. (2322)",
				],
			},
		]);

		const text = plain(component);
		expect(text).toContain("Late diagnostics");
		expect(text).toContain("1 error(s)");
		// File grouped as its own tree node...
		expect(text).toContain("packages/coding-agent/src/foo.ts");
		// ...and the diagnostic on a separate row with parsed location + message.
		expect(text).toContain(":7804:14");
		expect(text).toContain("Type 'string' is not assignable to type 'number'.");
		// The shared renderer folds severity/source into icons, so the raw inline
		// `[error]`/`[typescript]` markers of the old flat format must be gone.
		expect(text).not.toContain("[error]");
		expect(text).not.toContain("[typescript]");
	});

	it("caps collapsed output and reveals the rest when expanded", () => {
		const messages = Array.from(
			{ length: 8 },
			(_, i) => `src/foo.ts:${i + 1}:1 [error] [typescript] err ${i + 1} (2322)`,
		);
		const component = new LateDiagnosticsMessageComponent([
			{ path: "/abs/src/foo.ts", summary: "8 error(s)", errored: true, messages },
		]);

		const collapsed = plain(component);
		expect(collapsed).toContain("err 1");
		expect(collapsed).not.toContain("err 8");
		expect(collapsed).toContain("more");

		component.setExpanded(true);
		const expanded = plain(component);
		expect(expanded).toContain("err 8");
		expect(expanded).not.toContain("more");
	});

	it("groups multiple files under a single header", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/a.ts",
				summary: "1 error(s)",
				errored: true,
				messages: ["a.ts:1:1 [error] [typescript] bad a (2322)"],
			},
			{
				path: "/abs/b.ts",
				summary: "1 warning(s)",
				errored: false,
				messages: ["b.ts:2:2 [warning] [typescript] bad b (2322)"],
			},
		]);

		const text = plain(component);
		expect(text.match(/Late diagnostics/g)?.length).toBe(1);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).toContain("bad a");
		expect(text).toContain("bad b");
	});

	it("renders nothing when no diagnostics are present", () => {
		const component = new LateDiagnosticsMessageComponent([
			{ path: "/abs/empty.ts", summary: "", errored: false, messages: [] },
		]);
		expect(plain(component).trim()).toBe("");
	});

	it("hides and restores diagnostics without discarding the rendered block", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/src/foo.ts",
				summary: "1 error(s)",
				errored: true,
				messages: ["src/foo.ts:1:1 [error] [typescript] bad (2322)"],
			},
		]);

		expect(plain(component)).toContain("Late diagnostics");
		component.setToolActivityVisible(false);
		expect(plain(component)).toBe("");
		component.setToolActivityVisible(true);
		expect(plain(component)).toContain("Late diagnostics");
	});

	// A file whose server published no verdict is not a clean file: it was
	// never checked. The card used to render nothing at all for it, which read
	// as "no diagnostics" (issue #15408).
	it("reports a file no server judged instead of rendering nothing", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/wrangler.toml",
				summary: "diagnostics unavailable from silent-lsp",
				errored: false,
				messages: [],
				unjudgedServers: ["silent-lsp"],
			},
		]);

		const text = plain(component);
		expect(text).toContain("Late diagnostics");
		expect(text).toContain("diagnostics unavailable from silent-lsp");
	});
});

/**
 * Contract under test (late diagnostics routed into the edit/write frame):
 *
 * A post-write diagnostics request that misses the inline window arrives after
 * the tool already returned, so it is routed into the frame it belongs to. The
 * routed frame must report an unjudged file the way the immediate one does: the
 * head keeps the incomplete-verdict marker instead of counting the file as
 * clean (issue #15408).
 */
describe("late diagnostics routed into a tool frame", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
		setNativeRendering(true);
	});

	afterEach(() => {
		setNativeRendering(false);
	});

	it("shows the unavailable marker instead of counting an unjudged file as clean", () => {
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: "/abs/src/foo.ts" },
			{},
			undefined,
			ui,
			process.cwd(),
		);

		const routed = component.attachLateDiagnostics([
			{
				path: "/abs/src/foo.ts",
				summary: "diagnostics unavailable from silent-lsp",
				errored: false,
				messages: [],
				unjudgedServers: ["silent-lsp"],
			},
		]);
		expect(routed).toBe(true);

		const node = component.describe(cx);
		if (node.k !== "tool") throw new Error("Expected a tool node");
		expect(node.p?.badges?.map(badge => badge.text)).toEqual(["diagnostics unavailable"]);
	});
});
