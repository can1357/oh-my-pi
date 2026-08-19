import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import { getTaskSchema, taskItemSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { type } from "arktype";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields. The batch shape (`tasks[]` +
// shared `context`) is gated by the `task.batch` setting (default on, covered
// by test/task/task-batch.test.ts), and a per-call `schema` input no longer
// exists at all; follow-ups go through `irc` messaging.

describe("task schema (single-spawn)", () => {
	it("accepts {agent, assignment}", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("requires agent", () => {
		const parsed = taskSchema({ assignment: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("requires assignment", () => {
		const parsed = taskSchema({ agent: "explore" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("strips tasks/context/schema from the single-spawn schema", () => {
		const parsed = taskSchema({
			agent: "explore",
			assignment: "Map the auth module.",
			context: "shared background",
			tasks: [{ id: "A", assignment: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			// Unknown keys are stripped: batch/context exist only on the batch
			// schema and the per-call schema input was removed outright.
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task schema difficulty field", () => {
	it("accepts a valid difficulty value on the single-spawn schema", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "Map the auth module.", difficulty: "low" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.difficulty).toBe("low");
		}
	});

	it("accepts every difficulty value", () => {
		for (const difficulty of ["low", "medium", "high"] as const) {
			const parsed = taskSchema({ agent: "explore", assignment: "...", difficulty });
			expect(parsed instanceof type.errors).toBe(false);
		}
	});

	it("rejects an unsupported difficulty string", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "...", difficulty: "extreme" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("omits difficulty when not provided", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "..." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("difficulty" in parsed).toBe(false);
		}
	});
});

describe("task item schema (direct) — flat/no-batch item shape", () => {
	it("accepts a valid item with every field including difficulty", () => {
		const parsed = taskItemSchema({
			id: "A",
			description: "Map auth",
			assignment: "Map the auth module.",
			model: "anthropic/claude-haiku",
			difficulty: "medium",
			fork: false,
			cwd: "/tmp",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.difficulty).toBe("medium");
		}
	});

	it("accepts an item with no difficulty at all", () => {
		const parsed = taskItemSchema({ id: "A", assignment: "..." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("rejects an invalid difficulty value", () => {
		const parsed = taskItemSchema({ id: "A", assignment: "...", difficulty: "extreme" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("still requires assignment", () => {
		const parsed = taskItemSchema({ id: "A", difficulty: "low" });
		expect(parsed instanceof type.errors).toBe(true);
	});
});

describe("task item schema (direct) — batch/isolated item shape via getTaskSchema", () => {
	const batchSchema = getTaskSchema({ isolationEnabled: true, batchEnabled: true });

	it("accepts a batch tasks[] item with a valid difficulty and isolated/fork fields", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "Map the auth module.", difficulty: "high", isolated: true, fork: false }],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("tasks" in parsed).toBe(true);
			if ("tasks" in parsed) expect(parsed.tasks[0]?.difficulty).toBe("high");
		}
	});

	it("accepts every difficulty value on a batch tasks[] item", () => {
		for (const difficulty of ["low", "medium", "high"] as const) {
			const parsed = batchSchema({
				agent: "explore",
				context: "shared background",
				tasks: [{ id: "A", assignment: "...", difficulty }],
			});
			expect(parsed instanceof type.errors).toBe(false);
		}
	});

	it("rejects a batch tasks[] item with an invalid difficulty value", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "...", difficulty: "extreme" }],
		});
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("accepts a batch tasks[] item with no difficulty at all", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "..." }],
		});
		expect(parsed instanceof type.errors).toBe(false);
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("rejects a missing agent", async () => {
		const text = await executeText({ assignment: "..." });
		expect(text).toContain("Missing `agent`");
	});

	it("rejects a missing assignment", async () => {
		const text = await executeText({ agent: "explore" });
		expect(text).toContain("Missing `assignment`");
	});
});
