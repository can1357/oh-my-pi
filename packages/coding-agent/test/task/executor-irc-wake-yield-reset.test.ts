import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

const wakeAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("IRC wake turn yield reset", () => {
	it("re-arms the empty-last-turn guard at the start of an autonomous wake turn", async () => {
		// The same kept-alive session tool that runSubagentFollowUpTurn reuses is
		// also driven by autonomous IRC wake turns through this observer. A prior
		// run that emitted an incremental section leaves #hasIncrementalSections
		// set; without a per-wake reset a later thinking-only {type:"result"}
		// would skip the guard and finalize with the null-yield warning.
		const yieldTool = new YieldTool(toolSession({ getLastAssistantText: () => undefined }));
		let observer: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const session = {
			...createSessionDefaults(),
			getToolByName: (name: string) => (name === "yield" ? yieldTool : undefined),
			subscribe: () => () => {},
			setIrcWakeTurnObserver: (obs: typeof observer) => {
				observer = obs;
			},
			trackIrcReply: () => {},
		} as unknown as AgentSession;

		attachIrcWakeTurnMonitor(session, { id: "wake-1", agent: wakeAgent });
		if (!observer) throw new Error("wake-turn observer was not registered");

		// A prior run's incremental section sets the flag on the reused tool.
		await yieldTool.execute("prior-section", { type: ["findings"], data: "one finding" } as never);

		// Starting the wake turn must clear it.
		observer([{ role: "user", content: "wake up" }]);

		await expect(yieldTool.execute("wake-empty", { type: "result" } as never)).rejects.toThrow(
			/no text \(thinking only\)/,
		);
	});
});
