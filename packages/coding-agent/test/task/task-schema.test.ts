import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = taskSchema({ agent: "scout", task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("retains caller outputSchema and schemaMode while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			outputSchema,
			schemaMode: "strict",
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
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
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }),
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

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});
});
