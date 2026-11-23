import { describe, expect, it } from "bun:test";
import { formatTextPatch } from "@oh-my-pi/pi-coding-agent/commit/selective/patch";
import { formatPatchPreview } from "@oh-my-pi/pi-coding-agent/commit/selective/preview";

const HEADER = "diff --git a/f b/f\n--- a/f\n+++ b/f\n";
const file = (text: string) => ({ mode: "100644", text });
const patch = (before: string, after: string) => formatTextPatch("f", file(before), file(after));
/** The patch as `diff()` prints it; 768 bytes is the default column cap of tool output. */
const preview = (before: string, after: string, columns = 768) => formatPatchPreview(patch(before, after), columns);
/** `count` numbered words: unchanged text that makes a line long. */
const filler = (name: string, count: number) => Array.from({ length: count }, (_, n) => `${name}${n}`).join(" ");

/** Whether `row` is `before` edited into `after`, with only text both lines hold left out at each `…`. */
function standsFor(row: string, before: string, after: string): boolean {
	const parts = row
		.slice(1)
		.split(/(\[-.*?-\]|\{\+.*?\+\}|…)/)
		.filter(part => part !== "");
	const from = (index: number, old: number, now: number): boolean => {
		if (index === parts.length) return old === before.length && now === after.length;
		const part = parts[index];
		if (part === "…") {
			for (
				let hidden = 1;
				old + hidden <= before.length && before[old + hidden - 1] === after[now + hidden - 1];
				hidden++
			) {
				if (from(index + 1, old + hidden, now + hidden)) return true;
			}
			return false;
		}
		const removed = part.startsWith("[-");
		const added = part.startsWith("{+");
		const text = removed || added ? part.slice(2, -2) : part;
		if (!added && !before.startsWith(text, old)) return false;
		if (!removed && !after.startsWith(text, now)) return false;
		return from(index + 1, old + (added ? 0 : text.length), now + (removed ? 0 : text.length));
	};
	return from(0, 0, 0);
}

