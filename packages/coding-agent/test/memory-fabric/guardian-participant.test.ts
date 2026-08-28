import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/event-bus";
import { SessionEventBus } from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/event-bus";
import type { GuardianPendingInjection } from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/integration";
import {
	createGuardianSessionParticipant,
	formatContinuationCapsule,
	type GuardianInjectionSource,
	GuardianSessionParticipant,
	type GuardianSessionParticipantOptions,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/guardian-participant";
import type {
	AfterToolCallEvent,
	BeforeCompactionEvent,
	BeforeModelEvent,
	BeforeToolCallEvent,
	MemoryEventMetadata,
	MemorySessionScope,
	SessionResumeEvent,
	SessionStartEvent,
	SessionStopEvent,
	UserPromptEvent,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/types";

const SCOPE: MemorySessionScope = { projectId: "proj", sessionId: "sess", cwd: "/repo" };

const EVENT_TYPES: Array<SessionEvent["type"]> = [
	"session-start",
	"user-prompt",
	"before-model",
	"plan-commit",
	"tool-call",
	"tool-result",
	"compaction",
	"resume",
	"idle",
	"session-stop",
];

function metadata(overrides: Partial<MemoryEventMetadata> = {}): MemoryEventMetadata {
	return {
		origin: "main-agent",
		correlationId: "corr-1",
		depth: 0,
		sequence: 1,
		timestamp: 1_000,
		...overrides,
	};
}

function base(overrides: { scope?: MemorySessionScope; metadata?: Partial<MemoryEventMetadata> } = {}) {
	return {
		metadata: metadata(overrides.metadata),
		scope: overrides.scope ?? SCOPE,
		sequence: 1,
	};
}

function pending(overrides: Partial<GuardianPendingInjection> = {}): GuardianPendingInjection {
	return {
		interventionId: "iv-1",
		trigger: "user-prompt",
		action: "INJECT_CONTEXT",
		warning: false,
		context: { text: "recalled context", recordIds: ["m1", "m2"], tokenCount: 42 },
		...overrides,
	};
}

/** Records what was taken, so single-shot consumption can be asserted. */
class FakeInjections implements GuardianInjectionSource {
	staged: GuardianPendingInjection | null = null;
	takeCount = 0;
	idleCount = 0;

	async whenIdle(): Promise<void> {
		this.idleCount += 1;
	}

	takeInjection(): GuardianPendingInjection | null {
		this.takeCount += 1;
		const staged = this.staged;
		this.staged = null;
		return staged;
	}

	peekInjection(): GuardianPendingInjection | null {
		return this.staged;
	}
}

interface Harness {
	participant: GuardianSessionParticipant;
	bus: SessionEventBus;
	injections: FakeInjections;
	seen: SessionEvent[];
}

function setup(overrides: Partial<GuardianSessionParticipantOptions> = {}): Harness {
	const bus = new SessionEventBus();
	const injections = new FakeInjections();
	const seen: SessionEvent[] = [];

	for (const type of EVENT_TYPES) {
		bus.on(type, async (event: SessionEvent) => {
			seen.push(event);
		});
	}

	const participant = new GuardianSessionParticipant({
		bus,
		injections,
		now: () => 5_000,
		newId: () => "generated-id",
		...overrides,
	});

	return { participant, bus, injections, seen };
}

describe("GuardianSessionParticipant translation", () => {
	it("forwards session start with the scope's project and session", async () => {
		const { participant, seen } = setup();

		await participant.onSessionStart({ type: "session_start", resumed: false, ...base() } as SessionStartEvent);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "session-start", sessionId: "sess", projectId: "proj" });
	});

	it("omits worktree and branch when the scope does not carry them", async () => {
		const { participant, seen } = setup();

		await participant.onSessionStart({ type: "session_start", resumed: false, ...base() } as SessionStartEvent);

		expect(seen[0]).not.toHaveProperty("worktreeId");
		expect(seen[0]).not.toHaveProperty("branchId");
	});

	it("carries worktree and branch through when the scope has them", async () => {
		const { participant, seen } = setup();
		const scope: MemorySessionScope = { ...SCOPE, worktreeId: "wt-1", branchId: "main" };

		await participant.onSessionStart({
			type: "session_start",
			resumed: true,
			...base({ scope }),
		} as SessionStartEvent);

		expect(seen[0]).toMatchObject({ worktreeId: "wt-1", branchId: "main" });
	});

	it("extracts entities and intent from the prompt", async () => {
		const { participant, seen } = setup();

		await participant.onUserPrompt({
			type: "user_prompt",
			text: "please debug src/app.ts",
			...base(),
		} as UserPromptEvent);

		const event = seen[0];
		expect(event?.type).toBe("user-prompt");
		if (event?.type !== "user-prompt") throw new Error("expected a user-prompt event");
		expect(event.prompt).toBe("please debug src/app.ts");
		expect(event.promptId).toBe("corr-1");
		expect(event.intent).toBe("debugging");
		expect(event.entities.files).toContain("src/app.ts");
	});

	it("renames the tool payload from input to args", async () => {
		const { participant, seen } = setup();

		await participant.beforeToolCall({
			type: "before_tool_call",
			toolName: "read",
			input: { path: "a.ts" },
			...base({ metadata: { toolCallId: "tc-9" } }),
		} as BeforeToolCallEvent);

		expect(seen[0]).toMatchObject({
			type: "tool-call",
			toolName: "read",
			args: { path: "a.ts" },
			toolCallId: "tc-9",
		});
	});

	it("falls back to the correlation id when there is no tool call id", async () => {
		const { participant, seen } = setup();

		await participant.beforeToolCall({
			type: "before_tool_call",
			toolName: "read",
			input: {},
			...base(),
		} as BeforeToolCallEvent);

		expect(seen[0]).toMatchObject({ toolCallId: "corr-1" });
	});

	it("does not forward a tool result it cannot construct faithfully", async () => {
		const { participant, seen } = setup();

		await participant.afterToolCall({
			type: "after_tool_call",
			toolName: "read",
			input: {},
			output: "contents",
			success: true,
			durationMs: 3,
			...base(),
		} as AfterToolCallEvent);

		expect(seen).toHaveLength(0);
	});

	it("forwards a tool result when the describer supplies one", async () => {
		const { participant, seen } = setup({ describeToolResult: () => ({}) as ToolResultMessage });

		await participant.afterToolCall({
			type: "after_tool_call",
			toolName: "read",
			input: { path: "a.ts" },
			output: "contents",
			success: false,
			durationMs: 3,
			...base({ metadata: { toolCallId: "tc-2" } }),
		} as AfterToolCallEvent);

		expect(seen[0]).toMatchObject({ type: "tool-result", toolName: "read", isError: true, toolCallId: "tc-2" });
	});

	it("does not forward a turn it cannot construct faithfully", async () => {
		const { participant, seen } = setup();

		await participant.prepareContext({ type: "before_model", userText: "hi", ...base() } as BeforeModelEvent);

		expect(seen).toHaveLength(0);
		expect(participant.turnNumber).toBe(0);
	});

	it("forwards a turn and remembers its number when the describer supplies one", async () => {
		const { participant, seen } = setup({ describeTurn: () => ({ messages: [], turnNumber: 7 }) });

		await participant.prepareContext({ type: "before_model", userText: "hi", ...base() } as BeforeModelEvent);

		expect(seen[0]).toMatchObject({ type: "before-model", turnNumber: 7 });
		expect(participant.turnNumber).toBe(7);
	});

	it("maps compaction reasons onto the triggers the guardian distinguishes", async () => {
		const cases: Array<[string, string]> = [
			["token-limit", "token-limit"],
			["token-pressure", "token-limit"],
			["manual", "manual"],
			["checkpoint", "checkpoint"],
			["something-else", "manual"],
		];

		for (const [reason, trigger] of cases) {
			const { participant, seen } = setup();
			await participant.checkpoint({ type: "before_compaction", reason, ...base() } as BeforeCompactionEvent);
			expect(seen[0]).toMatchObject({ type: "compaction", trigger });
		}
	});

	it("defaults the resume parent to the session itself", async () => {
		const { participant, seen } = setup();

		await participant.onResume({ type: "session_resume", ...base() } as SessionResumeEvent);

		expect(seen[0]).toMatchObject({ type: "resume", parentSessionId: "sess" });
	});

	it("uses the configured parent session when resuming", async () => {
		const { participant, seen } = setup({ parentSessionId: "sess-0" });

		await participant.onResume({ type: "session_resume", ...base() } as SessionResumeEvent);

		expect(seen[0]).toMatchObject({ parentSessionId: "sess-0" });
	});

	it("passes through stop reasons the guardian understands", async () => {
		for (const reason of ["user-quit", "error", "completed", "timeout"]) {
			const { participant, seen } = setup();
			await participant.stop({ type: "session_stop", reason, ...base() } as SessionStopEvent);
			expect(seen[0]).toMatchObject({ type: "session-stop", reason });
		}
	});

	it("treats an unrecognised stop reason as completion", async () => {
		const { participant, seen } = setup();

		await participant.stop({ type: "session_stop", reason: "who-knows", ...base() } as SessionStopEvent);

		expect(seen[0]).toMatchObject({ reason: "completed" });
	});
});

