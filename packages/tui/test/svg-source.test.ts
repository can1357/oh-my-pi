import { describe, expect, it } from "bun:test";
import { closePartialSvg, hasSvgFence, prepareSvg, splitFigureFences } from "../src/chat/svg-source";

describe("SVG figure fences", () => {
	it("lifts top-level svg fences out of the prose around them", () => {
		const markdown = "Intro\n\n```svg\n<svg/>\n```\n\n~~~ SVG title\n<svg></svg>\n~~~\nOutro";
		expect(splitFigureFences(markdown, { svg: true, mermaid: false })).toEqual([
			{ kind: "markdown", text: "Intro\n\n" },
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "svg", source: "<svg></svg>\n", closed: true },
			{ kind: "markdown", text: "Outro" },
		]);
		expect(hasSvgFence(markdown)).toBe(true);
	});

	it("lifts CRLF svg fences without dropping the source line endings", () => {
		const markdown = "Intro\r\n```svg\r\n<svg/>\r\n```\r\nOutro";
		expect(hasSvgFence(markdown)).toBe(true);
		expect(splitFigureFences(markdown, { svg: true, mermaid: false })).toEqual([
			{ kind: "markdown", text: "Intro\r\n" },
			{ kind: "svg", source: "<svg/>\r\n", closed: true },
			{ kind: "markdown", text: "Outro" },
		]);
	});

	it("lifts CR-only svg fences as closed figures", () => {
		const markdown = "```svg\r<svg/>\r```";
		expect(splitFigureFences(markdown, { svg: true, mermaid: false })).toEqual([
			{ kind: "svg", source: "<svg/>\r", closed: true },
		]);
	});

	it("leaves svg fences nested in another fence or indented as code as prose", () => {
		const nested = "````markdown\n```svg\n<svg/>\n```\n````";
		const indented = "    ```svg\n    <svg/>\n    ```";
		expect(splitFigureFences(nested, { svg: true, mermaid: false })).toEqual([{ kind: "markdown", text: nested }]);
		expect(splitFigureFences(indented, { svg: true, mermaid: false })).toEqual([
			{ kind: "markdown", text: indented },
		]);
		expect(hasSvgFence(indented)).toBe(false);
		expect(hasSvgFence("```svgx\n```")).toBe(false);
	});

	it("keeps a fence that is still streaming open, and needs a long-enough closer", () => {
		expect(splitFigureFences("Look:\n````svg\n<svg>\n```\n<rect/>", { svg: true, mermaid: false })).toEqual([
			{ kind: "markdown", text: "Look:\n" },
			{ kind: "svg", source: "<svg>\n```\n<rect/>", closed: false },
		]);
		expect(splitFigureFences("```svg", { svg: true, mermaid: false })).toEqual([
			{ kind: "svg", source: "", closed: false },
		]);
	});
});

