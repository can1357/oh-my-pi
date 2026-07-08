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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);

			// The empty pass must NOT be cached (that is the 30-day poison).
			expect(storage.raw.size).toBe(0);

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
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
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
			const result = await manager.connectServers({ "warmup-1": stdioConfig() }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toHaveLength(1);
			const replacement = manager.getConnection("warmup");
			expect(replacement).not.toBe(original);

			// Release the stale empty response. It must NOT overwrite the recovered
			// tools — the guard sees the connection is no longer current.
			gate.resolve();
			await staleReList;

			expect(warmupTools(manager)).toHaveLength(1);
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: config }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
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
			await manager.connectServers({ warmup: config }, {});
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
			await manager.connectServers({ resonly: resourceOnlyConfig }, {});
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
			await manager.connectServers({ warmup: stdioConfig() }, {});
			await changed.promise;

			expect(warmupTools(manager)).toEqual([]);
			expect(manager.hasPendingEmptyToolsetRetry("warmup")).toBe(true);
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
