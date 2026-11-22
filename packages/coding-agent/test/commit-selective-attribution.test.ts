import { describe, expect, it } from "bun:test";
import {
	attribute,
	buildContent,
	classify,
	fromLines,
	historySteps,
	type RecordedEdit,
	toLines,
} from "@oh-my-pi/pi-coding-agent/commit/selective/attribution";

interface Edit {
	actor: string;
	before: string | null;
	after: string | null;
}

/** Content committed when only `scope`'s preselected ops are applied, plus the per-op verdicts. */
function commitFor(head: string | null, edits: Edit[], work: string | null, scope: string[], headMoved = false) {
	const recorded: RecordedEdit[] = edits.map(edit => ({
		actor: edit.actor,
		before: toLines(edit.before),
		after: toLines(edit.after),
	}));
	const headLines = toLines(head);
	const workLines = toLines(work);
	const attribution = attribute(headLines, historySteps(headLines, recorded, workLines), workLines, headMoved);
	const { status, reasons } = classify(attribution, new Set(scope));
	const selected = new Set(attribution.ops.filter(op => status[op.id] === "own").map(op => op.id));
	const verdicts = attribution.ops.map(op => `${status[op.id]} ${op.kind}${op.text}`);
	return { content: fromLines(buildContent(attribution, selected)), verdicts, reasons };
}

const CHANGELOG = "# Changelog\n## [Unreleased]\n### Fixed\n- old entry\n";
const CODE = "def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\ndef c():\n    return 3\n";

