import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { modelChip } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const SONNET = { provider: "anthropic", model: "claude-sonnet-5" };
const SOL = { provider: "openai-codex", model: "gpt-5.6-sol" };

function assistant(
	id: string,
	parentId: string,
	who: { provider: string; model: string; serviceTier?: string },
	stopReason: string,
	content: unknown[],
	cost = 0.5,
	timestamp = "2026-08-07T11:00:00.000Z",
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content,
			provider: who.provider,
			model: who.model,
			serviceTier: who.serviceTier,
			stopReason,
			usage: { input: 10, output: 20, totalTokens: 30, cost: { total: cost } },
		},
	});
}

function modelUsage(
	id: string,
	parentId: string,
	cost: number,
	timestamp: string,
	activeLeafId?: string | null,
): string {
	return JSON.stringify({
		type: "model_usage",
		id,
		parentId,
		timestamp,
		...(activeLeafId !== undefined ? { activeLeafId } : {}),
		purpose: "task-completion-probe",
		usage: { cost: { total: cost } },
	});
}

function sessionStub(cost: number, subagentCost = 0): AgentSession {
	return {
		sessionManager: { getUsageStatistics: () => ({ cost, subagentCost }) },
		dispose: async () => {},
	} as unknown as AgentSession;
}

function modelChange(id: string, parentId: string, model: string, role: string, isFallback: boolean): string {
	return JSON.stringify({
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-08-07T11:00:00.000Z",
		model,
		role,
		resolvedModelIsFallback: isFallback,
	});
}

/** Head every transcript shares: a session that started on sonnet under the `task` role. */
function transcriptHead(): string[] {
	return [
		JSON.stringify({ type: "session", id: "s0", parentId: null, timestamp: "2026-08-07T10:34:37.300Z" }),
		modelChange("m1", "s0", "anthropic/claude-sonnet-5", "task", false),
		JSON.stringify({
			type: "session_init",
			id: "si",
			parentId: "m1",
			timestamp: "2026-08-07T10:34:38.000Z",
			agent: "task",
			task: "build the thing",
		}),
	];
}

