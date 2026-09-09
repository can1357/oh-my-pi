import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeReadPath, parseSince, scanFile } from "./audit";

describe("parseSince", () => {
	it("maps window suffixes to milliseconds", () => {
		expect(parseSince("12h")).toBe(12 * 3_600_000);
		expect(parseSince("3d")).toBe(3 * 24 * 3_600_000);
		expect(parseSince("1w")).toBe(7 * 24 * 3_600_000);
		expect(parseSince("w")).toBe(7 * 24 * 3_600_000);
		expect(parseSince("2mo")).toBe(60 * 24 * 3_600_000);
	});

	it("rejects unparseable windows", () => {
		expect(() => parseSince("soon")).toThrow();
		expect(() => parseSince("5x")).toThrow();
	});
});

describe("normalizeReadPath", () => {
	it("strips line/raw selectors from plain paths", () => {
		expect(normalizeReadPath("src/foo.ts:50-200")).toBe("src/foo.ts");
		expect(normalizeReadPath("src/foo.ts:50+10")).toBe("src/foo.ts");
		expect(normalizeReadPath("src/foo.ts:raw")).toBe("src/foo.ts");
		expect(normalizeReadPath("src/foo.ts:5-16,960-973")).toBe("src/foo.ts");
		expect(normalizeReadPath("src/foo.ts:2-4:raw")).toBe("src/foo.ts");
	});

	it("keeps internal URL schemes distinct instead of collapsing to the scheme", () => {
		expect(normalizeReadPath("artifact://37")).toBe("artifact://37");
		expect(normalizeReadPath("agent://h0qbtw5y/report")).toBe("agent://h0qbtw5y/report");
		expect(normalizeReadPath("artifact://37:50-100")).toBe("artifact://37");
	});

	it("leaves selector-free paths untouched", () => {
		expect(normalizeReadPath("docs/readme.md")).toBe("docs/readme.md");
	});
});

// ---------------------------------------------------------------------------
// scanFile contract on a synthetic session transcript

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
afterAll(() => fs.rm(tmpDir, { recursive: true, force: true }));

function asst(opts: {
	ts: number;
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number };
	content: unknown[];
	stopReason?: string;
}): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			model: "test-model",
			stopReason: opts.stopReason ?? "toolUse",
			timestamp: opts.ts,
			usage: {
				input: opts.usage.input,
				output: opts.usage.output,
				cacheRead: opts.usage.cacheRead ?? 0,
				cacheWrite: opts.usage.cacheWrite ?? 0,
				cost: { total: opts.usage.cost },
			},
			content: opts.content,
		},
	});
}

function toolResult(callId: string, text: string, ts: number, isError = false): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			isError,
			timestamp: ts,
			content: [{ type: "text", text }],
		},
	});
}

it("scanFile recovers usage, turns, spawns, residency, and pruned result sizes", async () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T10:00:00.000Z", title: "Test session" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "fix the bug", timestamp: 1000 } }),
		// req 1: reads a file (result re-paid by 2 later requests)
		asst({
			ts: 2000,
			usage: { input: 100, output: 10, cacheWrite: 50, cost: 0.5 },
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts:10-20" } }],
		}),
		toolResult("c1", "x".repeat(400), 2500), // ~100 tokens
		// req 2: spawns a task; its result was pruned and stores a placeholder
		asst({
			ts: 3000,
			usage: { input: 200, output: 20, cacheRead: 300, cost: 1.0 },
			content: [
				{
					type: "toolCall",
					id: "c2",
					name: "task",
					arguments: { agent: "task", tasks: [{ id: "FixParser", description: "Fix the parser" }] },
				},
			],
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "task",
				isError: false,
				timestamp: 3500,
				content: [{ type: "text", text: "[Output truncated - 1993 tokens]" }],
			},
		}),
		// second user turn + final answer with no tools
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "thanks, also re-read it", timestamp: 4000 },
		}),
		asst({
			ts: 5000,
			usage: { input: 400, output: 40, cacheRead: 600, cost: 2.0 },
			content: [
				{ type: "text", text: "All done." },
				{ type: "toolCall", id: "c3", name: "read", arguments: { path: "src/a.ts:raw" } },
			],
			stopReason: "stop",
		}),
		toolResult("c3", "y".repeat(200), 5500),
	];
	const file = path.join(tmpDir, "synthetic.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);

	const scan = await scanFile(file);
	if (!scan) throw new Error("scanFile returned undefined");

	// Real usage sums (not estimates).
	expect(scan.usage.requests).toBe(3);
	expect(scan.usage.input).toBe(700);
	expect(scan.usage.output).toBe(70);
	expect(scan.usage.cacheRead).toBe(900);
	expect(scan.usage.cacheWrite).toBe(50);
	expect(scan.usage.cost).toBeCloseTo(3.5);
	// Context peak = max single-request input+cacheRead+cacheWrite.
	expect(scan.contextPeak).toBe(1000);

	// Turn segmentation: 2 user turns; first turn carries 2 requests.
	expect(scan.turns.length).toBe(2);
	expect(scan.turns[0].requests).toBe(2);
	expect(scan.turns[0].cost).toBeCloseTo(1.5);
	expect(scan.turns[1].requests).toBe(1);

	// Both reads of src/a.ts group together despite different selectors, and
	// per-path residency weights each result by later requests: c1 (100 tok,
	// request 1 of 3) → ×2 = 200; c3 (50 tok, request 3 of 3) → ×0.
	expect(scan.readCounts.get("src/a.ts")?.count).toBe(2);
	expect(scan.readCounts.get("src/a.ts")?.residency).toBe(200);

	// Pruned task result recovers its true size from the placeholder.
	expect(scan.spawns.length).toBe(1);
	expect(scan.spawns[0].labels).toEqual(["FixParser"]);
	expect(scan.spawns[0].resultToks).toBe(1993);

	// Residency: c1 result (100 tok) lands at request 1 → re-paid by 2 later
	// requests; c3 result (50 tok) lands at request 3 → no later requests.
	expect(scan.toolAgg.get("read")?.residency).toBe(200);

	expect(scan.lastAssistantText).toBe("All done.");
	expect(scan.title).toBe("Test session");
});
