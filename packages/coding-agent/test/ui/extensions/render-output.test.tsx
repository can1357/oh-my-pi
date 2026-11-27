/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createRoot, isUiNode, type JSXNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { builtinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { createTheme, type ResolvedTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { ExtensionRows } from "../../../src/extensibility/extensions/render-types";
import {
	extensionOutput,
	extensionTheme,
	isCompactOutput,
	isExtensionRows,
	renderExtension,
	singleNode,
} from "../../../src/ui/extensions/render-output";

/** The plain screen of `output` drawn in a 20-cell terminal. */
function screenOf(output: JSXNode, columns = 20): string[] {
	const term = createTestTerminal(() => ({ main: output }), { columns, rows: 6 });
	try {
		return term.screen().filter(row => row !== "");
	} finally {
		term.dispose();
	}
}

describe("extension render output", () => {
	// A terminal that draws bare text-default emoji inside one cell (kitty, Ghostty, WezTerm): slots stay bare.
	let previousTheme: ResolvedTheme;
	beforeEach(() => {
		previousTheme = currentTheme();
		setCurrentTheme(createTheme(builtinThemes().dark!, { emoji: { vs16Wide: true, bareFits: true } }));
	});
	afterEach(() => {
		setCurrentTheme(previousTheme);
	});
	it("passes pi-tui nodes through untouched", () => {
		createRoot(() => {
			const node = <text text="hello" />;
			expect(extensionOutput(node)).toBe(node);
			expect(extensionOutput("plain")).toBe("plain");
		});
	});

	it("draws nothing for undefined, null, booleans and the empty string", () => {
		for (const output of [undefined, null, false, true, ""]) expect(extensionOutput(output)).toBeUndefined();
	});

	it("draws a rows object as a canvas, cut to the width", () => {
		const rows: ExtensionRows = { render: width => [`width ${width}`, "x".repeat(40)] };
		createRoot(() => {
			const node = extensionOutput(rows);
			expect(isUiNode(node) && node.kind).toBe("canvas");
		});
		expect(screenOf(extensionOutput(rows))).toEqual(["width 20", "x".repeat(20)]);
	});

	it("adapts arrays element by element", () => {
		const output = [<text text="node" />, { render: () => ["rows"] }];
		expect(screenOf(extensionOutput(output))).toEqual(["node", "rows"]);
	});

	it("reports a throwing renderer and draws nothing", () => {
		const onError = vi.fn();
		const output = renderExtension(
			() => {
				throw new Error("boom");
			},
			{ onError },
		);
		expect(output).toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
	});

	it("reports output that is neither nodes nor rows", () => {
		const onError = vi.fn();
		expect(extensionOutput({ nope: true }, { onError })).toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("draws one error row when rows throw while painting, reporting once", () => {
		const onError = vi.fn();
		const rows: ExtensionRows = {
			render: () => {
				throw new Error("paint failed");
			},
		};
		expect(screenOf(extensionOutput(rows, { onError }), 60)).toEqual(["⚠ extension render failed: paint failed"]);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("repaints rows when the revision changes", () => {
		let label = "first";
		const revision = signal(0);
		const rows: ExtensionRows = { render: () => [label] };
		const term = createTestTerminal(() => ({ main: extensionOutput(rows, { revision }) }), { columns: 20, rows: 4 });
		try {
			expect(term.screen()[0]).toBe("first");
			label = "second";
			revision.set(1);
			term.render();
			expect(term.screen()[0]).toBe("second");
		} finally {
			term.dispose();
		}
	});

	it("routes keys and pastes of an interactive view to handleInput as raw input, then repaints", () => {
		const received: string[] = [];
		const rows: ExtensionRows = {
			render: () => [`got ${received.length}`],
			handleInput: data => {
				received.push(data);
			},
		};
		const node = singleNode(extensionOutput(rows, { input: true }));
		const term = createTestTerminal(() => ({ layer: node }), { columns: 20, rows: 4 });
		try {
			term.focus(node);
			term.type("a");
			term.paste("pasted");
			expect(received).toEqual(["a", "\x1b[200~pasted\x1b[201~"]);
			expect(term.screen()).toContain("got 2");
		} finally {
			term.dispose();
		}
	});

	it("disposes a rows object when its node goes", () => {
		const dispose = vi.fn();
		createRoot(release => {
			extensionOutput({ render: () => [], dispose });
			release();
		});
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("reads compactness from a rows object, guarded", () => {
		expect(isCompactOutput({ render: () => [], isTranscriptBlockCompact: () => true })).toBe(true);
		expect(isCompactOutput({ render: () => [], isTranscriptBlockCompact: () => false })).toBe(false);
		expect(
			isCompactOutput({
				render: () => [],
				isTranscriptBlockCompact: () => {
					throw new Error("broken");
				},
			}),
		).toBe(false);
		createRoot(() => expect(isCompactOutput(<text text="x" />)).toBe(false));
	});

	it("tells rows objects from nodes", () => {
		createRoot(() => {
			expect(isExtensionRows({ render: () => [] })).toBe(true);
			expect(isExtensionRows(<text text="x" />)).toBe(false);
			expect(isExtensionRows([{ render: () => [] }])).toBe(false);
		});
	});

	it("wraps anything but a single node for mount points that need one", () => {
		createRoot(() => {
			const node = singleNode(<text text="x" />);
			expect(node.kind).toBe("text");
			expect(singleNode(node)).toBe(node);
			const wrapped: UiNode = singleNode([<text text="a" />, <text text="b" />]);
			expect(wrapped.kind).toBe("col");
			expect(wrapped.children()).toHaveLength(2);
		});
	});

	it("hands extensions the theme plus pi-tui's attribute helpers", () => {
		const theme = extensionTheme(currentTheme());
		expect(theme).toBe(extensionTheme(currentTheme()));
		expect(Bun.stripANSI(theme.bold("b"))).toBe("b");
		expect(theme.bold("b")).not.toBe("b");
		expect(theme.fg("accent", "x")).toBe(currentTheme().fg("accent", "x"));
		expect(theme.name).toBe(currentTheme().name);
	});
});
