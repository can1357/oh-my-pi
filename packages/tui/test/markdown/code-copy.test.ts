import { describe, expect, test } from "bun:test";
import { stripEscapes } from "../../src/text/ansi";
import {
	CODE_COPY_ID,
	codeBlockHash,
	extractFencedCodeBlocks,
	renderMarkdownFrame,
	stripTrailingSpaces,
	takeCodeCopyMarkers,
} from "../../src/text/markdown";
import { loadThemeSync } from "../../src/theme";

const theme = loadThemeSync("dark");

describe("stripTrailingSpaces", () => {
	test("strips trailing spaces and tabs on every line while preserving indentation and blank lines", () => {
		const input = "  const a = 1;   \n\t\n  const b = 2;\t \r\n\treturn a + b;  ";
		expect(stripTrailingSpaces(input)).toBe("  const a = 1;\n\n  const b = 2;\r\n\treturn a + b;");
	});
});

describe("extractFencedCodeBlocks", () => {
	test("extracts multiple fenced blocks in document order with trailing spaces stripped", () => {
		const md = [
			"Intro",
			"```ts",
			"const x = 1;   ",
			"  const y = 2;\t",
			"```",
			"Middle",
			"```sh",
			"echo hello  ",
			"```",
		].join("\n");

		const blocks = extractFencedCodeBlocks(md);
		expect(blocks).toEqual([
			{ lang: "ts", code: "const x = 1;\n  const y = 2;", hash: codeBlockHash("const x = 1;\n  const y = 2;") },
			{ lang: "sh", code: "echo hello", hash: codeBlockHash("echo hello") },
		]);
	});

	test("handles nested backtick fences and tilde fences", () => {
		const md = [
			"````markdown",
			"Example:  ",
			"```ts",
			"const inner = true;  ",
			"```",
			"````",
			"",
			"~~~python",
			"def f():   ",
			"    return '```'  ",
			"~~~",
		].join("\n");

		const blocks = extractFencedCodeBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.lang).toBe("markdown");
		expect(blocks[0]!.code).toBe("Example:\n```ts\nconst inner = true;\n```");
		expect(blocks[1]!.lang).toBe("python");
		expect(blocks[1]!.code).toBe("def f():\n    return '```'");
	});

	test("ignores indented code blocks and extracts fences inside list items", () => {
		const md = ["    indented_code()", "", "- step one:", "  ```bash", "  ls -la   ", "  ```"].join("\n");

		const blocks = extractFencedCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.lang).toBe("bash");
		expect(blocks[0]!.code).toBe("ls -la");
	});

	test("only descends into blockquotes when includeQuotes is true", () => {
		const md = ["> ```ts", "> const quoted = 1;  ", "> ```"].join("\n");

		expect(extractFencedCodeBlocks(md)).toHaveLength(0);
		const withQuotes = extractFencedCodeBlocks(md, { includeQuotes: true });
		expect(withQuotes).toHaveLength(1);
		expect(withQuotes[0]!.code).toBe("const quoted = 1;");
	});
});

describe("markdown code-copy header button", () => {
	test("renders a right-aligned [Copy] marker on closed fenced code blocks and strips it cleanly", () => {
		const code = "const a = 1;  ";
		const md = `\`\`\`ts\n${code}\n\`\`\``;
		const frame = renderMarkdownFrame(md, 40, { theme, codeCopy: true });

		expect(frame.rows[0]).toContain(`id=${CODE_COPY_ID};`);
		const taken = takeCodeCopyMarkers(frame.rows[0]!);
		expect(taken.row).not.toContain(`id=${CODE_COPY_ID};`);
		expect(stripEscapes(taken.row)).toBe(`\`\`\`ts${" ".repeat(29)}[Copy]`);
		expect(taken.buttons).toEqual([{ hash: codeBlockHash(code), start: 34, end: 40 }]);
	});

	test("switches the button label to [Copied] when copiedCodeHash matches", () => {
		const code = "const a = 1;";
		const md = `\`\`\`ts\n${code}\n\`\`\``;
		const hash = codeBlockHash(code);
		const frame = renderMarkdownFrame(md, 40, { theme, codeCopy: true, copiedCodeHash: hash });
		const taken = takeCodeCopyMarkers(frame.rows[0]!);

		expect(stripEscapes(taken.row)).toBe(`\`\`\`ts${" ".repeat(27)}[Copied]`);
		expect(taken.buttons).toEqual([{ hash, start: 32, end: 40 }]);
	});

	test("omits the copy button when the width is too narrow or while a fence is still streaming open", () => {
		const md = "```typescript\nconst a = 1;\n```";
		const narrow = renderMarkdownFrame(md, 16, { theme, codeCopy: true });
		expect(takeCodeCopyMarkers(narrow.rows[0]!).buttons).toEqual([]);

		const openStream = renderMarkdownFrame("```ts\nconst a = 1;", 40, { theme, codeCopy: true, stream: true });
		expect(takeCodeCopyMarkers(openStream.rows[0]!).buttons).toEqual([]);
	});
});