describe("GuardianSessionParticipant collection", () => {
	it("yields no packet when the guardian staged nothing", async () => {
		const { participant, injections } = setup();

		const packet = await participant.prepareContext({
			type: "before_model",
			userText: "hi",
			...base(),
		} as BeforeModelEvent);

		expect(packet).toBeNull();
		expect(injections.idleCount).toBe(1);
	});

	it("turns staged context into a packet", async () => {
		const { participant, injections } = setup();
		injections.staged = pending();

		const packet = await participant.prepareContext({
			type: "before_model",
			userText: "hi",
			...base(),
		} as BeforeModelEvent);

		expect(packet).not.toBeNull();
		expect(packet?.id).toBe("generated-id");
		expect(packet?.text).toContain("recalled context");
		expect(packet?.memoryIds).toEqual(["m1", "m2"]);
		expect(packet?.tokenEstimate).toBe(42);
	});

	it("copies the record ids rather than aliasing the guardian's array", async () => {
		const { participant, injections } = setup();
		const staged = pending();
		injections.staged = staged;

		const packet = await participant.prepareContext({
			type: "before_model",
			userText: "hi",
			...base(),
		} as BeforeModelEvent);

		expect(packet?.memoryIds).not.toBe(staged.context.recordIds);
	});

	it("consumes staged context exactly once", async () => {
		const { participant, injections } = setup();
		injections.staged = pending();
		const event = { type: "before_model", userText: "hi", ...base() } as BeforeModelEvent;

		const first = await participant.prepareContext(event);
		const second = await participant.prepareContext(event);

		expect(first).not.toBeNull();
		expect(second).toBeNull();
	});

	it("marks a warning injection as such in the packet text", async () => {
		const { participant, injections } = setup();
		injections.staged = pending({ warning: true, action: "WARN_AGENT" });

		const packet = await participant.prepareContext({
			type: "before_model",
			userText: "hi",
			...base(),
		} as BeforeModelEvent);

		expect(packet?.text).toContain("conflict");
	});
});

