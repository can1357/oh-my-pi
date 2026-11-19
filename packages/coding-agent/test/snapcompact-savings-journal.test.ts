import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	createSnapcompactSavingsRecorder,
	readSnapcompactSavingsJournal,
} from "@oh-my-pi/pi-coding-agent/session/snapcompact-savings-journal";

function model(provider = "anthropic", id = "claude-test"): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

async function tmpJournal(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-savings-journal-"));
	return path.join(dir, "snapcompact-savings.jsonl");
}

describe("snapcompact savings journal", () => {
	it("appends one attributed record per imaged tool result", async () => {
		const journal = await tmpJournal();
		const record = createSnapcompactSavingsRecorder(() => "/proj/session.jsonl", journal);
		await record(
			[
				{ toolCallId: "call_1", savedTokens: 5000 },
				{ toolCallId: "call_2", savedTokens: 3000 },
			],
			model("google", "gemini-test"),
		);

		const recs = await readSnapcompactSavingsJournal(journal);
		expect(recs.map(r => r.toolCallId).sort()).toEqual(["call_1", "call_2"]);
		const first = recs.find(r => r.toolCallId === "call_1");
		expect(first).toMatchObject({
			session: "/proj/session.jsonl",
			provider: "google",
			model: "gemini-test",
			savedTokens: 5000,
		});
		expect(typeof first?.ts).toBe("number");
	});

	it("records each tool result once per session, even when re-imaged on later requests", async () => {
		const journal = await tmpJournal();
		const record = createSnapcompactSavingsRecorder(() => "/proj/session.jsonl", journal);
		// call_1 stays in context and is re-imaged on every request; call_2 appears later.
		await record([{ toolCallId: "call_1", savedTokens: 5000 }], model());
		await record(
			[
				{ toolCallId: "call_1", savedTokens: 5000 },
				{ toolCallId: "call_2", savedTokens: 4000 },
			],
			model(),
		);

		const recs = await readSnapcompactSavingsJournal(journal);
		expect(recs.map(r => r.toolCallId).sort()).toEqual(["call_1", "call_2"]);
	});

	it("writes nothing without a session or for non-positive savings", async () => {
		const journal = await tmpJournal();
		await createSnapcompactSavingsRecorder(() => null, journal)(
			[{ toolCallId: "call_1", savedTokens: 5000 }],
			model(),
		);
		await createSnapcompactSavingsRecorder(() => "/proj/session.jsonl", journal)(
			[
				{ toolCallId: "call_zero", savedTokens: 0 },
				{ toolCallId: "call_neg", savedTokens: -10 },
			],
			model(),
		);
		expect(await readSnapcompactSavingsJournal(journal)).toEqual([]);
	});

	it("returns empty for a missing journal file", async () => {
		expect(await readSnapcompactSavingsJournal(await tmpJournal())).toEqual([]);
	});
});
