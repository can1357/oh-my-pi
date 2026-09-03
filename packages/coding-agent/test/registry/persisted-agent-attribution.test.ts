import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { TempDir } from "@oh-my-pi/pi-utils";

const SONNET = { provider: "anthropic", model: "claude-sonnet-5" };
const SOL = { provider: "openai-codex", model: "gpt-5.6-sol" };

function assistant(
	id: string,
	parentId: string,
	who: { provider: string; model: string },
	stopReason: string,
	content: unknown[],
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-07T11:00:00.000Z",
		message: {
			role: "assistant",
			content,
			provider: who.provider,
			model: who.model,
			stopReason,
			usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
		},
	});
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
});
