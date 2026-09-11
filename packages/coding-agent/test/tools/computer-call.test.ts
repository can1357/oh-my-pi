import { describe, expect, it } from "bun:test";
import {
	DESKTOP_METHODS,
	ELEMENT_METHODS,
	isReadOnlyComputerCall,
	renderComputerCall,
	WINDOW_METHODS,
} from "@oh-my-pi/pi-coding-agent/tools/computer/call";

function errorMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected callback to throw");
}

describe("renderComputerCall", () => {
	it("keeps the public desktop, window, and element allowlists exact", () => {
		expect(Object.keys(DESKTOP_METHODS)).toEqual([
			"capabilities",
			"displays",
			"windows",
			"window",
			"focusedWindow",
			"screenshot",
			"click",
			"doubleClick",
			"move",
			"drag",
			"scroll",
			"type",
			"press",
			"elementAt",
			"focusedElement",
			"ref",
			"clipboard.read",
			"clipboard.write",
		]);
		expect(Object.keys(WINDOW_METHODS)).toEqual([
			"screenshot",
			"click",
			"doubleClick",
			"move",
			"drag",
			"scroll",
			"type",
			"press",
			"raise",
			"ax",
			"find",
			"ref",
		]);
		expect(Object.keys(ELEMENT_METHODS)).toEqual([
			"value",
			"setValue",
			"bounds",
			"attributes",
			"actions",
			"perform",
			"press",
			"click",
			"focus",
			"parent",
			"children",
		]);
	});

	it("renders root, window-hop, and element-hop calls byte-for-byte", () => {
		expect(renderComputerCall([{ method: "windows", args: [{ app: "Code" }] }])).toBe(
			'return await desktop.windows({"app":"Code"});',
		);
		expect(renderComputerCall([{ method: "clipboard.write", args: ["hi"] }])).toBe(
			'return await desktop.clipboard.write("hi");',
		);
		expect(
			renderComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "click", args: [10, 20, { button: "right" }] },
			]),
		).toBe('return await (await desktop.window("42")).click(10, 20, {"button":"right"});');
		expect(
			renderComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "setValue", args: ["todo"] },
			]),
		).toBe('return await (await desktop.ref("e5")).setValue("todo");');
	});

	it("classifies read-only chains by the terminal helper", () => {
		expect(isReadOnlyComputerCall([{ method: "screenshot", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "type", args: ["x"] }])).toBe(false);
		expect(isReadOnlyComputerCall([{ method: "clipboard.read", args: [] }])).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "ax", args: [] },
			]),
		).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "raise", args: [] },
			]),
		).toBe(false);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "bounds", args: [] },
			]),
		).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "press", args: [] },
			]),
		).toBe(false);
	});

	it("reports every invalid chain with its exact public error", () => {
		expect(errorMessage(() => renderComputerCall([]))).toBe("Action 'call' requires a non-empty 'chain'.");
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "window", args: ["42"] },
					{ method: "find", args: [{}] },
					{ method: "press", args: [] },
				]),
			),
		).toBe("Call chains support one handle hop at most; use computer.run(fn) for longer sequences.");
		expect(errorMessage(() => renderComputerCall([{ method: "launch", args: [] }]))).toBe(
			`Unknown desktop method "launch". Desktop helpers support: ${Object.keys(DESKTOP_METHODS).join(", ")}.`,
		);
		expect(errorMessage(() => renderComputerCall([{ method: "toString", args: [] }]))).toContain(
			'Unknown desktop method "toString"',
		);
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "windows", args: [] },
					{ method: "click", args: [1, 2] },
				]),
			),
		).toBe("Only desktop.window(id)/desktop.ref(ref) results accept a chained call; got desktop.windows().");
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "window", args: ["42"] },
					{ method: "setValue", args: ["x"] },
				]),
			),
		).toBe(`Unknown window method "setValue". Window handles support: ${Object.keys(WINDOW_METHODS).join(", ")}.`);
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "window", args: ["42"] },
					{ method: "toString", args: [] },
				]),
			),
		).toContain('Unknown window method "toString"');
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "ref", args: ["e5"] },
					{ method: "raise", args: [] },
				]),
			),
		).toBe(`Unknown element method "raise". Element handles support: ${Object.keys(ELEMENT_METHODS).join(", ")}.`);
		expect(errorMessage(() => isReadOnlyComputerCall([{ method: "launch", args: [] }]))).toContain(
			'Unknown desktop method "launch"',
		);
	});
});
