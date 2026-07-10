import { describe, expect, it } from "bun:test";
import type { OperationalStore } from "../../src/operational/store";
import { OperationalTrajectoryRecorder } from "../../src/operational/trajectory-recorder";
import type { AppendEventInput, JsonValue, TrajectoryEvent } from "../../src/operational/types";
import type { AgentSessionEvent } from "../../src/session/agent-session";

class TestClock {
	#now: number;
	constructor(start: number) {
		this.#now = start;
	}
	now = (): number => this.#now;
	advance(ms: number): void {
		this.#now += ms;
	}
}

class FakeStore {
	readonly events: TrajectoryEvent[] = [];
	failNext = false;
	appendEvent = (input: AppendEventInput): TrajectoryEvent => {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("store append failed");
		}
		const event: TrajectoryEvent = {
			id: `evt-${this.events.length + 1}`,
			kind: input.kind,
			jobId: input.jobId ?? null,
			sessionId: input.sessionId ?? null,
			payload: (input.payload ?? null) as JsonValue,
			createdAt: 1,
		};
		this.events.push(event);
		return event;
	};
}

class FakeSession {
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
	listenerCount(): number {
		return this.#listeners.size;
	}
}

function asStore(fake: FakeStore): OperationalStore {
	return fake as unknown as OperationalStore;
}

function payloadsByKind(store: FakeStore, kind: TrajectoryEvent["kind"]): JsonValue[] {
	return store.events.filter(event => event.kind === kind).map(event => event.payload);
}

function jsonIncludesForbidden(value: JsonValue, needles: string[]): boolean {
	const text = JSON.stringify(value);
	return needles.some(needle => text.includes(needle));
}

