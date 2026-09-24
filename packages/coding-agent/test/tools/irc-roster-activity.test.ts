import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("IRC roster activity", () => {
	let registry: AgentRegistry;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		mock.restore();
	});

	it("setActivity refreshes lastActivity so a working agent is not shown as stale", () => {
		// Recency must refresh on activity, including repeated identical heartbeats.
		const now = spyOn(Date, "now");
		now.mockReturnValue(1_000);
		registry.register({ id: "Worker", displayName: "task", kind: "sub", session: null, status: "running" });
		now.mockReturnValue(60_000);
		registry.setActivity("Worker", "running bash");
		expect(registry.get("Worker")?.lastActivity).toBe(60_000);
		// A repeated identical gist is still a heartbeat: recency must refresh even
		// though the activity text did not change.
		now.mockReturnValue(90_000);
		registry.setActivity("Worker", "running bash");
		expect(registry.get("Worker")?.lastActivity).toBe(90_000);
	});

	it("clears activity when a peer leaves running so finished work is not shown as current", () => {
		registry.register({ id: "Done", displayName: "task", kind: "sub", session: null, status: "running" });
		registry.setActivity("Done", "running bash");
		expect(registry.get("Done")?.activity).toBe("running bash");
		registry.setStatus("Done", "idle");
		expect(registry.get("Done")?.activity).toBeUndefined();
	});

	it("ignores activity heartbeats for an agent that is no longer running", () => {
		registry.register({ id: "Stopped", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.setActivity("Stopped", "running bash");
		expect(registry.get("Stopped")?.activity).toBeUndefined();
	});

	it("normalizes a multi-line activity gist to one bounded line", () => {
		// A model-authored intent with newlines/tabs must remain one bounded line.
		registry.register({ id: "Noisy", displayName: "task", kind: "sub", session: null, status: "running" });
		registry.setActivity("Noisy", "editing\n- fake roster line\twith tabs");
		expect(registry.get("Noisy")?.activity).toBe("editing - fake roster line with tabs");
	});

	it("setActivity is a no-op for an unknown agent id (registers no phantom ref)", () => {
		const before = registry.list().length;
		registry.setActivity("Ghost", "noop");
		expect(registry.get("Ghost")).toBeUndefined();
		expect(registry.list().length).toBe(before);
	});
});
