import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	ensureFusionSidekick,
	type FusionSidekickHost,
	reconcileFusionSidekickModel,
} from "../../src/session/fusion-sidekick";
import * as taskDiscovery from "../../src/task/discovery";
import * as taskExecutor from "../../src/task/executor";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSettings(initial?: Record<string, unknown>): SettingsLike {
	const map = new Map<string, unknown>(Object.entries(initial ?? {}));
	return {
		get(key: string) {
			return map.get(key);
		},
	};
}

function makeModelRegistry(): ModelRegistryLike {
	return {
		getAvailable: () => [],
		hasConfiguredAuth: () => true,
		authStorage: {},
	};
}

function makeMockAgentSession(overrides?: Partial<AgentSessionLike>): AgentSessionLike {
	return {
		settings: makeSettings(),
		modelRegistry: makeModelRegistry(),
		sessionManager: makeMockSessionManager(),
		getFusionSidekickId: () => undefined,
		setFusionSidekickId: () => {},
		getPlanModeState: () => ({ enabled: true }),
		getPlanReferencePath: () => undefined,
		getAgentId: () => undefined,
		skills: [],
		promptTemplates: [],
		model: undefined,
		...overrides,
	};
}

function makeMockSessionManager(): SessionManagerLike {
	return {
		getCwd: () => "/test/cwd",
		ensureOnDisk: () => Promise.resolve(),
		getSessionFile: () => null,
		getArtifactsDir: () => undefined,
		getSessionId: () => "session-id",
		getArtifactManager: () => undefined,
	};
}

interface FusionSidekickHostLike {
	session: AgentSessionLike;
	settings: SettingsLike;
	sessionManager: SessionManagerLike;
	mcpManager?: FusionSidekickHost["mcpManager"];
	eventBus?: FusionSidekickHost["eventBus"];
}

function makeHost(overrides?: Partial<FusionSidekickHostLike>): FusionSidekickHost {
	return {
		session: makeMockAgentSession(),
		settings: makeSettings(),
		sessionManager: makeMockSessionManager(),
		...overrides,
	} as unknown as FusionSidekickHost;
}

// ---------------------------------------------------------------------------
// Spy references (restored after each test)
// ---------------------------------------------------------------------------

let agentRegistrySpy: ReturnType<typeof spyOn>;
let lifecycleSpy: ReturnType<typeof spyOn>;
let discoverAgentsSpy: ReturnType<typeof spyOn>;
let runSubprocessSpy: ReturnType<typeof spyOn>;

// ---------------------------------------------------------------------------
// Mocks & types
// ---------------------------------------------------------------------------

interface SettingsLike {
	get(key: string): unknown;
}

interface ModelRegistryLike {
	getAvailable(): Array<Model<Api>>;
	hasConfiguredAuth(model: Model<Api>): boolean;
	authStorage?: unknown;
}

interface AgentRefLike {
	id: string;
	session: unknown;
	status: string;
}

interface AgentSessionLike {
	settings: SettingsLike;
	modelRegistry: ModelRegistryLike;
	sessionManager: SessionManagerLike;
	getFusionSidekickId(): string | undefined;
	setFusionSidekickId(id: string | undefined): void;
	getPlanModeState?: () => unknown;
	getPlanReferencePath?: () => unknown;
	getAgentId?: () => string | undefined;
	skills?: unknown[];
	promptTemplates?: unknown[];
	isStreaming?: boolean;
	model?: Model<Api>;
	setModelTemporary?(model: Model<Api>, thinkingLevel?: unknown, options?: unknown): Promise<void>;
}

interface SessionManagerLike {
	getCwd(): string;
	ensureOnDisk(): Promise<void>;
	getSessionFile(): string | null;
	getArtifactsDir(): string | undefined;
	getSessionId(): string;
	getArtifactManager?(): unknown;
}

