import { describe, expect, it } from "bun:test";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-api-v1-");

function makeMessage(timestamp: number, entryId: string, folder = "/tmp/project"): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder,
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
	};
}

function makeError(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/error-session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "error",
		errorMessage: `failure ${entryId}`,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
	};
}

describe("API v1 meta endpoint", () => {
	it("returns version, ranges, and endpoints", async () => {
		const res = await handleApi(new Request("http://stats.test/api/v1/meta"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.version).toBe(1);
		expect(body.ranges).toContain("24h");
		expect(body.ranges).toContain("7d");
		expect(body.ranges).toContain("all");
		expect(body.endpoints).toContain("/api/v1/meta");
		expect(body.endpoints).toContain("/api/v1/overview");
		expect(body.serverTime).toBeGreaterThan(0);
	});
});

describe("API v1 overview endpoint", () => {
	it("returns overview stats with default range", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "v1-overview-1"),
			makeMessage(now - 48 * 60 * 60 * 1000, "v1-overview-old"),
		]);

		const res = await handleApi(new Request("http://stats.test/api/v1/overview?range=24h"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.overall).toBeDefined();
		expect((body.overall as Record<string, number>).totalRequests).toBe(1);
	});
});

describe("API v1 errors endpoint", () => {
	it("returns errors as MessageStats[]", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([makeError(now, "v1-err-1"), makeError(now - 1000, "v1-err-2")]);

		const res = await handleApi(new Request("http://stats.test/api/v1/errors?limit=20"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as MessageStats[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(2);
		expect(body[0].entryId).toBe("v1-err-1");
	});
});

describe("API v1 requests endpoint with real pagination", () => {
	it("returns requests with real total count and offset", async () => {
		await initDb();
		const now = Date.now();
		const msgs = Array.from({ length: 10 }, (_, i) => makeMessage(now - i * 1000, `v1-req-${i}`));
		insertMessageStats(msgs);

		const res = await handleApi(new Request("http://stats.test/api/v1/requests?limit=3&offset=0"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { requests: MessageStats[]; total: number };
		expect(body.requests.length).toBe(3);
		expect(body.total).toBe(10);
		expect(body.requests[0].entryId).toBe("v1-req-0");

		const page2 = await handleApi(new Request("http://stats.test/api/v1/requests?limit=3&offset=3"));
		const body2 = (await page2.json()) as { requests: MessageStats[]; total: number };
		expect(body2.requests.length).toBe(3);
		expect(body2.total).toBe(10);
		expect(body2.requests[0].entryId).toBe("v1-req-3");
	});

	it("filters requests by range for both total and page", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "v1-range-recent"),
			makeMessage(now - 48 * 60 * 60 * 1000, "v1-range-2d-old"),
		]);

		const res = await handleApi(new Request("http://stats.test/api/v1/requests?range=24h&limit=10&offset=0"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { requests: MessageStats[]; total: number };
		expect(body.total).toBe(1);
		expect(body.requests).toHaveLength(1);
		expect(body.requests[0].entryId).toBe("v1-range-recent");

		const all = await handleApi(new Request("http://stats.test/api/v1/requests?range=all&limit=10&offset=0"));
		const bodyAll = (await all.json()) as { requests: MessageStats[]; total: number };
		expect(bodyAll.total).toBe(2);
		expect(bodyAll.requests).toHaveLength(2);
	});
});

describe("API v1 404 for unknown endpoint", () => {
	it("returns 404 for unknown v1 endpoint", async () => {
		const res = await handleApi(new Request("http://stats.test/api/v1/unknown"));
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, string>;
		expect(body.error).toBe("Unknown v1 endpoint");
	});
});

describe("API v1 CORS headers", () => {
	it("returns CORS headers on v1 responses", async () => {
		const res = await handleApi(new Request("http://stats.test/api/v1/meta"));
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
		expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
	});
});

describe("API v1 range parameter validation", () => {
	it("rejects unknown range with 400", async () => {
		const res = await handleApi(new Request("http://stats.test/api/v1/overview?range=invalid"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error)).toContain("Invalid range");
	});
});