describe("GuardianSessionParticipant advisories", () => {
	const call = { type: "before_tool_call", toolName: "write", input: {}, ...base() } as BeforeToolCallEvent;

	it("raises no advisory when nothing is staged", async () => {
		const { participant } = setup();

		expect(await participant.beforeToolCall(call)).toBeNull();
	});

	it("leaves context staged for the model alone", async () => {
		const { participant, injections } = setup();
		injections.staged = pending({ warning: false, trigger: "user-prompt" });

		const advisory = await participant.beforeToolCall(call);

		expect(advisory).toBeNull();
		expect(injections.takeCount).toBe(0);
		expect(injections.peekInjection()).not.toBeNull();
	});

	it("leaves a warning raised by something other than this call alone", async () => {
		const { participant, injections } = setup();
		injections.staged = pending({ warning: true, trigger: "user-prompt" });

		expect(await participant.beforeToolCall(call)).toBeNull();
		expect(injections.takeCount).toBe(0);
	});

	it("surfaces a warning raised by this tool call", async () => {
		const { participant, injections } = setup();
		injections.staged = pending({ warning: true, trigger: "tool-call", action: "WARN_AGENT" });

		const advisory = await participant.beforeToolCall(call);

		expect(advisory).not.toBeNull();
		expect(advisory?.severity).toBe("warning");
		expect(advisory?.memoryIds).toEqual(["m1", "m2"]);
		expect(injections.takeCount).toBe(1);
	});
});

describe("GuardianSessionParticipant checkpoints", () => {
	const compaction = { type: "before_compaction", reason: "manual", ...base() } as BeforeCompactionEvent;

	it("yields no capsule without a port to read working state from", async () => {
		const { participant } = setup();

		expect(await participant.checkpoint(compaction)).toBeNull();
	});

	it("yields no capsule when the session has no working state", async () => {
		const { participant } = setup({ port: { getWorkingState: async () => null } });

		expect(await participant.checkpoint(compaction)).toBeNull();
	});

	it("yields no capsule when the working state is empty", async () => {
		const { participant } = setup({ port: { getWorkingState: async () => ({}) } });

		expect(await participant.checkpoint(compaction)).toBeNull();
	});

	it("renders the objective and constraints into a capsule", async () => {
		const { participant } = setup({
			port: { getWorkingState: async () => ({ objective: "ship it", constraints: ["no new deps"] }) },
		});

		const capsule = await participant.checkpoint(compaction);

		expect(capsule?.id).toBe("generated-id");
		expect(capsule?.createdAt).toBe(5_000);
		expect(capsule?.text).toBe("Objective: ship it\n\nConstraints:\n- no new deps");
	});

	it("still emits the compaction event when no capsule can be produced", async () => {
		const { participant, seen } = setup();

		await participant.checkpoint(compaction);

		expect(seen[0]).toMatchObject({ type: "compaction" });
	});
});

describe("formatContinuationCapsule", () => {
	it("is empty when there is nothing to say", () => {
		expect(formatContinuationCapsule(undefined, undefined)).toBe("");
		expect(formatContinuationCapsule(undefined, [])).toBe("");
	});

	it("renders an objective alone", () => {
		expect(formatContinuationCapsule("ship it", [])).toBe("Objective: ship it");
	});

	it("renders constraints alone as a list", () => {
		expect(formatContinuationCapsule(undefined, ["a", "b"])).toBe("Constraints:\n- a\n- b");
	});
});

describe("createGuardianSessionParticipant", () => {
	it("builds a participant", () => {
		const participant = createGuardianSessionParticipant({
			bus: new SessionEventBus(),
			injections: new FakeInjections(),
		});

		expect(participant).toBeInstanceOf(GuardianSessionParticipant);
		expect(participant.participantName).toBe("guardian");
	});
});