describe("selective commit attribution", () => {
	it("keeps only the agent's changelog bullet when other agents added bullets next to it", () => {
		const foreignFirst = CHANGELOG.replace("### Fixed\n", "### Fixed\n- Fixed theme flicker\n");
		const own = foreignFirst.replace("### Fixed\n", "### Fixed\n- Fixed /commit picking foreign hunks\n");
		const work = own.replace("- old entry\n", "- old entry\n- Fixed stale MCP list\n");

		const { content } = commitFor(CHANGELOG, [{ actor: "Main", before: foreignFirst, after: own }], work, ["Main"]);

		expect(content).toBe(CHANGELOG.replace("### Fixed\n", "### Fixed\n- Fixed /commit picking foreign hunks\n"));
	});

	for (const [side, workBody, selectedBody] of [
		["before", "check\nshared\nnew", "check\nshared\nold\nshared"],
		["after", "new\ncheck\nshared", "old\nshared\ncheck\nshared"],
	]) {
		it(`keeps an insertion ${side} a replacement when the replacement is not selected`, () => {
			const head = "begin\nold\nshared\nend";
			const before = "begin\nnew\nend";
			// Identical text in the old body does not make our new line a restoration of it.
			const work = `begin\n${workBody}\nend`;
			const edits = [
				{ actor: "Other", before: head, after: before },
				{ actor: "Main", before, after: work },
			];

			const committed = commitFor(head, edits, work, ["Main"]).content;
			expect(committed).toBe(`begin\n${selectedBody}\nend`);
			// A replacement made before recording also keeps the repeated text on its own side.
			expect(commitFor(head, edits.slice(1), work, ["Main"]).content).toBe(committed);
			expect(commitFor(head, edits, work, ["Other"]).content).toBe(before);
			expect(commitFor(head, edits, work, ["Main", "Other"]).content).toBe(work);
			expect(commitFor(head, edits, work, []).content).toBe(head);

			const replay = commitFor(committed, edits, work, ["Main"]);
			expect(replay.verdicts).toEqual(["other -old", "other -shared", "other +new"]);
			expect(replay.content).toBe(committed);
			const remaining = commitFor(committed, edits, work, ["Other"]);
			expect(remaining.verdicts).toEqual(["own -old", "own -shared", "own +new"]);
			expect(remaining.content).toBe(work);
		});
	}

	it("places the rest of an insertion around a line already committed at the boundary", () => {
		const original = "begin\nold\nend";
		const before = "begin\nnew\nend";
		const work = "begin\nfirst\ncheck\nlast\nnew\nend";
		const committed = "begin\ncheck\nold\nend";
		const edits = [
			// The gap after this snapshot hides the committed check until Main re-adds it.
			{ actor: "Earlier", before: null, after: committed },
			{ actor: "Other", before: original, after: before },
			{ actor: "Main", before, after: work },
		];
		const replay = commitFor(committed, edits, work, ["Main"]);
		expect(replay.content).toBe("begin\nfirst\ncheck\nlast\nold\nend");
		expect(replay.verdicts).toEqual(["own +first", "own +last", "other -old", "other +new"]);
	});

	it("reviews an entire insertion between lines of someone else's replacement", () => {
		const head = "begin\nold\nshared\nend";
		const before = "begin\nfirst\nsecond\nend";
		const work = "begin\nfirst\ncheck\nshared\nsecond\nend";
		const edits = [
			{ actor: "Other", before: head, after: before },
			{ actor: "Main", before, after: work },
		];

		const { content, verdicts, reasons } = commitFor(head, edits, work, ["Main"]);
		expect(content).toBe(head);
		expect(verdicts).toContain("review +check");
		expect(verdicts).toContain("review +shared");
		expect([...reasons.values()]).toContainEqual({ kind: "placement", with: ["Other"] });
		expect(commitFor(head, edits, work, ["Other"]).content).toBe(before);
		expect(commitFor(head, edits, work, ["Main", "Other"]).content).toBe(work);
	});

	it("does not infer authorship from the position of an unrecorded insertion", () => {
		const head = "old";
		const after = "first\nsecond";
		const work = "first\ninserted\nsecond";
		const { content } = commitFor(head, [{ actor: "Main", before: head, after }], work, ["Main"]);
		expect(content).toBe(after);
	});

	it("leaves a foreign edit between the agent's edits out and holds back own lines rewritten later", () => {
		const firstAfter = CODE.replace("return 1", "return 10");
		const secondBefore = firstAfter.replace("return 3", "return 30  # foreign");
		const secondAfter = secondBefore.replace("def b():\n    return 2", "def b():\n    log()\n    return 2");
		const work = secondAfter.replace("return 10", "return 10 ");

		const { content, verdicts } = commitFor(
			CODE,
			[
				{ actor: "Main", before: CODE, after: firstAfter },
				{ actor: "Main", before: secondBefore, after: secondAfter },
			],
			work,
			["Main"],
		);

		// `return 1` → `return 10` was rewritten after the edit by nobody on record: neither half is committed.
		expect(verdicts).toContain("review -    return 1");
		expect(verdicts).toContain("review +    return 10 ");
		expect(content).toBe(CODE.replace("def b():\n    return 2", "def b():\n    log()\n    return 2"));
	});

	describe("history that predates HEAD", () => {
		const created = "package demo\n\nfunc a() error {\n\treturn nil\n}\n\nfunc c() int {\n\treturn 3\n}\n";
		const withB = created.replace("\nfunc c", '\nfunc b() string {\n\treturn "b"\n}\n\nfunc c');

		it("keeps committed lines in place when HEAD equals a recorded snapshot", () => {
			const work = withB.replace("\treturn 3\n", "\tlog()\n\treturn 3\n");

			const { content, verdicts } = commitFor(
				withB,
				[
					{ actor: "TxnFix", before: null, after: created },
					{ actor: "TxnFix", before: created, after: withB },
					{ actor: "Main", before: withB, after: work },
				],
				work,
				["Main"],
			);

			expect(verdicts).toEqual(["own +\tlog()"]);
			expect(content).toBe(work);
		});

		it("keeps a partial commit's lines in place and treats them as committed", () => {
			const mainLine = created.replace("package demo\n", "package demo\n\nconst m = 1\n");
			const subLines = mainLine.replace("\nfunc c", '\nfunc b() string {\n\treturn "b"\n}\n\nfunc c');
			const work = subLines.replace("\treturn nil\n", "\treturn errA\n");

			const { content, verdicts } = commitFor(
				withB, // TxnFix's lines were committed without Main's `const m`
				[
					{ actor: "TxnFix", before: null, after: created },
					{ actor: "Main", before: created, after: mainLine },
					{ actor: "TxnFix", before: mainLine, after: subLines },
					{ actor: "Main", before: subLines, after: work },
				],
				work,
				["Main"],
			);

			expect(verdicts.filter(verdict => !verdict.startsWith("own "))).toEqual([]);
			expect(content).toBe(work);
		});

		it("does not duplicate a committed block an edit re-added past a repeated line", () => {
			const draft = "\nfn end() {\n\tif fill.is_none() {\n\t\treturn;\n\t}\n\tdone();\n}\n";
			const final = draft
				.replace("\tif fill.is_none() {\n", "\tlet Some(fill) = fill else {\n")
				.replace("\t\treturn;\n\t}\n", "\t\treturn;\n\t};\n\tif fill.busy() {\n\t\treturn;\n\t}\n");
			const own = (body: string) => `const X: u8 = 1;\n${body}`;
			const work = own(final).replace("\tdone();\n", "\tdone();\n\ttrace();\n");

			// `end` was committed without `const X`, so no snapshot equals HEAD. Replaying the history
			// deletes HEAD's `return; }; if fill.busy() {` and re-adds `}; if fill.busy() { return;`
			// one `return;` further down.
			const { content, verdicts } = commitFor(
				final,
				[
					{ actor: "Main", before: "", after: own(draft) },
					{ actor: "Main", before: own(draft), after: own(final) },
					{ actor: "Main", before: own(final), after: work },
				],
				work,
				["Main"],
			);

			expect(verdicts).toEqual(["own +const X: u8 = 1;", "own +\ttrace();"]);
			expect(content).toBe(work);
		});
	});

	it("puts an edit of another actor's uncommitted line in review instead of committing it half", () => {
		const foreign = CODE.replace("return 2", "return 2\n    x = helper()");
		const own = foreign.replace("helper()", "helper(strict=True)");

		const { content, verdicts } = commitFor(CODE, [{ actor: "Main", before: foreign, after: own }], own, ["Main"]);

		expect(verdicts).toEqual(["review +    x = helper(strict=True)"]);
		expect(content).toBe(CODE);
	});

	it("deletes a whole function when the agent removed it", () => {
		const head = "a = 1\n\ndef f():\n    x = 1\n    return x\n\ndef g():\n    return 2\n";
		const work = "a = 1\n\ndef g():\n    return 2\n";

		const { content } = commitFor(head, [{ actor: "Main", before: head, after: work }], work, ["Main"]);

		expect(content).toBe(work);
	});

	it("deletes the file only when every line's deletion is selected", () => {
		const { content } = commitFor("x\n", [{ actor: "Main", before: "x\n", after: null }], null, ["Main"]);

		expect(content).toBeNull();
	});

	// HEAD advanced on its own, then writers reordered lines. Each case once preselected an
	// insertion whose matching deletion went elsewhere, committing a second `A`.
	for (const [head, steps] of [
		["x B x D A", ["B x x A", "Main: B A x x C", "Other: A x x C D B", "Main: A x C D B x"]],
		["D B x x A", ["A B x x", "Main: B A x x", "Other: B A D x x", "Main: B D A x"]],
	] as const) {
		it(`never preselects a line the net change would then hold twice (HEAD ${head})`, () => {
			const lines = (text: string) => text.split(" ").join("\n");
			const edits: Edit[] = [];
			let before = lines(steps[0]);
			for (const step of steps.slice(1)) {
				const [actor, after] = step.split(": ");
				edits.push({ actor, before, after: lines(after) });
				before = lines(after);
			}
			const tally = (text: string | null) => {
				const counts = new Map<string, number>();
				for (const line of toLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
				return counts;
			};
			const headCounts = tally(lines(head));
			const workCounts = tally(before);

			const committed = tally(commitFor(lines(head), edits, before, ["Main"], true).content);

			for (const [line, count] of committed) {
				expect(count).toBeLessThanOrEqual(Math.max(headCounts.get(line) ?? 0, workCounts.get(line) ?? 0));
			}
		});
	}

	it("keeps an unrelated insertion preselected when only a reviewed reorder also adds its text", () => {
		const lines = (text: string) => text.split(" ").join("\n");
		const snapshots = [
			"B x x A q q q q",
			"Main: B A x x C q q q q",
			"Other: A x x C D B q q q q",
			"Main: A x C D B x q q q q",
			// Unrelated to the reorder, though the reviewed hunks add a `C` as well.
			"Main: A x C D B x q q C q q",
		];
		const edits: Edit[] = [];
		let before = lines(snapshots[0]);
		for (const step of snapshots.slice(1)) {
			const [actor, after] = step.split(": ");
			edits.push({ actor, before, after: lines(after) });
			before = lines(after);
		}

		const { verdicts } = commitFor(lines("x B x D A q q q q"), edits, before, ["Main"], true);

		expect(verdicts.at(-1)).toBe("own +C");
		expect(verdicts.slice(0, -1).every(verdict => verdict.startsWith("review"))).toBe(true);
	});

	it("keeps the agent's lines selectable in a file that was only dirty before recording began", () => {
		// The user dropped `}` and added `u` before any record; Main then added a `}` of its own.
		const head = "\nc\n}";
		const before = "\nc\nu";
		const work = "\n}\nc\nu";
		const edits = [{ actor: "Main", before, after: work }];

		const { verdicts, content } = commitFor(head, edits, work, ["Main"]);

		expect(verdicts).toEqual(["own +}", "other -}", "other +u"]);
		expect(content).toBe("\n}\nc\n}");
	});

	it("never preselects a line already committed when its twin shares one hunk", () => {
		// Main wrote `B`; a commit took it after recording began; Other then rewrote the rest.
		const edits = [
			{ actor: "Main", before: "A", after: "A\nB" },
			{ actor: "Other", before: "A\nB", after: "B\nx" },
		];

		expect(commitFor("B", edits, "B\nx", ["Main"], true).content).toBe("B");
	});

	describe("subagents", () => {
		const mainAfter = CODE.replace("return 1", "return 10");
		const subAfter = mainAfter.replace("return 2", "return 20");
		const edits: Edit[] = [
			{ actor: "Main", before: CODE, after: mainAfter },
			{ actor: "ParserFix", before: mainAfter, after: subAfter },
		];

		it("commits one subagent's lines without its parent's", () => {
			expect(commitFor(CODE, edits, subAfter, ["ParserFix"]).content).toBe(CODE.replace("return 2", "return 20"));
		});

		it("commits parent and subagent lines together when both are in scope", () => {
			expect(commitFor(CODE, edits, subAfter, ["Main", "ParserFix"]).content).toBe(subAfter);
		});

		it("holds back a subagent's rewrite of its parent's uncommitted line unless both are in scope", () => {
			const rewrite = mainAfter.replace("return 10", "return 11");
			const chain: Edit[] = [
				{ actor: "Main", before: CODE, after: mainAfter },
				{ actor: "ParserFix", before: mainAfter, after: rewrite },
			];

			expect(commitFor(CODE, chain, rewrite, ["ParserFix"]).content).toBe(CODE);
			expect(commitFor(CODE, chain, rewrite, ["Main"]).content).toBe(CODE);
			expect(commitFor(CODE, chain, rewrite, ["Main", "ParserFix"]).content).toBe(rewrite);
		});
	});
});
