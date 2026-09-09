import { describe, expect, it } from "bun:test";
import { expandCommand, type WorkflowCommand } from "@oh-my-pi/pi-coding-agent/task/commands";

function makeCommand(instructions: string): WorkflowCommand {
	return { name: "test", description: "test", instructions, source: "project", filePath: "test.md" };
}

describe("expandCommand", () => {
	it("substitutes $@ with the input", () => {
		expect(expandCommand(makeCommand("Do: $@ and again $@"), "fix the bug")).toBe(
			"Do: fix the bug and again fix the bug",
		);
	});

	it("keeps $-patterns in user input literal", () => {
		expect(expandCommand(makeCommand("Run $@"), "echo $$ $& $' $` $@")).toBe("Run echo $$ $& $' $` $@");
	});
});
