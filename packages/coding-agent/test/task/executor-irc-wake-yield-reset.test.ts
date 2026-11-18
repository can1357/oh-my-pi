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
	it("re-arms the data-less terminal yield guard at the start of an autonomous wake turn", async () => {
		// The same kept-alive session tool that runSubagentFollowUpTurn reuses is
		// also driven by autonomous IRC wake turns through this observer. A prior
		// run that submitted incremental sections leaves #hasIncrementalSections
		// set; without a per-wake reset a later data-less {type:"result"} would
		// finalize those stale sections instead of being rejected as empty.
		const yieldTool = new YieldTool(toolSession({ outputSchema: {} }));
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

		attachIrcWakeTurnMonitor(session, { id: "wake-1", agent: wakeAgent, outputSchema: {} });
		if (!observer) throw new Error("wake-turn observer was not registered");

		// A prior run's incremental section makes a data-less terminal yield valid.
		await yieldTool.execute("prior-section", { type: ["findings"], data: "one finding" } as never);
		const finalized = await yieldTool.execute("prior-final", { type: "result" } as never);
		expect(finalized.details).toMatchObject({ status: "success", type: "result" });

		// Starting the wake turn must clear the submitted-sections state.
		observer([{ role: "user", content: "wake up" }]);

		await expect(yieldTool.execute("wake-empty", { type: "result" } as never)).rejects.toThrow(/none were submitted/);
	});
});
