/**
 * Contracts for a transcript holding an entry nested deeper than `JSON.stringify`
 * recurses (Bun's gives out at 40,000 levels; `JSON.parse` reads millions): the
 * dashboard routes answer with it, the trace and the parser measure it, and the
 * Spotlight ingest reads its tool call.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { argumentTokens, callTarget, SPOTLIGHT_TARGET_CHARS } from "@oh-my-pi/omp-stats/spotlight-arguments";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { DEEP_LEVELS, nestedChainJson, nestingOf } from "../../ai/test/helpers/deep-nesting";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-deep-entry-");

const T = 1_700_000_000_000;
/** The JSON text of `{ "next": … }` nested {@link DEEP_LEVELS} levels around `{ "leaf": "bottom" }`. */
const DEEP_JSON = nestedChainJson();

const iso = (ms: number) => new Date(ms).toISOString();

/** A transcript whose tool call `call1` has arguments, and whose result `r1` has details, nested {@link DEEP_LEVELS} levels. */
async function writeDeepFixture(): Promise<string> {
	const file = path.join(getSessionsDir(), "--tmp--deep--", "1700000000000_deep.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "deep", timestamp: iso(T), cwd: "/tmp/deep" }),
		JSON.stringify({
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: iso(T + 2000),
			message: {
				role: "assistant",
				model: "m-1",
				provider: "p",
				api: "openai-completions",
				timestamp: T + 1000,
				duration: 1000,
				completedAt: T + 2000,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call1", name: "inspect", arguments: "DEEP" }],
			},
		}).replace('"DEEP"', DEEP_JSON),
		JSON.stringify({
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: iso(T + 3000),
			message: {
				role: "toolResult",
				toolCallId: "call1",
				toolName: "inspect",
				timestamp: T + 3000,
				isError: false,
				content: [{ type: "text", text: "inspected" }],
				details: "DEEP",
			},
		}).replace('"DEEP"', DEEP_JSON),
	];
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

describe("a transcript holding an entry nested deeper than JSON.stringify recurses", () => {
	it("the span drawer's entry route answers with the whole entry", async () => {
		const file = await writeDeepFixture();

		const response = await handleApi(
			new Request(`http://stats.test/api/session/entry?file=${encodeURIComponent(file)}&id=r1`),
		);

		expect(response.status).toBe(200);
		const { entry } = (await response.json()) as { entry: { id: string; message: { details: unknown } } };
		expect(entry.id).toBe("r1");
		expect(nestingOf(entry.message.details)).toEqual({ levels: DEEP_LEVELS, bottom: { leaf: "bottom" } });
	}, 20_000);

	it("the request detail route answers with the whole request", async () => {
		const file = await writeDeepFixture();
		await initDb();
		const parsed = await parseSessionFile(file);
		insertMessageStats(parsed.stats);
		const [row] = getRecentRequests(1);

		const response = await handleApi(new Request(`http://stats.test/api/request/${row.id}`));

		expect(response.status).toBe(200);
		const { output } = (await response.json()) as { output: { content: { arguments: unknown }[] } };
		expect(nestingOf(output.content[0].arguments)).toEqual({ levels: DEEP_LEVELS, bottom: { leaf: "bottom" } });
	}, 20_000);

	it("the trace shows the head of the tool call's arguments", async () => {
		const file = await writeDeepFixture();

		const response = await handleApi(
			new Request(`http://stats.test/api/session/trace?file=${encodeURIComponent(file)}`),
		);

		expect(response.status).toBe(200);
		const trace = (await response.json()) as { tracks: { spans: { kind: string; detail?: string }[] }[] };
		const tool = trace.tracks[0].spans.find(span => span.kind === "tool");
		expect(tool?.detail).toBe(`${DEEP_JSON.slice(0, 159)}…`);
	}, 20_000);

	it("the parser counts the tool call's argument characters", async () => {
		const parsed = await parseSessionFile(await writeDeepFixture());

		expect(parsed.toolCalls.map(call => [call.toolCallId, call.argsChars])).toEqual([["call1", DEEP_JSON.length]]);
	}, 20_000);

	it("the Spotlight ingest reads the tool call's target and argument tokens", () => {
		const args = JSON.parse(DEEP_JSON);

		expect(callTarget("inspect", args)).toBe(DEEP_JSON.slice(0, SPOTLIGHT_TARGET_CHARS));
		expect(argumentTokens(args)).toEqual(["leaf=bottom"]);
	}, 20_000);
});
