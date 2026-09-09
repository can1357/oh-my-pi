import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task.async-fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to sync execution when the session has no job manager", async () => {
		// Two-stage spy: the initial discovery during `TaskTool.create` advertises
		// `task` so the tool builds; the executor's later call (inside the sync
		// `#runSpawn`) advertises *nothing*, forcing the unique "Unknown agent"
		// message. That re-discovery only happens on the sync codepath — the
		// async path resolves agents from the create-time snapshot and returns a
		// job stub immediately — so hitting it proves the missing
		// `session.asyncJobManager` routed us through the sync fallback.
		const discoverSpy = vi.spyOn(discoveryModule, "discoverAgents");
		discoverSpy.mockResolvedValueOnce({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		discoverSpy.mockResolvedValue({ agents: [], projectAgentsDir: null });

		// Enable async so the missing `asyncJobManager` is the fallback trigger.
		const tool = await TaskTool.create(createSession({ "async.enabled": true }));

		const result = await tool.execute("tool-1", {
			agent: "task",
			name: "One",
			task: "Do the thing.",
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain('Unknown agent "task"');
		expect(text).toContain("Available: none");
		// create + sync-path re-discovery; the async path would have stopped at one.
		expect(discoverSpy).toHaveBeenCalledTimes(2);
	});
});
