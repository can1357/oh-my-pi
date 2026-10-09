import { describe, expect, it } from "bun:test";
import { closePartialSvg, hasSvgFence, prepareSvg, splitSvgFences } from "../src/chat/svg-source";

describe("splitSvgFences", () => {
	it("lifts top-level svg fences out of the prose around them", () => {
		const markdown = "Intro\n\n```svg\n<svg/>\n```\n\n~~~ SVG title\n<svg></svg>\n~~~\nOutro";
		expect(splitSvgFences(markdown)).toEqual([
			{ kind: "markdown", text: "Intro\n\n" },
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "svg", source: "<svg></svg>\n", closed: true },
			{ kind: "markdown", text: "Outro" },
		]);
		expect(hasSvgFence(markdown)).toBe(true);
	});

	it("leaves svg fences nested in another fence or indented as code as prose", () => {
		const nested = "````markdown\n```svg\n<svg/>\n```\n````";
		const indented = "    ```svg\n    <svg/>\n    ```";
		expect(splitSvgFences(nested)).toEqual([{ kind: "markdown", text: nested }]);
		expect(splitSvgFences(indented)).toEqual([{ kind: "markdown", text: indented }]);
		expect(hasSvgFence(indented)).toBe(false);
		expect(hasSvgFence("```svgx\n```")).toBe(false);
	});

	it("keeps a fence that is still streaming open, and needs a long-enough closer", () => {
		expect(splitSvgFences("Look:\n````svg\n<svg>\n```\n<rect/>")).toEqual([
			{ kind: "markdown", text: "Look:\n" },
			{ kind: "svg", source: "<svg>\n```\n<rect/>", closed: false },
		]);
		expect(splitSvgFences("```svg")).toEqual([{ kind: "svg", source: "", closed: false }]);
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
