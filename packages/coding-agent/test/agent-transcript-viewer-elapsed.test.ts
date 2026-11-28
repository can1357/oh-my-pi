/**
 * The transcript viewer's stats row reads elapsed time from the agent's last
 * progress snapshot. The executor stops sending snapshots that would only
 * advance the clock, so a running agent's time must advance from the
 * snapshot's arrival, while a finished agent shows its final time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentTranscriptViewerModel } from "../src/ui/overlays/panels/agent-transcript-viewer-model";

const AGENT_ID = "Main/worker";

function viewerFor(status: string): AgentTranscriptViewerModel {
	const agents = new AgentRegistry();
	agents.register({ id: AGENT_ID, displayName: AGENT_ID, kind: "sub", parentId: "Main", session: null });
	const session = {
		status,
		progress: { durationMs: 2_000, toolCount: 1, cost: 0 },
		progressAt: 50_000,
	};
	return new AgentTranscriptViewerModel({
		transcript: agentTranscriptSource,
		agentId: AGENT_ID,
		registry: agents,
		observers: { getSession: id => (id === AGENT_ID ? session : undefined) },
		terminalRows: () => 40,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		onClose: () => {},
		onHubClose: () => {},
		settings,
	});
}

describe("transcript viewer elapsed time", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("advances a running agent's time from its last snapshot and holds a finished agent's", () => {
		const running = viewerFor("active");
		const finished = viewerFor("completed");
		try {
			vi.spyOn(Date, "now").mockReturnValue(53_000);
			expect(running.progress()?.durationMs).toBe(5_000);
			expect(finished.progress()?.durationMs).toBe(2_000);
		} finally {
			running.dispose();
			finished.dispose();
		}
	});
});
