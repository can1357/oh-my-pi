/**
 * Verifies parent-discovered rules, extensions, and custom tools are forwarded
 * to `createAgentSession` so subagents skip the FS scans the parent already
 * paid for. Regression guard for issue #2190.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Rule } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import * as sdkModule from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type {
	AgentSession,
	AgentSessionEvent,
	PromptOptions,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { runSubprocess } from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import { EventBus } from "@pk-nerdsaver-ai/pi-coding-agent/utils/event-bus";

function createMockSession(
	onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void,
	onSessionInit: (init: { maxModelRequestsPerRun?: number; fusionSidekick?: boolean }) => void = () => {},
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: onSessionInit },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(
	onSessionInit?: (init: { maxModelRequestsPerRun?: number; fusionSidekick?: boolean }) => void,
): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-pass-through",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
	}, onSessionInit);
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards rules, preloadedExtensionPaths, and preloadedCustomToolPaths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.ompk/extensions/foo.ts"];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];

		const result = await runSubprocess({
			...baseOptions,
			rules,
			preloadedExtensionPaths,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedCustomToolPaths).toBe(preloadedCustomToolPaths);
	});

	it("forwards the parent client bridge to child session creation", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const clientBridge: ClientBridge = {
			capabilities: { requestPermission: true, toolApprovalMode: "always-ask" },
			requestPermission: async () => ({ outcome: "cancelled" }),
		};

		const result = await runSubprocess({ ...baseOptions, clientBridge });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.clientBridge).toBe(clientBridge);
	});

	it("forwards undefined when the parent has not pre-discovered state", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.rules).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toBeUndefined();
		expect(forwarded?.preloadedCustomToolPaths).toBeUndefined();
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The registry parent is the spawning agent — never the child itself (the
		// self-parent bug). The child's own id still drives both its agent id and
		// its artifact/output-id prefix; those must not double as the parent link.
		expect(forwarded?.parentAgentId).toBe("SpawnerAgent");
		expect(forwarded?.agentId).toBe("ChildAgent");
		expect(forwarded?.parentTaskPrefix).toBe("ChildAgent");
	});

	it("applies fusion.sidekickRequestBudget only to the explicit Fusion sidekick spawn", async () => {
		const settings = Settings.isolated();
		settings.set("fusion.enabled", true);
		settings.set("fusion.mode", "escalate");
		settings.set("fusion.sidekickRequestBudget", 3);
		const normalInits: Array<{ maxModelRequestsPerRun?: number; fusionSidekick?: boolean }> = [];
		const sidekickInits: Array<{ maxModelRequestsPerRun?: number; fusionSidekick?: boolean }> = [];
		const normalSession = yieldEmittingSession(init => normalInits.push(init));
		const sidekickSession = yieldEmittingSession(init => sidekickInits.push(init));
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(normalSession))
			.mockResolvedValueOnce(createSessionResult(sidekickSession));

		const normal = await runSubprocess({ ...baseOptions, settings, id: "Sidekick" });
		const sidekick = await runSubprocess({ ...baseOptions, settings, id: "Sidekick", fusionSidekick: true });

		expect(normal.exitCode).toBe(0);
		expect(sidekick.exitCode).toBe(0);
		const normalOptions = spy.mock.calls[0]?.[0];
		const sidekickOptions = spy.mock.calls[1]?.[0];
		expect(normalOptions).toBeDefined();
		expect(sidekickOptions).toBeDefined();
		expect(normalOptions?.maxModelRequestsPerRun).toBeUndefined();
		expect(sidekickOptions?.maxModelRequestsPerRun).toBe(3);
		expect(normalInits[0]?.fusionSidekick).toBeUndefined();
		expect(normalInits[0]?.maxModelRequestsPerRun).toBeUndefined();
		expect(sidekickInits[0]?.fusionSidekick).toBe(true);
		expect(sidekickInits[0]?.maxModelRequestsPerRun).toBe(3);
	});
});
