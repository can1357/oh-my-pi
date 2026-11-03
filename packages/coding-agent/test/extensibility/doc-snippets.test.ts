import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Each file in `doc-snippets/` is a type-checked copy of one documented code
 * block: the package type check compiles it against the real extension API.
 * This test keeps every copy identical to its block, so a documented snippet
 * cannot drift into code that no longer compiles.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const snippetDir = path.join(import.meta.dir, "doc-snippets");
const MARKER = "// ---- documented snippet below, verbatim ----\n";

function codeBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)].map(match => match[1]!);
}

const snippetFiles = [...new Bun.Glob("*.ts").scanSync(snippetDir)].sort();

describe("documented extension snippets", () => {
	it("has a type-checked copy for each covered block", () => {
		expect(snippetFiles.length).toBeGreaterThan(0);
	});

	for (const file of snippetFiles) {
		it(`${file} matches its documented block`, async () => {
			const copy = await Bun.file(path.join(snippetDir, file)).text();
			const source = copy.match(/^\/\/ Type-checked copy of a snippet in (\S+);/)?.[1];
			expect(source).toBeDefined();
			const markerAt = copy.indexOf(MARKER);
			expect(markerAt).toBeGreaterThan(-1);
			const snippet = copy.slice(markerAt + MARKER.length);
			const blocks = codeBlocks(await Bun.file(path.join(repoRoot, source!)).text());
			expect(blocks).toContain(snippet);
		});
	}
});
