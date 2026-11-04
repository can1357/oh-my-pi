import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

afterEach(() => vi.restoreAllMocks());

it("updates async guidance when wait, messaging, or background execution availability changes", async () => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const settings = Settings.isolated({ "async.enabled": true });
	let waitActive = true;
	const tool = await TaskTool.create({
		cwd: "/tmp/task-async-description",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		isToolActive: (name: string) => name !== "wait" || waitActive,
	} as unknown as ToolSession);
	for (const ircEnabled of [true, false]) {
		cfgTaskMaxRecursionDepth.override(settings, ircEnabled ? -1 : 0);
		for (const waitTool of [true, false]) {
			waitActive = waitTool;
			const description = tool.description;
			expect(description).toContain("Results auto-deliver");
			expect(description.includes("Call `wait`")).toBe(waitTool);
			expect(description.includes("write agent://")).toBe(ircEnabled);
			expect(description).toContain("read proc://");
		}
	}
	cfgAsyncEnabled.override(settings, false);
	expect(tool.description).not.toContain("Results auto-deliver");
	expect(tool.description).not.toContain("read proc://");
});