describe("fusion-sidekick", () => {
	beforeEach(() => {
		agentRegistrySpy = spyOn(AgentRegistry, "global");
		lifecycleSpy = spyOn(AgentLifecycleManager, "global");
		discoverAgentsSpy = spyOn(taskDiscovery, "discoverAgents");
		runSubprocessSpy = spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => undefined as never);
	});

	afterEach(() => {
		agentRegistrySpy.mockRestore();
		lifecycleSpy.mockRestore();
		discoverAgentsSpy.mockRestore();
		runSubprocessSpy.mockRestore();
	});

	// ---------------------------------------------------------------------------
	// ensureFusionSidekick
	// ---------------------------------------------------------------------------

	describe("ensureFusionSidekick", () => {
		it("no-ops when fusion.enabled is not true", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": false }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("force:true does not spawn when fusion is disabled", async () => {
			let recordedId: string | undefined = "stale-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": false }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(recordedId).toBeUndefined();
			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("no-ops when fusion.mode is 'off'", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "off" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("no-ops when a sidekick id is already recorded", async () => {
			const existingRef: AgentRefLike = { id: "existing-id", session: {}, status: "idle" };
			const registryMock = { get: (_id: string) => existingRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "existing-id",
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("clears a stale recorded id and respawns", async () => {
			const refs = new Map<string, AgentRefLike>();
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => ({ release: async () => {} }) as unknown as AgentLifecycleManager);
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined = "stale-missing-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).toHaveBeenCalled();
			expect(runSubprocessSpy).toHaveBeenCalled();
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("stale-missing-id");
		});

		it("force:true releases stale ref and respawns", async () => {
			const releaseMock = { release: async (_id: string) => {} };
			const releaseSpy = spyOn(releaseMock, "release");

			const refs = new Map<string, AgentRefLike>([["stale-id", { id: "stale-id", session: {}, status: "idle" }]]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (staleId: string) => {
					refs.delete(staleId);
				}),
			};

			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => lifecycleMock as unknown as AgentLifecycleManager);

			// discoverAgents returns a task agent so spawn proceeds
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "stale-id",
					setFusionSidekickId: () => {},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(releaseSpy).toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------------------
	// reconcileFusionSidekickModel
	// ---------------------------------------------------------------------------

	describe("reconcileFusionSidekickModel", () => {
		it("returns early when fusion is disabled", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": false }),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(result).toEqual({ note: "", sidekickLive: false });
		});

		it("retargets a live idle sidekick via setModelTemporary", async () => {
			const targetModel: Model<Api> = { provider: "test", id: "model-x", contextWindow: 128000 } as Model<Api>;

			const liveSession: AgentSessionLike = {
				settings: makeSettings(),
				modelRegistry: {
					getAvailable: () => [targetModel],
					hasConfiguredAuth: () => true,
				},
				sessionManager: makeMockSessionManager(),
				getFusionSidekickId: () => "live-id",
				setFusionSidekickId: () => {},
				model: { provider: "test", id: "old-model", contextWindow: 128000 } as Model<Api>,
				isStreaming: false,
				setModelTemporary: async () => {},
			};
			const setModelTemporarySpy = spyOn(liveSession, "setModelTemporary");

			const liveRef: AgentRefLike = {
				id: "live-id",
				session: liveSession as unknown as AgentSession,
				status: "idle",
			};
			const registryMock = { get: (_id: string) => liveRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "live-id",
					modelRegistry: {
						getAvailable: () => [targetModel],
						hasConfiguredAuth: () => true,
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "print",
					"fusion.sidekickModel": "test/model-x",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(setModelTemporarySpy).toHaveBeenCalled();
			expect(result.sidekickLive).toBe(true);
		});

		it("leaves mid-turn sidekick alone — setModelTemporary not called", async () => {
			const targetModel: Model<Api> = { provider: "test", id: "model-y", contextWindow: 128000 } as Model<Api>;

			const liveSession: AgentSessionLike = {
				settings: makeSettings(),
				modelRegistry: {
					getAvailable: () => [targetModel],
					hasConfiguredAuth: () => true,
				},
				sessionManager: makeMockSessionManager(),
				getFusionSidekickId: () => "streaming-id",
				setFusionSidekickId: () => {},
				model: { provider: "test", id: "old-model", contextWindow: 128000 } as Model<Api>,
				isStreaming: true,
				setModelTemporary: async () => {},
			};
			const setModelTemporarySpy = spyOn(liveSession, "setModelTemporary");

			const liveRef: AgentRefLike = {
				id: "streaming-id",
				session: liveSession as unknown as AgentSession,
				status: "idle",
			};
			const registryMock = { get: (_id: string) => liveRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "streaming-id",
					modelRegistry: {
						getAvailable: () => [targetModel],
						hasConfiguredAuth: () => true,
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "print",
					"fusion.sidekickModel": "test/model-y",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(setModelTemporarySpy).not.toHaveBeenCalled();
			expect(result.note).toContain("mid-turn");
			expect(result.sidekickLive).toBe(true);
		});

		it("releases parked sidekick and calls ensureFusionSidekick to respawn", async () => {
			const releaseMock = { release: async (_id: string) => {} };
			const releaseSpy = spyOn(releaseMock, "release");

			const refs = new Map<string, AgentRefLike>([
				["parked-id", { id: "parked-id", session: null, status: "parked" }],
			]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (parkedId: string) => {
					refs.delete(parkedId);
				}),
			};

			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => lifecycleMock as unknown as AgentLifecycleManager);

			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined = "parked-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "print",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(releaseSpy).toHaveBeenCalledWith("parked-id");
			expect(result.note).not.toBe("");
			expect(result.sidekickLive).toBe(true);
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("parked-id");
		});
	});
});
