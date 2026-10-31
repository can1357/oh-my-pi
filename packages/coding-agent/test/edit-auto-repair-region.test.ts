import { describe, expect, it } from "bun:test";
import { computeRepairRegion } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";

/** `count` functions, blank-line separated so each edited return line is its own hunk. */
function source(count: number, edit: (index: number) => string): string {
	return Array.from(
		{ length: count },
		(_, index) => `function f${index}() {\n\treturn compute(${index});\n}\n\nconst pad${index} = ${index};\n`,
	)
		.map((block, index) => block.replace(`return compute(${index});`, edit(index)))
		.join("\n");
}

describe("computeRepairRegion", () => {
	it.each([15, 16, 30])("isolates two broken hunks among %i edited hunks", hunks => {
		const prev = source(hunks, index => `return compute(${index});`);
		// Every hunk changes; hunks 4 and 11 each drop a closing paren.
		const next = source(hunks, index =>
			index === 4 || index === 11 ? `return computeNext(${index};` : `return computeNext(${index});`,
		);
		const region = computeRepairRegion({ path: "edited.ts", prev, next });
		expect(region).toBeDefined();
		expect(region!.brokenText).toContain("computeNext(4;");
		expect(region!.brokenText).toContain("computeNext(11;");
		expect(region!.referenceText).toContain("return compute(4);");
		expect(region!.referenceText).toContain("return compute(11);");
	});
});
