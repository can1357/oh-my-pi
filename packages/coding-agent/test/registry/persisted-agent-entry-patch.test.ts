/**
 * The Agent Hub's row for a persisted subagent counts its tool calls and
 * credits the model whose turn produced output, from each assistant turn's
 * `content`. An `entry_patch` record that sets a turn's content after its line
 * was written must count as that content, as a full rewrite of the file
 * leaves it. The records are written by hand, as a file holds them.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-08-07T11:00:00.000Z";

function line(entry: object): string {
	return JSON.stringify(entry);
}

function assistant(id: string, parentId: string, model: string, stopReason: string, content: unknown[]): string {
	return line({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			content,
			provider: "anthropic",
			model,
			stopReason,
			usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
		},
	});
}

function record(id: string, parentId: string, patches: object[]): string {
	return line({ type: "custom", customType: "entry_patch", id, parentId, timestamp: TIMESTAMP, data: { patches } });
}

const HEAD = [
	line({ type: "session", id: "s0", parentId: null, timestamp: "2026-08-07T10:34:37.300Z" }),
	line({
		type: "session_init",
		id: "si",
		parentId: "s0",
		timestamp: "2026-08-07T10:34:38.000Z",
		agent: "task",
		task: "build the thing",
	}),
];

const TWO_CALLS = [
	{ type: "toolCall", id: "t1", name: "read", arguments: {} },
	{ type: "toolCall", id: "t2", name: "read", arguments: {} },
];
const ONE_CALL = [{ type: "toolCall", id: "t1", name: "read", arguments: {} }];

/** Writes `id`'s transcript beside an empty root session and reads its history as the Hub does. */
async function historyFor(dir: string, id: string, records: string[]) {
	await Bun.write(path.join(dir, "main.jsonl"), "");
	await Bun.write(path.join(dir, "main", `${id}.jsonl`), `${records.join("\n")}\n`);
	const registry = new AgentRegistry();
	await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
	const history = registry.get(id)?.history;
	return { tools: history?.metrics?.tools, resolvedModel: history?.resolvedModel };
}

describe("persisted agent metrics and entry_patch records", () => {
	it("counts tool calls and credits the serving model from the content a record set, as with it inline", async () => {
		using dir = TempDir.createSync("@omp-persisted-entry-patch-");
		// The later turn answered with text that a record replaced by nothing: it produced no output.
		const patched = await historyFor(path.join(dir.path(), "patched"), "Worker", [
			...HEAD,
			assistant("a1", "si", "claude-sonnet-5", "toolUse", TWO_CALLS),
			assistant("a2", "a1", "claude-opus-5", "stop", [{ type: "text", text: "answered" }]),
			record("p1", "a2", [
				{ entryId: "a1", message: { content: ONE_CALL } },
				{ entryId: "a2", message: { content: [{ type: "text", text: "  " }] } },
			]),
		]);
		const inline = await historyFor(path.join(dir.path(), "inline"), "Worker", [
			...HEAD,
			assistant("a1", "si", "claude-sonnet-5", "toolUse", ONE_CALL),
			assistant("a2", "a1", "claude-opus-5", "stop", [{ type: "text", text: "  " }]),
		]);
		expect(patched).toEqual({ tools: 1, resolvedModel: "anthropic/claude-sonnet-5" });
		expect(patched).toEqual(inline);
	});
});
