import { describe, expect, test } from "bun:test";
import { taskSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";

describe("task fork param (U11)", () => {
	test("flat schema accepts fork boolean", () => {
		const parsed = taskSchema({
			agent: "task",
			assignment: "look up the current retry policy in this conversation",
			fork: true,
		});
		expect(parsed).not.toBeInstanceOf(Error);
		expect((parsed as { fork?: boolean }).fork).toBe(true);
	});

	test("flat schema rejects non-boolean fork", () => {
		const parsed = taskSchema({ agent: "task", assignment: "x", fork: "yes" });
		expect(String(parsed)).toContain("fork");
	});
});
