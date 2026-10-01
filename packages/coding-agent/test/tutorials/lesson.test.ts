import { describe, expect, it } from "bun:test";
import { getLessons } from "@oh-my-pi/pi-coding-agent/tutorials/catalog";
import { type LessonSource, parseLesson } from "@oh-my-pi/pi-coding-agent/tutorials/lesson";

const LESSON_MD = `---
id: demo
title: Demo lesson
minutes: 3
requires: [eval]
history:
  - dir: commits/one
    message: "refactor: one"
steps:
  - id: first
    check: turn
    hint: Send anything.
    done: A turn finished.
  - id: second
    check:
      - keyword: jevify
      - tool: eval
        match: 'judge\\('
      - file: src/a.ts
        matches: 'export'
      - command: /btw
      - reply: 'refund\\.ts'
    hint: Use the keyword.
    done: Judged.
---
Intro for {{dir}}.
`;

function source(overrides: Record<string, string | undefined> = {}): LessonSource {
	const files: Record<string, string> = {
		"lesson.md": LESSON_MD,
		"first.md": "Step one.",
		"second.md": "Step two.",
		"when.md": "When to use it.",
	};
	for (const [name, text] of Object.entries(overrides)) {
		if (text === undefined) delete files[name];
		else files[name] = text;
	}
	return { id: "demo", files };
}

describe("parseLesson", () => {
	it("normalizes frontmatter, step texts, and every check kind", () => {
		const lesson = parseLesson(source());
		expect(lesson).toMatchObject({
			id: "demo",
			title: "Demo lesson",
			minutes: 3,
			requires: ["eval"],
			intro: "Intro for {{dir}}.",
			when: "When to use it.",
			history: [{ dir: "commits/one", message: "refactor: one" }],
		});
		expect(lesson.steps.map(step => [step.id, step.text, step.checks.map(check => check.kind)])).toEqual([
			["first", "Step one.", ["turn"]],
			["second", "Step two.", ["keyword", "tool", "file", "command", "reply"]],
		]);
		const [, second] = lesson.steps;
		// `/btw` is stored as the canonical command name the input controller reports.
		expect(second!.checks[3]).toEqual({ kind: "command", name: "btw" });
		// Regexes are case-insensitive so lesson authors do not depend on model casing.
		const reply = second!.checks[4]!;
		expect(reply.kind === "reply" && reply.pattern.test("SRC/REFUND.TS")).toBe(true);
	});

	it.each([
		["a step text file is missing", { "second.md": undefined }, /missing second\.md/],
		["when.md is missing", { "when.md": undefined }, /missing when\.md/],
		[
			"the id does not match the directory",
			{ "lesson.md": LESSON_MD.replace("id: demo", "id: other") },
			/does not match/,
		],
		["a regex is invalid", { "lesson.md": LESSON_MD.replace("'judge\\('", "'judge('") }, /not a valid regex/],
		[
			"a keyword is not registered",
			{ "lesson.md": LESSON_MD.replace("keyword: jevify", "keyword: nope") },
			/not a registered magic keyword/,
		],
		[
			"a file check escapes the repo",
			{ "lesson.md": LESSON_MD.replace("file: src/a.ts", "file: ../a.ts") },
			/inside the lesson repo/,
		],
		["the YAML is broken", { "lesson.md": "---\nid: [demo\n---\nbody" }, /Tutorial lesson "demo"/],
	])("fails with a clear error when %s", (_label, overrides, message) => {
		expect(() => parseLesson(source(overrides))).toThrow(message);
	});
});

describe("bundled lessons", () => {
	it("all parse, so /tutorial cannot crash on a shipped lesson", () => {
		const ids = getLessons().map(lesson => lesson.id);
		expect(ids).toEqual(["basics", "btw", "jevify", "ttsr"]);
	});
});
