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
		undefined, // getMemory
		undefined, // settings
		undefined, // getActivePersonaName
		undefined, // localProtocolOptions
		getAsyncJobSnapshot,
	);
}

describe("ExtensionRunner async job context", () => {
	it("defaults to null outside a session", () => {
		expect(createRunner().createContext().getAsyncJobSnapshot()).toBeNull();
	});
});
