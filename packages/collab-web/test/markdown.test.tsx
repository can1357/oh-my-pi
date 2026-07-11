import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/transcript/Markdown";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}

describe("Transcript Markdown", () => {
	it("preserves assistant soft line breaks for tree-shaped prose", () => {
		const html = renderMarkdown("요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임");

		expect(html).toContain("요청 요지<br>");
		expect(html).toContain("있음<br>");
		expect(html).toContain("├── 현재 collab guest는");
		expect(html).toContain("└── 빠진 것은 guest → host 방향");
	});

	it("preserves soft line breaks inside tight list items", () => {
		const html = renderMarkdown("- Decision:\n  │   └── detail");

		expect(html).toContain("<li>Decision:<br>│   └── detail</li>");
	});

	it("continues escaping raw HTML", () => {
		const html = renderMarkdown("safe\n<img src=x onerror=alert(1)>");

		expect(html).toContain("safe<br>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
	});

	it("strips span and text HTML tags but preserves their contents and inline text rendering", () => {
		const html = renderMarkdown("<span></span><text>▃</text>");

		expect(html).toContain("▃");
		expect(html).not.toContain("&lt;span&gt;");
		expect(html).not.toContain("&lt;text&gt;");
	});

	it("unescapes HTML entities inside span and text HTML tags safely", () => {
		const html = renderMarkdown("<span>&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;</span>");

		expect(html).toContain("&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;");
	});
	it("strips advisory wrapper tags but renders their content", () => {
		const html = renderMarkdown('<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>');

		expect(html).toContain("Keep this advice.");
		expect(html).not.toContain("&lt;advisory");
		expect(html).not.toContain("&lt;/advisory&gt;");
	});

});