describe("splitFigureFences", () => {
	it("preserves mixed authored line endings across multiple top-level and nested Mermaid fences", () => {
		const prefix = "\n\tUnicode 🦀 prose\r\n\r\n";
		const first = "flowchart LR\r\n\tA[一] --> B[二]  \r\n";
		const nested = "- item\n\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n\n";
		const second = "sequenceDiagram\r\tA->>B: Grüße  \r";
		const tail = "\rLater 🦀\tstill streaming";
		const markdown =
			`${prefix}\`\`\`\` MERMAID title\r\n${first}\`\`\`\`\`\r\n${nested}` + `~~~mermaid\r${second}~~~~\r${tail}`;
		expect(splitFigureFences(markdown, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: prefix },
			{ kind: "mermaid", source: first, closed: true },
			{ kind: "markdown", text: nested },
			{ kind: "mermaid", source: second, closed: true },
			{ kind: "markdown", text: tail },
		]);
	});

	it("does not confuse a Mermaid fence inside HTML with an identical top-level fence", () => {
		const source = "flowchart LR\nA[Repeat] --> B[Done]\n";
		const fence = `\`\`\`mermaid\n${source}\`\`\`\n`;
		const prefix = `<div>\n${fence}</div>\n\n`;
		expect(splitFigureFences(`${prefix}${fence}`, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: prefix },
			{ kind: "mermaid", source, closed: true },
		]);
	});

	it("keeps a completed Mermaid figure while a later longer fence is still streaming", () => {
		const first = "flowchart LR\nA --> B\n";
		const between = "Between\t🦀\n\n";
		const second = "sequenceDiagram\nA->>B: Next\n```\n";
		const partial = `\`\`\`\`mermaid\n${second}`;
		const markdown = `~~~mermaid\n${first}~~~~\n${between}${partial}`;
		expect(splitFigureFences(markdown, { svg: false, mermaid: true })).toEqual([
			{ kind: "mermaid", source: first, closed: true },
			{ kind: "markdown", text: `${between}${partial}` },
		]);
		expect(splitFigureFences(`${markdown}\`\`\`\`\nAfter`, { svg: false, mermaid: true })).toEqual([
			{ kind: "mermaid", source: first, closed: true },
			{ kind: "markdown", text: between },
			{ kind: "mermaid", source: second, closed: true },
			{ kind: "markdown", text: "After" },
		]);
	});

	it("does not let a streaming tail retroactively swallow a completed Mermaid fence", () => {
		const source = "flowchart LR\nA --> B\n";
		const prefix = "$$\n";
		// The diagram's opener prefix has no math closer. Appending one later
		// must not change the already-completed figure's prefix-based verdict.
		const tail = "$$\n\nUnicode 🦀\tprose still streaming";
		const markdown = `${prefix}\`\`\`mermaid\n${source}\`\`\`\n${tail}`;
		expect(splitFigureFences(markdown, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: prefix },
			{ kind: "mermaid", source, closed: true },
			{ kind: "markdown", text: tail },
		]);
		const nextSource = "flowchart LR\nC --> D\n";
		expect(
			splitFigureFences(`${markdown}\n\n\`\`\`mermaid\n${nextSource}\`\`\`\n`, { svg: false, mermaid: true }),
		).toEqual([
			{ kind: "markdown", text: prefix },
			{ kind: "mermaid", source, closed: true },
			{ kind: "markdown", text: `${tail}\n\n` },
			{ kind: "mermaid", source: nextSource, closed: true },
		]);
	});

	it("keeps SVG streaming and surrounding prose unchanged when nested Mermaid fences are rejected", () => {
		const nested = "- item\n\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n\n";
		const markdown = `Before\n~~~svg\n<svg/>\n~~~\n${nested}~~~svg\n<svg>`;
		expect(splitFigureFences(markdown, { svg: true, mermaid: true })).toEqual([
			{ kind: "markdown", text: "Before\n" },
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "markdown", text: nested },
			{ kind: "svg", source: "<svg>", closed: false },
		]);
	});
});

describe("closePartialSvg", () => {
	it("returns null until the root start tag is complete", () => {
		expect(closePartialSvg("")).toBeNull();
		expect(closePartialSvg('<?xml version="1.0"?>\n<svg viewBox="0 0')).toBeNull();
		expect(closePartialSvg("<!-- <svg> -->")).toBeNull();
	});

	it("passes a complete document through unchanged", () => {
		const svg = '<svg viewBox="0 0 10 10"><g><rect width="1"/></g></svg>\n';
		expect(closePartialSvg(svg)).toBe(svg);
	});

	it("cuts the construct being written and closes open elements innermost first", () => {
		expect(closePartialSvg('<svg><g><text x="1">Hel')).toBe('<svg><g><text x="1">Hel</text></g></svg>');
		// A `>` inside a quoted attribute value does not end the tag.
		expect(closePartialSvg('<svg><g><path d="M0 0" data-x="a>b')).toBe("<svg><g></g></svg>");
		expect(closePartialSvg("<svg><g></g><!-- note")).toBe("<svg><g></g></svg>");
		expect(closePartialSvg("<svg><style><![CDATA[ rect { fill")).toBe("<svg><style></style></svg>");
		expect(closePartialSvg("<svg><text>a &amp; b &am")).toBe("<svg><text>a &amp; b </text></svg>");
		expect(closePartialSvg("<svg><g><rect/></")).toBe("<svg><g><rect/></g></svg>");
	});
});

describe("prepareSvg", () => {
	const palette = { fg: "#eeeeee", accent: "#ff8800" };

	it("resolves theme tokens, falling back to the given default and then to fg", () => {
		const svg = prepareSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" color="red" font-family="serif"><style>.a{fill:var(--accent)}</style>' +
				'<rect stroke="var( --accent , #000)" fill="var(--nope, rgb(1, 2, 3))"/><text fill="var(--missing)"/></svg>',
			palette,
		);
		expect(svg).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" color="red" font-family="serif"><style>.a{fill:#ff8800}</style>' +
				'<rect stroke="#ff8800" fill="rgb(1, 2, 3)"/><text fill="#eeeeee"/></svg>',
		);
	});

	it("gives a bare root the theme text color, a sans-serif font, and the namespaces the source needs", () => {
		expect(prepareSvg('<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>', palette)).toBe(
			'<svg color="#eeeeee" font-family="sans-serif" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>',
		);
	});
});
