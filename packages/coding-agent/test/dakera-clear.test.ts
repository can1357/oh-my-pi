import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { dakeraBackend } from "@oh-my-pi/pi-coding-agent/dakera/backend";
import { DakeraApi } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";
import { DakeraSessionState, setDakeraSessionState } from "@oh-my-pi/pi-coding-agent/dakera/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { logger } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/**
 * Regression coverage for backend `clear()`. The wipe is drain-style with
 * offset paging: forget a page, re-list, advance the window when nothing new
 * is addressable, stop past the end of the store. The guard that stops it must
 * count *newly attempted ids*, not page size — a listing pinned at the cap by a
 * few undeletable rows still hides deletable rows behind them, and stopping
 * there (the previous "page stopped shrinking" check) abandoned the wipe after
 * one unaddressable row.
 *
 * These drive `dakeraBackend.clear()` against a fake server with a mutable
 * listing: an in-test copy of the loop would only ever prove the copy.
 */

const BASE_URL = "http://dakera.local";
const PAGE_LIMIT = 1000;
/** Mirrors CLEAR_MAX_ROWS in backend.ts; only an id-minting server reaches it. */
const MAX_ROWS = 100_000;

/**
 * Fake Dakera server. `live` is the row set; forgets honor the `memory_ids`
 * filter except for ids matching `undeletable`, simulating rows the API cannot
 * remove (server-side pins, tombstones). `regrow` mints fresh ids after each
 * forget, simulating a server that rewrites its own store. A row may carry
 * `tags` — under a shared agent id, `clear()` must only forget tagged rows.
 */
class FakeServer {
	listCalls = 0;
	forgetCalls = 0;
	forgetRequests: string[][] = [];
	live: Array<string | { id: string; tags?: string[] }> = [];
	undeletable: RegExp = /__never__$/;
	regrow = false;
	/** Serve rows without ids instead of `live` — tests the id-filtering guard. */
	idless = false;
	/** Simulate a server or proxy that drops the `offset` query — page one replays forever. */
	ignoreOffset = false;
	#mint = 0;

	install(): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = new URL(String(input));
				const path = url.pathname;
				if (path.endsWith("/memories")) {
					this.listCalls++;
					const offset = this.ignoreOffset ? 0 : Number(url.searchParams.get("offset") ?? "0");
					const rows = this.idless
						? [{ content: "row the server never gave an id" }]
						: this.live
								.slice(offset, offset + PAGE_LIMIT)
								.map(entry => (typeof entry === "string" ? { id: entry, content: `memory ${entry}` } : entry));
					return new Response(JSON.stringify({ memories: rows }), { status: 200 });
				}
				if (path === "/v1/memory/forget") {
					this.forgetCalls++;
					// Parse the real request body so the actual client path runs:
					// the ids the backend asked to forget are the ones we remove.
					const body = JSON.parse(String(init?.body)) as { memory_ids?: string[] };
					this.#applyForget(body.memory_ids ?? []);
					return new Response(JSON.stringify({ deleted_count: body.memory_ids?.length ?? 0 }), { status: 200 });
				}
				return new Response("{}", { status: 404 });
			}),
		);
	}

	/** Remove the requested ids, honoring rows the API cannot address. */
	#applyForget(ids: string[]): void {
		this.forgetRequests.push(ids);
		const rowId = (entry: string | { id: string }): string => (typeof entry === "string" ? entry : entry.id);
		this.live = this.live.filter(entry => !ids.includes(rowId(entry)) || this.undeletable.test(rowId(entry)));
		if (this.regrow) {
			this.live = Array.from({ length: PAGE_LIMIT }, (_, i) => `gen${this.#mint++}-m${i}`);
		}
	}
}

