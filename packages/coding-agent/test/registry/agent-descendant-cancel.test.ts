import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSessionStub(): AgentSession {
	return {
		dispose: async () => {},
		abort: async () => {},
		isStreaming: false,
	} as unknown as AgentSession;
}

function makeToolSession(
	registry: AgentRegistry,
	lifecycle: AgentLifecycleManager,
	manager: AsyncJobManager,
	ownerId: string,
): ToolSession {
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		agentRegistry: registry,
		agentLifecycle: () => lifecycle,
		asyncJobManager: manager,
		getAgentId: () => ownerId,
	} as unknown as ToolSession;
}

describe("agent descendant cancel and retirement", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	let manager: AsyncJobManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		manager = new AsyncJobManager({ onJobComplete: () => {} });
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("walks the parentId chain for descendant authorization", () => {
		registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: makeSessionStub(),
			status: "running",
		});
		registry.register({
			id: "TranscriptRoleAdoption",
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: makeSessionStub(),
			status: "idle",
		});
		registry.register({
			id: "TranscriptRoleAdoption.TranscriptTerraLead",
			displayName: "task",
			kind: "sub",
			parentId: "TranscriptRoleAdoption",
			session: makeSessionStub(),
			status: "idle",
		});

		expect(registry.isDescendantOf("TranscriptRoleAdoption.TranscriptTerraLead", "Main")).toBe(true);
		expect(registry.isDescendantOf("TranscriptRoleAdoption.TranscriptTerraLead", "TranscriptRoleAdoption")).toBe(
			true,
		);
		expect(registry.isDescendantOf("TranscriptRoleAdoption.TranscriptTerraLead", "EstateDeliverySol")).toBe(false);
		expect(registry.listDescendantSubIds("TranscriptRoleAdoption")).toEqual([
			"TranscriptRoleAdoption.TranscriptTerraLead",
		]);
	});

	it("allows an ancestor to cancel a nested descendant, not only the direct spawner", async () => {
		const roleParent = registry.register({
			id: "TranscriptRoleAdoption",
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: makeSessionStub(),
			status: "idle",
		});
		const grandchild = registry.register({
			id: "TranscriptRoleAdoption.TranscriptTerraLead",
			displayName: "task",
			kind: "sub",
			parentId: roleParent.id,
			session: makeSessionStub(),
			status: "idle",
		});
		lifecycle.adopt(roleParent.id, { idleTtlMs: 0 }, roleParent);
		lifecycle.adopt(grandchild.id, { idleTtlMs: 0 }, grandchild);

		const tool = new HubTool(makeToolSession(registry, lifecycle, manager, "Main"));
		const result = await tool.execute("call-1", { op: "cancel", ids: [grandchild.id] });

		expect(result.details?.cancelled?.[0]?.status).toBe("cancelled");
		expect(registry.get(grandchild.id)).toBeUndefined();
		expect(registry.get(roleParent.id)).toBe(roleParent);
	});

	it("retires the descendant subtree when a role parent is cancelled", async () => {
		const roleParent = registry.register({
			id: "TranscriptRoleAdoption",
			displayName: "task",
			kind: "sub",
			parentId: "EstateDeliverySol",
			session: makeSessionStub(),
			status: "idle",
		});
		const grandchild = registry.register({
			id: "TranscriptRoleAdoption.TranscriptTerraLead",
			displayName: "task",
			kind: "sub",
			parentId: roleParent.id,
			session: makeSessionStub(),
			status: "idle",
		});
		lifecycle.adopt(roleParent.id, { idleTtlMs: 0 }, roleParent);
		lifecycle.adopt(grandchild.id, { idleTtlMs: 0 }, grandchild);

		const tool = new HubTool(makeToolSession(registry, lifecycle, manager, "EstateDeliverySol"));
		const result = await tool.execute("call-2", { op: "cancel", ids: [roleParent.id] });

		expect(result.details?.cancelled?.[0]?.status).toBe("cancelled");
		expect(registry.get(roleParent.id)).toBeUndefined();
		expect(registry.get(grandchild.id)).toBeUndefined();
	});

	it("rejects cancel for agents outside the caller descendant tree", async () => {
		registry.register({
			id: "Alice",
			displayName: "task",
			kind: "sub",
			session: makeSessionStub(),
			status: "idle",
		});
		const bobChild = registry.register({
			id: "Bob.Child",
			displayName: "task",
			kind: "sub",
			parentId: "Bob",
			session: makeSessionStub(),
			status: "idle",
		});
		registry.register({
			id: "Bob",
			displayName: "task",
			kind: "sub",
			session: makeSessionStub(),
			status: "idle",
		});

		const tool = new HubTool(makeToolSession(registry, lifecycle, manager, "Alice"));
		const result = await tool.execute("call-3", { op: "cancel", ids: [bobChild.id] });

		expect(result.details?.cancelled?.[0]?.status).toBe("not_found");
		expect(registry.get(bobChild.id)).toBe(bobChild);
	});
});
