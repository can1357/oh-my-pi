import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoadExtensionsResult } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import type { AgentExecutionProfile } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/agent-execution-profile";
import {
	resolveCollaborationPolicy,
	serializeCollaborationPolicy,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/collaboration-policy";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { createPersistedSubagentReviverFactory } from "@pk-nerdsaver-ai/pi-coding-agent/task/persisted-revive";
import type { ToolCapability } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-profiles";
import { EventBus } from "@pk-nerdsaver-ai/pi-coding-agent/utils/event-bus";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";

const executionProfile: AgentExecutionProfile = Object.freeze({
	tier: "frontier",
	autonomy: "independent",
	collaboration: "report-only",
	workClass: "judgment",
	editMode: "hashline",
	maxRequests: 3,
	maxRuntimeMs: 45_000,
	modelPool: Object.freeze(["openrouter/*"]),
	modelPoolConstrained: true,
});

const toolMaximum: readonly ToolCapability[] = Object.freeze([
	Object.freeze({ source: "builtin", name: "read" }),
	Object.freeze({ source: "hidden", name: "yield" }),
]);

function mockRevivedSession(): AgentSession {
	return {
		sessionManager: { getArtifactManager: () => undefined },
		setActiveToolsByName: async () => {},
		setCollaborationPolicy: () => {},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

function topSession(cwd: string): AgentSession {
	return {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
	} as unknown as AgentSession;
}

async function writeSessionFile(dir: string, init: Record<string, unknown>): Promise<string> {
	const sessionFile = path.join(dir, "PersistedWorker.jsonl");
	await Bun.write(
		sessionFile,
		[
			JSON.stringify({ type: "session", id: "parent", timestamp: new Date().toISOString(), cwd: dir }),
			JSON.stringify({
				type: "session_init",
				id: "init",
				parentId: null,
				timestamp: new Date().toISOString(),
				systemPrompt: "system",
				task: "task",
				...init,
			}),
		].join("\n"),
	);
	return sessionFile;
}

function installCreateSessionSpy(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
}

describe("persisted execution profile revive", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("hydrates report-only collaboration and source-qualified tool ceiling before cold-revived visibility", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-profile-revive-"));
		try {
			const collaborationPolicy = resolveCollaborationPolicy({
				mode: "report-only",
				parentId: "Main",
			});
			const sessionFile = await writeSessionFile(dir, {
				tools: ["read", "bash", "yield"],
				executionProfile,
				collaborationPolicy: serializeCollaborationPolicy(collaborationPolicy),
				toolCeiling: toolMaximum,
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "PersistedWorker",
				displayName: "worker",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			const revivedSession = mockRevivedSession();
			const createSessionSpy = installCreateSessionSpy(revivedSession);
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});

			const reviver = await reviveFactory(ref);
			expect(createSessionSpy).not.toHaveBeenCalled();
			expect(registry.get("PersistedWorker")?.collaborationPolicy).toMatchObject({
				mode: "report-only",
				parentId: "Main",
				allowBusyModelReply: false,
			});

			await reviver?.();
			const options = createSessionSpy.mock.calls[0]?.[0];
			expect(options?.executionProfile).toEqual(executionProfile);
			expect(options?.collaborationPolicy).toMatchObject({ mode: "report-only", parentId: "Main" });
			expect(options?.toolProfile?.maximum).toEqual(toolMaximum);
			expect(options?.toolNames).toEqual(["read", "yield"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("restores legacy self-coordinate behavior for older sessions without profile fields", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-profile-legacy-"));
		try {
			const sessionFile = await writeSessionFile(dir, { tools: ["read", "bash", "yield"] });
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "LegacyWorker",
				displayName: "legacy worker",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			const createSessionSpy = installCreateSessionSpy(mockRevivedSession());
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});

			const reviver = await reviveFactory(ref);
			expect(registry.get("LegacyWorker")?.collaborationPolicy).toMatchObject({
				mode: "self-coordinate",
				peerScope: "all",
				allowBusyModelReply: true,
			});

			await reviver?.();
			const options = createSessionSpy.mock.calls[0]?.[0];
			expect(options?.executionProfile).toBeUndefined();
			expect(options?.toolProfile).toBeUndefined();
			expect(options?.collaborationPolicy).toMatchObject({ mode: "self-coordinate" });
			expect(options?.toolNames).toEqual(["read", "bash", "yield"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects extension/MCP same-name tools when only a builtin capability is persisted", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-profile-shadow-"));
		try {
			const collaborationPolicy = resolveCollaborationPolicy({
				mode: "report-only",
				parentId: "Main",
			});
			const sessionFile = await writeSessionFile(dir, {
				// `read` is a builtin name; an MCP-prefixed twin must not ride the builtin ceiling.
				tools: ["read", "mcp__shadow__read", "yield"],
				executionProfile,
				collaborationPolicy: serializeCollaborationPolicy(collaborationPolicy),
				toolCeiling: toolMaximum,
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "ShadowWorker",
				displayName: "shadow worker",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			const createSessionSpy = installCreateSessionSpy(mockRevivedSession());
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});

			await (await reviveFactory(ref))?.();
			const options = createSessionSpy.mock.calls[0]?.[0];
			expect(options?.toolNames).toEqual(["read", "yield"]);
			expect(options?.toolNames).not.toContain("mcp__shadow__read");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("admits bare-name extension overwrite when only extension capability is persisted", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-profile-ext-overwrite-"));
		try {
			const collaborationPolicy = resolveCollaborationPolicy({
				mode: "report-only",
				parentId: "Main",
			});
			const extensionCeiling: readonly ToolCapability[] = Object.freeze([
				Object.freeze({ source: "extension", name: "read" }),
				Object.freeze({ source: "hidden", name: "yield" }),
			]);
			const sessionFile = await writeSessionFile(dir, {
				// Bare builtin catalog name, but ceiling identity is extension:read only.
				tools: ["read", "bash", "yield"],
				executionProfile,
				collaborationPolicy: serializeCollaborationPolicy(collaborationPolicy),
				toolCeiling: extensionCeiling,
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "ExtOverwriteWorker",
				displayName: "ext overwrite",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			const createSessionSpy = installCreateSessionSpy(mockRevivedSession());
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});

			await (await reviveFactory(ref))?.();
			const options = createSessionSpy.mock.calls[0]?.[0];
			expect(options?.toolProfile?.maximum).toEqual(extensionCeiling);
			// Must not false-deny via catalog-first builtin inference.
			expect(options?.toolNames).toEqual(["read", "yield"]);
			expect(options?.toolNames).not.toContain("bash");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not invent a full-tier tool ceiling when only executionProfile is persisted", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-profile-exec-only-"));
		try {
			const sessionFile = await writeSessionFile(dir, {
				tools: ["read", "bash", "yield"],
				executionProfile,
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "ExecOnlyWorker",
				displayName: "exec only",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			const createSessionSpy = installCreateSessionSpy(mockRevivedSession());
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});

			await (await reviveFactory(ref))?.();
			const options = createSessionSpy.mock.calls[0]?.[0];
			expect(options?.executionProfile).toEqual(executionProfile);
			expect(options?.toolProfile).toBeUndefined();
			expect(options?.toolNames).toEqual(["read", "bash", "yield"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
