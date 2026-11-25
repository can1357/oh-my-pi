import { expect, test } from "bun:test";
import { escapeHtml } from "../../src/escape";

test("escapes HTML metacharacters exactly once", () => {
	expect(escapeHtml("a < b")).toBe("a &lt; b");
	expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
	expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
});
