import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAsyncJobAccess,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

function createRunner(asyncJobs?: ExtensionAsyncJobAccess): ExtensionRunner {
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
		asyncJobs,
	);
}

describe("ExtensionRunner async job context", () => {
	it("defaults to null and no-op cancel outside a session", () => {
		const ctx = createRunner().createContext();
		expect(ctx.getAsyncJobSnapshot()).toBeNull();
		expect(ctx.cancelAsyncJob("job-1")).toBe(false);
	});

	it("cancels through the owning session", () => {
		const cancelled: string[] = [];
		const ctx = createRunner({
			getSnapshot: () => null,
			cancel: id => {
				cancelled.push(id);
				return id === "job-1";
			},
		}).createContext();
		expect(ctx.cancelAsyncJob("job-1")).toBe(true);
		expect(ctx.cancelAsyncJob("job-2")).toBe(false);
		expect(cancelled).toEqual(["job-1", "job-2"]);
	});
});
