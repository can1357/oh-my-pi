/**
 * The MCP tool cache's cross-process ordering token must record when a
 * `tools/list` was ISSUED, not when its response came back.
 *
 * Several sessions (and separate CLI processes) share one `agent.db`, so the
 * only thing that orders two catalog writes is the token persisted on the row.
 * Sampling it at write time orders them by response latency instead of by
 * request order: a delayed answer to an EARLIER `tools/list` then carries the
 * LARGER token, outranks the newer catalog a faster later request already
 * persisted, and squats the row for the 30-day TTL with nothing to correct it.
 *
 * `test/mcp-tool-cache-empty.test.ts` pins that inversion at the cache's own
 * API. This file pins the half the cache cannot enforce for itself: that the
 * production caller genuinely captures the token BEFORE issuing its request.
 * The fixture holds its `tools/list` open, so a token sampled after the
 * response lands is measurably later than one sampled before the request.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache, toolCatalogObservedAt } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { isRecord, removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "gated-tools-list-mcp.ts");

function createFakeStorage(): AgentStorage & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const stub = {
		raw,
		getCache(key: string): string | null {
			return raw.get(key) ?? null;
		},
		setCache(key: string, value: string): void {
			raw.set(key, value);
		},
		setCacheIfMatches(key: string, expectedValue: string | null, value: string): boolean {
			if ((raw.get(key) ?? null) !== expectedValue) return false;
			raw.set(key, value);
			return true;
		},
	};
	return stub as unknown as AgentStorage & { raw: Map<string, string> };
}

/**
 * Poll a real-clock predicate.
 *
 * Deliberate real-clock wait: the state being awaited is a file written by a
 * spawned fixture process, so fake timers cannot drive it — they cannot advance
 * another process's clock. There is no in-process signal for "the server has
 * received the request", which is exactly the instant this test must observe.
 * The bound only fails a wedge; the loop exits on the first true reading.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}

describe("MCP tool cache request-time ordering token", () => {
	let workDir: string;
	let gatePath: string;
	let startedPath: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-order-"));
		gatePath = path.join(workDir, "release-tools-list");
		startedPath = path.join(workDir, "tools-list-started");
		fs.writeFileSync(startedPath, "");
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	function stdioConfig(): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_LIST_GATE: gatePath, OMP_TEST_LIST_STARTED: startedPath },
		};
	}

	it("skips the cache write when the ordering claim could not be reserved", async () => {
		// The manager samples a fresh reading when there is NO cache to write to.
		// Applying that same fallback to a cache's `undefined` erases the skip
		// sentinel and hands `set()` an unreserved token — the exact write the
		// sentinel exists to stop. Drive the real connect path with every CAS
		// losing, and assert nothing lands on the catalog row.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);
		// Sustained cross-process contention, as seen from inside one process.
		cache.observeCatalogAt = () => undefined;
		const manager = new MCPManager(workDir, cache);
		manager.setEmptyToolsetRetryScheduleForTests("0");

		try {
			void manager.connectServers({ gated: stdioConfig() }, {});
			expect(await waitFor(() => fs.readFileSync(startedPath, "utf8").trim().length > 0)).toBe(true);
			fs.writeFileSync(gatePath, "go");

			// The tools still register: only the PERSISTED catalog is skipped.
			expect(await waitFor(() => manager.getTools().length > 0)).toBe(true);

			// Give a would-be write every chance to land before asserting absence.
			await Bun.sleep(250);
			expect(storage.raw.get("mcp_tools:gated")).toBeUndefined();
		} finally {
			if (!fs.existsSync(gatePath)) fs.writeFileSync(gatePath, "go");
			await manager.disconnectAll();
		}
	}, 25_000);

	it("keeps the ordering mark past the catalog TTL for an unbounded request", async () => {
		// A `tools/list` has no maximum duration (`timeout: 0` disables it), so a
		// claim sized to the catalog TTL could expire while the request it orders
		// was still outstanding. The mark then vanished, and a process starting
		// afterwards floored BELOW the outstanding token.
		const expiries = new Map<string, number>();
		const rows = new Map<string, string>();
		const storage = {
			getCache: (key: string): string | null => rows.get(key) ?? null,
			setCache: (key: string, value: string, expiresAtSec: number): void => {
				rows.set(key, value);
				expiries.set(key, expiresAtSec);
			},
			setCacheIfMatches: (key: string, expected: string | null, value: string, expiresAtSec: number): boolean => {
				if ((rows.get(key) ?? null) !== expected) return false;
				rows.set(key, value);
				expiries.set(key, expiresAtSec);
				return true;
			},
		} as unknown as AgentStorage;
		const cache = new MCPToolCache(storage);

		expect(cache.observeCatalogAt("slow")).toBeDefined();

		const claimExpiry = expiries.get("mcp_tools_claim:slow");
		if (claimExpiry === undefined) throw new Error("expected the claim row to be written");
		// Still readable a year out, where the catalog's own 30-day TTL is not.
		const oneYearOut = Math.floor((Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000);
		expect(claimExpiry).toBeGreaterThan(oneYearOut);
	});

	it("outlasts more older writers than the attempt count", async () => {
		// A CAS loss proves only that a peer committed — never that its catalog is
		// newer. With a fixed bound, enough older writers committing in the
		// read/write window exhausted the attempts and abandoned a listing that
		// had genuinely succeeded, leaving the last OLDER toolset cached for the
		// full TTL. Every loss here is an older writer, so the loop has to keep
		// re-reading until it commits.
		const raw = new Map<string, { value: string; expiresAtSec: number }>();
		const visible = (key: string): string | null => {
			const row = raw.get(key);
			if (!row) return null;
			return row.expiresAtSec > Date.now() / 1000 ? row.value : null;
		};
		// One older peer commits into EVERY read window, well past any fixed bound.
		let peerWrites = 0;
		const olderPeers = 12;
		const base = Date.now();
		const storage = {
			getCache(key: string): string | null {
				const observed = visible(key);
				if (key === "mcp_tools:crowded" && peerWrites < olderPeers) {
					peerWrites++;
					raw.set(key, {
						// Strictly older than our write, so none of them may stand.
						value: JSON.stringify({
							version: 1,
							configHash: "",
							tools: [{ name: `older_${peerWrites}`, inputSchema: { type: "object" as const } }],
							writeStartedAt: base - 1000 - peerWrites,
						}),
						expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
					});
				}
				return observed;
			},
			setCache(key: string, value: string, expiresAtSec: number): void {
				raw.set(key, { value, expiresAtSec });
			},
			setCacheIfMatches(key: string, expectedValue: string | null, value: string, expiresAtSec: number): boolean {
				if (visible(key) !== expectedValue) return false;
				raw.set(key, { value, expiresAtSec });
				return true;
			},
		} as unknown as AgentStorage;

		const cache = new MCPToolCache(storage);
		await cache.set(
			"crowded",
			stdioConfig(),
			[{ name: "fresh_tool", description: "", inputSchema: { type: "object" as const } }],
			base + 5000,
		);

		const stored = raw.get("mcp_tools:crowded");
		expect(stored).toBeDefined();
		const payload = JSON.parse(stored?.value ?? "{}") as { tools: { name: string }[] };
		expect(payload.tools.map(tool => tool.name)).toEqual(["fresh_tool"]);
	});

	it("suppresses an older in-flight write after a reservation failure", async () => {
		// A reservation failure skips its own write, but the response still
		// OBSERVED the server later than anything already in flight. Returning
		// without recording that left an earlier request free to pass
		// `isCurrent()` — and `#writeOrdered()` inspects the catalog row, never
		// the claim — so it cached its superseded catalog for the full TTL.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);
		const config = stdioConfig();

		// The earlier request reserves a token, then parks in `hashConfig()`.
		const earlier = cache.observeCatalogAt("gated");
		expect(earlier).toBeDefined();

		// A NEWER request's response lands first and cannot reserve: sustained
		// contention, the case `observeCatalogAt` answers with `undefined`.
		await cache.set(
			"gated",
			config,
			[{ name: "fresh", description: "", inputSchema: { type: "object" as const } }],
			undefined,
		);

		// Now the earlier request's delayed response arrives.
		await cache.set(
			"gated",
			config,
			[{ name: "stale", description: "", inputSchema: { type: "object" as const } }],
			earlier,
		);

		// Pre-fix the superseded catalog landed and stood for 30 days.
		expect(storage.raw.get("mcp_tools:gated")).toBeUndefined();
	}, 25_000);

	it("stamps the cached row from before the tools/list, not from when its response arrived", async () => {
		const storage = createFakeStorage();
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		// Auto-retry would fire a second `tools/list` behind our back and write
		// the row from that later request; this server never lists empty, but
		// disabling the loop keeps the assertion about the connect path only.
		manager.setEmptyToolsetRetryScheduleForTests("0");

		try {
			void manager.connectServers({ gated: stdioConfig() }, {});

			// The fixture logs the request's arrival before it starts waiting, so
			// this is proof the `tools/list` is genuinely in flight.
			expect(await waitFor(() => fs.readFileSync(startedPath, "utf8").trim().length > 0)).toBe(true);

			// Everything from here on is strictly AFTER the request went out. A
			// token sampled when the response lands must exceed this reading; a
			// token sampled before the request must fall below it.
			const afterRequestIssued = toolCatalogObservedAt();

			fs.writeFileSync(gatePath, "go");
			// The cache write is fire-and-forget and awaits the config hash, so it
			// can still be pending when the tools are registered. Await the
			// CATALOG, not merely the row: `observeCatalogAt()` reserves its
			// ordering token on the row before the request goes out, so the key
			// exists from the claim onward and its presence no longer means the
			// write has landed.
			expect(
				await waitFor(() => {
					const pending = storage.raw.get("mcp_tools:gated");
					if (pending === undefined) return false;
					const seen: unknown = JSON.parse(pending);
					return isRecord(seen) && Array.isArray(seen.tools) && seen.tools.length > 0;
				}),
			).toBe(true);

			const row = storage.raw.get("mcp_tools:gated");
			const parsed: unknown = JSON.parse(row as string);
			if (!isRecord(parsed)) throw new Error("cached row must be an object");
			expect(parsed.tools).toHaveLength(1);
			const writeStartedAt = parsed.writeStartedAt;
			expect(typeof writeStartedAt).toBe("number");
			// The row's ordering token predates the request's release. Sampled at
			// write time it would sit after `afterRequestIssued` — the inversion
			// that lets a delayed stale response outrank a newer catalog.
			expect(writeStartedAt as number).toBeLessThan(afterRequestIssued);
		} finally {
			// Release a still-parked fixture so teardown cannot block on it.
			if (!fs.existsSync(gatePath)) fs.writeFileSync(gatePath, "go");
			await manager.disconnectAll();
		}
	}, 25_000);
});