describe("patch preview", () => {
	it("prints a long line edited in place once, with its changes marked", () => {
		const line = (sources: string, judge: string, end: string) =>
			`Search covers ${filler("lead", 30)} recent projects, ${sources}and recaps ${filler("mid", 30)} when the ${judge} judge resolves ${filler("tail", 30)}${end}\n`;
		const before = `# Notes\n\nlimit = 10\n${line("past sessions, ", "old", ".")}retries = 2\n`;
		const after = `# Notes\n\nlimit = 20\n${line("", "first usable", ". Recaps are optional.")}retries = 3\n`;

		// The short lines around it stay as the patch has them, removed then added.
		expect(preview(before, after)).toBe(
			`${HEADER}@@ -1,5 +1,5 @@\n # Notes\n \n-limit = 10\n+limit = 20\n` +
				"!…6 lead27 lead28 lead29 recent projects, [-past sessions, -]and recaps mid0 mid1 mid2 mid3 mid4 mid5… mid25 mid26 mid27 mid28 mid29 when the [-old -]{+first usable +}judge resolves tail0 tail1 tail2 tail3 t…ail24 tail25 tail26 tail27 tail28 tail29{+. Recaps are optional+}.\n" +
				"-retries = 2\n+retries = 3\n",
		);
	});

	it("leaves a patch without a long line edited in place as it is", () => {
		const wide = filler("word", 80);
		// Some 150 characters: both lines print whole, and are short enough to compare by eye.
		const short = (word: string) => `${filler("lead", 12)} ${word} ${filler("tail", 12)}`;
		const before = `${wide}\nkept();\n${short("old")}\n`;
		// A long line added whole was not edited in place, however much it shares with the line above it.
		const after = `${wide}\n${wide.replace("word40", "term40")}\nkept();\n${short("new")}\n`;

		expect(preview(before, after)).toBe(patch(before, after));
	});

	it("finds a change deep inside a very long line", () => {
		// A minified file: one line of 100,000 words.
		const line = (word: string) => `${filler("a", 60_000)} ${word} ${filler("b", 40_000)}\n`;

		expect(preview(line("old"), line("new")).split("\n")[4]).toBe(
			"!…9994 a59995 a59996 a59997 a59998 a59999 [-old-]{+new+} b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 b10 b11 b…",
		);
	});

	it("keeps every change of a line in its row under any column cap", () => {
		const line = (word: string) =>
			`${Array.from({ length: 8 }, (_, n) => `${filler(`pad${n}x`, 12)} ${word}${n}`).join(" ")} ${filler("end", 12)}\n`;
		const row = (columns: number) => preview(line("old"), line("new"), columns).split("\n")[4];

		// 0 = the tool cuts no line: nothing has to give.
		expect(row(0)).toContain(
			"pad0x7 pad0x8 pad0x9 pad0x10 pad0x11 [-old0-]{+new0+} pad1x0 pad1x1 pad1x2 pad1x3 pad1x4",
		);
		for (const columns of [768, 256]) {
			// Unchanged text gives way first.
			expect(Buffer.byteLength(row(columns))).toBeLessThanOrEqual(columns);
			expect(row(columns).match(/\[-old\d-\]\{\+new\d\+\}/g)).toHaveLength(8);
		}
	});

	it("leaves two lines whose changes cannot fit the column cap as the patch has them", () => {
		const before = `${filler("lead", 40)} ${filler("old", 60)} ${filler("tail", 40)}\n`;
		const after = `${filler("lead", 40)} ${filler("new", 60)} ${filler("tail", 40)}\n`;

		expect(preview(before, after, 256)).toBe(patch(before, after));
	});

	it("leaves two long lines that share little as the patch has them", () => {
		const before = `${filler("alpha", 30)} shared words here ${filler("gamma", 30)}\n`;
		const after = `${filler("beta", 30)} shared words here ${filler("delta", 30)}\n`;

		// With no column cap either: a row holding most of both lines reads worse than the two lines.
		for (const columns of [768, 0]) expect(preview(before, after, columns)).toBe(patch(before, after));
	});

	it("leaves text out between characters, never inside one", () => {
		const faces = "😀".repeat(200);
		// The padding dot shifts where the text is cut: in one of the two rows that is inside a surrogate pair.
		for (const pad of ["", "."]) {
			const before = `${faces}${pad} old ${pad}${faces}\n`;
			const row = preview(before, before.replace("old", "new")).split("\n")[4];

			expect(row).toContain(" [-old-]{+new+} ");
			expect(row.isWellFormed()).toBe(true);
		}
	});

	it("never shows text of the lines that reads as a mark", () => {
		const near = `${filler("lead", 40)} take items[-1] when oldName is set ${filler("tail", 40)}\n`;
		// Unchanged text is left out of the row instead.
		expect(preview(near, near.replace("oldName", "newName")).split("\n")[4]).toBe(
			"!…when [-oldName-]{+newName+} is s…",
		);

		// A change cannot be left out: the lines stay as the patch has them.
		const before = `${filler("lead", 40)} last = items[-1] or fallback ${filler("tail", 40)}\n`;
		const after = before.replace(" items[-1] or", "");
		expect(preview(before, after)).toBe(patch(before, after));
	});

	it("keeps what the patch says about a missing final newline", () => {
		const before = `${filler("lead", 40)} old ${filler("tail", 40)}`;
		const after = before.replace("old", "new");

		expect(preview(before, after)).toBe(
			`${HEADER}@@ -1,1 +1,1 @@\n!…ad34 lead35 lead36 lead37 lead38 lead39 [-old-]{+new+} tail0 tail1 tail2 tail3 tail4 tail5 tai…\n\\ No newline at end of file\n`,
		);
		// One row cannot say that only one of its two lines ends without a newline.
		expect(preview(before, `${after}\n`)).toBe(patch(before, `${after}\n`));
	});

	it("shows exactly the two lines a row stands for, within the column cap", () => {
		let state = 0x9e3779b9;
		const pick = (count: number): number => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return Math.floor((state / 2 ** 32) * count);
		};
		const words = [
			"alpha",
			"beta",
			"gamma",
			"past",
			"sessions,",
			"x",
			"=",
			">=",
			"(",
			");",
			"`judge`",
			"é",
			"日本語",
			"😀",
			"…",
		];
		const marks = ["items[-1]", "[-", "-]", "{+", "+}", "[", "-", "]", "{", "+", "}", "!", "\t", "  "];
		let rows = 0;
		for (let round = 0; round < 400; round++) {
			const vocabulary = round % 2 === 0 ? words : [...words, ...marks];
			const parts = Array.from({ length: 50 + pick(130) }, () => vocabulary[pick(vocabulary.length)]);
			const before = parts.join(" ");
			for (let edits = 1 + pick(6); edits > 0; edits--) {
				const at = pick(parts.length);
				const edit = pick(4);
				if (edit === 0) parts.splice(at, 1 + pick(3));
				else if (edit === 1) parts.splice(at, 0, vocabulary[pick(vocabulary.length)]);
				else if (edit === 2) parts[at] = vocabulary[pick(vocabulary.length)];
				else parts[at] += " ";
			}
			const after = parts.join(" ");
			const columns = [768, 256, 0][round % 3];
			const row = preview(`${before}\n`, `${after}\n`, columns).split("\n")[4];
			if (!row?.startsWith("!")) continue;
			rows++;
			expect(standsFor(row, before, after)).toBe(true);
			expect(row.length).toBeLessThanOrEqual(Math.max(before.length, after.length));
			if (columns > 0) expect(Buffer.byteLength(row)).toBeLessThanOrEqual(columns);
		}
		// The property is empty unless the rounds do print rows.
		expect(rows).toBeGreaterThan(100);
	});

	it("stops aligning costly lines once a preview has spent its budget", () => {
		// The two changes sit at the ends of each line, so aligning one means walking all of its words.
		const shared = "kept words ".repeat(1000);
		const text = (word: string) => `${word} ${shared}${word}\n`.repeat(32);
		const rows = preview(text("old"), text("new")).split("\n!").length - 1;

		// Lines this similar cost far less than their worst case, so the budget pays for several.
		expect(rows).toBeGreaterThan(1);
		expect(rows).toBeLessThan(32);
	});
});
