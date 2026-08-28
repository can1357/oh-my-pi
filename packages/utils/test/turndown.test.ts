import { describe, expect, it } from "bun:test";
import TurndownService, { gfm, type TurndownNode } from "@oh-my-pi/pi-utils/turndown";

type ListParent = {
	nodeName: string;
	getAttribute(name: string): string | null;
	children: ArrayLike<unknown>;
};

function createConfiguredTurndown(): TurndownService {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.use(gfm);
	turndown.addRule("strikethrough", {
		filter: ["del", "s", "strike"],
		replacement(content) {
			return `~~${content}~~`;
		},
	});
	turndown.addRule("heading", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const level = Number(node.nodeName.charAt(1));
			return `\n\n${"#".repeat(level)} ${content.replace(/\\([.])/g, "$1").trim()}\n\n`;
		},
	});
	turndown.addRule("listItem", {
		filter: "li",
		replacement(content, node, options) {
			const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
			const parent = node.parentNode as ListParent | null;
			let prefix = `${options.bulletListMarker} `;
			if (parent?.nodeName === "OL") {
				const start = parent.getAttribute("start");
				prefix = `${(start ? Number(start) : 1) + Array.prototype.indexOf.call(parent.children, node)}. `;
			}
			return prefix + body + (node.nextSibling ? "\n" : "");
		},
	});
	return turndown;
}

const GOLDENS = [
	{
		name: "complex aligned tables",
		html: '<table><thead><tr><th align="left">Name</th><th align="center">Value</th><th align="right">Notes</th></tr></thead><tbody><tr><td>A | B</td><td><strong>bold</strong></td><td>x\\y</td></tr><tr><td colspan="2">wide</td><td></td></tr></tbody></table>',
		markdown: "| Name | Value | Notes |\n| :-- | :-: | --: |\n| A | B | **bold** | x\\\\y |\n| wide |  |",
	},
	{
		name: "nested ordered and unordered lists",
		html: '<ol start="3"><li>first<ul><li>nested <em>item</em></li><li>second</li></ul></li><li>last</li></ol>',
		markdown: "3. first\n  - nested _item_\n  - second\n4. last",
	},
	{
		name: "fenced code and highlighted code",
		html: '<div class="highlight-source-js"><pre>const x = 1;</pre></div><pre><code class="language-ts">let y: number = 2;\n</code></pre>',
		markdown: "```js\nconst x = 1;\n```\n\n```ts\nlet y: number = 2;\n```",
	},
	{
		name: "nested blockquotes and hard breaks",
		html: "<blockquote><p>Hello<br>world</p><blockquote><p>deep</p></blockquote></blockquote>",
		markdown: "> Hello  \n> world\n> \n> > deep",
	},
	{
		name: "links and images",
		html: '<p><a href="https://example.com/a_(b)" title="A title">link</a> and <a href="https://same.test">https://same.test</a> <img src="pic.png" alt="A [pic]" title="T"></p>',
		markdown:
			'[link](https://example.com/a_\\(b\\) "A title") and [https://same.test](https://same.test) ![A \\[pic\\]](pic.png "T")',
	},
	{
		name: "strikethrough and task list items",
		html: '<p><del>gone</del> and <s>also</s></p><ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>',
		markdown: "~~gone~~ and ~~also~~\n\n- [x]  done\n- [ ]  todo",
	},
	{
		name: "mixed inline and unknown HTML",
		html: "<h2>1. Intro <span>inline <b>bold</b></span></h2><p>Hello&nbsp;  <mark>kept?</mark> <kbd>key</kbd> <u>under</u>.</p><hr><details><summary>More</summary><p>Body</p></details>",
		markdown: "## 1. Intro inline **bold**\n\nHello  kept? key under.\n\n* * *\n\nMore\n\nBody",
	},
] as const;

describe("TurndownService golden compatibility", () => {
	for (const fixture of GOLDENS) {
		it(fixture.name, () => {
			expect(createConfiguredTurndown().turndown(fixture.html)).toBe(fixture.markdown);
		});
	}

	it("supports rule, plugin, keep, remove, and escape extension points", () => {
		const service = new TurndownService({ emDelimiter: "*", fence: "~~~" });
		service.use(instance => {
			instance.addRule("mark", { filter: "mark", replacement: content => `==${content}==` });
		});
		service.keep("kbd").remove("script");
		expect(service.turndown("<p><em>x</em> <mark>y</mark> <kbd>z</kbd><script>bad</script></p>")).toBe(
			"*x* ==y== <kbd>z</kbd>",
		);
		expect(service.escape("1. [a] *b* \\ c")).toBe("1\\. \\[a\\] \\*b\\* \\\\ c");
	});

	it("honors formatting and blank-replacement options", () => {
		const service = new TurndownService({
			headingStyle: "atx",
			hr: "---",
			bulletListMarker: "+",
			codeBlockStyle: "fenced",
			fence: "~~~",
			emDelimiter: "*",
			strongDelimiter: "__",
			blankReplacement: (_content, node) => (node.nodeName === "SPAN" ? "{blank}" : ""),
		});
		const html =
			'<h3>Title</h3><hr><ul><li>one</li></ul><p><em>e</em> <strong>s</strong></p><pre><code class="language-js">x</code></pre><span></span>';
		expect(service.turndown(html)).toBe("### Title\n\n---\n\n+   one\n\n*e* __s__\n\n~~~js\nx\n~~~\n\n{blank}");
	});

	it("accepts a standards-shaped node", () => {
		const text: TurndownNode = {
			nodeType: 3,
			nodeName: "#text",
			parentNode: null,
			childNodes: [],
			children: [],
			firstChild: null,
			lastChild: null,
			nextSibling: null,
			previousSibling: null,
			textContent: "node input",
			getAttribute: () => null,
			hasAttribute: () => false,
		};
		expect(new TurndownService().turndown(text)).toBe("node input");
	});
});
