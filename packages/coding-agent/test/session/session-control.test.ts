import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import {
	clearSessionMetricsCache,
	type EnumerateOptions,
	enumerateSessions,
	isArchived,
	type SessionControlDeps,
	setArchived,
} from "@oh-my-pi/pi-coding-agent/session/session-control";
import { installStatsTestIsolation } from "../../../stats/test/helpers/temp-agent";

installStatsTestIsolation("@pi-session-control-");

let sessionDir: string;
let currentPath: string;
let otherPath: string;
let orphanPath: string;

function header(id: string, ts: string, cwd: string): string {
	return JSON.stringify({ type: "session", id, timestamp: ts, cwd });
}

function makeStats(
	entryId: string,
	sessionFile: string,
	input: number,
	output: number,
	cacheRead: number,
): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + output + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
	};
}

function makeRegistry(counts: { running: number; idle: number; parked: number }) {
	const refs: Array<{ status: string }> = [];
	for (let i = 0; i < counts.running; i++) refs.push({ status: "running" });
	for (let i = 0; i < counts.idle; i++) refs.push({ status: "idle" });
	for (let i = 0; i < counts.parked; i++) refs.push({ status: "parked" });
	return { list: () => refs };
}

beforeEach(async () => {
	clearSessionMetricsCache();
	sessionDir = mkdtempSync(join(tmpdir(), "sess-"));
	currentPath = join(sessionDir, "2024-01-01T00-00-00-000Z_cur.jsonl");
	otherPath = join(sessionDir, "2024-01-01T00-00-00-000Z_oth.jsonl");
	orphanPath = join(sessionDir, "2024-01-01T00-00-00-000Z_orp.jsonl");
	writeFileSync(currentPath, `${header("cur", "1970-01-01T00:00:01.000Z", "/tmp/proj")}\n`);
	writeFileSync(otherPath, `${header("oth", "1970-01-01T00:00:02.000Z", "/tmp/proj2")}\n`);
	writeFileSync(orphanPath, `${header("orp", "1970-01-01T00:00:03.000Z", "/tmp/proj3")}\n`);
	// Controlled modified times (seconds) for the "recent" sort.
	utimesSync(currentPath, 1, 5);
	utimesSync(otherPath, 2, 1);
	utimesSync(orphanPath, 3, 2);
	await initDb();
	await insertMessageStats([makeStats("e1", currentPath, 1000, 500, 200), makeStats("e2", otherPath, 200, 100, 50)]);
});

afterEach(() => {
	closeDb();
	rmSync(sessionDir, { recursive: true, force: true });
});

function deps(overrides: Partial<SessionControlDeps> = {}): SessionControlDeps {
	return {
		registry: makeRegistry({ running: 1, idle: 2, parked: 1 }),
		gate: { paused: false },
		session: { sessionFile: currentPath, model: "claude-opus-4" },
		currentSessionFile: currentPath,
		profile: "work",
		...overrides,
	};
}

function opts(overrides: Partial<EnumerateOptions> = {}, d?: SessionControlDeps): EnumerateOptions {
	return { cwd: sessionDir, sessionDir, deps: d ?? deps(), ...overrides };
}

