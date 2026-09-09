import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createRunner(getAsyncJobSnapshot?: () => AsyncJobSnapshot | null): ExtensionRunner {
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
});
