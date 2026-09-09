import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SubagentObservabilityController } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/subagent-observability";

function createRunner(
	getAsyncJobSnapshot?: () => AsyncJobSnapshot | null,
	subagents?: SubagentObservabilityController,
): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		getAsyncJobSnapshot,
		subagents,
	);
}

describe("ExtensionRunner async job context", () => {
	it("defaults to null outside a session", () => {
		expect(createRunner().createContext().getAsyncJobSnapshot()).toBeNull();
	});

	it("exposes the owning session snapshot", () => {
		const snapshot: AsyncJobSnapshot = {
			running: [{ id: "bg-1", type: "bash", status: "running", label: "sleep 30", startTime: 1 }],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		};
		expect(
			createRunner(() => snapshot)
				.createContext()
				.getAsyncJobSnapshot(),
		).toBe(snapshot);
	});

	it("exposes the root-scoped subagent capability", () => {
		const subagents: SubagentObservabilityController = {
			version: 1,
			getSnapshot: () => ({ version: 1, rootAgentId: "Root", revision: 0, capturedAt: 1, agents: [] }),
			subscribe: () => () => {},
			dispose: () => {},
		};
		expect(createRunner(undefined, subagents).createContext().subagents).toBe(subagents);
	});
});