describe("enumerateSessions", () => {
	it("marks the current session and distinguishes it from others", async () => {
		const rows = await enumerateSessions(opts());
		expect(rows.length).toBe(3);
		expect(rows.filter(r => r.isCurrent).length).toBe(1);
		const current = rows.find(r => r.isCurrent)!;
		expect(current.info.path).toBe(currentPath);
		expect(rows.find(r => r.info.path === otherPath)!.isCurrent).toBe(false);
	});

	it("exposes model/profile only for the current session", async () => {
		const rows = await enumerateSessions(opts());
		const cur = rows.find(r => r.isCurrent)!;
		const oth = rows.find(r => r.info.path === otherPath)!;
		expect(cur.model).toBe("claude-opus-4");
		expect(cur.profile).toBe("work");
		expect(oth.model).toBeUndefined();
		expect(oth.profile).toBeUndefined();
	});

	it("derives agent counts and live state from the injected registry (current only)", async () => {
		const rows = await enumerateSessions(opts());
		const cur = rows.find(r => r.isCurrent)!;
		const oth = rows.find(r => r.info.path === otherPath)!;
		expect(cur.agentCounts).toEqual({ running: 1, idle: 2, parked: 1 });
		expect(cur.liveState).toBe("streaming");
		expect(oth.agentCounts).toBeUndefined();
		expect(oth.liveState).toBeUndefined();
	});

	it("reports paused live state when the gate is paused", async () => {
		const rows = await enumerateSessions(opts({}, deps({ gate: { paused: true } })));
		expect(rows.find(r => r.isCurrent)!.liveState).toBe("paused");
	});

	it("flows cost/token data from the real stats DB", async () => {
		const rows = await enumerateSessions(opts());
		const cur = rows.find(r => r.isCurrent)!;
		const oth = rows.find(r => r.info.path === otherPath)!;
		expect(cur.cost).toBeGreaterThan(0);
		expect(cur.tokensIn).toBe(1000);
		expect(cur.tokensOut).toBe(500);
		expect(oth.cost).toBeGreaterThan(0);
		expect(oth.tokensIn).toBe(200);
		expect(oth.tokensOut).toBe(100);
	});

	it("leaves metrics undefined when no source is available (no fake zeros)", async () => {
		const rows = await enumerateSessions(opts());
		const orphan = rows.find(r => r.info.path === orphanPath)!;
		// No stats row inserted for the orphan session:
		expect(orphan.cost).toBeUndefined();
		expect(orphan.tokensIn).toBeUndefined();
		expect(orphan.tokensOut).toBeUndefined();
		// git status + checkpoint count are best-effort and unavailable here:
		expect(orphan.branch).toBeUndefined();
		expect(orphan.dirty).toBeUndefined();
		expect(orphan.checkpointCount).toBeUndefined();
	});

	describe("sorting", () => {
		it("recent orders by modified desc", async () => {
			const rows = await enumerateSessions(opts({ sort: "recent" }));
			expect(rows[0].info.path).toBe(currentPath); // modified 5 > others
		});
		it("created orders by created desc", async () => {
			const rows = await enumerateSessions(opts({ sort: "created" }));
			expect(rows[0].info.path).toBe(orphanPath); // created 3000 > others
		});
		it("cost orders by cost desc", async () => {
			const rows = await enumerateSessions(opts({ sort: "cost" }));
			expect(rows[0].info.path).toBe(currentPath); // more tokens => higher cost
		});
		it("agents orders by total agent count desc", async () => {
			const rows = await enumerateSessions(opts({ sort: "agents" }));
			expect(rows[0].info.path).toBe(currentPath); // only current has counts
		});
	});

	describe("filtering", () => {
		it("current returns only the current session", async () => {
			const rows = await enumerateSessions(opts({ filter: "current" }));
			expect(rows.length).toBe(1);
			expect(rows[0].isCurrent).toBe(true);
		});
		it("all returns every session", async () => {
			const rows = await enumerateSessions(opts({ filter: "all" }));
			expect(rows.length).toBe(3);
		});
		it("archived returns only archived sessions", async () => {
			await setArchived(otherPath, true);
			try {
				const rows = await enumerateSessions(opts({ filter: "archived" }));
				expect(rows.length).toBe(1);
				expect(rows[0].info.path).toBe(otherPath);
			} finally {
				await setArchived(otherPath, false);
			}
		});
		it("active excludes archived sessions", async () => {
			await setArchived(otherPath, true);
			try {
				const rows = await enumerateSessions(opts({ filter: "active" }));
				expect(rows.every(r => !r.archived)).toBe(true);
				expect(rows.find(r => r.info.path === otherPath)).toBeUndefined();
			} finally {
				await setArchived(otherPath, false);
			}
		});
	});
});

describe("archive sentinel", () => {
	it("roundtrips write/remove and isArchived reflects it", async () => {
		const p = join(sessionDir, "sentinel.jsonl");
		expect(isArchived(p)).toBe(false);
		await setArchived(p, true);
		expect(isArchived(p)).toBe(true);
		await setArchived(p, false);
		expect(isArchived(p)).toBe(false);
	});
});
