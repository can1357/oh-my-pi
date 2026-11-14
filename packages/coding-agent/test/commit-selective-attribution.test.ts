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
	gapHint?: string;
}

/** Content committed when only `scope`'s preselected ops are applied, plus the per-op verdicts. */
function commitFor(head: string | null, edits: Edit[], work: string | null, scope: string[], tailHint?: string) {
	const recorded: RecordedEdit[] = edits.map(edit => ({
		actor: edit.actor,
		before: toLines(edit.before),
		after: toLines(edit.after),
		gapHint: edit.gapHint,
	}));
	const headLines = toLines(head);
	const workLines = toLines(work);
	const attribution = attribute(headLines, historySteps(headLines, recorded, workLines, tailHint), workLines);
	const { status } = classify(attribution, new Set(scope));
	const selected = new Set(attribution.ops.filter(op => status[op.id] === "own").map(op => op.id));
	const verdicts = attribution.ops.map(op => `${status[op.id]} ${op.kind}${op.text}`);
	return { content: fromLines(buildContent(attribution, selected)), verdicts };
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

	it("counts an unrecorded rewrite of the agent's lines as its own when its shell call explains it", () => {
		const after = CODE.replace("return 1", "return  10");
		const work = CODE.replace("return 1", "return 10");

		const { content } = commitFor(CODE, [{ actor: "Main", before: CODE, after }], work, ["Main"], "Main");

		expect(content).toBe(work);
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
