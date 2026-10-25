import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

afterEach(() => vi.restoreAllMocks());

it("updates async guidance when the capability wait, messaging, or background execution availability changes", async () => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const settings = Settings.isolated({ "async.enabled": true });
	// The capability wait (MCP) replaced the built-in `wait`; guidance names it
	// only while the capability server has mounted it in the tool registry.
	const toolRegistry = new Map<string, unknown>();
	const tool = await TaskTool.create({
		cwd: "/tmp/task-async-description",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		toolRegistry,
	} as unknown as ToolSession);
	for (const ircEnabled of [true, false]) {
		cfgTaskMaxRecursionDepth.override(settings, ircEnabled ? -1 : 0);
		for (const waitTool of [true, false]) {
			if (waitTool) toolRegistry.set("mcp__capability_agentmux_capability_wait", {});
			else toolRegistry.delete("mcp__capability_agentmux_capability_wait");
			const description = tool.description;
			expect(description).toContain("Results auto-deliver");
			expect(description.includes("mcp__capability_agentmux_capability_wait")).toBe(waitTool);
			expect(description.includes("write agent://")).toBe(ircEnabled);
			expect(description).toContain("read proc://");
		}
	}
	cfgAsyncEnabled.override(settings, false);
	expect(tool.description).not.toContain("Results auto-deliver");
	expect(tool.description).not.toContain("read proc://");
});
