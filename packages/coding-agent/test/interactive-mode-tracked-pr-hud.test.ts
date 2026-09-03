import { expect, test } from "bun:test";
import { composePersistentHudColumns } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

test("renders tracked pull requests as a right-side footer panel", () => {
	const lines = composePersistentHudColumns(
		80,
		["", "TODO", " ├─ Implement tracker", " └────"],
		["", "PULL REQUESTS", " #10637 conflict"],
	);

	expect(lines[1]).toEndWith("PULL REQUESTS");
	expect(lines[1]).toContain("TODO");
	expect(lines[2]).toContain("Implement tracker");
	expect(lines[2]).toEndWith("#10637 conflict");
	expect(lines[3]).toBe(" └────");
});
