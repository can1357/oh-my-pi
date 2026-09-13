/**
 * Regression test for the whole-session MCP outage: a successful-but-empty
 * `tools/list` during an aggregating gateway's cold-start warmup left the
 * session with zero MCP tools for its entire lifetime.
 *
 * Verbatim repro (see fixtures/warmup-empty-tools-mcp.ts): a healthy stdio MCP
 * server answers its first `tools/list` with `{"tools":[]}` (a 200, not an
 * error), then advertises its real tools on the next call. The connection
 * never drops, so recovery cannot come from the reconnect path — it must come
 * from an in-session re-list.
 *
 * Contracts defended:
 *   1. Auto-heal on connect: a connected server that first lists empty is
 *      re-listed on a bounded backoff; once its tools appear they are
 *      registered and `#onToolsChanged` fires — no reconnect, no user action.
 *   2. The empty pass is never cached (no 30-day poison) — asserted via the
 *      tool cache staying empty for that server after the empty list.
 *   3. `/mcp refresh` primitive: `refreshAllTools()` re-lists every live
 *      connection and picks up tools that appeared after the initial connect.
 *
 * Timing note: this is a real subprocess integration test. The auto-retry
 * backoff runs on the platform clock inside a spawned MCP server's transport,
 * so fake timers cannot drive it. Rather than sleep-poll, tests await the
 * manager's own `#onToolsChanged` signal directly; the `it(…, timeout)` bound
 * fails the test if the heal never fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPLoadResult } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "warmup-empty-tools-mcp.ts");
const RESOURCE_ONLY_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "resource-only-mcp.ts");
const BUN_EXEC = process.execPath;
const PROBE_PATH = path.join(import.meta.dir, "fixtures", "warmup-disconnect-exit-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

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

describe("MCP empty-toolset warmup recovery", () => {
	let workDir: string;
	let listLog: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-warmup-"));
		listLog = path.join(workDir, "lists.log");
		fs.writeFileSync(listLog, "");
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	// Construct a manager with a per-instance retry schedule instead of mutating
	// the process-global `OMP_MCP_EMPTY_RETRY_MS`. The default `"20"` keeps the
	// auto-retry backoff tiny so a heal fires promptly instead of waiting out the
	// production schedule; `"0"` disables auto-retry. Scoping the override to the
	// instance is what makes this file full-suite-safe: a sibling MCP suite
	// constructing a manager during our async window sees the real schedule, not
	// ours.
	function makeManager(retryMs = "20", cache: MCPToolCache | null = null): MCPManager {
		const manager = new MCPManager(workDir, cache);
		manager.setEmptyToolsetRetryScheduleForTests(retryMs);
		return manager;
	}

	function stdioConfig(): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
		};
	}

	/**
	 * Connect and wait for the server to actually be attached.
	 *
	 * `connectServers` deliberately returns after {@link STARTUP_TIMEOUT_MS}
	 * (250ms) and leaves a slower connect in flight, so its resolution is NOT
	 * the signal that a server is up — on a loaded machine a spawned fixture
	 * needs longer than that and the call returns `connectedServers: []` with
	 * no error. Anything asserting post-connect state must gate on the
	 * `connected` event instead, or it is timing out against a production
	 * constant rather than testing behaviour.
	 */
	async function connectAndAttach(
		manager: MCPManager,
		configs: Record<string, MCPStdioServerConfig>,
	): Promise<MCPLoadResult> {
		const names = new Set(Object.keys(configs));
		const attached = Promise.withResolvers<void>();
		const stop = manager.addConnectionStatusListener(event => {
			if (event.type !== "connected" && event.type !== "failed") return;
			names.delete(event.serverName);
			if (names.size === 0) attached.resolve();
		});
		try {
			const result = await manager.connectServers(configs, {});
			if (Object.keys(configs).every(name => result.connectedServers.includes(name))) return result;
			await attached.promise;
			return result;
		} finally {
			stop();
		}
	}

	function warmupTools(manager: MCPManager): { name: string }[] {
		return manager.getTools().filter(t => t.name.startsWith("mcp__warmup_"));
	}

	it("scopes the retry schedule per manager without mutating the process-global env", async () => {
		// Full-suite-safety contract: shrinking the auto-retry backoff for a test
		// must not touch `OMP_MCP_EMPTY_RETRY_MS`. Mutating it is process-global,
		// so a sibling MCP suite constructing a manager during our async window
		// would inherit our tiny (or disabled) schedule and flake. Construct a
		// manager with a fast per-instance schedule, heal through it, and assert
		// the global env is exactly what it was before.
		const before = Bun.env.OMP_MCP_EMPTY_RETRY_MS;
		const manager = makeManager("20");

		const healed = Promise.withResolvers<void>();
		manager.setOnToolsChanged(tools => {
			if (tools.filter(t => t.name.startsWith("mcp__warmup_")).length === 1) healed.resolve();
		});

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			// The per-instance override drove the heal — proof the fast schedule
			// took effect without any env mutation.
			await healed.promise;
			expect(warmupTools(manager)).toHaveLength(1);
			expect(Bun.env.OMP_MCP_EMPTY_RETRY_MS).toBe(before);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("auto-heals a session that connected during the empty-list window", async () => {
		const storage = createFakeStorage();
		const manager = makeManager("20", new MCPToolCache(storage));

		// Await the real signal the heal emits rather than sleep-polling: resolve
		// once #onToolsChanged reports the warmed tool registered.
		const healed = Promise.withResolvers<void>();
		const toolsChangedCounts: number[] = [];
		manager.setOnToolsChanged(tools => {
			const warmed = tools.filter(t => t.name.startsWith("mcp__warmup_")).length;
			toolsChangedCounts.push(warmed);
			if (warmed === 1) healed.resolve();
		});

		try {
			// Initial connect lands in the empty window: 0 tools, but connected.
			const result = await connectAndAttach(manager, { warmup: stdioConfig() });
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);

			// The empty pass must never become an authoritative cached toolset
			// (that is the 30-day poison). An invalidation marker may be stored,
			// but no CATALOG row may carry tools. Ordering-claim rows are keyed
			// separately and hold only a token, so they are not catalogs.
			for (const [key, value] of storage.raw.entries()) {
				if (!key.startsWith("mcp_tools:")) continue;
				const parsed: unknown = JSON.parse(value);
				const tools = parsed && typeof parsed === "object" && "tools" in parsed ? parsed.tools : undefined;
				expect(tools).toEqual([]);
			}

			// Auto-retry re-lists and registers the warmed tool with no reconnect
			// and no user action.
			await healed.promise;

			expect(warmupTools(manager)).toHaveLength(1);
			// The heal fired #onToolsChanged with the populated set.
			expect(toolsChangedCounts.some(count => count === 1)).toBe(true);
			// The server never dropped — recovery came from a re-list, not a
			// reconnect.
			expect(manager.getConnectionStatus("warmup")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("re-lists live connections on refreshAllTools (/mcp refresh primitive)", async () => {
		// Disable auto-retry so the ONLY thing that can pick up the warmed tool
		// is the explicit refresh — isolates the manual-recovery contract.
		const manager = makeManager("0");

		try {
			const result = await connectAndAttach(manager, { warmup: stdioConfig() });
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);
			// With auto-retry off, the empty toolset stands until we refresh.
			expect(warmupTools(manager)).toEqual([]);

			await manager.refreshAllTools();

			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("stops re-listing once a sanitized-name server recovers (owner-count, not name-prefix)", async () => {
		// Server name `warmup-1` sanitizes to `warmup` for tool names (the `-1`
		// collapses to `_`, then the trailing `_` is stripped), so its tools
		// register as `mcp__warmup_*`. A `mcp__${name}_` = `mcp__warmup-1_`
		// ownership prefix therefore never matches its own tools, so the retry
		// loop's success guard would stay 0 forever and burn the whole backoff
		// (~5 redundant re-lists) before mislogging "retry exhausted" — despite
		// recovery. Owner-matching via `mcpServerName` is what makes the loop
		// terminate. The digit-free tool names keep the tool segment stable, so
		// the ONLY moving part under test is the server-segment ownership match.
		const manager = makeManager();

		const healed = Promise.withResolvers<void>();
		manager.setOnToolsChanged(tools => {
			if (tools.filter(t => t.mcpServerName === "warmup-1").length === 1) healed.resolve();
		});

		try {
			const result = await connectAndAttach(manager, { "warmup-1": stdioConfig() });
			expect(result.tools.filter(t => t.mcpServerName === "warmup-1")).toEqual([]);

			// Recovery still registers the tool — the bug is in the loop's
			// termination signal, not tool ownership on the register path.
			await healed.promise;
			expect(manager.getTools().filter(t => t.mcpServerName === "warmup-1")).toHaveLength(1);

			// Settle well past the full override schedule ([20,40,80,160,320]ms,
			// cumulative 620ms) so a non-terminating loop would have exhausted it.
			await Bun.sleep(900);

			// The loop terminated after the first re-list that produced a tool:
			// one empty list on connect + one recovery list = 2. The prefix bug
			// never early-returns, so it re-lists on every delay (1 + 5 = 6).
			const lists = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			expect(lists).toHaveLength(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("coalesces concurrent refreshes for the same connection onto one tools/list", async () => {
		// A manual `/mcp refresh` overlapping the automatic empty-toolset re-list
		// must not each fire their own `tools/list`. Two concurrent
		// `refreshServerTools` for the same live connection share one in-flight
		// request; without the guard each clears `connection.tools` and re-lists
		// independently, and an older response can overwrite a newer one.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			// Connect listed once (empty). Baseline.
			const listsAfterConnect = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			expect(listsAfterConnect).toHaveLength(1);

			// Fire two refreshes in the same tick. The second must observe the
			// first's in-flight promise and reuse it.
			await Promise.all([manager.refreshServerTools("warmup"), manager.refreshServerTools("warmup")]);

			const listsAfterRefresh = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			// Coalesced: exactly one additional tools/list. Pre-fix: two.
			expect(listsAfterRefresh).toHaveLength(2);
			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("discards a stale empty re-list once the connection was replaced (no toolless overwrite)", async () => {
		// Reproduces the stale-overwrite race: an empty `tools/list` that was in
		// flight against the ORIGINAL connection lands after a reconnect+refresh
		// already recovered populated tools under the same name. Applying the
		// stale `[]` unconditionally would wipe the recovered tools permanently.
		// The connection-identity guard drops the response instead.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const original = manager.getConnection("warmup");
			if (!original) throw new Error("expected an initial connection");

			// Gate an empty `tools/list` on the ORIGINAL connection: it enters the
			// request, then parks until we release it — standing in for the
			// auto-retry loop's re-list that raced the manual recovery.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const realRequest = original.transport.request.bind(original.transport);
			original.transport.request = (<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
				if (method === "tools/list") {
					entered.resolve();
					return gate.promise.then(() => ({ tools: [] }) as T);
				}
				return realRequest<T>(method, params);
			}) as typeof original.transport.request;

			const staleReList = manager.refreshServerTools("warmup");
			// Await the real signal that the stale re-list reached its parked
			// request, rather than guessing a delay, before replacing the
			// connection out from under it.
			await entered.promise;

			// Replace the connection under the same name (disconnect + reconnect),
			// then recover real tools on the replacement.
			await manager.disconnectServer("warmup");
			await connectAndAttach(manager, { warmup: stdioConfig() });
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toHaveLength(1);
			const replacement = manager.getConnection("warmup");
			expect(replacement).not.toBe(original);

			// Release the stale empty response. It must NOT overwrite the recovered
			// tools — the guard sees the connection is no longer current — and the
			// refresh must not report success for a response it never applied.
			gate.resolve();
			await expect(staleReList).rejects.toThrow(/replaced while refreshing tools/);

			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("abandons a retry loop whose connection was replaced under the same name", async () => {
		// A disconnect+reconnect under one name does not bump `#epoch`, and
		// `disconnectServer` drops the pending-retry marker, so the replacement
		// arms its own loop. A loop bound only by NAME therefore survives the
		// swap and keeps re-listing against a connection it never owned —
		// overlapping the replacement's own `tools/list` calls, and letting the
		// old loop's cleanup clear the new loop's marker. The loop has to stop on
		// connection identity, not on the name still being connected.
		//
		// Every server here lists `[]` forever, so `#serverToolCount` can never
		// be what ends the loop — only the identity check can.
		const alwaysEmpty = (): MCPStdioServerConfig => ({
			...stdioConfig(),
			env: { OMP_TEST_TOOLS_PER_LIST: "0", OMP_TEST_LIST_LOG: listLog },
		});
		const manager = makeManager("600");

		try {
			await connectAndAttach(manager, { warmup: alwaysEmpty() });
			const original = manager.getConnection("warmup");
			if (!original) throw new Error("expected an initial connection");

			// Park a re-list inside the ORIGINAL connection so the swap lands while
			// the loop is mid-iteration. Parked in its backoff instead, a
			// disconnect would cancel the wait and the loop would exit for a
			// different reason, never reaching the identity check. Whichever
			// iteration this wrap catches is the one that parks, so a slow connect
			// cannot miss the window.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const realRequest = original.transport.request.bind(original.transport);
			original.transport.request = (<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
				if (method === "tools/list") {
					entered.resolve();
					return gate.promise.then(() => ({ tools: [] }) as T);
				}
				return realRequest<T>(method, params);
			}) as typeof original.transport.request;

			await entered.promise;

			// Disable auto-retry before the replacement connects, so the only loop
			// in play is the original's — the running loop already captured its
			// own schedule, so this cannot shorten or stop it.
			manager.setEmptyToolsetRetryScheduleForTests("0");
			await manager.disconnectServer("warmup");
			await connectAndAttach(manager, { warmup: alwaysEmpty() });
			const replacement = manager.getConnection("warmup");
			if (!replacement) throw new Error("expected a replacement connection");
			expect(replacement).not.toBe(original);

			// Any `tools/list` reaching the REPLACEMENT from here is the stale loop
			// re-listing a connection it does not own — the defect, observed
			// directly rather than counted after a wait.
			const strayList = Promise.withResolvers<"stray">();
			const replacementRequest = replacement.transport.request.bind(replacement.transport);
			replacement.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list") strayList.resolve("stray");
				return replacementRequest<T>(method, params);
			}) as typeof replacement.transport.request;

			// Release the stale re-list; its response is dropped (the connection
			// moved) and the loop proceeds to its next backoff.
			gate.resolve();

			// Deliberate real-clock bound, not a measurement: the backoff runs on
			// the platform clock inside a spawned server's transport, so fake
			// timers cannot drive it (see this file's header). The race settles as
			// soon as a stray list appears, so only the passing path waits — and
			// this bound is twice the loop's next delay (1200ms).
			const outcome = await Promise.race([strayList.promise, Bun.sleep(2_400).then(() => "quiet" as const)]);

			expect(outcome).toBe("quiet");
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);

	it("fails the refresh whose response was discarded after the connection was replaced", async () => {
		// The connection-identity guard correctly drops a `tools/list` response
		// that belongs to a since-replaced connection, but dropping it is not
		// success: nothing was applied, so the registry still holds the catalog
		// from before the refresh. Resolving here made `refreshAllTools()` report
		// `{ ok: true }` and `/mcp refresh` announce "MCP tools refreshed" while
		// the replacement's own tool load was still in flight (or had failed),
		// leaving the stale catalog standing with no signal to the user. The
		// unapplied response must surface as a failed outcome.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const original = manager.getConnection("warmup");
			if (!original) throw new Error("expected an initial connection");

			// Park the original connection's `tools/list` so the connection can be
			// replaced underneath it, then answer with a populated catalog — the
			// response is perfectly valid, it just belongs to a dead connection.
			// Issue the real `tools/list` immediately — while the original
			// transport is still live — and park only its RESOLUTION. Parking the
			// request itself would send it after the disconnect below, so it would
			// fail with "Transport not connected" and never reach the identity
			// guard this test is about.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const realRequest = original.transport.request.bind(original.transport);
			original.transport.request = (<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
				if (method === "tools/list") {
					// Let the real request COMPLETE against the live transport, then
					// hold the settled value behind the gate. The response is valid;
					// it just becomes stale while parked. Keeping the request itself
					// in flight across the disconnect would instead surface the
					// transport teardown ("Transport closed"), never the guard.
					return realRequest<T>("tools/list", params).then(async value => {
						entered.resolve();
						await gate.promise;
						return value;
					});
				}
				return realRequest<T>(method, params);
			}) as typeof original.transport.request;

			const staleRefresh = manager.refreshServerTools("warmup");
			await entered.promise;

			// Replace the connection under the same name. Deliberately do NOT
			// refresh the replacement: this models the real window where the
			// replacement is still connecting or its own `tools/list` failed, so
			// the catalog the user sees is stale.
			await manager.disconnectServer("warmup");
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const replacement = manager.getConnection("warmup");
			expect(replacement).not.toBe(original);

			gate.resolve();
			// Pre-fix: resolves, so the caller cannot tell the refresh was a no-op.
			await expect(staleRefresh).rejects.toThrow(/replaced while refreshing tools/);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("runs exactly one follow-up when a list_changed notification lands mid-flight", async () => {
		// A `notifications/tools/list_changed` arriving while the first
		// notification's `tools/list` is still in flight must not be lost: the
		// in-flight promise is shared (no second concurrent list, preserving the
		// single-flight overwrite fix), but the newer notification marks the
		// pending entry dirty so exactly ONE follow-up refresh runs once the
		// current one settles.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const connection = manager.getConnection("warmup");
			if (!connection) throw new Error("expected a connection");

			// Count `tools/list` request INITIATIONS (synchronous, so a follow-up
			// started in the pending entry's `.finally` is counted before the
			// outer await resumes) and gate the first one so a second notification
			// arrives mid-flight.
			let listInitiations = 0;
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let gated = true;
			const realRequest = connection.transport.request.bind(connection.transport);
			connection.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list") {
					listInitiations++;
					if (gated) {
						gated = false;
						entered.resolve();
						return gate.promise.then(() => realRequest<T>("tools/list", params));
					}
				}
				return realRequest<T>(method, params);
			}) as typeof connection.transport.request;

			// First notification-driven refresh parks on the gate.
			const first = manager.refreshServerTools("warmup", { notification: true });
			await entered.promise;
			// Second list_changed lands mid-flight: it shares the in-flight request
			// rather than firing a concurrent one. While the first is gated, no new
			// `tools/list` has been initiated by the second caller.
			const second = manager.refreshServerTools("warmup", { notification: true });
			expect(listInitiations).toBe(1);

			gate.resolve();
			await Promise.all([first, second]);

			// First refresh's list + exactly one dirty follow-up = 2 initiations.
			// Without the dirty flag the newer notification is dropped → 1.
			expect(listInitiations).toBe(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("surfaces a failed dirty follow-up through refreshAllTools", async () => {
		// The dirty follow-up used to be chained through
		// `#triggerNotificationRefresh`, which converts every rejection to
		// fulfillment. Error suppression is right at the notification fanout
		// boundary (a server pushing `list_changed` has no caller to report to)
		// but wrong here: this promise is awaited by `refreshServerTools`'s
		// callers, so `refreshAllTools` reported `{ ok: true }` for a catalog that
		// failed to load and `/mcp refresh` announced success on a stale toolset.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const connection = manager.getConnection("warmup");
			if (!connection) throw new Error("expected a connection");

			// Gate the first `tools/list` so a second notification lands mid-flight
			// and marks the entry dirty; fail the follow-up list only.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let listCount = 0;
			const realRequest = connection.transport.request.bind(connection.transport);
			connection.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list") {
					listCount++;
					if (listCount === 1) {
						entered.resolve();
						return gate.promise.then(() => realRequest<T>("tools/list", params));
					}
					return Promise.reject(new Error("follow-up tools/list failed"));
				}
				return realRequest<T>(method, params);
			}) as typeof connection.transport.request;

			const first = manager.refreshServerTools("warmup", { notification: true });
			await entered.promise;
			const second = manager.refreshServerTools("warmup", { notification: true });
			gate.resolve();

			// The follow-up's rejection must reach the awaiting callers, not be
			// logged and swallowed.
			await expect(Promise.all([first, second])).rejects.toThrow("follow-up tools/list failed");

			const outcomes = await manager.refreshAllTools();
			const warmup = outcomes.find(outcome => outcome.name === "warmup");
			expect(warmup?.ok).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("reports success when a failed refresh recovers through a dirty follow-up", async () => {
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const connection = manager.getConnection("warmup");
			if (!connection) throw new Error("expected a connection");

			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let listCount = 0;
			const realRequest = connection.transport.request.bind(connection.transport);
			connection.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list") {
					listCount++;
					if (listCount === 1) {
						entered.resolve();
						return gate.promise.then(() => realRequest<T>(method, params));
					}
				}
				return realRequest<T>(method, params);
			}) as typeof connection.transport.request;

			const first = manager.refreshServerTools("warmup", { notification: true });
			await entered.promise;
			const dirtyFollowUp = manager.refreshServerTools("warmup", { notification: true });
			gate.reject(new Error("initial tools/list failed"));

			const outcomes = await manager.refreshAllTools();
			const warmup = outcomes.find(outcome => outcome.name === "warmup");
			expect(warmup?.ok).toBe(true);
			expect(listCount).toBe(2);
			await Promise.all([first, dirtyFollowUp]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("resolves the coalesced list_changed caller on the follow-up's fresh catalog", async () => {
		// #handleServerNotification awaits the promise returned by
		// refreshServerTools before fanning out to extension listeners, so a
		// listener sees the manager's post-refresh state. A second
		// `list_changed` landing mid-flight coalesces onto the in-flight promise
		// and marks it dirty, which queues exactly one follow-up list. If that
		// follow-up is fired-and-forgotten, the coalesced caller resolves on the
		// STALE first response and the ordering contract breaks: the follow-up
		// catalog it requested has not landed yet. The follow-up must be chained
		// onto the awaited promise so the caller resolves only after it settles.
		//
		// Scripted counts model a changed toolset: connect lists 1 tool, the
		// first refresh re-lists the same 1 (stale), the follow-up lists 2
		// (fresh). When the coalesced caller resolves, the fresh set must stand.
		const manager = makeManager("0");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "1,1,2", OMP_TEST_LIST_LOG: listLog },
		};

		try {
			await connectAndAttach(manager, { warmup: config });
			const connection = manager.getConnection("warmup");
			if (!connection) throw new Error("expected a connection");
			expect(warmupTools(manager)).toHaveLength(1);

			// Gate the first refresh's `tools/list` so the second notification
			// arrives while it is in flight and coalesces onto it.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let gated = true;
			const realRequest = connection.transport.request.bind(connection.transport);
			connection.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list" && gated) {
					gated = false;
					entered.resolve();
					return gate.promise.then(() => realRequest<T>("tools/list", params));
				}
				return realRequest<T>(method, params);
			}) as typeof connection.transport.request;

			const first = manager.refreshServerTools("warmup", { notification: true });
			await entered.promise;
			const second = manager.refreshServerTools("warmup", { notification: true });

			gate.resolve();
			await Promise.all([first, second]);

			// The coalesced caller resolved only after the follow-up delivered the
			// fresh 2-tool catalog. Pre-fix the follow-up is fired with `void`, so
			// the caller resolves on the stale 1-tool response → length 1.
			expect(warmupTools(manager)).toHaveLength(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("plain concurrent /mcp refresh still coalesces to one list (no dirty follow-up)", async () => {
		// A manual refresh does not pass the notification flag, so overlapping
		// manual refreshes never mark dirty: they coalesce to a single list with
		// no follow-up. This is the contract the dirty scoping must not break. A
		// follow-up, if wrongly queued, initiates its `tools/list` synchronously
		// in the pending entry's `.finally` — before the outer await resumes — so
		// counting initiations catches it without any wall-clock wait.
		const manager = makeManager("0");

		try {
			await connectAndAttach(manager, { warmup: stdioConfig() });
			const connection = manager.getConnection("warmup");
			if (!connection) throw new Error("expected a connection");

			let listInitiations = 0;
			const realRequest = connection.transport.request.bind(connection.transport);
			connection.transport.request = (<T = unknown>(
				method: string,
				params?: Record<string, unknown>,
			): Promise<T> => {
				if (method === "tools/list") listInitiations++;
				return realRequest<T>(method, params);
			}) as typeof connection.transport.request;

			await Promise.all([manager.refreshServerTools("warmup"), manager.refreshServerTools("warmup")]);

			// Exactly one list — coalesced, and NO follow-up initiated.
			expect(listInitiations).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("re-arms recovery when a refresh empties a populated server", async () => {
		// A populated gateway can answer a notification- or user-driven refresh
		// with `[]` while its upstream sessions restart. The refresh registers
		// the empty set, but only connect and reconnect schedule the recovery
		// loop — so pre-fix the server stays toolless until the next notification
		// or manual refresh. The refresh path must re-arm the same loop, and it
		// must fire exactly once (the scheduler dedups against a running loop).
		//
		// Scripted list counts model the outage: connect lists one tool, the
		// refresh lists empty, the recovery re-list lists one tool again.
		const manager = makeManager();
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "1,0,1", OMP_TEST_LIST_LOG: listLog },
		};

		const emptied = Promise.withResolvers<void>();
		const recovered = Promise.withResolvers<void>();
		let sawEmpty = false;
		manager.setOnToolsChanged(tools => {
			const count = tools.filter(t => t.name.startsWith("mcp__warmup_")).length;
			if (count === 0) {
				sawEmpty = true;
				emptied.resolve();
			} else if (count === 1 && sawEmpty) {
				// Only the post-empty repopulation is recovery; the populated
				// initial connect also fires this callback with count 1.
				recovered.resolve();
			}
		});

		try {
			// Connect lands populated — the server already advertises its tool.
			await connectAndAttach(manager, { warmup: config });
			expect(warmupTools(manager)).toHaveLength(1);

			// A refresh lists empty and clears the registered tool. Pre-fix this
			// is where recovery is lost: the empty set stands with no retry armed.
			await manager.refreshServerTools("warmup");
			await emptied.promise;
			expect(warmupTools(manager)).toEqual([]);

			// Re-armed recovery re-lists and repopulates the tool with no
			// reconnect and no further user action.
			await recovered.promise;
			expect(warmupTools(manager)).toHaveLength(1);
			expect(manager.getConnectionStatus("warmup")).toBe("connected");

			// The recovery loop terminated after the first re-list that produced a
			// tool: connect (1) + refresh-empty (1) + recovery re-list (1) = 3. A
			// loop that stacked or never terminated would show more.
			const lists = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			expect(lists).toHaveLength(3);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("does not schedule empty-toolset recovery for a server without the tools capability", async () => {
		// A resource-only (or prompt-only) MCP server never advertises the tools
		// capability, so `listTools()` short-circuits to `[]` without a
		// `tools/list` call. That permanent empty is not a warmup window — it is
		// the server's fixed shape. Scheduling the recovery loop would run the
		// full retry schedule and a session-wide tools-changed rebind on every
		// attempt for a server that can never produce a tool. Gate scheduling on
		// the capability, and guard against over-correction: a tools-capable
		// server that lists empty must still arm recovery.
		const manager = makeManager();
		const resourceOnlyConfig: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [RESOURCE_ONLY_FIXTURE_PATH],
		};

		try {
			const changed = Promise.withResolvers<void>();
			manager.setOnToolsChanged(() => changed.resolve());
			await connectAndAttach(manager, { resonly: resourceOnlyConfig });
			// `#onToolsChanged` fires synchronously in the connect tool-load block
			// immediately before the scheduling decision, so awaiting it observes
			// the final marker state with no wall-clock wait.
			await changed.promise;

			expect(manager.getConnectionStatus("resonly")).toBe("connected");
			expect(warmupTools(manager)).toEqual([]);
			// Pre-fix this is `true`: the empty result alone armed the loop.
			expect(manager.hasPendingEmptyToolsetRetry("resonly")).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("still schedules recovery for a tools-capable server that lists empty", async () => {
		// Over-correction guard for the capability gate: the warmup fixture DOES
		// advertise the tools capability and lists `[]` on its first call, so the
		// recovery loop must still arm — the gate narrows scheduling to
		// tools-incapable servers, it must not suppress the warmup case.
		const manager = makeManager();

		try {
			const changed = Promise.withResolvers<void>();
			manager.setOnToolsChanged(() => changed.resolve());
			await connectAndAttach(manager, { warmup: stdioConfig() });
			await changed.promise;

			expect(warmupTools(manager)).toEqual([]);
			expect(manager.hasPendingEmptyToolsetRetry("warmup")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("reconciles an already-healed toolset when the tools-changed listener installs late", async () => {
		// A non-UI/SDK session runs MCP discovery before its `AgentSession`
		// exists, so `setOnToolsChanged` lands long after `connectServers`
		// returned. When a heal completes inside that window it updates only the
		// manager — `#onToolsChanged` is still undefined — and the recovery loop
		// then terminates because tools are present. Nothing ever fires again,
		// so the session keeps the empty snapshot it was built from and stays
		// toolless for its whole lifetime. Installing the listener must
		// therefore reconcile against the manager's current toolset.
		//
		// Auto-retry is disabled and the heal is driven through
		// `refreshServerTools` — the exact re-list the recovery loop performs
		// (and the same registration + notify path) — so the heal is awaitable
		// and the test carries no wall-clock wait. What is under test is the
		// listener-install reconcile, not the backoff schedule.
		const manager = makeManager("0");

		try {
			const result = await connectAndAttach(manager, { warmup: stdioConfig() });
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);

			// Heal with NO listener installed — exactly the sdk.ts ordering.
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toHaveLength(1);

			const rebound: string[][] = [];
			await manager.setOnToolsChanged(tools => {
				rebound.push(tools.map(t => t.name));
			});

			expect(rebound).toHaveLength(1);
			expect(rebound[0]?.filter(name => name.startsWith("mcp__warmup_"))).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("reconciles an emptied toolset when the tools-changed listener installs late", async () => {
		// Mirror image of the reconcile above, and the case the length check
		// misses. Discovery lists a tool, so the session is constructed from a
		// NON-empty snapshot; a `tools/list_changed` refresh then retires every
		// tool before the `AgentSession` exists to install its listener. The
		// manager now holds `[]` while the session still exposes the retired
		// tool. Reconciling only when the current snapshot is non-empty skips
		// the one notification that would correct that — permanently, if the
		// server legitimately stays empty. So the handler must be invoked for
		// whatever the manager currently holds, empty included.
		//
		// Auto-retry is disabled so the empty state stands: what is under test
		// is the install-time reconcile, not the recovery loop.
		const manager = makeManager("0");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "1,0", OMP_TEST_LIST_LOG: listLog },
		};

		try {
			// Discovery lands populated — this is the snapshot the session is
			// built from.
			const result = await connectAndAttach(manager, { warmup: config });
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toHaveLength(1);

			// The server retires its tools, with NO listener installed — exactly
			// the sdk.ts ordering.
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toEqual([]);

			const rebound: string[][] = [];
			await manager.setOnToolsChanged(tools => {
				rebound.push(tools.map(t => t.name));
			});

			// The session must be told the tool is gone. Pre-fix `rebound` is
			// empty, so the session keeps serving a tool the server retired.
			expect(rebound).toHaveLength(1);
			expect(rebound[0]?.filter(name => name.startsWith("mcp__warmup_"))).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("awaits a toolset change that lands DURING the install-time reconcile", async () => {
		// Third case, distinct from both reconciles above: the change arrives
		// neither before the install nor safely after it, but WHILE the
		// install-time reconcile is still rebuilding the session. A background
		// `tools/list` completing there fires the handler a second time with a
		// NEWER snapshot. Session registry mutations are serialized, so awaiting
		// only the first firing can release `createAgentSession()` between the two
		// mutations — and the first prompt then goes out on the roster the second
		// firing supersedes.
		//
		// Driven from inside the handler, which is exactly that window and needs
		// no clock: the reconcile is suspended there by construction. The
		// re-list is `refreshServerTools`, the same one the recovery loop
		// performs, so the second firing is the production path's own.
		const manager = makeManager("0");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			// Discovery lists empty, the install-time reconcile's own re-list
			// heals to one tool, and the re-list driven from inside that
			// reconcile retires it again — so the newest snapshot is
			// distinguishable from the one the reconcile started with.
			env: { OMP_TEST_TOOLS_PER_LIST: "0,1,0", OMP_TEST_LIST_LOG: listLog },
		};

		try {
			await connectAndAttach(manager, { warmup: config });
			// Heal with no listener installed, so the reconcile has a non-empty
			// snapshot to carry — the state the session would be built from.
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toHaveLength(1);

			// Stands in for the session's rebind: `refreshMCPTools` runs through
			// `runToolRegistryMutation`, which serializes every registry mutation
			// on a tail. Each firing queues its own snapshot, so the roster the
			// session ends up exposing is the last mutation to RUN — and a caller
			// released between two queued mutations sees the older one.
			let boundRoster: string[] = [];
			let firings = 0;
			let mutationTail: Promise<void> = Promise.resolve();
			const secondFiring = Promise.withResolvers<void>();
			const applySnapshot = (snapshot: string[], gate?: Promise<void>): Promise<void> => {
				mutationTail = mutationTail.then(async () => {
					if (gate) await gate;
					boundRoster = snapshot;
				});
				return mutationTail;
			};
			await manager.setOnToolsChanged(async tools => {
				const snapshot = tools.map(t => t.name);
				firings++;
				if (firings === 1) {
					// A background `tools/list` completes while this reconcile is
					// still rebuilding, retiring the tool. Not awaited: a real
					// background list runs on its own.
					void manager.refreshServerTools("warmup");
					// This reconcile's own rebind is still in flight when that
					// second firing lands — the interleaving under test. Gating on
					// the firing's arrival rather than a delay is what makes it
					// land inside the window on every run and in any file order.
					await applySnapshot(snapshot, secondFiring.promise);
					return;
				}
				secondFiring.resolve();
				// Queued BEHIND the reconcile's own mutation, which is the whole
				// hazard: awaiting only the first firing releases the caller once
				// that one commits, while this newer snapshot is still queued.
				//
				// The apply completes on a real I/O completion, not a microtask.
				// `refreshMCPTools` rebuilds the system prompt, which reads files,
				// so its rebind genuinely lands in the event loop's poll phase —
				// and a caller that merely drains microtasks cannot observe it.
				// That is the property under test, so the stand-in has to share
				// it: an in-microtask apply would settle inside the first
				// firing's own continuation and pass whether it was awaited or
				// not. Reading a file the fixture already writes keeps this an
				// event completion with no duration to tune.
				await applySnapshot(
					snapshot,
					fs.promises.readFile(listLog, "utf8").then(() => {}),
				);
			});

			// The session is exposed only once every firing from its reconcile
			// window has applied. Awaiting the first alone hands back a session
			// whose first prompt still advertises a tool the server retired.
			expect(firings).toBe(2);
			expect(boundRoster.filter(name => name.startsWith("mcp__warmup_"))).toEqual([]);
			expect(warmupTools(manager)).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("tears down the in-flight empty-toolset backoff on disconnectAll so shutdown does not hang", async () => {
		// A tools-capable server that lists empty arms the recovery loop, which
		// then parks in a backoff wait. If `disconnectAll()` leaves that wait's
		// Bun timer live, it keeps the event loop alive until the delay elapses
		// — so a one-shot/SDK consumer that shuts down blocks on it. Pin the
		// backoff far longer than the test; the only way the process exits
		// promptly is if disconnect tears the pending timer down.
		//
		// Event-loop keep-alive is observable ONLY across a process boundary (the
		// test runner's own loop stays alive regardless), so spawn a probe that
		// arms the loop, disconnects, and returns — then assert it exits rather
		// than hanging out the pinned backoff. Mirrors the #7235 retained-timer
		// regression (test/bash-autobg-timer.test.ts), which is only detectable
		// the same way.
		const start = performance.now();
		const proc = Bun.spawn([process.execPath, PROBE_PATH], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				// Pinned far longer than the watchdog: a retained timer would hold
				// the probe ~100s, so a prompt exit can only mean teardown ran.
				OMP_MCP_EMPTY_RETRY_MS: "100000",
				OMP_MCP_PROBE_WORKDIR: workDir,
				OMP_MCP_PROBE_FIXTURE: FIXTURE_PATH,
				OMP_MCP_PROBE_LIST_LOG: listLog,
			},
		});
		// Real-clock watchdog: the probe's wall-clock exit IS the contract, so
		// fake timers cannot apply (they cannot drive another process's clock).
		// This only bounds a wedged probe — a retained backoff timer would
		// otherwise pin it for the full pinned delay.
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 12_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const elapsedMs = performance.now() - start;

			// The probe reached shutdown (armed the loop, disconnected) and exited
			// cleanly — not killed by the watchdog after hanging on a live timer.
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("DISCONNECTED");
			expect(elapsedMs).toBeLessThan(10_000);
		} finally {
			clearTimeout(watchdog);
		}
	}, 20_000);
});
