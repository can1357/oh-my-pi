import { describe, expect, it } from "bun:test";
import { RICH_TEXT_LIMIT, mdCode, mdText, plural, richMarkdown } from "../../src/telegram/rich";
import { renderAssistantText } from "../../src/telegram/markdown";

describe("mdText", () => {
	it("escapes what carries meaning but keeps newlines", () => {
		expect(mdText("/tmp/a*b[c].md")).toBe("/tmp/a\\*b\\[c\\]\\.md");
		expect(mdText("$HOME and a || b")).toBe("\\$HOME and a \\|\\| b");
		expect(mdText("<script>")).toBe("&lt;script\\>");
		expect(mdText("a & b")).toBe("a &amp; b");
		expect(mdText("first\nsecond")).toBe("first\nsecond");
	});
});

describe("mdCode", () => {
	it("picks a fence that cannot collide with the backticks inside", () => {
		expect(mdCode("Array<string>")).toBe("`Array<string>`");
		expect(mdCode("a`b")).toBe("``a`b``");
		expect(mdCode("`x`")).toBe("`` `x` ``");
		expect(mdCode("two\nlines")).toBe("`two lines`");
	});
});

describe("plural", () => {
	it("uses the singular for exactly one and the plural otherwise", () => {
		expect(plural(1, "file", "files")).toBe("file");
		expect(plural(0, "file", "files")).toBe("files");
		expect(plural(2, "file", "files")).toBe("files");
		expect(plural(21, "file", "files")).toBe("files");
	});
});

describe("richMarkdown", () => {
	it("neutralises Telegram extensions in prose but not in code or fences", () => {
		const source = [
			"Costs $HOME and $5 and $10, branch a || b, check x == y, type Array<string>.",
			"",
			"```js",
			"const price = $HOME || a == b;",
			"```",
			"",
			"inline `$HOME || x == y`",
		].join("\n");
		const [chunk] = richMarkdown(source);
		expect(chunk).toMatch(/\\\$HOME and \\\$5 and \\\$10/u);
		expect(chunk).toMatch(/a \\\|\\\| b/u);
		expect(chunk).toMatch(/x \\=\\= y/u);
		expect(chunk).toMatch(/Array&lt;string>/u);
		expect(chunk).toMatch(/const price = \$HOME \|\| a == b;/u);
		expect(chunk).toMatch(/`\$HOME \|\| x == y`/u);
	});

	it("lets escaped text reach the user literally, in the HTML fallback too", () => {
		const source = richMarkdown(mdText("$HOME, a || b, x == y, Array<string>")).join("\n");
		const [html] = renderAssistantText(source);
		expect(html).toMatch(/\$HOME, a \|\| b, x == y, Array&lt;string&gt;/u);
		const [direct] = renderAssistantText("$HOME, a || b, x == y, Array<string>");
		expect(direct).toMatch(/\$HOME, a \|\| b, x == y, Array&lt;string&gt;/u);
		expect(direct.includes("*Array")).toBe(false);
	});

	it("keeps supported tags and escapes foreign ones", () => {
		const source = [
			"<details><summary>Breakdown</summary>",
			"inside $VAR",
			"</details>",
			"",
			"<script>alert(1)</script>",
		].join("\n");
		const [chunk] = richMarkdown(source);
		expect(chunk).toMatch(/<details><summary>Breakdown<\/summary>/u);
		expect(chunk).toMatch(/<\/details>/u);
		expect(chunk).toMatch(/&lt;script>alert\(1\)&lt;\/script>/u);
		expect(chunk).toMatch(/inside \\\$VAR/u);
	});

	it("cuts a long code block between chunks with the fence reopened", () => {
		const code = Array.from({ length: 3000 }, (_unused, index) => `code line ${index} ${"x".repeat(20)}`);
		const chunks = richMarkdown(`Look:\n\n\`\`\`js\n${code.join("\n")}\n\`\`\`\n\ndone`);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(RICH_TEXT_LIMIT);
		for (const line of code) expect(chunks.filter(chunk => chunk.includes(line)).length).toBe(1);
		const reopened = chunks.filter(chunk => chunk.startsWith("```js"));
		expect(reopened.length).toBe(chunks.length - 1);
		for (const chunk of chunks) expect((chunk.match(/```/gu) ?? []).length % 2).toBe(0);
	});

	it("closes an unclosed fence and does not tear an unclosed details block", () => {
		expect(richMarkdown("text\n\n```py\nprint(1)")).toEqual(["text\n\n```py\nprint(1)\n```"]);
		const body = Array.from({ length: 1500 }, (_unused, index) => `line ${index} ${"y".repeat(20)}`).join("\n");
		const chunks = richMarkdown(`<details><summary>Summary</summary>\n${body}\n</details>`);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.startsWith("<details><summary>Summary</summary>")).toBe(true);
			expect(chunk.trimEnd().endsWith("</details>")).toBe(true);
		}
	});

	it("renders nothing for an empty answer", () => {
		expect(richMarkdown("   \n\n")).toEqual([]);
	});

	it("keeps code inside details as code, unescaped", () => {
		const notice = [
			"⚠️ Process omp exited (code 1).",
			"",
			"<details><summary>stderr tail</summary>",
			"",
			"```",
			"at Object.<anonymous> (/tmp/a.js:1:1)",
			"echo $HOME || x == y and Array<string>",
			"```",
			"",
			"</details>",
		].join("\n");
		const [chunk] = richMarkdown(notice);
		expect(chunk).toMatch(/at Object\.<anonymous> \(\/tmp\/a\.js:1:1\)/u);
		expect(chunk).toMatch(/echo \$HOME \|\| x == y and Array<string>/u);
		expect(chunk.includes("&lt;anonymous>")).toBe(false);
		expect(chunk.includes("\\$")).toBe(false);
		expect(chunk.includes("&lt;string>")).toBe(false);
		expect(chunk).toMatch(/<details><summary>stderr tail<\/summary>/u);
		expect(chunk).toMatch(/<\/details>/u);
	});

	it("closes an unclosed fence inside details instead of swallowing the block", () => {
		const [chunk] = richMarkdown("<details><summary>Tail</summary>\n\n```\ncode line\n</details>");
		expect((chunk.match(/```/gu) ?? []).length).toBe(2);
		expect(chunk).toMatch(/code line\n```\n<\/details>/u);
	});
});

describe("rich text limit", () => {
	it("matches the limit Telegram enforces on a rich message", () => {
		expect(RICH_TEXT_LIMIT).toBe(32768);
	});
});
