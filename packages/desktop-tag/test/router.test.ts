import { describe, expect, it, spyOn } from "bun:test";

import {
	assertContextPacket,
	CapabilityRegistry,
	createDefaultRegistry,
	routeContext,
	updateAvailability,
} from "../src/router";
import type { ContextPacket } from "../src/types";

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
	return {
		captureId: "capture-1",
		timestamp: new Date().toISOString(),
		captureMode: "screen",
		userRequest: "explain this",
		visual: { displayScale: 1, annotations: [] },
		foregroundApp: {},
		browser: {},
		selection: {},
		availableCapabilities: [],
		...overrides,
	};
}

describe("CapabilityRegistry", () => {
	it("registers and queries executors", () => {
		const registry = new CapabilityRegistry();
		registry.register({
			id: "test",
			name: "Test executor",
			location: "local",
			riskLevel: "low",
			available: true,
			capabilities: [{ name: "greet", approval: "none" }],
		});

		expect(registry.getExecutor("test")?.name).toBe("Test executor");
		expect(registry.listExecutors()).toHaveLength(1);
		expect(registry.findMatching("greet")?.id).toBe("test");
	});

	it("respects application filters", () => {
		const registry = new CapabilityRegistry();
		registry.register({
			id: "app-a",
			name: "App A executor",
			location: "local",
			riskLevel: "low",
			available: true,
			applications: ["a"],
			capabilities: [{ name: "save" }],
		});
		registry.register({
			id: "app-b",
			name: "App B executor",
			location: "local",
			riskLevel: "low",
			available: true,
			applications: ["b"],
			capabilities: [{ name: "save" }],
		});

		expect(registry.findMatching("save", "a")?.id).toBe("app-a");
		expect(registry.findMatching("save", "b")?.id).toBe("app-b");
	});
});

describe("routeContext", () => {
	it("routes general questions to answer-only", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "what does this error mean?" }));

		expect(decision.executorId).toBe("answer-only");
		expect(decision.tools).toContain("inspect_image");
		expect(decision.level).toBe(0);
	});

	it("routes code tasks to local-pi", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "fix this test" }));

		expect(decision.executorId).toBe("local-pi");
		expect(decision.tools).toContain("bash");
		expect(decision.tools).toContain("edit");
	});

	it("falls back rather than routing email to an unavailable executor", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "email this to the team" }));

		expect(registry.getExecutor("gmail-mcp")?.available).toBe(false);
		expect(decision.executorId).toBe("answer-only");
	});

	it("falls back rather than routing screen control to an unavailable executor", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "click the submit button" }));

		expect(registry.getExecutor("computer-use")?.available).toBe(false);
		expect(decision.executorId).toBe("answer-only");
	});

	it("uses browser URL/title to detect Salesforce", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(
			registry,
			makePacket({
				userRequest: "look at this",
				browser: { url: "https://myorg.lightning.force.com/", title: "Salesforce" },
			}),
		);

		expect(decision.executorId).toBe("ix-bridge");
		expect(decision.tools).toContain("ix_bridge");
	});

	it("throws clearly when no executors are available", () => {
		const registry = createDefaultRegistry();
		for (const executor of registry.listExecutors()) executor.available = false;

		expect(() => routeContext(registry, makePacket())).toThrow("No available executors are registered");
	});

	it("rejects malformed context packets", () => {
		const malformed = { ...makePacket(), captureMode: "desktop" };

		expect(() => assertContextPacket(malformed)).toThrow("Unsupported context capture mode");
	});

	it("rejects blank foreground window titles", () => {
		const malformed = { ...makePacket(), foregroundApp: { windowTitle: "   " } };

		expect(() => assertContextPacket(malformed)).toThrow("windowTitle must be a nonblank string");
	});
});

describe("updateAvailability", () => {
	it("requires an attached IX Bridge browser extension", async () => {
		const fetchSpy = spyOn(globalThis, "fetch");
		try {
			const registry = createDefaultRegistry();
			fetchSpy.mockResolvedValueOnce(Response.json({ running: true, extension_connected: false }));
			await updateAvailability(registry);
			expect(registry.getExecutor("ix-bridge")?.available).toBe(false);

			fetchSpy.mockResolvedValueOnce(Response.json({ running: true, extension_connected: true }));
			await updateAvailability(registry);
			expect(registry.getExecutor("ix-bridge")?.available).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
