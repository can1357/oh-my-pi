/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Picker list windows: {@link scrollWindow} centres a list that opens and
 * scrolls at the edge from a previous window; {@link pickerWindow} keeps
 * that window as the node's terminal state, so a look drawing through it
 * moves its window only when the selection crosses an edge.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type JSXNode, type UiNode } from "../../src";
import { pickerWindow, scrollWindow } from "../../src/term/painters/picker";

function node(view: () => JSXNode): { node: UiNode; dispose: () => void } {
	return createRoot(dispose => {
		const built = view();
		if (!isUiNode(built)) throw new Error("expected one node");
		return { node: built, dispose };
	});
}

describe("scrollWindow", () => {
	test("centres the index without a previous window", () => {
		expect(scrollWindow(20, 10, 5)).toEqual({ start: 8, end: 13 });
		expect(scrollWindow(20, 0, 5)).toEqual({ start: 0, end: 5 });
		expect(scrollWindow(20, 19, 5)).toEqual({ start: 15, end: 20 });
		expect(scrollWindow(3, 2, 5)).toEqual({ start: 0, end: 3 });
	});

	test("keeps a previous window while the index is inside it and moves it to the edge otherwise", () => {
		expect(scrollWindow(20, 4, 5, 0)).toEqual({ start: 0, end: 5 });
		expect(scrollWindow(20, 5, 5, 0)).toEqual({ start: 1, end: 6 });
		expect(scrollWindow(20, 3, 5, 1)).toEqual({ start: 1, end: 6 });
		expect(scrollWindow(20, 0, 5, 1)).toEqual({ start: 0, end: 5 });
		expect(scrollWindow(20, 12, 5, 0)).toEqual({ start: 8, end: 13 });
		// A list that shrank under the window clamps it.
		expect(scrollWindow(8, 7, 5, 6)).toEqual({ start: 3, end: 8 });
	});
});

describe("pickerWindow", () => {
	const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));

	test("steps down to the bottom edge, then scrolls one row at a time; stepping back up keeps the window", () => {
		const { node: picker, dispose } = node(() => <picker items={items} query="" />);
		try {
			const starts: number[] = [];
			for (let index = 0; index <= 7; index++) starts.push(pickerWindow(picker, 20, index, 5).start);
			expect(starts).toEqual([0, 0, 0, 0, 0, 1, 2, 3]);
			const back: number[] = [];
			for (let index = 6; index >= 2; index--) back.push(pickerWindow(picker, 20, index, 5).start);
			expect(back).toEqual([3, 3, 3, 3, 2]);
		} finally {
			dispose();
		}
	});

	test("opens centred and re-centres when its key changes", () => {
		const { node: picker, dispose } = node(() => <picker items={items} />);
		try {
			expect(pickerWindow(picker, 20, 10, 5, "a").start).toBe(8);
			expect(pickerWindow(picker, 20, 11, 5, "a").start).toBe(8);
			expect(pickerWindow(picker, 20, 11, 5, "ab").start).toBe(9);
		} finally {
			dispose();
		}
	});
});
