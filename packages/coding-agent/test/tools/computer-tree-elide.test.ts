import { describe, expect, it } from "bun:test";
import { elideAxTree } from "@oh-my-pi/pi-coding-agent/tools/computer/tree-elide";

const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");

describe("elideAxTree", () => {
	const editor = [
		'- window "Untitled" [ref=e1] app=TextEdit (focused)',
		"  - toolbar [ref=e2]",
		'    - button "Bold" [ref=e3]',
		'    - button "Italic" [ref=e4] (disabled)',
	];

	it("returns undefined when the text already fits or is not a tree", () => {
		const tree = editor.join("\n");
		expect(elideAxTree(tree, bytes(tree))).toBeUndefined();
		const lone = `${editor[0]}\n… skipped 2 unreadable nodes`;
		expect(elideAxTree(lone, 10)).toBeUndefined();
	});

	it("replaces the deepest text without controls by one placeholder, keeping header, marked rows and trailers", () => {
		const paragraphs = Array.from(
			{ length: 40 },
			(_, index) =>
				`      - statictext "Paragraph ${index + 1}: the quick brown fox jumps over the lazy dog" [ref=e${index + 10}]`,
		);
		const head = [
			"Window w3 · TextEdit — Untitled",
			...editor,
			"  - scrollarea [ref=e5]",
			'    - textarea "Body" [ref=e6]: "Dear team,…"',
		];
		const tail = [
			'  - group "Save sheet" [ref=e60]',
			'    + textfield "Save As" [ref=e61]: "Untitled" (focused)',
			'    + button "Save" [ref=e62]',
			'    ~ button "Cancel" [ref=e63]',
			"… truncated (800 nodes)",
			"… skipped 3 unreadable nodes",
		];
		const expected = [...head, "      … 40 rows elided", ...tail].join("\n");
		// Exactly the budget the whole paragraph run needs: 39 of 40 would not do.
		const result = elideAxTree([...head, ...paragraphs, ...tail].join("\n"), bytes(expected));
		expect(result).toEqual({ text: expected, elidedRows: 40 });
	});

	it("drops empty wrappers whole before any deeper labelled row", () => {
		const wrapper = [
			"  - group [ref=e2]",
			"    - group [ref=e3]",
			"      - image [ref=e4]",
			"      - image [ref=e5]",
		];
		const rest = [
			'  - list "Sidebar" [ref=e6]',
			'    - group "Favorites" [ref=e7]',
			'      - group "Recents section" [ref=e8]',
			'        - statictext "Recents" [ref=e9]',
		];
		const root = '- window "Downloads" [ref=e1] app=Finder';
		const expected = [root, "  … 4 rows elided", ...rest].join("\n");
		const result = elideAxTree([root, ...wrapper, ...rest].join("\n"), bytes(expected));
		expect(result).toEqual({ text: expected, elidedRows: 4 });
	});

	it("prunes unmarked control subtrees before marked ones, counting every row in each sibling run", () => {
		const row = (index: number, bullet = "-") => [
			`    - row [ref=e${index * 2 + 10}]`,
			`      ${bullet} cell "Message ${index} — Quarterly report draft" [ref=e${index * 2 + 11}]`,
		];
		const rows = Array.from({ length: 11 }, (_, index) => row(index, index === 4 ? "~" : "-"));
		const root = ['- window "Inbox" [ref=e1] app=Mail', '  - table "Messages" [ref=e2]'];
		const toolbar = ["  - toolbar [ref=e3]", '    - button "Reply" [ref=e4]'];
		const expected = [...root, "    … 8 rows elided", ...row(4, "~"), "    … 12 rows elided", ...toolbar].join("\n");
		const result = elideAxTree([...root, ...rows.flat(), ...toolbar].join("\n"), bytes(expected));
		expect(result).toEqual({ text: expected, elidedRows: 20 });
	});

	it("drops a wrapper with its last child, spending the budget on labelled rows instead of empty shells", () => {
		const item = (index: number, bullet = "-") => [
			`    - group [ref=e${index * 3}]`,
			`      ${bullet} checkbox "Receipt ${index}: quarterly expense report" [ref=e${index * 3 + 1}]`,
			`      - statictext "Receipt ${index}: quarterly expense report" [ref=e${index * 3 + 2}]`,
		];
		const root = ['- window "Receipts" [ref=e1] app=Safari', '  - webarea "Receipts" [ref=e2]'];
		const items = Array.from({ length: 8 }, (_, index) => item(index + 1, index === 5 ? "~" : "-"));
		const approve = '  - button "Approve selected" [ref=e99]';
		const kept = (index: number, bullet = "-") => [...item(index, bullet).slice(0, 2), "      … 1 row elided"];
		const expected = [...root, "    … 12 rows elided", ...kept(5), ...kept(6, "~"), ...kept(7), ...kept(8), approve];
		const result = elideAxTree([...root, ...items.flat(), approve].join("\n"), 600);
		expect(result).toEqual({ text: expected.join("\n"), elidedRows: 16 });
	});

	it("reads role, label and ref in render order, so quoted text posing as a row is not a control", () => {
		const root = [
			'- window "Trash" [ref=e1] app=Finder',
			'  - group "Confirm" [ref=e2]',
			'    - button "Delete" [ref=e3]',
		];
		const decoy = String.raw`    - statictext "  - button \"Empty\" [ref=e9]: \"now\"" [ref=e4]`;
		const expected = [...root, "    … 1 row elided"].join("\n");
		const result = elideAxTree([...root, decoy].join("\n"), bytes(expected));
		expect(result).toEqual({ text: expected, elidedRows: 1 });
	});

	it("returns undefined when even the root and one placeholder exceed the budget", () => {
		const tree = [...editor, "… truncated (800 nodes)"].join("\n");
		expect(elideAxTree(tree, bytes(editor[0]) + 10)).toBeUndefined();
	});

	it("brings a 5,000-row tree under budget as a tree, keeping marked rows and their ancestors", () => {
		const lines = ['- window "Spreadsheet" [ref=e1] app=Numbers'];
		let ref = 2;
		for (let section = 0; section < 50; section++) {
			lines.push(`  - group "Sheet ${section}" [ref=e${ref++}]`);
			for (let item = 0; item < 33; item++) {
				lines.push(`    - row [ref=e${ref++}]`);
				lines.push(`      - cell "R${item}C0 value ${section}" [ref=e${ref++}]`);
				lines.push(`      - statictext "Note ${section}.${item}" [ref=e${ref++}]`);
			}
		}
		const marked = `      + button "Undo" [ref=e${ref++}]`;
		lines.splice(2500, 0, marked);
		const budget = 4_000;
		const result = elideAxTree(lines.join("\n"), budget);
		expect(result).toBeDefined();
		const out = result!.text.split("\n");
		expect(bytes(result!.text)).toBeLessThanOrEqual(budget);
		expect(out[0]).toBe(lines[0]);
		const markedAt = out.indexOf(marked);
		expect(markedAt).toBeGreaterThan(0);
		// Every surviving line sits at most one level below the line before it: no orphans.
		const depth = (line: string) => line.search(/\S/) / 2;
		for (let index = 1; index < out.length; index++)
			expect(depth(out[index])).toBeLessThanOrEqual(depth(out[index - 1]) + 1);
		// The marked row's ancestors survive above it.
		for (let level = 1, index = markedAt; level < depth(marked); level++) {
			while (depth(out[index]) !== depth(marked) - level || out[index].includes("…")) index--;
			expect(out[index]).toMatch(/^\s*- (row|group) /);
		}
		const survivingRows = out.filter(line => /^\s*[-+~] /.test(line)).length;
		expect(result!.elidedRows).toBe(lines.length - survivingRows);
	});
});