/** Writes a worker transcript beside an empty root session and registers it. */
async function historyFor(dir: string, id: string, records: string[]): Promise<AgentRegistry> {
	await Bun.write(path.join(dir, "main.jsonl"), "");
	await Bun.write(path.join(dir, "main", `${id}.jsonl`), `${records.join("\n")}\n`);
	const registry = new AgentRegistry();
	await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
	return registry;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("persisted agent model attribution", () => {
	it("reports the model that produced output, not a fallback that never served", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-incident-");
		// The incident: sonnet does the work, a chain candidate errors instantly.
		const registry = await historyFor(tempDir.path(), "BuildThing", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "toolUse", [{ type: "toolCall", id: "t1", name: "read" }]),
			assistant("e1", "a1", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("e2", "m2", SOL, "error", []),
		]);

		const history = registry.get("BuildThing")?.history;
		expect(history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(history?.resolvedModelIsFallback).toBe(false);
		// The role label survives the ephemeral fallback transition on top of it.
		expect(history?.modelRole).toBe("task");
		// Every assistant turn still counts toward the row's telemetry.
		expect(history?.metrics?.requests).toBe(3);
	});

	it("does not infer an applied fast tier from persisted configured-tier records", async () => {
		using tempDir = TempDir.createSync("@omp-unknown-fast-history-");
		const registry = await historyFor(tempDir.path(), "Legacy", [
			...transcriptHead(),
			JSON.stringify({
				type: "service_tier_change",
				id: "tier",
				parentId: "si",
				serviceTier: { anthropic: "priority" },
			}),
			assistant("a1", "tier", SONNET, "stop", [{ type: "text", text: "done" }]),
		]);
		expect(registry.get("Legacy")?.history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(registry.get("Legacy")?.history?.fastMode).toBeUndefined();
		expect(registry.get("Legacy")?.history?.responseFastMode).toBeUndefined();
	});

	it.each([undefined, "unrecognized"])(
		"clears prior response evidence after a same-model unknown tier (%s)",
		async tier => {
			using tempDir = TempDir.createSync("@omp-refresh-fast-history-");
			const registry = await historyFor(tempDir.path(), "Refresh", [
				...transcriptHead(),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: "si",
					message: {
						role: "assistant",
						...SOL,
						serviceTier: "priority",
						stopReason: "stop",
						content: [{ type: "text", text: "first" }],
					},
				}),
			]);
			const ref = registry.get("Refresh")!;
			expect(modelChip(ref, undefined)?.fastMode).toBe(true);
			await fs.appendFile(
				path.join(tempDir.path(), "main", "Refresh.jsonl"),
				JSON.stringify({
					type: "message",
					id: "a2",
					parentId: "a1",
					message: {
						role: "assistant",
						...SOL,
						serviceTier: tier,
						stopReason: "stop",
						content: [{ type: "text", text: "latest" }],
					},
				}) + "\n",
			);
			await registerPersistedSubagents(registry, path.join(tempDir.path(), "main.jsonl"));
			expect(modelChip(ref, undefined)?.fastMode).toBeUndefined();
		},
	);

	it.each([
		{ tier: "priority", expected: true },
		{ tier: "ultrafast", expected: true },
		{ tier: "default", expected: false },
		{ tier: undefined, expected: undefined },
		{ tier: "unrecognized", expected: undefined },
	])("restores the latest serving response tier ($tier), not an earlier fast turn", async ({ tier, expected }) => {
		using tempDir = TempDir.createSync("@omp-response-fast-history-");
		const response = (id: string, parentId: string, serviceTier: string | undefined) =>
			JSON.stringify({
				type: "message",
				id,
				parentId,
				message: {
					role: "assistant",
					...SOL,
					serviceTier,
					stopReason: "stop",
					content: [{ type: "text", text: "done" }],
				},
			});
		const registry = await historyFor(tempDir.path(), "Recorded", [
			...transcriptHead(),
			response("a1", "si", "priority"),
			response("a2", "a1", tier),
			modelChange("m2", "a2", "anthropic/claude-sonnet-5", "fallback", true),
			assistant("failed", "m2", SONNET, "error", []),
		]);
		expect(registry.get("Recorded")?.history?.resolvedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(registry.get("Recorded")?.history?.responseFastMode).toBe(expected);
	});

	it.each([false, true])("keeps runtime fast state %s ahead of older response evidence", runtimeFast => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session: null,
			status: "parked",
			history: { resolvedModel: "openai-codex/gpt-5.6-sol", fastMode: runtimeFast },
		});
		registry.setHistory(ref.id, {
			resolvedModel: "openai-codex/gpt-5.6-sol",
			responseFastMode: !runtimeFast,
		});
		expect(modelChip(ref, undefined)?.fastMode).toBe(runtimeFast);
		registry.setHistory(ref.id, { resolvedModel: "anthropic/claude-sonnet-5" });
		expect(modelChip(ref, undefined)?.fastMode).toBeUndefined();
	});

	it("preserves same-model runtime tier evidence across scans, but not model or transcript replacement", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/original.jsonl",
			history: { resolvedModel: "anthropic/claude-sonnet-5", fastMode: true },
		});
		registry.setHistory(ref.id, { resolvedModel: "anthropic/claude-sonnet-5" });
		expect(ref.history?.fastMode).toBe(true);
		registry.setHistory(ref.id, { fastMode: false });
		expect(ref.history?.fastMode).toBe(false);
		registry.setHistory(ref.id, { resolvedModel: "openai-codex/gpt-5.6-sol" });
		expect(ref.history?.fastMode).toBeUndefined();
		registry.setHistory(ref.id, { fastMode: true });
		registry.setHistory(ref.id, { fastMode: undefined });
		expect(ref.history?.fastMode).toBeUndefined();
		registry.setHistory(ref.id, { fastMode: true });
		registry.attachSession(ref.id, sessionStub(0), "/tmp/replacement.jsonl", ref);
		expect(ref.history?.fastMode).toBeUndefined();
		expect(ref.history?.resolvedModel).toBeUndefined();
		expect(ref.history?.responseFastMode).toBeUndefined();
	});

	it("preserves cold-revived serving attribution until the bootstrap primary actually serves", async () => {
		using tempDir = TempDir.createSync("@omp-cold-serving-attribution-");
		const registry = await historyFor(tempDir.path(), "Cold", [
			...transcriptHead(),
			modelChange("m2", "si", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("a1", "m2", { ...SOL, serviceTier: "priority" }, "stop", [{ type: "text", text: "fallback work" }]),
		]);
		const ref = registry.get("Cold")!;
		const primary = createMockModel({
			provider: SONNET.provider,
			id: SONNET.model,
			handler: { content: ["new work"] },
		});
		const recovery = new TurnRecovery({
			model: () => primary,
			thinkingLevel: () => undefined,
			sessionManager: { getSessionId: () => "cold-runtime" },
			settings: Settings.isolated({}),
			modelRegistry: {},
			configWarnings: [],
		} as unknown as TurnRecoveryHost);
		const session = sessionStub(0.5);
		Object.defineProperties(session, {
			model: { get: () => primary },
			servingModel: { get: () => recovery.servingModel },
			isFastModeActive: { value: () => false },
		});
		registry.attachSession(ref.id, session, ref.sessionFile, ref);
		registry.setStatus(ref.id, "idle", ref);
		const lifecycle = new AgentLifecycleManager(registry);
		lifecycle.adopt(ref.id, { idleTtlMs: 0 }, ref);
		await lifecycle.park(ref.id);
		expect(ref.history).toMatchObject({
			resolvedModel: "openai-codex/gpt-5.6-sol",
			resolvedModelIsFallback: true,
			responseFastMode: true,
		});
		expect(ref.history?.fastMode).toBeUndefined();

		// The same primary becomes authoritative only after it produces output.
		await recovery.onAssistantSettledSuccessfully(createAssistantMessage("new primary work"));
		registry.attachSession(ref.id, session, ref.sessionFile, ref);
		registry.detachSession(ref.id, ref);
		expect(ref.history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(ref.history?.resolvedModelIsFallback).toBe(false);
		expect(ref.history?.fastMode).toBe(false);
		expect(ref.history?.responseFastMode).toBeUndefined();
	});

	it("rejects superseded monitor writes at the registry boundary without retiring the owner on detach", () => {
		const registry = new AgentRegistry();
		const session = sessionStub(0);
		Object.assign(session, {
			model: { provider: SONNET.provider, id: SONNET.model },
			servingModel: { selector: "anthropic/claude-sonnet-5", isFallback: false },
			isFastModeActive: () => true,
		});
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session,
			sessionFile: "/tmp/worker.jsonl",
			history: { resolvedModel: "anthropic/claude-sonnet-5", fastMode: true },
		});
		const olderOwner = Symbol();
		const owner = Symbol();
		registry.claimAttributionOwner(ref, olderOwner);
		registry.claimAttributionOwner(ref, owner);
		const options = { sessionFile: "/tmp/worker.jsonl", ref, owner };
		expect(
			registry.setHistory(
				ref.id,
				{ resolvedModel: "openai-codex/gpt-5.6-sol", fastMode: false, outputPath: "/stale.md" },
				{ ...options, owner: olderOwner },
			),
		).toBe(false);
		expect(ref.history).toEqual({ resolvedModel: "anthropic/claude-sonnet-5", fastMode: true });

		registry.detachSession(ref.id, ref);
		expect(registry.setHistory(ref.id, { resolvedModel: "openai-codex/gpt-5.6-sol", fastMode: false }, options)).toBe(
			true,
		);
		expect(ref.history).toMatchObject({ resolvedModel: "openai-codex/gpt-5.6-sol", fastMode: false });
	});

	it("fences delayed hydration attribution while retaining metadata, cost, and later rescans", async () => {
		using tempDir = TempDir.createSync("@omp-delayed-runtime-attribution-");
		const rootFile = path.join(tempDir.path(), "main.jsonl");
		const transcriptFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const registry = await historyFor(tempDir.path(), "Worker", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "old work" }], 0.5),
		]);
		const ref = registry.get("Worker")!;
		await fs.appendFile(transcriptFile, `${modelUsage("usage", "a1", 0.1, "2026-08-07T11:30:00.000Z")}\n`);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const visit = sessionLoader.visitEntriesFromFileStream;
		let pause = true;
		vi.spyOn(sessionLoader, "visitEntriesFromFileStream").mockImplementation(async (file, visitor, options) => {
			const result = await visit(file, visitor, options);
			if (file === transcriptFile && pause) {
				pause = false;
				entered.resolve();
				await release.promise;
			}
			return result;
		});
		const hydration = registerPersistedSubagents(registry, rootFile);
		try {
			await entered.promise;
			await fs.appendFile(
				transcriptFile,
				`${assistant("a2", "usage", { ...SOL, serviceTier: "priority" }, "stop", [{ type: "text", text: "new work" }])}\n`,
			);
			const session = sessionStub(1.25);
			Object.assign(session, {
				model: { provider: SOL.provider, id: SOL.model },
				servingModel: {
					selector: "openai-codex/gpt-5.6-sol",
					modelIdentity: "openai-codex/gpt-5.6-sol",
					isFallback: true,
				},
				isFastModeActive: () => false,
			});
			registry.attachSession(ref.id, session, transcriptFile, ref);
			registry.setStatus(ref.id, "idle", ref);
			registry.setHistory(ref.id, {
				resolvedModel: "openai-codex/gpt-5.6-sol",
				resolvedModelIsFallback: true,
				fastMode: false,
				responseFastMode: false,
				outputPath: "/runtime/result.md",
			});
			const lifecycle = new AgentLifecycleManager(registry);
			lifecycle.adopt(ref.id, { idleTtlMs: 0 }, ref);
			await lifecycle.park(ref.id);
			release.resolve();
			await hydration;
			expect(ref.history).toMatchObject({
				resolvedModel: "openai-codex/gpt-5.6-sol",
				resolvedModelIsFallback: true,
				fastMode: false,
				responseFastMode: false,
				modelRole: "task",
				outputPath: "/runtime/result.md",
				directCost: 1.25,
			});
			// No permanent latch: a new scan can read current response evidence,
			// and the aligned runtime false still outranks that response's true.
			await registerPersistedSubagents(registry, rootFile);
			expect(ref.history?.responseFastMode).toBe(true);
			expect(ref.history?.fastMode).toBe(false);
			expect(ref.history?.metrics?.requests).toBe(2);
			expect(ref.history?.directCost).toBe(1.25);
		} finally {
			release.resolve();
			await hydration;
		}
	});

	it("treats a stall aborted mid-tool-call as unserved despite its partial content", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-stall-");
		// A dropped stream is finalized as `aborted` with the partially streamed
		// tool call still attached, so content alone does not prove it completed.
		const registry = await historyFor(tempDir.path(), "Stalled", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "sonnet did the work" }]),
			assistant("e1", "a1", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("e2", "m2", SOL, "aborted", [{ type: "toolCall", id: "t2", name: "read" }]),
		]);

		const history = registry.get("Stalled")?.history;
		expect(history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(history?.resolvedModelIsFallback).toBe(false);
	});

	it("treats a substantively empty stop as unserved despite a non-empty content array", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-empty-stop-");
		// A `stop` carrying only whitespace text and unsigned thinking produced
		// nothing actionable — it is what the empty-stop retry machinery exists to
		// recover from. A content-length check alone would credit the candidate.
		const registry = await historyFor(tempDir.path(), "EmptyStop", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "sonnet did the work" }]),
			assistant("e1", "a1", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("e2", "m2", SOL, "stop", [
				{ type: "thinking", thinking: "   ", thinkingSignature: "" },
				{ type: "text", text: "  " },
			]),
		]);

		const history = registry.get("EmptyStop")?.history;
		expect(history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(history?.resolvedModelIsFallback).toBe(false);
	});

	it("credits a turn whose only output is an image", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-image-");
		// A native image response can arrive with no text and no tool call at all.
		// Recognising only those would call it nothing and leave the run credited
		// to whichever model spoke before it.
		const registry = await historyFor(tempDir.path(), "Painter", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "sonnet did the work" }]),
			assistant("e1", "a1", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("a2", "m2", SOL, "stop", [{ type: "image", data: "aGk=", mimeType: "image/png" }]),
		]);

		const history = registry.get("Painter")?.history;
		expect(history?.resolvedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(history?.resolvedModelIsFallback).toBe(true);
	});

	it("treats a budget-exhausted length stop with nothing usable as unserved", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-length-");
		// `length` is not an "empty stop", so the empty-stop rule never inspects it:
		// a candidate that burned its whole output budget on unsigned thinking still
		// produced nothing to attribute.
		const registry = await historyFor(tempDir.path(), "OutOfBudget", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "sonnet did the work" }]),
			assistant("e1", "a1", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("e2", "m2", SOL, "length", [{ type: "thinking", thinking: "spent it all", thinkingSignature: "" }]),
		]);

		const history = registry.get("OutOfBudget")?.history;
		expect(history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(history?.resolvedModelIsFallback).toBe(false);
	});

	it("summarizes a transcript carrying malformed content blocks", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-malformed-");
		// Transcripts outlive the shapes that wrote them. A block that is null or
		// missing its `text` must not throw: the reader catches and returns an
		// empty summary, blanking the whole row over one bad line.
		const registry = await historyFor(tempDir.path(), "Legacy", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [null, { type: "text" }]),
			assistant("a2", "a1", SONNET, "stop", [{ type: "text", text: "recovered and did the work" }]),
		]);

		const history = registry.get("Legacy")?.history;
		expect(history?.resolvedModel).toBe("anthropic/claude-sonnet-5");
		expect(history?.metrics?.requests).toBe(2);
	});

	it("labels the row with the newest role a transition assigned, skipping ephemeral ones", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-role-");
		// Two real role transitions plus an ephemeral fallback on top: the label
		// must be the latest deliberate role, not the first one nor the fallback.
		const registry = await historyFor(tempDir.path(), "Rerolled", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "first role" }]),
			modelChange("m2", "a1", "openai-codex/gpt-5.6-sol", "slow", false),
			assistant("a2", "m2", SOL, "stop", [{ type: "text", text: "second role" }]),
			modelChange("m3", "a2", "openai-codex/gpt-5.6-sol", "fallback", true),
		]);

		const history = registry.get("Rerolled")?.history;
		expect(history?.modelRole).toBe("slow");
	});

	it("reports the fallback once it has served a turn", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-served-");
		const registry = await historyFor(tempDir.path(), "Worker", [
			...transcriptHead(),
			assistant("e1", "si", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol", "fallback", true),
			assistant("a1", "m2", SOL, "toolUse", [{ type: "toolCall", id: "t1", name: "read" }]),
		]);

		const history = registry.get("Worker")?.history;
		expect(history?.resolvedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(history?.resolvedModelIsFallback).toBe(true);
	});

	it("matches a served model to a transition carrying a gateway route", async () => {
		using tempDir = TempDir.createSync("@omp-attribution-routed-");
		// Writers record the selector through `formatModelStringWithRouting`, which
		// appends an `@upstream` gateway route the raw message never carries.
		// Failing to match drops the fallback flag.
		const registry = await historyFor(tempDir.path(), "Routed", [
			...transcriptHead(),
			assistant("e1", "si", SONNET, "error", []),
			modelChange("m2", "e1", "openai-codex/gpt-5.6-sol@vercel-gw", "fallback", true),
			assistant("a1", "m2", SOL, "stop", [{ type: "text", text: "served via the gateway" }]),
		]);

		const history = registry.get("Routed")?.history;
		expect(history?.resolvedModel).toBe("openai-codex/gpt-5.6-sol@vercel-gw");
		expect(history?.resolvedModelIsFallback).toBe(true);
	});

	it("keeps same-transcript direct cost monotonic when a delayed scan commits after park", async () => {
		using tempDir = TempDir.createSync("@omp-stale-cost-");
		const transcriptFile = path.join(tempDir.path(), "main", "BuildThing.jsonl");
		const registry = await historyFor(tempDir.path(), "BuildThing", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "completed" }], 0.6),
		]);
		const staleScanSnapshot = registry.get("BuildThing")?.history;
		expect(staleScanSnapshot?.directCost).toBeCloseTo(0.6);

		const ref = registry.get("BuildThing")!;
		const session = sessionStub(1.25, 0.25);
		expect(registry.attachSession("BuildThing", session, transcriptFile, ref)).toBe(true);
		expect(registry.setStatus("BuildThing", "idle", ref)).toBe(true);
		const lifecycle = new AgentLifecycleManager(registry);
		lifecycle.adopt("BuildThing", { idleTtlMs: 0 }, ref);
		await lifecycle.park("BuildThing");

		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(ref.history?.directCost).toBeCloseTo(1);
		expect(registry.setHistory("BuildThing", staleScanSnapshot!, { sessionFile: transcriptFile })).toBe(true);
		expect(ref.history?.directCost).toBeCloseTo(1);
		// The stale persisted scan still supplies selected-leaf non-cost history;
		// only its same-file cumulative direct-cost snapshot is rejected.
		expect(ref.history?.metrics).toEqual(staleScanSnapshot?.metrics);
		expect(ref.history?.metrics?.cost).toBeCloseTo(0.6);

		const replacementFile = path.join(tempDir.path(), "replacement.jsonl");
		expect(registry.attachSession("BuildThing", sessionStub(0.1), replacementFile, ref)).toBe(true);
		expect(ref.history?.directCost).toBeUndefined();
		expect(registry.setHistory("BuildThing", { directCost: 0.1 }, { sessionFile: replacementFile })).toBe(true);
		expect(ref.history?.directCost).toBeCloseTo(0.1);
		// A late scan from the superseded transcript cannot update the new ref.
		expect(registry.setHistory("BuildThing", staleScanSnapshot!, { sessionFile: transcriptFile })).toBe(false);
		expect(ref.history?.directCost).toBeCloseTo(0.1);
		// Without a transcript identity token, setHistory keeps last-write semantics.
		expect(registry.setHistory("BuildThing", { directCost: 0.05 })).toBe(true);
		expect(ref.history?.directCost).toBeCloseTo(0.05);
	});

	it("uses an off-branch usage record's active leaf for cold selected-leaf metrics", async () => {
		using tempDir = TempDir.createSync("@omp-active-leaf-history-");
		const registry = await historyFor(tempDir.path(), "Branching", [
			...transcriptHead(),
			assistant(
				"old-owner",
				"si",
				SONNET,
				"stop",
				[{ type: "text", text: "older branch" }],
				0.2,
				"2026-08-07T10:50:00.000Z",
			),
			modelChange("m2", "si", "openai-codex/gpt-5.6-sol", "task", false),
			assistant(
				"active-leaf",
				"m2",
				SOL,
				"stop",
				[{ type: "text", text: "active branch" }],
				0.3,
				"2026-08-07T11:00:00.000Z",
			),
			modelUsage("late-usage", "old-owner", 0.1, "2026-08-07T11:30:00.000Z", "active-leaf"),
		]);

		const history = registry.get("Branching")?.history;
		expect(history?.directCost).toBeCloseTo(0.6);
		expect(history?.metrics?.requests).toBe(1);
		expect(history?.metrics?.cost).toBeCloseTo(0.3);
	});

	it("clears cold leaf-scoped metrics when a late usage record marks no active leaf", async () => {
		using tempDir = TempDir.createSync("@omp-cleared-active-leaf-");
		const registry = await historyFor(tempDir.path(), "Branching", [
			...transcriptHead(),
			assistant("old-owner", "si", SONNET, "stop", [{ type: "text", text: "older branch" }], 0.2),
			modelChange("m2", "si", "openai-codex/gpt-5.6-sol", "task", false),
			assistant("active-leaf", "m2", SOL, "stop", [{ type: "text", text: "active branch" }], 0.3),
			modelUsage("late-usage", "old-owner", 0.1, "2026-08-07T11:30:00.000Z", null),
		]);

		const history = registry.get("Branching")?.history;
		expect(history?.directCost).toBeCloseTo(0.6);
		expect(history?.metrics).toBeUndefined();
	});

	it("falls back to the newest real entry when a late usage record's active leaf is gone", async () => {
		using tempDir = TempDir.createSync("@omp-dangling-active-leaf-");
		const registry = await historyFor(tempDir.path(), "Branching", [
			...transcriptHead(),
			assistant("old-owner", "si", SONNET, "stop", [{ type: "text", text: "older branch" }], 0.2),
			modelChange("m2", "si", "openai-codex/gpt-5.6-sol", "task", false),
			assistant("active-leaf", "m2", SOL, "stop", [{ type: "text", text: "active branch" }], 0.3),
			modelUsage("late-usage", "old-owner", 0.1, "2026-08-07T11:30:00.000Z", "rolled-back"),
		]);

		const history = registry.get("Branching")?.history;
		expect(history?.metrics?.requests).toBe(1);
		expect(history?.metrics?.cost).toBeCloseTo(0.3);
	});
});

describe("persisted history rescans", () => {
	it("reads a transcript again only after it changed", async () => {
		using tempDir = TempDir.createSync("@omp-history-rescan-");
		const rootFile = path.join(tempDir.path(), "main.jsonl");
		const transcriptFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		const registry = await historyFor(tempDir.path(), "Worker", [
			...transcriptHead(),
			assistant("a1", "si", SONNET, "stop", [{ type: "text", text: "done" }], 0.5),
		]);
		const ref = registry.get("Worker")!;
		expect(ref.history?.directCost).toBeCloseTo(0.5);
		const changed: string[] = [];
		registry.onChange(event => {
			if (event.type === "metadata_changed") changed.push(event.ref.id);
		});

		await registerPersistedSubagents(registry, rootFile);
		expect(changed).toEqual([]);

		await fs.appendFile(
			transcriptFile,
			`${assistant("a2", "a1", SONNET, "stop", [{ type: "text", text: "more" }], 0.25)}\n`,
		);
		await registerPersistedSubagents(registry, rootFile);
		expect(changed).toEqual(["Worker"]);
		expect(ref.history?.directCost).toBeCloseTo(0.75);
	});
});
