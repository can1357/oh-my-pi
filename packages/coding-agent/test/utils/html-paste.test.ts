import { describe, expect, it } from "bun:test";
import { htmlToPaste } from "@oh-my-pi/pi-coding-agent/utils/html-paste";

const PNG = "iVBORw0KGgo=";

describe("htmlToPaste", () => {
	it("pastes a Tern composer copy back as its exact text with the image attached in place", () => {
		// What Tern writes for a draft holding `**bold** a_b`, a line break, and an image token.
		const html = `<div style="white-space: pre-wrap">**bold**  a_b &lt;x&gt;<br><img src="data:image/png;base64,${PNG}" alt="🖼 #1"> after</div>`;
		expect(htmlToPaste(html)).toEqual([
			"**bold**  a_b <x>\n",
			{ type: "image", mimeType: "image/png", data: PNG },
			" after",
		]);
	});

	it("pastes a code editor's copy as its code, indentation and blank lines kept", () => {
		const html =
			'<meta charset="utf-8"><div style="color: #d4d4d4;white-space: pre;"><div><span>fn main() {</span></div>' +
			"<div><span>    let a_b = 1;</span></div><div><br></div><div><span>}</span></div></div>";
		expect(htmlToPaste(html)).toEqual(["fn main() {\n    let a_b = 1;\n\n}"]);
	});

	it("pastes a lone code block as its code, not a fence", () => {
		expect(htmlToPaste("<pre><code>x = [1, 2]\n  y</code></pre>")).toEqual(["x = [1, 2]\n  y"]);
	});

	it("turns a web page's styling into Markdown without escaping its text", () => {
		const html =
			'<html><head><style>p { color: red }</style></head><body><h2>Setup</h2><p>Run <code>bun i</code> with <a href="https://x.dev/a">the docs</a> and *care*.</p>' +
			"<ul><li>one</li><li><strong>two</strong></li></ul><pre><code>ls -la</code></pre><p>end</p></body></html>";
		expect(htmlToPaste(html)).toEqual([
			"## Setup\n\nRun `bun i` with [the docs](https://x.dev/a) and *care*.\n\n- one\n- **two**\n\n```\nls -la\n```\n\nend",
		]);
	});

	it("drops Google Docs' normal-weight wrapper instead of bolding the whole paste", () => {
		const html =
			'<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span>Plain</span></p><p dir="ltr"><span>text</span></p></b>';
		expect(htmlToPaste(html)).toEqual(["Plain\n\ntext"]);
	});

	it("keeps images it cannot attach as their alt text, never as a data URL", () => {
		const html = '<p>see <img src="data:image/svg+xml;utf8,<svg/>" alt="diagram"> here</p>';
		expect(htmlToPaste(html)).toEqual(["see diagram here"]);
	});

	it("has nothing to paste for markup without text or images", () => {
		expect(htmlToPaste("<div> <br> </div>")).toBeUndefined();
	});
});
