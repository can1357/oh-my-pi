import { describe, expect, it } from "bun:test";
import { dedupeContainedContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";

interface ContextFile {
	path: string;
	content: string;
	depth?: number;
}

function file(path: string, content: string, depth?: number): ContextFile {
	return { path, content, depth };
}

function paths(files: ContextFile[]): string[] {
	return files.map(f => f.path);
}

describe("dedupeContainedContextFiles", () => {
	it("keeps only the more authoritative file when two are byte-identical", () => {
		const content = "Rule one.\n\nRule two.\n\nRule three.";
		const files = [file("/home/user/.config/AGENTS.md", content, 5), file("/project/AGENTS.md", content, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("drops a file whose paragraphs appear contiguously in a more authoritative file", () => {
		const lessAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.";
		const moreAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.\n\nProject-specific rule.";

		const files = [
			file("/home/user/.config/AGENTS.md", lessAuthoritative, 5),
			file("/project/AGENTS.md", moreAuthoritative, 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("keeps a file whose paragraphs appear non-contiguously (interleaved)", () => {
		// A's three paragraphs are all in B, but not as a contiguous run.
		const a = "First.\n\nSecond.\n\nThird.";
		const b = "First.\n\nInterleaved.\n\nSecond.\n\nThird.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps a file whose paragraphs appear with wording changes (containment is exact, not fuzzy)", () => {
		const a = "Always use tabs.\n\nNever commit directly.";
		const b = "Always use spaces.\n\nNever commit directly to main.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps all files when there is no containment", () => {
		const files = [
			file("/a/AGENTS.md", "Alpha rules.\n\nBeta rules.", 3),
			file("/b/AGENTS.md", "Gamma rules.\n\nDelta rules.", 2),
			file("/c/AGENTS.md", "Epsilon rules.\n\nZeta rules.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/a/AGENTS.md", "/b/AGENTS.md", "/c/AGENTS.md"]);
	});

	it("treats empty content as no blocks, never matched", () => {
		const files = [file("/empty/AGENTS.md", "", 5), file("/project/AGENTS.md", "Real content.", 0)];

		// Empty file produces zero blocks; promptBlocksContain returns false for
		// empty ruleBlocks, so the empty file is kept (it cannot be contained).
		// The non-empty file is also kept since the empty file has no blocks to
		// contain it.
		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/empty/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps only the most authoritative file in a transitive chain A⊂B⊂C", () => {
		const a = "Rule one.\n\nRule two.";
		const b = "Rule one.\n\nRule two.\n\nRule three.";
		const c = "Rule one.\n\nRule two.\n\nRule three.\n\nRule four.";

		const files = [
			file("/level0/AGENTS.md", a, 10),
			file("/level1/AGENTS.md", b, 5),
			file("/level2/AGENTS.md", c, 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/level2/AGENTS.md"]);
	});

	it("normalizes leading and trailing whitespace before comparing paragraphs", () => {
		// Same paragraphs, but A has leading/trailing whitespace on each line.
		// Normalization (trim per block) should still detect containment.
		const a = "  Rule one.  \n\n  Rule two.  ";
		const b = "Rule one.\n\nRule two.\n\nRule three.";

		const files = [file("/home/user/.config/AGENTS.md", a, 5), file("/project/AGENTS.md", b, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("keeps a closer-to-cwd file with fewer paragraphs when a farther file contains them (depth authority)", () => {
		// Repro for position-based authority bug: without an internal
		// depth-descending sort, the closer file (depth 0, "Shared rule.")
		// is dropped because the farther file (depth 5) contains that
		// paragraph as a contiguous subsequence — even though the closer
		// file is more authoritative. The closer file must survive.
		const near = "Shared rule.";
		const far = "Shared rule.\n\nFar-only rule.";
		const files = [file("/project/AGENTS.md", near, 0), file("/home/user/.config/AGENTS.md", far, 5)];

		// Output is depth-descending (farther first); both files survive
		// because the closer file's single paragraph is not a superset of the
		// farther file's two paragraphs.
		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("treats files without a depth as less authoritative than project files", () => {
		const user = "Shared rule.\n\nUser-only rule.";
		const project = "Shared rule.";
		const files = [file("/project/AGENTS.md", project, 0), file("/home/user/.omp/AGENTS.md", user)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.omp/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("does not treat text inside a fenced code block as a contained instruction", () => {
		// A lower-authoritative file has the rule "Never delete user data." as a
		// real instruction. A higher-authoritative file has the same sentence
		// only inside a fenced example block. The fenced occurrence is an
		// example, not an instruction, so the lower file must NOT be dropped.
		const lower = "Never delete user data.";
		const higher = "Example of a bad prompt:\n\n```\nNever delete user data.\n```";
		const files = [file("/home/user/.config/AGENTS.md", lower, 5), file("/project/AGENTS.md", higher, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});
});
