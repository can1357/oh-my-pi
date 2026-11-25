import { expect, test } from "bun:test";
import { renderInline } from "../../src/inline";

test("renders emphasis, links, and code spans", () => {
	expect(renderInline("**a** and *b*")).toBe("<strong>a</strong> and <em>b</em>");
	expect(renderInline("[docs](https://example.com)")).toBe('<a href="https://example.com">docs</a>');
	expect(renderInline("run `make`")).toBe("run <code>make</code>");
});
