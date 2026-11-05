import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatRequestError, hasRequestFailure } from "@oh-my-pi/omp-stats/client/data/formatters";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-retry-after-");

const USAGE = {
	input: 10,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failedTurn(id: string, failure: { errorMessage: string; errorRetryAfterMs?: number }): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-10-31T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			content: [],
			usage: USAGE,
			stopReason: "error",
			timestamp: Date.parse("2026-10-31T00:00:00.000Z") + Number(id.slice(1)),
			...failure,
		},
	});
}

async function ingest(lines: string[]): Promise<void> {
	const dir = path.join(getSessionsDir(), "--tmp--retry-after");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	await initDb();
	insertMessageStats((await parseSessionFile(file)).stats);
}

function requestFor(entryId: string) {
	const row = getRecentRequests(10).find(request => request.entryId === entryId);
	if (!row) throw new Error(`Expected an ingested request for ${entryId}`);
	return row;
}

describe("the server's retry wait in stats.db", () => {
	it("stores the wait in its own column and keeps the error text raw", async () => {
		await ingest([failedTurn("e1", { errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 })]);

		// The Errors view groups on `error_message`; a wait written into it would
		// split one failure into a group per wait.
		expect(requestFor("e1")).toMatchObject({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 });
	});

	it("stores no wait for a turn that stated none, even when its old text names one", async () => {
		await ingest([failedTurn("e2", { errorMessage: "429 rate_limit_error retry-after-ms=9000" })]);

		const row = requestFor("e2");
		expect(row.errorRetryAfterMs).toBeNull();
		expect(row.errorMessage).toBe("429 rate_limit_error retry-after-ms=9000");
	});

	it("fills the wait when a re-parse re-ingests a row stored without it", async () => {
		await ingest([failedTurn("e3", { errorMessage: "429 rate_limit_error" })]);
		expect(requestFor("e3").errorRetryAfterMs).toBeNull();

		await ingest([failedTurn("e3", { errorMessage: "429 rate_limit_error", errorRetryAfterMs: 45_000 })]);
		expect(requestFor("e3").errorRetryAfterMs).toBe(45_000);
	});

	it("fills the wait from a model_usage entry", async () => {
		await ingest([
			JSON.stringify({
				type: "model_usage",
				id: "u1",
				parentId: null,
				timestamp: "2026-10-31T00:00:01.000Z",
				purpose: "judge",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: USAGE,
				stopReason: "error",
				errorMessage: "429 rate_limit_error",
				errorRetryAfterMs: 12_000,
			}),
		]);

		expect(requestFor("u1")).toMatchObject({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 12_000 });
	});
});

// The request views read a stored failure through one formatter. Ingest keeps
// the raw text and the shown text in separate columns; reading the raw one here
// showed a refused wait as an invitation to retry, with the explanation sitting
// unread in the same row.
describe("formatRequestError", () => {
	it("shows the stored explanation, not the provider's own words", () => {
		expect(
			formatRequestError({
				errorMessage: "503 overloaded",
				errorDisplayMessage:
					"503 overloaded (server asked to wait 17.1 s before retrying; the caller's 12.5 s providerRetryWaitCeilingMs refused it, so the provider did not retry)",
				errorRetryAfterMs: 17_125,
			}),
		).toContain("the caller's 12.5 s providerRetryWaitCeilingMs refused it");
	});

	it("falls back to the provider's words when omp stored none of its own", () => {
		expect(formatRequestError({ errorMessage: "503 overloaded", errorRetryAfterMs: null })).toBe("503 overloaded");
	});

	it("has nothing to show for a request that did not fail", () => {
		expect(formatRequestError({ errorMessage: null, errorRetryAfterMs: null })).toBeNull();
	});
});

// A failure may carry no provider text at all and still have something to say:
// a refused wait is recorded as shown text alone. Gating a stats error view on
// the raw text hid exactly that failure.
describe("a textless refusal is still shown", () => {
	it("renders the explanation when the provider sent no words of its own", () => {
		expect(
			formatRequestError({
				errorMessage: null,
				errorDisplayMessage:
					"(server asked to wait 30 s before retrying; the caller's 10 s providerRetryWaitCeilingMs refused it, so the provider did not retry)",
				errorRetryAfterMs: 30_000,
			}),
		).toContain("the caller's 10 s providerRetryWaitCeilingMs refused it");
	});
});

// The overview's status column and the request drawer's error section ask one
// question through one predicate: did this request fail. That is not the same
// as "did the provider send words about it" — a wait refused before any
// provider text exists is a failure whose only text is omp's own explanation,
// and testing the raw column labelled such a row OK beside a drawer that
// showed the refusal.
describe("hasRequestFailure", () => {
	it.each([
		["the provider's own words", { errorMessage: "503 overloaded", errorDisplayMessage: null }],
		[
			"omp's words alone",
			{
				errorMessage: null,
				errorDisplayMessage:
					"(server asked to wait 30 s before retrying; the caller's 10 s providerRetryWaitCeilingMs refused it, so the provider did not retry)",
			},
		],
	])("reads a row carrying %s as failed", (_name, row) => {
		expect(hasRequestFailure(row)).toBe(true);
		// And the section the badge promises has something to show.
		expect(formatRequestError({ ...row, errorRetryAfterMs: null })).not.toBeNull();
	});

	it("reads a row that carries neither as not failed", () => {
		const row = { errorMessage: null, errorDisplayMessage: null };
		expect(hasRequestFailure(row)).toBe(false);
		expect(formatRequestError({ ...row, errorRetryAfterMs: null })).toBeNull();
	});
});
