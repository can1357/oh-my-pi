import { describe, expect, it } from "bun:test";
import type { GuardianRetrievalPort } from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/integration";
import {
	activateMemoryFabric,
	createInertRetrievalPort,
	MEMORY_FABRIC_ENV_VAR,
	readMemoryFabricStage,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/activation";
import type { MemorySessionScope } from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/types";

const scope: MemorySessionScope = {
	projectId: "project-1",
	sessionId: "session-1",
	cwd: "/tmp/project",
};

function envWith(value: string): Record<string, string | undefined> {
	return { [MEMORY_FABRIC_ENV_VAR]: value };
}

describe("readMemoryFabricStage", () => {
	it("is off when the flag is absent", () => {
		expect(readMemoryFabricStage({})).toBe("off");
	});

	it("treats the falsey spellings as off", () => {
		for (const value of ["", "0", "off", "false", "no", "OFF", "  false  "]) {
			expect(readMemoryFabricStage(envWith(value))).toBe("off");
		}
	});

	it("treats the truthy spellings as observe", () => {
		for (const value of ["1", "on", "true", "yes", "observe", "OBSERVE", " on "]) {
			expect(readMemoryFabricStage(envWith(value))).toBe("observe");
		}
	});

	it("recognises active", () => {
		expect(readMemoryFabricStage(envWith("active"))).toBe("active");
		expect(readMemoryFabricStage(envWith(" Active "))).toBe("active");
	});

	it("treats an unrecognised value as off rather than guessing a rung", () => {
		expect(readMemoryFabricStage(envWith("obsrve"))).toBe("off");
		expect(readMemoryFabricStage(envWith("enabled"))).toBe("off");
	});
});

describe("createInertRetrievalPort", () => {
	it("answers every question emptily", async () => {
		const port = createInertRetrievalPort();
		const records = await port.retrieve({
			scope,
			text: "",
			intent: "unknown",
			files: [],
			symbols: [],
			errors: [],
			limit: 5,
		});
		expect(records).toEqual([]);
		expect(await port.getWorkingState("session-1")).toBeNull();
		expect(await port.composeContext([], 100)).toEqual({ text: "", recordIds: [], tokenCount: 0 });
	});
});

describe("activateMemoryFabric", () => {
	it("constructs nothing when the flag is absent", () => {
		expect(activateMemoryFabric({ scope, env: {} })).toBeNull();
	});

	it("constructs nothing when the flag is off", () => {
		expect(activateMemoryFabric({ scope, env: envWith("off") })).toBeNull();
		expect(activateMemoryFabric({ scope, stage: "off" })).toBeNull();
	});

	it("wires the guardian to its own bus when observing", () => {
		const runtime = activateMemoryFabric({ scope, stage: "observe" });
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		expect(runtime.stage).toBe("observe");
		expect(runtime.requestedStage).toBe("observe");
		expect(runtime.downgradeReason).toBeUndefined();
		expect(runtime.guardian.engine.getConfig().mode).toBe("observe");
		expect(runtime.guardianBus.listenerCount("user-prompt")).toBeGreaterThan(0);
		runtime.dispose();
	});

	it("reads the stage from the environment when none is supplied", () => {
		const runtime = activateMemoryFabric({ scope, env: envWith("true") });
		expect(runtime?.stage).toBe("observe");
		runtime?.dispose();
	});

	it("downgrades active to observe when no retrieval port is supplied", () => {
		const runtime = activateMemoryFabric({ scope, stage: "active" });
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		expect(runtime.requestedStage).toBe("active");
		expect(runtime.stage).toBe("observe");
		expect(runtime.downgradeReason).toContain("retrieval port");
		expect(runtime.guardian.engine.getConfig().mode).toBe("observe");
		runtime.dispose();
	});

	it("stays active when a retrieval port is supplied", () => {
		const port: GuardianRetrievalPort = createInertRetrievalPort();
		const runtime = activateMemoryFabric({ scope, stage: "active", port });
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		expect(runtime.stage).toBe("active");
		expect(runtime.downgradeReason).toBeUndefined();
		expect(runtime.guardian.engine.getConfig().mode).toBe("active");
		runtime.dispose();
	});

	it("lets the stage override guardian config that would contradict it", () => {
		const runtime = activateMemoryFabric({
			scope,
			stage: "observe",
			guardianConfig: { enabled: false, mode: "off", maxRetainedInterventions: 5 },
		});
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		const config = runtime.guardian.engine.getConfig();
		expect(config.enabled).toBe(true);
		expect(config.mode).toBe("observe");
		expect(config.maxRetainedInterventions).toBe(5);
		runtime.dispose();
	});

	it("carries a lifecycle call all the way to a guardian decision", async () => {
		const runtime = activateMemoryFabric({ scope, stage: "observe" });
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		await runtime.bridge.userPrompt("why does the parser drop trailing commas?");
		await Bun.sleep(1);

		const interventions = runtime.guardian.engine.getInterventions();
		expect(interventions.length).toBeGreaterThan(0);
		expect(interventions.some(intervention => intervention.trigger === "user-prompt")).toBe(true);
		runtime.dispose();
	});

	it("detaches every listener on dispose", () => {
		const runtime = activateMemoryFabric({ scope, stage: "observe" });
		expect(runtime).not.toBeNull();
		if (!runtime) return;

		expect(runtime.guardianBus.listenerCount("user-prompt")).toBeGreaterThan(0);
		runtime.dispose();
		expect(runtime.guardianBus.listenerCount("user-prompt")).toBe(0);
		runtime.dispose();
		expect(runtime.guardianBus.listenerCount("user-prompt")).toBe(0);
	});
});
