import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { encodeHostError } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { HostLink } from "@oh-my-pi/pi-coding-agent/mcp/link";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { rejectionOf, trackUnhandled } from "../helpers/rejection";
import { FakeHost, type Message, metaOf, paramsOf, REMOTE_SPEC, settled, unauthorized } from "./link-fake-host";

const TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const CANCELLED = "notifications/cancelled";

/**
 * Deadlines, cancellation and progress of a session's requests: the link is
 * the only place that owns them, whatever transport the host uses upstream.
 */
describe("HostLink request deadlines and cancellation", () => {
	let host: FakeHost;
	let links: HostLink[];
	let savedTimeout: string | undefined;

	beforeEach(() => {
		host = new FakeHost();
		links = [];
		// A deadline from the environment would override every one configured here.
		savedTimeout = Bun.env[TIMEOUT_ENV];
		delete Bun.env[TIMEOUT_ENV];
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const link of links) await link.close();
		if (savedTimeout === undefined) delete Bun.env[TIMEOUT_ENV];
		else Bun.env[TIMEOUT_ENV] = savedTimeout;
	});

	/** A connected link; `timeout` is the server's configured request timeout, absent for the defaults. */
	async function connected(timeout?: number): Promise<HostLink> {
		const link = new HostLink({
			name: "fixture",
			spec: REMOTE_SPEC,
			instance: "manager-1",
			roots: () => [],
			idleMs: 1_000,
			timeout,
			access: host,
		});
		links.push(link);
		await link.connect();
		return link;
	}

	/** The newest request the session wrote with `method`; requests are written before `request()` returns. */
	function sent(method: string): Message {
		const message = host.tunnel.sent.findLast(entry => entry.method === method);
		if (!message) throw new Error(`session never sent ${method}`);
		return message;
	}

	function cancellations(): Message[] {
		return host.tunnel.sent.filter(entry => entry.method === CANCELLED).map(paramsOf);
	}

	function progress(request: Message, amount: unknown, rest: Message = {}): void {
		host.tunnel.push({
			method: "notifications/progress",
			params: { progressToken: metaOf(request).progressToken, progress: amount, ...rest },
		});
	}

	it("keeps the deadline's error and its one cancellation when the caller aborts afterwards", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const caller = new AbortController();
		const outcome = rejectionOf(link.request("tools/call", { name: "hang" }, { signal: caller.signal }));
		const request = sent("tools/call");

		vi.advanceTimersByTime(150);
		const error = await outcome;
		caller.abort(new Error("too late"));

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			stage: "receive",
			failure: "timeout",
			message: "Request timeout after 150ms",
			retryable: false,
		});
		expect(cancellations()).toEqual([{ requestId: request.id, reason: "Request timed out after 150ms" }]);
	});

	it("disarms the deadline of an aborted request, so the host hears of the abort alone", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const caller = new AbortController();
		const outcome = rejectionOf(link.request("tools/call", { name: "hang" }, { signal: caller.signal }));
		const request = sent("tools/call");

		caller.abort("a reason that is not an Error");
		vi.advanceTimersByTime(1_000);

		expect(await outcome).toEqual(new Error("Aborted"));
		expect(cancellations()).toEqual([{ requestId: request.id, reason: "Request cancelled by the client" }]);
	});

	it("sends neither the request nor a cancellation when the signal is already aborted", async () => {
		const link = await connected();
		const reason = new Error("already cancelled");

		const refused = link.request("tools/call", { name: "hang" }, { signal: AbortSignal.abort(reason) });

		expect(await rejectionOf(refused)).toBe(reason);
		expect(host.tunnel.sent.map(entry => entry.method)).not.toContain("tools/call");
		expect(cancellations()).toEqual([]);
	});

	it("does not cancel a request the host already answered or failed, whatever happens to its signal or deadline", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const caller = new AbortController();

		const answered = link.request("tools/call", { name: "echo" }, { signal: caller.signal });
		host.tunnel.push({ id: sent("tools/call").id, result: { content: [] } });
		const failed = rejectionOf(link.request("tools/call", { name: "nope" }, { signal: caller.signal }));
		host.tunnel.push({ id: sent("tools/call").id, error: { code: -32602, message: "Unknown tool: nope" } });

		expect(await answered).toEqual({ content: [] });
		expect(await failed).toMatchObject({ failure: "json_rpc", code: -32602 });
		caller.abort(new Error("after both settled"));
		vi.advanceTimersByTime(1_000);
		expect(cancellations()).toEqual([]);
	});

	it("rejects a request that cannot be serialized without leaving a deadline or a cancellation behind", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const tracker = trackUnhandled();
		try {
			const caller = new AbortController();
			const params: Record<string, unknown> = { name: "hang" };
			params.circular = params;

			const error = await rejectionOf(link.request("tools/call", params, { signal: caller.signal }));
			caller.abort(new Error("after serialization failed"));
			vi.advanceTimersByTime(1_000);
			vi.useRealTimers();
			// One macrotask for a rejection nobody observed to be reported.
			await Bun.sleep(0);

			// Sending the same params again cannot go better: nothing may retry this.
			expect(error).toMatchObject({ stage: "send", failure: "unknown", retryable: false });
			expect(host.tunnel.sent.map(entry => entry.method)).not.toContain("tools/call");
			expect(cancellations()).toEqual([]);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("ends a subscription the host never acknowledges at the deadline, and cancels it there", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const outcome = rejectionOf(link.request("subscriptions/listen", { notifications: { toolsListChanged: true } }));
		const listen = sent("subscriptions/listen");

		vi.advanceTimersByTime(150);

		expect(await outcome).toMatchObject({ failure: "timeout", message: "Request timeout after 150ms" });
		expect(cancellations()).toEqual([{ requestId: listen.id, reason: "Request timed out after 150ms" }]);
	});

	it("keeps an acknowledged subscription open however long it lasts", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const caller = new AbortController();
		let over = false;
		const stream = rejectionOf(
			link.request("subscriptions/listen", { notifications: { toolsListChanged: true } }, { signal: caller.signal }),
		).finally(() => {
			over = true;
		});
		const listen = sent("subscriptions/listen");

		vi.advanceTimersByTime(100);
		host.tunnel.acknowledge(listen);
		vi.advanceTimersByTime(3_600_000);
		await Promise.resolve();
		expect(over).toBe(false);
		expect(cancellations()).toEqual([]);

		caller.abort(new Error("done listening"));
		expect(await stream).toEqual(new Error("done listening"));
		expect(cancellations()).toEqual([{ requestId: listen.id, reason: "Request cancelled by the client" }]);
	});

	it("counts the wait for a re-attach against the request's deadline and ends it with the caller's signal", async () => {
		vi.useFakeTimers();
		const link = await connected(150);
		const unit = Promise.withResolvers<void>();
		host.attachGate = unit.promise;
		host.tunnel.drop();
		const caller = new AbortController();

		const cancelled = rejectionOf(link.request("tools/call", { name: "a" }, { signal: caller.signal }));
		const late = rejectionOf(link.request("tools/list"));
		caller.abort(new Error("cancelled while reconnecting"));
		expect(await cancelled).toEqual(new Error("cancelled while reconnecting"));
		vi.advanceTimersByTime(150);
		expect(await late).toMatchObject({ failure: "timeout", message: "Request timeout after 150ms" });

		// The re-attach itself goes on for whoever asks next, and neither abandoned request reaches the new unit.
		vi.useRealTimers();
		host.attachGate = undefined;
		unit.resolve();
		const second = await host.attached(2);
		const after = link.request("tools/list");
		second.push({ id: (await second.next("tools/list")).id, result: { tools: [] } });
		expect(await after).toEqual({ tools: [] });
		expect(second.sent.map(entry => entry.method)).not.toContain("tools/call");
		expect(second.sent.filter(entry => entry.method === "tools/list")).toHaveLength(1);
	});

	it("stops waiting for refreshed credentials when the caller gives up", async () => {
		const link = await connected();
		link.onAuthError = () => new Promise(() => {});
		const caller = new AbortController();

		const outcome = rejectionOf(link.request("tools/list", undefined, { signal: caller.signal }));
		host.tunnel.push({ id: sent("tools/list").id, error: encodeHostError(unauthorized()) });
		await settled();
		caller.abort(new Error("stop waiting"));

		expect(await outcome).toEqual(new Error("stop waiting"));
		expect(host.tunnels).toHaveLength(1);
	});

	it("holds a configured timeout as a hard cap however much progress arrives, and routes none after it", async () => {
		vi.useFakeTimers();
		const link = await connected(1_000);
		const updates: MCPProgress[] = [];
		const outcome = rejectionOf(
			link.request("tools/call", { name: "slow" }, { onProgress: update => updates.push(update) }),
		);
		const request = sent("tools/call");

		for (let step = 1; step <= 4; step++) {
			vi.advanceTimersByTime(240);
			progress(request, step);
		}
		vi.advanceTimersByTime(40);
		progress(request, 5);

		expect(await outcome).toMatchObject({ failure: "timeout", message: "Request timeout after 1000ms" });
		expect(updates).toEqual([{ progress: 1 }, { progress: 2 }, { progress: 3 }, { progress: 4 }]);
		expect(cancellations()).toEqual([{ requestId: request.id, reason: "Request timed out after 1000ms" }]);
	});

	it("restarts the default tool-call deadline on progress", async () => {
		vi.useFakeTimers();
		const link = await connected();
		let settled = false;
		const outcome = rejectionOf(link.request("tools/call", { name: "slow" }, { onProgress: () => {} })).finally(
			() => {
				settled = true;
			},
		);
		const request = sent("tools/call");

		// Ten minutes of silence would end it; progress just before buys another ten.
		vi.advanceTimersByTime(599_000);
		progress(request, 1);
		vi.advanceTimersByTime(599_000);
		await Promise.resolve();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(1_000);
		expect(await outcome).toMatchObject({ failure: "timeout", message: "Request timeout after 600000ms" });
	});

	it("ends a default tool call after an hour even when progress never stops", async () => {
		vi.useFakeTimers();
		const link = await connected();
		const outcome = rejectionOf(link.request("tools/call", { name: "slow" }, { onProgress: () => {} }));
		const request = sent("tools/call");

		for (let minute = 5; minute < 60; minute += 5) {
			vi.advanceTimersByTime(300_000);
			progress(request, minute);
		}
		vi.advanceTimersByTime(300_000);

		expect(await outcome).toMatchObject({ failure: "timeout", message: "Request timeout after 3600000ms" });
	});

	it("gives a listing the short default deadline, which progress does not restart", async () => {
		vi.useFakeTimers();
		const link = await connected();
		const outcome = rejectionOf(link.request("tools/list", undefined, { onProgress: () => {} }));
		const request = sent("tools/list");

		vi.advanceTimersByTime(29_000);
		progress(request, 1);
		vi.advanceTimersByTime(1_000);

		expect(await outcome).toMatchObject({ failure: "timeout", message: "Request timeout after 30000ms" });
	});

	it("contains a throwing progress callback: its request and a sibling's progress carry on", async () => {
		const link = await connected();
		let calls = 0;
		const sibling: MCPProgress[] = [];
		const throwing = link.request(
			"tools/call",
			{ name: "a" },
			{
				onProgress: () => {
					calls++;
					throw new Error("consumer failed");
				},
			},
		);
		const first = sent("tools/call");
		const quiet = link.request("tools/call", { name: "b" }, { onProgress: update => sibling.push(update) });
		const second = sent("tools/call");

		for (const amount of [1, 2]) {
			progress(first, amount);
			progress(second, amount);
		}
		host.tunnel.push({ id: first.id, result: { content: [] } });
		host.tunnel.push({ id: second.id, result: { content: [] } });

		expect(await throwing).toEqual({ content: [] });
		expect(await quiet).toEqual({ content: [] });
		expect(calls).toBe(2);
		expect(sibling).toEqual([{ progress: 1 }, { progress: 2 }]);
	});

	it("drops progress that is not well-formed instead of handing it to the caller", async () => {
		const link = await connected();
		const updates: MCPProgress[] = [];
		const pending = link.request("tools/call", { name: "slow" }, { onProgress: update => updates.push(update) });
		const request = sent("tools/call");

		progress(request, 0, { total: 0, message: "" });
		progress(request, -0.5, { total: "bad", message: 4 });
		progress(request, "invalid");
		progress(request, null);
		host.tunnel.push({ method: "notifications/progress", params: { progressToken: { nested: 1 }, progress: 7 } });
		host.tunnel.push({ id: request.id, result: { content: [] } });
		await pending;

		expect(updates).toEqual([{ progress: 0, total: 0, message: "" }, { progress: -0.5 }]);
	});

	it("gives the retry after an auth refresh a progress token of its own", async () => {
		const link = await connected();
		link.onAuthError = async () => ({ Authorization: "Bearer refreshed" });
		const updates: MCPProgress[] = [];

		const pending = link.request("tools/call", { name: "slow" }, { onProgress: update => updates.push(update) });
		const first = host.tunnel;
		const original = await first.next("tools/call");
		first.push({
			id: original.id,
			error: encodeHostError(
				new MCPTransportError({
					transport: "http",
					stage: "receive",
					failure: "http_status",
					message: "HTTP 401: expired",
					retryable: false,
					code: 401,
				}),
			),
		});
		const second = await host.attached(2);
		const retry = await second.next("tools/call");
		// Progress for the request the server refused must not be taken for the retry's.
		progress(original, 99);
		progress(retry, 1);
		second.push({ id: retry.id, result: { content: [] } });
		await pending;

		expect(metaOf(retry).progressToken).not.toBe(metaOf(original).progressToken);
		expect(updates).toEqual([{ progress: 1 }]);
	});
});
