import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Each file in `doc-snippets/` is a type-checked copy of one documented code
 * block: the package type check compiles it against the real extension and hook
 * APIs. This test keeps every copy identical to the block it names (the Nth
 * ts/typescript block under a heading), so a documented snippet cannot drift into
 * code that no longer compiles, and a copy cannot be dropped silently.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const snippetDir = path.join(import.meta.dir, "doc-snippets");
const MARKER = "// ---- documented snippet below, verbatim ----\n";
const HEADER = /^\/\/ Type-checked copy of block (\d+) under "(.+)" in (\S+);/;
const EXPECTED_COPIES = [
	"extensions-command-provider.ts",
	"extensions-quick-start.ts",
	"extensions-readme-reconstruct.ts",
	"extensions-readme.ts",
	"extensions-tool-call-guard.ts",
	"extensions-tool-template.ts",
	"hooks-context-filter.ts",
	"hooks-readme.ts",
	"skills-context-filter.ts",
];

/** The ts/typescript fenced blocks of a markdown file, each with the heading line it sits under. */
function codeBlocks(markdown: string): { heading: string | undefined; body: string }[] {
	const blocks: { heading: string | undefined; body: string }[] = [];
	const lines = markdown.split("\n");
	let heading: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (/^#{1,6} /.test(line)) heading = line;
		if (!/^```(ts|typescript)\s*$/.test(line)) continue;
		const body: string[] = [];
		for (index++; index < lines.length && !lines[index]!.startsWith("```"); index++) body.push(lines[index]!);
		blocks.push({ heading, body: `${body.join("\n")}\n` });
	}
	return blocks;
}

describe("documented extension and hook snippets", () => {
	it("keeps a type-checked copy of every covered block", () => {
		const copies = [...new Bun.Glob("*.ts").scanSync(snippetDir)].sort();
		expect(copies).toEqual(EXPECTED_COPIES);
	});

	for (const file of EXPECTED_COPIES) {
		it(`${file} matches the block it names`, async () => {
			const copy = await Bun.file(path.join(snippetDir, file)).text();
			const header = copy.match(HEADER);
			expect(header).not.toBeNull();
			const [, ordinal, heading, source] = header!;
			const markerAt = copy.indexOf(MARKER);
			expect(markerAt).toBeGreaterThan(-1);
			const underHeading = codeBlocks(await Bun.file(path.join(repoRoot, source!)).text()).filter(
				block => block.heading === heading,
			);
			expect(underHeading[Number(ordinal) - 1]?.body).toBe(copy.slice(markerAt + MARKER.length));
		});
	}
});