/** A live session state with dirty cursors, installed on a bare session. */
function dakeraSession(retainTags?: string[]): { session: AgentSession; state: DakeraSessionState } {
	const config = loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": BASE_URL }));
	const state = new DakeraSessionState({
		sessionId: "sess-clear",
		client: new DakeraApi({ baseUrl: config.apiUrl ?? BASE_URL }),
		agentId: "omp",
		retainTags,
		config,
		session: {
			sessionManager: {
				getSessionId: () => "sess-clear",
				getEntries: () => [],
			},
		} as unknown as AgentSession,
	});
	// Dirty cursors: any clear that reaches a server must reset them.
	state.hasRecalledForFirstTurn = true;
	state.lastRetainedTurn = 7;
	const session = {} as AgentSession;
	setDakeraSessionState(session, state);
	return { session, state };
}

/** Messages logged at warn level during `run`. */
async function warnings(run: () => Promise<void>): Promise<string> {
	const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	await run();
	return spy.mock.calls.map(call => String(call[0])).join("\n");
}

describe("dakeraBackend.clear", () => {
	let server: FakeServer;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drains pages until the listing comes back empty", async () => {
		server = new FakeServer();
		server.install();
		server.live = Array.from({ length: 1500 }, (_, i) => `m${i}`);
		const { session, state } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.live).toEqual([]);
		// page(1000) → forget → page(500) → forget → empty page stops the loop.
		expect(server.listCalls).toBe(3);
		expect(server.forgetRequests.map(ids => ids.length)).toEqual([1000, 500]);
		expect(logged).toBe("");
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRetainedTurn).toBe(0);
	});

	// Regression for the old 20-pass cap: a store larger than 20 pages must still
	// drain completely. clear() is a wipe, and truncating it at a pass count left
	// every row past the cap in place while reporting success.
	it("drains a store larger than any pass count", async () => {
		server = new FakeServer();
		server.install();
		server.live = Array.from({ length: 21_000 }, (_, i) => `m${i}`);
		const { session, state } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.live).toEqual([]);
		// 21 full pages, then the empty listing that ends the drain.
		expect(server.forgetCalls).toBe(21);
		expect(logged).toBe("");
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("reports an empty store without touching the server's rows", async () => {
		server = new FakeServer();
		server.install();
		const { session, state } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.listCalls).toBe(1);
		expect(server.forgetCalls).toBe(0);
		expect(logged).toContain("agent omp had no memories to clear");
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("keeps draining while the head is pinned and the page stays at the cap", async () => {
		server = new FakeServer();
		server.install();
		// 500 undeletable rows ahead of 1500 deletable ones: every listing is
		// pinned at the 1000 cap, so the old size comparison stopped after the
		// first forget and left 1500 memories behind. The deletion guard only
		// compares *new* ids, so the drain now walks the whole deletable tail.
		server.live = [
			...Array.from({ length: 500 }, (_, i) => `pin${i}`),
			...Array.from({ length: 1500 }, (_, i) => `del${i}`),
		];
		server.undeletable = /^pin/;
		const { session } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.live).toEqual(Array.from({ length: 500 }, (_, i) => `pin${i}`));
		expect(server.forgetRequests.map(ids => ids.length)).toEqual([1000, 500, 500]);
		// 2000 rows were addressed (1500 deleted, 500 pinned), 500 remain.
		expect(logged).toContain("clear stopped with 500 rows left after 2000 forgotten");
		expect(logged).toContain("forgotten rows keep coming back");
	});

	it("stops on a page of rows the server cannot address", async () => {
		server = new FakeServer();
		server.install();
		server.live = ["m0undel", "m1", "m2"];
		server.undeletable = /undel$/;
		const { session, state } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.live).toEqual(["m0undel"]);
		expect(server.forgetRequests.map(ids => ids.length)).toEqual([3]);
		expect(logged).toContain("clear stopped with 1 rows left after 3 forgotten");
		// The wipe still resets cursors: what remains was never session content.
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("stops immediately on idless rows instead of re-listing them forever", async () => {
		server = new FakeServer();
		server.install();
		server.idless = true;
		const { session, state } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		// One listing: there is nothing to forget, so a second cannot help.
		expect(server.listCalls).toBe(1);
		expect(server.forgetCalls).toBe(0);
		expect(logged).toContain("clear stopped with 1 rows left after 0 forgotten");
		expect(logged).toContain("the listing carried no memory ids");
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("stops at the row budget when the server re-grows its store", async () => {
		server = new FakeServer();
		server.install();
		server.regrow = true;
		server.live = Array.from({ length: PAGE_LIMIT }, (_, i) => `gen0-m${i}`);
		const { session } = dakeraSession();

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		// Every pass forgets a full page of ids it has never seen, so the store
		// never drains and never stops shrinking — only the row budget ends it.
		// MAX_ROWS is a multiple of PAGE_LIMIT, so it takes exactly that many pages.
		expect(server.forgetCalls).toBe(MAX_ROWS / PAGE_LIMIT);
		expect(logged).toContain("anti-runaway budget was reached");
	});
	// Under a shared agent id (global / per-project-tagged scoping) the listing
	// carries other projects' rows: the wipe must forget only rows tagged with
	// this project's retain tag, stop cleanly when no tagged rows remain, and
	// never report the survivors as a residue of this wipe.
	it("forgets only this project's tagged rows under a shared agent id", async () => {
		server = new FakeServer();
		server.install();
		server.live = [
			{ id: "mine-1", tags: ["project:alpha"] },
			{ id: "mine-2", tags: ["project:alpha", "extra"] },
			{ id: "other-1", tags: ["project:beta"] },
			{ id: "untagged" },
		];
		const { session } = dakeraSession(["project:alpha"]);

		const logged = await warnings(() => dakeraBackend.clear("", "", session));
		expect(server.forgetRequests).toEqual([["mine-1", "mine-2"]]);
		expect(server.live).toEqual([{ id: "other-1", tags: ["project:beta"] }, { id: "untagged" }]);
		// Page one forgets both tagged rows, page two is foreign-only (advance),
		// page three is past the end — clean stop.
		expect(server.listCalls).toBe(3);
		expect(logged).toBe("");
	});

	// The gap offset-paging closes: under a tag scope, foreign rows are never
	// deleted, so page one stays pinned at the cap and this project's rows
	// behind them are invisible to a limit-only walk — clear() would report
	// "rows keep coming back" while the project's own memories survive.
	it("reaches tagged rows buried behind a full page of foreign rows", async () => {
		server = new FakeServer();
		server.install();
		server.live = [
			...Array.from({ length: 1200 }, (_, i) => ({ id: `foreign-${i}`, tags: ["project:beta"] })),
			{ id: "mine-late", tags: ["project:alpha"] },
		];
		const { session } = dakeraSession(["project:alpha"]);

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.forgetRequests).toEqual([["mine-late"]]);
		expect(server.live.some(row => typeof row !== "string" && row.id === "mine-late")).toBe(false);
		expect(server.live).toHaveLength(1200);
		expect(logged).toBe("");
	});

	// A server or proxy that drops the `offset` query replays page one forever;
	// the drain must detect the repeat and stop instead of spinning. Page one's
	// scoped rows are still forgotten before the stop.
	it("stops with a reason when the server ignores the offset parameter", async () => {
		server = new FakeServer();
		server.install();
		server.ignoreOffset = true;
		server.live = [
			{ id: "mine-1__never__", tags: ["project:alpha"] },
			{ id: "foreign-1", tags: ["project:beta"] },
			{ id: "foreign-2", tags: ["project:beta"] },
		];
		const { session } = dakeraSession(["project:alpha"]);

		const logged = await warnings(() => dakeraBackend.clear("", "", session));

		expect(server.forgetRequests).toEqual([["mine-1__never__"]]);
		expect(server.live).toHaveLength(3); // the undeletable scoped row and both foreign rows survive
		expect(logged).toContain("the listing ignored its offset");
		expect(logged).toContain("1 rows left");
	});
});
