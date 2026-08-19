import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { type AssignmentResultV1, withAssignmentContractDigest } from "../../src/task/assignment-contract";
import { runSubprocess } from "../../src/task/executor";
import {
	nextRecoveryAttempt,
	type RecoveryAttempt,
	type RecoveryCapsule,
	type RecoveryPolicyInput,
} from "../../src/task/recovery-policy";
import { createSpawnPlan, type SpawnRouteCandidate } from "../../src/task/spawn-plan";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

type RecoveryExecutor = (attempt: RecoveryAttempt, capsule: RecoveryCapsule) => Promise<SingleResult>;

type RecoveryExecution =
	| {
			readonly action: "stop";
			readonly reasonCode: string;
			readonly suppressedProviders: readonly string[];
	  }
	| {
			readonly action: "retry";
			readonly attempt: RecoveryAttempt;
			readonly capsule: RecoveryCapsule;
			readonly suppressedProviders: readonly string[];
			readonly result: SingleResult;
	  };

function candidate(selector: string, tier: SpawnRouteCandidate["tier"], provider: string): SpawnRouteCandidate {
	return {
		selector,
		tier,
		provider,
		modelId: selector.split("/")[1],
		maxRequests: 8,
		maxRuntimeMs: 30_000,
	};
}

function recoveryInput(overrides: Partial<RecoveryPolicyInput> = {}): RecoveryPolicyInput {
	return {
		workClass: "mechanical",
		eligible: [
			candidate("cheap-a/smol", "light", "cheap-a"),
			candidate("cheap-b/smol", "light", "cheap-b"),
			candidate("reliable/mid", "mid", "reliable"),
			candidate("frontier/heavy", "frontier", "frontier"),
		],
		previousAttempts: [],
		suppressedProviders: [],
		outcome: {
			terminal: true,
			failedChildId: "failed-cheap-a",
			failure: {
				class: "spawn_transport",
				message: "TLS handshake failed",
				failedProvider: "cheap-a",
			},
		},
		requestFallbackRemaining: false,
		contract: {
			id: "assignment-1",
			revision: 1,
			digest: "digest-1",
		},
		verifiedArtifactRefs: ["artifact://evidence-1"],
		...overrides,
	};
}

function childResult(attempt: RecoveryAttempt, id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "recover assignment",
		assignment: "Complete the original assignment.",
		exitCode: 0,
		output: "recovery child completed",
		stderr: "",
		truncated: false,
		durationMs: 2,
		tokens: 0,
		requests: 1,
		recoveryAttempt: attempt.attempt,
		recoveryTier: attempt.tier,
		recoveryProvider: attempt.provider,
	};
}

async function executeRecovery(input: RecoveryPolicyInput, executor: RecoveryExecutor): Promise<RecoveryExecution> {
	const decision = nextRecoveryAttempt(input);
	if (decision.action === "stop") {
		return {
			action: "stop",
			reasonCode: decision.reasonCode,
			suppressedProviders: decision.suppressedProviders,
		};
	}

	const child = await executor(decision.attempt, decision.capsule);
	return {
		action: "retry",
		attempt: decision.attempt,
		capsule: decision.capsule,
		suppressedProviders: decision.suppressedProviders,
		result: {
			...child,
			recoveryAttempt: decision.attempt.attempt,
			recoveryTier: decision.attempt.tier,
			recoveryProvider: decision.attempt.provider,
			nextRecoveryAction: decision.action,
		},
	};
}

