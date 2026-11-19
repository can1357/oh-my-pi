import { describe, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";

describe("prompt.format renderPhase", () => {
	test("pre-render preserves indentation on Handlebars block lines", () => {
		const input = "<root>\n  {{#if ok}}\n    value\n  {{/if}}\n</root>";

		const output = prompt.format(input, { renderPhase: "pre-render" });

		expect(output).toBe("<root>\n  {{#if ok}}\n    value\n  {{/if}}\n</root>");
	});

	test("pre-render preserves leading tabs", () => {
		const input = "\t<root>\n\t  {{#if ok}}\n\t    value\n\t  {{/if}}\n</root>";

		const output = prompt.format(input, { renderPhase: "pre-render" });

		expect(output).toBe(input);
	});

	test("pre-render trims trailing whitespace", () => {
		const input = "\t<root>   \n\t  {{#if ok}}\t\n\t    value   \n\t  {{/if}} \n</root>";

		const output = prompt.format(input, { renderPhase: "pre-render" });

		expect(output).toBe("\t<root>\n\t  {{#if ok}}\n\t    value\n\t  {{/if}}\n</root>");
	});

	test("post-render mode preserves indentation on Handlebars-like lines", () => {
		const input = "<root>\n  {{#if ok}}\n    value\n  {{/if}}\n</root>";

		const output = prompt.format(input, { renderPhase: "post-render" });

		expect(output).toBe("<root>\n  {{#if ok}}\n    value\n  {{/if}}\n</root>");
	});

	test("pre-render removes blank line before closing Handlebars block while post-render keeps it", () => {
		const input = "<root>\n{{#if ok}}\nvalue\n\n{{/if}}\n</root>";

		const preRender = prompt.format(input, { renderPhase: "pre-render" });
		const postRender = prompt.format(input, { renderPhase: "post-render" });

		expect(preRender).toBe("<root>\n{{#if ok}}\nvalue\n{{/if}}\n</root>");
		expect(postRender).toBe("<root>\n{{#if ok}}\nvalue\n\n{{/if}}\n</root>");
	});
	test("pre-render compacts table rows and does not duplicate content when replacing ascii", () => {
		const input =
			'|`cat <<\'EOF\' > file`|`write(path="file", content="...")`|\n|`sed -i \'s/old/new/\' file`|`edit(path="file", edits=[...])`|';
		const output = prompt.format(input, {
			renderPhase: "pre-render",
			replaceAsciiSymbols: true,
		});
		expect(output).toBe(
			'|`cat <<\'EOF\' > file`|`write(path="file", content="…")`|\n|`sed -i \'s/old/new/\' file`|`edit(path="file", edits=[…])`|',
		);
	});
	test("does not mutate HTML comment markers when replacing ascii symbols", () => {
		const input = "<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->";
		const output = prompt.format(input, {
			renderPhase: "pre-render",
			replaceAsciiSymbols: true,
		});
		expect(output).toBe(input);
	});
	test("replaces arrows outside but not inside HTML comments", () => {
		const input = "<!-- -> in comment -->\nvalue -> value";
		const output = prompt.format(input, {
			renderPhase: "pre-render",
			replaceAsciiSymbols: true,
		});
		expect(output).toBe("<!-- -> in comment -->\nvalue → value");
	});
	test("handles multi-line HTML comments", () => {
		const input = "<!--\nA -> B\n-->";
		const output = prompt.format(input, {
			renderPhase: "pre-render",
			replaceAsciiSymbols: true,
		});
		expect(output).toBe("<!--\nA -> B\n-->");
	});
});
