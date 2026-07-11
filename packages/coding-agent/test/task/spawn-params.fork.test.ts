import { describe, expect, test } from "bun:test";
import { taskItemSchema, taskSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";

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

	test("batch item schema preserves fork boolean (not silently stripped by '+'delete')", () => {
		// taskItemSchema has `"+": "delete"` — fork must be explicitly declared or it
		// disappears before spawnParamsFor ever sees it, silently falling back to a
		// fresh context instead of the requested fork.
		const parsed = taskItemSchema({ assignment: "check the retry policy", fork: true });
		expect(parsed).not.toBeInstanceOf(Error);
		expect((parsed as { fork?: boolean }).fork).toBe(true);
	});

	test("batch item schema rejects non-boolean fork", () => {
		const parsed = taskItemSchema({ assignment: "x", fork: "yes" });
		expect(String(parsed)).toContain("fork");
	});
});