function yieldingSession(status: "success" | "failed", data?: AssignmentResultV1): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"], messages: [] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		setActiveTaskContract: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			emit({
				type: "tool_execution_end",
				toolCallId: `tool-${status}`,
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: status === "success" ? { status, data } : { status, error: "verification failed" },
				},
				isError: status === "failed",
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function createdSession(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

describe("task recovery integration", () => {
	afterEach(() => vi.restoreAllMocks());
	it("stops before fresh-child execution while existing request fallback remains", async () => {
		const executor = vi.fn(async (attempt: RecoveryAttempt) => childResult(attempt, "unexpected-child"));

		const execution = await executeRecovery(recoveryInput({ requestFallbackRemaining: true }), executor);

		expect(execution).toEqual({
			action: "stop",
			reasonCode: "request_fallback_remaining",
			suppressedProviders: ["cheap-a"],
		});
		expect(executor).not.toHaveBeenCalled();
	});

	it("suppresses a TLS-dead cheap provider, falls back, then escalates to mid", async () => {
		const executor = vi.fn(async (attempt: RecoveryAttempt, capsule: RecoveryCapsule) => {
			expect(attempt.freshChild).toBe(true);
			expect(capsule.historyRef).toMatch(/^history:\/\//);
			return childResult(attempt, `recovery-${attempt.attempt}`);
		});

		const fallback = await executeRecovery(recoveryInput(), executor);
		expect(fallback.action).toBe("retry");
		if (fallback.action !== "retry") throw new Error("Expected cheap fallback retry");
		expect(fallback.suppressedProviders).toEqual(["cheap-a"]);
		expect(fallback.attempt.selector).toBe("cheap-b/smol");
		expect(fallback.result).toMatchObject({
			recoveryAttempt: 1,
			recoveryTier: "light",
			recoveryProvider: "cheap-b",
			nextRecoveryAction: "retry",
		});

		const escalated = await executeRecovery(
			recoveryInput({
				previousAttempts: [fallback.attempt],
				suppressedProviders: fallback.suppressedProviders,
				outcome: {
					terminal: true,
					failedChildId: fallback.result.id,
					failure: {
						class: "acceptance",
						message: "Cheap fallback did not satisfy the verifier",
					},
				},
			}),
			executor,
		);
		expect(escalated.action).toBe("retry");
		if (escalated.action !== "retry") throw new Error("Expected mid-tier escalation");
		expect(escalated.attempt.selector).toBe("reliable/mid");
		expect(escalated.result).toMatchObject({
			recoveryAttempt: 2,
			recoveryTier: "mid",
			recoveryProvider: "reliable",
			nextRecoveryAction: "retry",
		});
		expect(executor).toHaveBeenCalledTimes(2);
	});

	it("runSubprocess replaces a failed child with the next candidate and verifies the fresh result", async () => {
		const contract = withAssignmentContractDigest({
			version: "assignment-contract/v1",
			id: "executor-recovery-contract",
			revision: 3,
			role: "task",
			workClass: "mechanical",
			autonomy: "bound",
			objective: "Return a digest-bound successful result.",
			deliverables: ["Verified result"],
			scope: { allowedPaths: [] },
			acceptance: [
				{
					id: "scope-clean",
					description: "No files changed outside the empty scope.",
					check: "changed_file_scope",
				},
			],
			reporting: "assignment-result/v1",
		});
		const successfulResult: AssignmentResultV1 = {
			version: "assignment-result/v1",
			contractId: contract.id,
			revision: contract.revision,
			digest: contract.digest,
			status: "success",
			changedFiles: [],
			evidence: [
				{
					criterionId: "scope-clean",
					passed: true,
					summary: "Authoritative changed-file set is empty.",
				},
			],
			summary: "Contract checks completed successfully.",
		};
		const planned = createSpawnPlan({
			correlationId: "executor-recovery-correlation",
			agentName: "task",
			assignment: "Exercise executor recovery.",
			eligible: [
				candidate("openai/gpt-4o", "light", "openai"),
				candidate("anthropic/claude-sonnet-4-5", "mid", "anthropic"),
			],
		});
		if (!planned.ok) throw new Error("Expected valid recovery spawn plan");
		const failedSession = yieldingSession("failed");
		const successfulSession = yieldingSession("success", successfulResult);
		const createSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createdSession(failedSession))
			.mockResolvedValueOnce(createdSession(successfulSession));
		const modelRegistry = {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [
				{ provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
				{
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					name: "Claude Sonnet 4.5",
					contextWindow: 200_000,
				},
			],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const agent: AgentDefinition = {
			name: "task",
			description: "Recovery integration agent",
			systemPrompt: "Execute the assignment contract.",
			source: "bundled",
		};
		const allocateRecoveryId = vi.fn(async (attempt: RecoveryAttempt) => {
			expect(attempt.selector).toBe("anthropic/claude-sonnet-4-5");
			return "executor-recovery-child";
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "Exercise executor recovery.",
			assignment: "Exercise executor recovery.",
			index: 0,
			id: "executor-initial-child",
			settings: Settings.isolated(),
			modelRegistry,
			enableLsp: false,
			modelOverride: ["openai/gpt-4o"],
			spawnPlan: planned.plan,
			assignmentContract: contract,
			actualChangedFiles: [],
			allocateRecoveryId,
		});

		expect(createSessionSpy).toHaveBeenCalledTimes(2);
		expect(createSessionSpy.mock.calls.map(call => call.at(0)?.model?.id)).toEqual(["gpt-4o", "claude-sonnet-4-5"]);
		expect(allocateRecoveryId).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			id: "executor-recovery-child",
			exitCode: 0,
			assignmentVerificationStatus: "verified",
			contractDigest: contract.digest,
			contractRevision: contract.revision,
			recoveryAttempt: 2,
			recoveryProvider: "anthropic",
			isError: false,
		});
	});
});