describe("OperationalTrajectoryRecorder", () => {
	it("records explicit model/skill/outcome signals without secret metadata values", () => {
		const store = new FakeStore();
		const recorder = new OperationalTrajectoryRecorder({
			store: asStore(store),
			sessionId: "sess-1",
			jobId: "job-1",
		});

		recorder.recordModelDecision({
			decision: "route",
			provider: "openai",
			model: "gpt-test",
			metadata: { api_key: "sk-secret", note: "ok" },
		});
		recorder.recordSkillCandidate({ skillName: "search", score: 0.8, selected: true });
		recorder.recordOutcome({ status: "ok", stopReasons: ["end_turn"] });

		expect(store.events.map(event => event.kind)).toEqual(["model_decision", "skill_candidate", "outcome"]);
		expect(store.events[0]?.sessionId).toBe("sess-1");
		expect(store.events[0]?.jobId).toBe("job-1");
		const modelPayload = store.events[0]?.payload;
		expect(jsonIncludesForbidden(modelPayload ?? null, ["sk-secret", "api_key"])).toBe(false);
		expect(JSON.stringify(modelPayload)).toContain('"note":"ok"');
	});

	it("bounds human correction summaries and rejects secret-like keys/values", () => {
		const store = new FakeStore();
		const recorder = new OperationalTrajectoryRecorder({ store: asStore(store) });

		recorder.recordHumanCorrection({
			category: "preference",
			rating: 4,
			summary: "x".repeat(400),
		});
		const payload = store.events[0]?.payload as { summary?: string };
		expect(payload.summary?.endsWith("…")).toBe(true);
		expect((payload.summary ?? "").length).toBeLessThanOrEqual(280);

		expect(() =>
			recorder.recordHumanCorrection({
				category: "bug",
				summary: "token=abc123secret",
			}),
		).toThrow(/secret-like/);

		expect(() =>
			recorder.recordHumanCorrection({
				category: "bug",
				metadata: { password: "hunter2" },
			}),
		).toThrow(/secret-like/);
	});

	it("maps tool start/end with argument keys only and correlates durations", () => {
		const store = new FakeStore();
		const clock = new TestClock(1000);
		const session = new FakeSession();
		const recorder = new OperationalTrajectoryRecorder({
			store: asStore(store),
			sessionId: "sess-2",
			now: clock.now,
		});
		const attachment = recorder.attach(session);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "read",
			args: { path: "src/a.ts", offset: 10, api_key: "should-not-key" },
			intent: "Inspect file",
		} as AgentSessionEvent);

		clock.advance(42);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "read",
			isError: false,
			result: {
				content: [{ type: "text", text: "SECRET_FILE_BODY" }],
				details: {
					kind: "file",
					resolvedPath: "src/a.ts",
					summary: { lines: 12, elidedSpans: 1, elidedLines: 4 },
					displayContent: { text: "SECRET_FILE_BODY", startLine: 1 },
				},
			},
		} as AgentSessionEvent);

		const toolDecisions = payloadsByKind(store, "tool_decision") as Array<Record<string, JsonValue>>;
		expect(toolDecisions).toHaveLength(2);
		expect(toolDecisions[0]).toMatchObject({
			phase: "start",
			toolName: "read",
			toolCallId: "tc-1",
		});
		expect(toolDecisions[0]?.argumentKeys).toEqual(["offset", "path"]);
		expect(JSON.stringify(toolDecisions)).not.toContain("Inspect file");
		expect(toolDecisions[1]).toMatchObject({
			phase: "end",
			toolName: "read",
			toolCallId: "tc-1",
			status: "ok",
			durationMs: 42,
		});

		const context = payloadsByKind(store, "context_retrieval") as Array<Record<string, JsonValue>>;
		expect(context).toHaveLength(1);
		expect(context[0]).toMatchObject({
			toolName: "read",
			toolCallId: "tc-1",
			status: "ok",
			kind: "file",
		});
		expect(jsonIncludesForbidden(context[0] ?? null, ["SECRET_FILE_BODY", "displayContent"])).toBe(false);

		attachment.unsubscribe();
		expect(session.listenerCount()).toBe(0);
	});

	it("maps search/lsp/ast context retrieval and patch tools without content or diffs", () => {
		const store = new FakeStore();
		const session = new FakeSession();
		const recorder = new OperationalTrajectoryRecorder({ store: asStore(store) });
		recorder.attach(session);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "s1",
			toolName: "search",
			args: { pattern: "TODO", paths: ["src"] },
		} as AgentSessionEvent);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "s1",
			toolName: "search",
			result: {
				details: {
					matchCount: 3,
					fileCount: 2,
					files: ["src/a.ts", "src/b.ts"],
					displayContent: "match body SECRET",
				},
			},
		} as AgentSessionEvent);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "e1",
			toolName: "edit",
			args: { path: "src/a.ts", oldText: "alpha", newText: "beta" },
		} as AgentSessionEvent);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: {
				details: {
					path: "src/a.ts",
					diff: "--- a\n+++ b\nSECRET_DIFF",
					oldText: "alpha",
					newText: "beta",
					op: "update",
					filesTouched: 1,
				},
			},
		} as AgentSessionEvent);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "w1",
			toolName: "write",
			args: { path: "src/c.ts", content: "file body" },
		} as AgentSessionEvent);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "w1",
			toolName: "write",
			result: { details: { resolvedPath: "src/c.ts" } },
		} as AgentSessionEvent);

		const context = payloadsByKind(store, "context_retrieval");
		expect(context.some(payload => JSON.stringify(payload).includes('"matchCount":3'))).toBe(true);
		expect(jsonIncludesForbidden(context[0] ?? null, ["match body SECRET", "TODO"])).toBe(false);

		const patches = payloadsByKind(store, "patch") as Array<Record<string, JsonValue>>;
		expect(patches).toHaveLength(2);
		expect(patches[0]).toMatchObject({
			toolName: "edit",
			toolCallId: "e1",
			status: "ok",
			op: "update",
			filesTouched: 1,
		});
		expect(patches[0]?.paths).toEqual(["src/a.ts"]);
		expect(
			jsonIncludesForbidden(patches[0] ?? null, ["SECRET_DIFF", "alpha", "beta", "oldText", "newText", "diff"]),
		).toBe(false);
		expect(patches[1]).toMatchObject({ toolName: "write", toolCallId: "w1" });
		expect(jsonIncludesForbidden(patches[1] ?? null, ["file body"])).toBe(false);

		for (const payload of patches) {
			expect(jsonIncludesForbidden(payload, ["SECRET_DIFF", "file body", "oldText", "newText"])).toBe(false);
		}
		const writeStart = payloadsByKind(store, "tool_decision").find(payload => {
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
			const record = payload as { toolCallId?: string; phase?: string };
			return record.toolCallId === "w1" && record.phase === "start";
		}) as { argumentKeys?: string[] } | undefined;
		expect(writeStart?.argumentKeys).toEqual(["content", "path"]);
		expect(jsonIncludesForbidden(writeStart ?? null, ["file body"])).toBe(false);
	});

	it("records verification for test-like bash/eval without command or source text", () => {
		const store = new FakeStore();
		const clock = new TestClock(5000);
		const session = new FakeSession();
		const recorder = new OperationalTrajectoryRecorder({
			store: asStore(store),
			now: clock.now,
		});
		recorder.attach(session);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "bun test packages/coding-agent/test/foo.test.ts" },
		} as AgentSessionEvent);
		clock.advance(15);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			isError: false,
			result: { details: { exitCode: 0 } },
		} as AgentSessionEvent);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "b2",
			toolName: "bash",
			args: { command: "ls -la" },
		} as AgentSessionEvent);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "b2",
			toolName: "bash",
			result: { details: { exitCode: 0 } },
		} as AgentSessionEvent);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "ev1",
			toolName: "eval",
			args: { cells: [{ source: "expect(1).toBe(1)" }] },
		} as AgentSessionEvent);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "ev1",
			toolName: "eval",
			isError: true,
			result: { details: { isError: true } },
		} as AgentSessionEvent);

		const verifications = payloadsByKind(store, "verification") as Array<Record<string, JsonValue>>;
		expect(verifications).toHaveLength(2);
		expect(verifications[0]).toMatchObject({
			toolName: "bash",
			toolCallId: "b1",
			kind: "test",
			passed: true,
			exitCode: 0,
			durationMs: 15,
		});
		expect(verifications[1]).toMatchObject({
			toolName: "eval",
			toolCallId: "ev1",
			kind: "test",
			passed: false,
		});
		for (const payload of verifications) {
			expect(jsonIncludesForbidden(payload, ["bun test", "ls -la", "expect(1)", "command", "cells"])).toBe(false);
		}
	});

	it("records agent_end outcome from stop metadata and telemetry without message content", () => {
		const store = new FakeStore();
		const session = new FakeSession();
		const recorder = new OperationalTrajectoryRecorder({ store: asStore(store) });
		recorder.attach(session);

		session.emit({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "VISIBLE_ASSISTANT_SECRET" }],
					model: "gpt-test",
					stopReason: "end_turn",
					timestamp: 1,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
			telemetry: {
				stepCount: 2,
				chats: { total: 1, byStopReason: { end_turn: 1 }, totalLatencyMs: 10 },
				tools: {
					total: 1,
					ok: 1,
					error: 0,
					skipped: 0,
					blocked: 0,
					timeout: 0,
					aborted: 0,
					totalLatencyMs: 5,
					byName: {},
				},
				usage: {
					inputTokens: 3,
					outputTokens: 4,
					cachedInputTokens: 0,
					cacheWriteTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 7,
				},
				cost: { estimatedUsd: 0.01, unavailableReasons: [] },
				errors: { total: 0, byType: {} },
			},
		} as unknown as AgentSessionEvent);

		const outcomes = payloadsByKind(store, "outcome") as Array<Record<string, JsonValue>>;
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			status: "ok",
			stopReasons: ["end_turn"],
		});
		expect(JSON.stringify(outcomes[0]?.telemetry)).toContain('"stepCount":2');
		expect(jsonIncludesForbidden(outcomes[0] ?? null, ["VISIBLE_ASSISTANT_SECRET", "content"])).toBe(false);
	});

	it("isolates recorder/store failures through onError and keeps listening", () => {
		const store = new FakeStore();
		const session = new FakeSession();
		const errors: unknown[] = [];
		const recorder = new OperationalTrajectoryRecorder({
			store: asStore(store),
			onError: error => {
				errors.push(error);
			},
		});
		recorder.attach(session);

		store.failNext = true;
		expect(() => {
			session.emit({
				type: "tool_execution_start",
				toolCallId: "x1",
				toolName: "find",
				args: { paths: ["src"] },
			} as AgentSessionEvent);
		}).not.toThrow();
		expect(errors).toHaveLength(1);

		session.emit({
			type: "tool_execution_end",
			toolCallId: "x1",
			toolName: "find",
			result: { details: { fileCount: 1, files: ["src/a.ts"] } },
		} as AgentSessionEvent);

		expect(payloadsByKind(store, "tool_decision").length).toBeGreaterThan(0);
		expect(payloadsByKind(store, "context_retrieval")).toHaveLength(1);
	});

	it("unsubscribe and dispose stop further event capture", () => {
		const store = new FakeStore();
		const session = new FakeSession();
		const recorder = new OperationalTrajectoryRecorder({ store: asStore(store) });
		const attachment = recorder.attach(session);

		attachment.unsubscribe();
		session.emit({
			type: "tool_execution_start",
			toolCallId: "z1",
			toolName: "read",
			args: { path: "a.ts" },
		} as AgentSessionEvent);
		expect(store.events).toHaveLength(0);

		const attachment2 = recorder.attach(session);
		attachment2.dispose();
		session.emit({
			type: "tool_execution_start",
			toolCallId: "z2",
			toolName: "read",
			args: { path: "b.ts" },
		} as AgentSessionEvent);
		expect(store.events).toHaveLength(0);
		expect(session.listenerCount()).toBe(0);
	});
});
