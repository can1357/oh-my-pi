/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it, vi } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import "../../../src/ui/styles/tools";
import "../../../src/ui/tools";
import type { ExtensionTheme } from "../../../src/extensibility/extensions/render-types";
import type { ToolViewState } from "../../../src/ui/tools/contract";
import { defaultPresenter } from "../../../src/ui/tools/default";
import { type LegacyToolRenderer, legacyParts, legacyPresenter } from "../../../src/ui/tools/legacy";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";

const STATE: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: true };
const RESULT = { content: [{ type: "text", text: "done" }] };

/** The plain screen of a tool block for `renderer`, after its result. */
function blockScreen(renderer: LegacyToolRenderer): string[] {
	const call = new ToolCall({
		id: "call1",
		name: "ext_tool",
		args: { q: "needle" },
		presenter: legacyPresenter(renderer, defaultPresenter),
	});
	call.setArgsComplete();
	call.setExecutionStarted();
	call.updateResult(RESULT, false);
	const term = createTestTerminal(() => ({ main: <ToolBlock call={call} /> }), { columns: 40, rows: 12 });
	try {
		return term.screen().filter(row => row.trim() !== "");
	} finally {
		term.dispose();
	}
}

describe("extension tool render hooks", () => {
	it("draws a rows object in the terminal only, keeping the base view for Tern", () => {
		createRoot(() => {
			const presenter = legacyPresenter({ renderCall: () => ({ render: () => ["call rows"] }) }, defaultPresenter);
			const view = presenter.call?.({ q: "x" }, STATE);
			const base = defaultPresenter.call?.({ q: "x" }, STATE);
			expect(view?.term?.look).toBe("legacy");
			expect(view?.body).toEqual(base?.body);
		});
	});

	it("puts node output in the view's body so both backends draw it", () => {
		createRoot(() => {
			const presenter = legacyPresenter({ renderCall: () => <text text="call node" /> }, defaultPresenter);
			const view = presenter.call?.({ q: "x" }, STATE);
			const body = view?.body as readonly UiNode[];
			expect(body).toHaveLength(1);
			expect(isUiNode(body[0]) && body[0].kind).toBe("text");
			expect(view?.term).toMatchObject({ parts: body });
		});
	});

	it("paints rows and nodes in order inside the custom-tool box", () => {
		const screen = blockScreen({
			renderCall: (args: never) => <text text={`call ${(args as { q: string }).q}`} />,
			renderResult: () => ({ render: () => ["result rows"] }),
		});
		expect(screen.map(row => row.trim())).toEqual(["call needle", "result rows"]);
	});

	it("hands renderers the extension theme", () => {
		const renderCall = vi.fn((_args: never, _options: unknown, theme: ExtensionTheme) => ({
			render: () => [theme.bold("x")],
		}));
		createRoot(() => legacyParts({ renderCall }, {}, STATE));
		expect(typeof renderCall.mock.calls[0]?.[2].bold).toBe("function");
	});

	it("reports a throwing hook and falls back to the base view when nothing drew", () => {
		const onRenderError = vi.fn();
		createRoot(() => {
			const presenter = legacyPresenter(
				{
					renderCall: () => {
						throw new Error("boom");
					},
					onRenderError,
				},
				defaultPresenter,
			);
			const view = presenter.call?.({ q: "x" }, STATE);
			expect(view?.term?.look).not.toBe("legacy");
		});
		expect(onRenderError).toHaveBeenCalledWith(expect.any(Error), "call");
		// The terminal shows the generic card instead of an empty block.
		expect(
			blockScreen({
				renderCall: () => {
					throw new Error("boom");
				},
			}).length,
		).toBeGreaterThan(0);
	});

	it("draws nothing for a phase whose hook returns undefined", () => {
		const drawing = createRoot(() =>
			legacyParts({ renderCall: () => undefined, renderResult: () => ({ render: () => ["r"] }) }, {}, STATE, RESULT),
		);
		expect(drawing.failed).toBe(false);
		expect(drawing.parts).toHaveLength(1);
	});
});
