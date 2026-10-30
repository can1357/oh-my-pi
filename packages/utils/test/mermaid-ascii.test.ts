import { describe, expect, it } from "bun:test";
import { renderMermaidAscii, renderMermaidAsciiSafe } from "../src/mermaid-ascii";

describe("renderMermaidAscii", () => {
	it("renders through the native binding with the requested options", () => {
		const rendered = renderMermaidAscii("graph LR\n  A --> B", { useAscii: true, colorMode: "none" });
		expect(rendered).toBe(
			["+---+     +---+", "|   |     |   |", "| A |---->| B |", "|   |     |   |", "+---+     +---+"].join("\n"),
		);
	});

	it("maps renderer errors to null in the safe variant", () => {
		expect(() => renderMermaidAscii("", { colorMode: "none" })).toThrow("Empty mermaid diagram");
		expect(renderMermaidAsciiSafe("", { colorMode: "none" })).toBeNull();
	});
});
