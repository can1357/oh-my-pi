/**
 * Contracts: an advisor-kind registry ref is observability-only — present for the
 * Agent Hub, hidden from every agent-facing surface, and never messageable.
 *
 * - `AgentRegistry.listVisibleTo` (irc roster / broadcast targets) excludes advisors.
 * - `IrcBus.send` to an advisor ref fails as non-messageable, without reviving it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("advisor registry visibility", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("excludes advisor refs from listVisibleTo", () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session: null, status: "idle" });
		registry.register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "idle",
		});

		const visible = registry.listVisibleTo("Main").map(ref => ref.id);
		expect(visible).toContain("Worker");
		expect(visible).not.toContain("Main/advisor");
	});

	it("refuses to message an advisor ref", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});
		const bus = new IrcBus(registry);

		const receipt = await bus.send({ from: "Main", to: "Main/advisor", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("advisor");
		// It must still be parked — a refused send never revives an advisor transcript.
		expect(registry.get("Main/advisor")?.status).toBe("parked");
	});
});
