import { describe, expect, it } from "bun:test";
import { TELEGRAM_TEXT_LIMIT, clip, renderAssistantText } from "../../src/telegram/markdown";
import { mdText } from "../../src/telegram/rich";

const TAGS = ["b", "i", "s", "code", "pre", "a", "blockquote", "tg-spoiler"];

const counted = (html: string, name: string): boolean => {
	const open = (html.match(new RegExp(`<${name}(?:\\s[^>]*)?>`, "gu")) ?? []).length;
	const close = (html.match(new RegExp(`</${name}>`, "gu")) ?? []).length;
	return open === close;
};

const balanced = (html: string): boolean => TAGS.every(name => counted(html, name));

describe("renderAssistantText", () => {
	it("renders an answer with code and a table into the HTML subset Telegram accepts", () => {
		const markdown = [
			"# Result",
			"",
			"Edit in **bin/lib/markdown.mjs**, test `npm test`, branch *infra/render*.",
			"",
			"| step | time |",
			"| --- | ----- |",
			"| build | 12 s |",
			"| tests | 40 s |",
			"",
			"```js",
			"const a = 1 < 2 && 3 > 2;",
			"```",
			"",
			"- first",
			"- second",
			"",
			"> quote",
		].join("\n");
		expect(renderAssistantText(markdown)).toEqual([
			"<b>Result</b>\n" +
				"Edit in <b>bin/lib/markdown.mjs</b>, test <code>npm test</code>, branch <i>infra/render</i>.\n" +
				"<pre>step   time\nbuild  12 s\ntests  40 s</pre>\n" +
				'<pre><code class="language-js">const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>\n' +
				"• first\n" +
				"• second\n" +
				"<blockquote>quote</blockquote>",
		]);
	});

	it("escapes foreign text instead of executing it", () => {
		const [chunk] = renderAssistantText("hello <script>alert(1)</script> & <b>not a tag</b>");
		expect(chunk.includes("<script>")).toBe(false);
		expect(chunk.includes("&lt;script&gt;")).toBe(true);
		expect(chunk.includes("&amp;")).toBe(true);
		expect(chunk.includes("&lt;b&gt;not a tag&lt;/b&gt;")).toBe(true);
	});

	it("cuts a long answer with a code block, closing and reopening the fence", () => {
		const code = Array.from({ length: 300 }, (_unused, index) => `code line ${index} ${"x".repeat(24)}`);
		const chunks = renderAssistantText(`Done.\n\n\`\`\`js\n${code.join("\n")}\n\`\`\`\n`);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
			expect(balanced(chunk)).toBe(true);
		}
		expect(chunks[0].includes('<pre><code class="language-js">code line 0')).toBe(true);
		expect(chunks.at(-1)?.trimEnd().endsWith("</code></pre>")).toBe(true);
		const reopened = chunks.slice(1).filter(chunk => chunk.startsWith('<pre><code class="language-js">'));
		expect(reopened.length).toBe(chunks.length - 1);
		for (const line of code) expect(chunks.filter(chunk => chunk.includes(line)).length).toBe(1);
	});

	it("cuts one long line without leaving a tag open", () => {
		const chunks = renderAssistantText(`**${"bold text ".repeat(900)}**`);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
			expect(balanced(chunk)).toBe(true);
			expect(counted(chunk, "b")).toBe(true);
		}
	});

	it("keeps nested markup in order", () => {
		expect(renderAssistantText("**bold *and italic* more**")).toEqual(["<b>bold <i>and italic</i> more</b>"]);
		expect(renderAssistantText("***bold italic***")).toEqual(["<b><i>bold italic</i></b>"]);
		expect(renderAssistantText("~~was~~ and `code`")).toEqual(["<s>was</s> and <code>code</code>"]);
		expect(renderAssistantText("> quote\n> second")).toEqual(["<blockquote>quote\nsecond</blockquote>"]);
	});

	it("cuts long quotes, tables and nested markup without tearing tags", () => {
		const quote = renderAssistantText(`> ${"quote text ".repeat(400)}`);
		const table = renderAssistantText(
			[
				"| key | value |",
				"| --- | --- |",
				...Array.from({ length: 200 }, (_unused, index) => `| key ${index} | ${"z".repeat(30)} |`),
			].join("\n"),
		);
		const nested = renderAssistantText(`**${"*italic inside*".repeat(400)}**`);
		for (const chunks of [quote, table, nested]) {
			expect(chunks.length).toBeGreaterThanOrEqual(2);
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
				expect(balanced(chunk)).toBe(true);
			}
		}
		expect(quote.every(chunk => chunk.startsWith("<blockquote>") && chunk.endsWith("</blockquote>"))).toBe(true);
		expect(table.every(chunk => chunk.startsWith("<pre>") && chunk.endsWith("</pre>"))).toBe(true);
	});

	it("does not turn an empty answer into an empty message", () => {
		expect(renderAssistantText("   \n\n")).toEqual([]);
		expect(renderAssistantText(null)).toEqual([]);
	});

	it("renders details as a bold summary and an expandable quote, and never tears the attribute", () => {
		expect(renderAssistantText("<details><summary>Breakdown</summary>\nshort text\n</details>")).toEqual([
			"<b>Breakdown</b>\n<blockquote expandable>short text</blockquote>",
		]);
		const lines = Array.from({ length: 400 }, (_unused, index) => `line ${index} ${"z".repeat(30)}`);
		const chunks = renderAssistantText(`<details><summary>Breakdown</summary>\n${lines.join("\n")}\n</details>`);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
			expect(balanced(chunk)).toBe(true);
			expect(chunk.includes("</blockquote expandable>")).toBe(false);
			expect(chunk.trimEnd().endsWith("</blockquote>")).toBe(true);
		}
		for (const line of lines) expect(chunks.filter(chunk => chunk.includes(line)).length).toBe(1);
	});

	it("renders checklists, marks and spoilers", () => {
		expect(renderAssistantText("- [x] done\n- [ ] not done")).toEqual(["☑ done\n☐ not done"]);
		expect(renderAssistantText("- plain item")).toEqual(["• plain item"]);
		expect(renderAssistantText("==important== and ||hidden||")).toEqual([
			"important and <tg-spoiler>hidden</tg-spoiler>",
		]);
	});

	it("removes the backslash rich markdown uses to escape text", () => {
		expect(renderAssistantText("\\$HOME and \\*not italic\\*")).toEqual(["$HOME and *not italic*"]);
		expect(renderAssistantText("\\<b>not a tag\\</b>")).toEqual(["\\&lt;b&gt;not a tag\\&lt;/b&gt;"]);
		expect(renderAssistantText("&lt;b&gt;not a tag&lt;/b&gt;")).toEqual(["&lt;b&gt;not a tag&lt;/b&gt;"]);
	});

	it("renders code inside a details block as pre, not as raw fences", () => {
		const notice = [
			"⚠️ Process omp exited (code 1).",
			"",
			"<details><summary>stderr tail</summary>",
			"",
			"```",
			"at Object.<anonymous> (/tmp/a.js:1:1)",
			"echo $HOME || x == y",
			"```",
			"",
			"</details>",
		].join("\n");
		const [chunk] = renderAssistantText(notice);
		expect(chunk).toBe(
			"⚠️ Process omp exited (code 1).\n" +
				"<b>stderr tail</b>\n" +
				"<pre><code>at Object.&lt;anonymous&gt; (/tmp/a.js:1:1)\necho $HOME || x == y</code></pre>",
		);
		expect(chunk.includes("```")).toBe(false);
	});

	it("does not turn an escaped backtick into code", () => {
		const [chunk] = renderAssistantText(mdText("Fix `foo` and $HOME"));
		expect(chunk).toBe("Fix `foo` and $HOME");
		expect(chunk.includes("<code>")).toBe(false);
		expect(renderAssistantText("Fix \\`foo\\`")).toEqual(["Fix `foo`"]);
	});
});

describe("clip", () => {
	it("collapses whitespace and truncates with an ellipsis", () => {
		expect(clip("abcdef", 3)).toBe("ab…");
		expect(clip("  a\n b ", 10)).toBe("a b");
	});
});

describe("text limit", () => {
	it("matches the limit Telegram enforces on a message", () => {
		expect(TELEGRAM_TEXT_LIMIT).toBe(4096);
	});
});
