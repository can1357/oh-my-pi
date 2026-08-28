import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { streamCursor } from "../src/providers/cursor";
import type { CursorH2AcquireOptions, CursorH2Acquisition } from "../src/providers/cursor/h2-pool";
import {
	__cursorH2ConnectingSnapshot,
	__cursorH2PoolSnapshot,
	__setCursorH2EstablishBodyGate,
	__setCursorH2FreshSessionHook,
	__setCursorH2HandshakeTimeoutMs,
	acquireCursorH2,
	disposeCursorH2Pool,
} from "../src/providers/cursor/h2-pool";
import type { Context, Model } from "../src/types";

/**
 * Pool fixtures run against a real loopback `http2.createServer()` so session
 * reuse, GOAWAY drain, reservation-before-connect, and connect classification
 * exercise the actual http2 stack rather than a mock (pattern:
 * cursor-terminal-error.test.ts).
 */

const RUN_PATH = "/agent.v1.AgentService/Run";

const servers: http2.Http2Server[] = [];
const sessions = new Set<http2.Http2Session>();
let totalSessions = 0;
let streamCount = 0;
let serveStream: ((stream: http2.ServerHttp2Stream) => void) | undefined;

async function startServer(): Promise<string> {
	const srv = http2.createServer();
	servers.push(srv);
	srv.on("session", session => {
		totalSessions++;
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	srv.on("stream", (stream: http2.ServerHttp2Stream) => {
		streamCount++;
		stream.on("data", () => {});
		serveStream?.(stream);
	});
	const listening = Promise.withResolvers<void>();
	srv.once("error", listening.reject);
	srv.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = srv.address();
	if (!address || typeof address === "string") {
		throw new Error("expected fixture http2 server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function respondOk(stream: http2.ServerHttp2Stream): void {
	stream.respond({ ":status": 200 });
	stream.write(Buffer.from("ok"));
	stream.end();
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	const closing = servers.splice(0);
	await Promise.all(
		closing.map(srv => {
			const closed = Promise.withResolvers<void>();
			srv.close(() => closed.resolve());
			return closed.promise;
		}),
	);
}

function poolOutstanding(): number {
	return __cursorH2PoolSnapshot().reduce((n, entry) => n + entry.outstanding, 0);
}

function poolIdleUnreferenced(): boolean {
	const snapshot = __cursorH2PoolSnapshot();
	return snapshot.length > 0 && snapshot.every(entry => entry.outstanding === 0 && !entry.referenced);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}

/** Returns a loopback port that is currently free (connect will be refused). */
async function freeClosedPort(): Promise<number> {
	const srv = net.createServer();
	const listening = Promise.withResolvers<void>();
	srv.once("error", listening.reject);
	srv.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = srv.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	srv.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
	return port;
}

function runArgs(baseUrl: string): CursorH2AcquireOptions {
	return { baseUrl, requestPath: RUN_PATH, headers: {}, provider: "cursor" };
}

beforeEach(async () => {
	totalSessions = 0;
	streamCount = 0;
	serveStream = undefined;
	await disposeCursorH2Pool();
});

afterEach(async () => {
	await stopServer();
	await disposeCursorH2Pool();
	__setCursorH2HandshakeTimeoutMs(undefined);
});

describe("cursor HTTP/2 session pool", () => {
	it("reuses one pooled session for two sequential acquisitions on the same baseUrl", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;

		const first = await acquireCursorH2(runArgs(baseUrl));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const second = await acquireCursorH2(runArgs(baseUrl));
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// Distinct request streams on the SAME underlying session.
		expect(second.lease.request).not.toBe(first.lease.request);
		await waitFor(() => streamCount >= 2);
		expect(totalSessions).toBe(1);

		first.lease.release();
		second.lease.release();
		expect(poolOutstanding()).toBe(0);
	});

	it("caps retained sessions and evicts the oldest idle entry beyond the cap", async () => {
		serveStream = respondOk;
		// Nine distinct baseUrls, each acquired and released inside the idle
		// window: age-based eviction alone would retain all nine sessions.
		const urls: string[] = [];
		for (let index = 0; index < 9; index++) urls.push(await startServer());
		for (const url of urls) {
			const acquired = await acquireCursorH2(runArgs(url));
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			acquired.lease.release();
		}
		const snapshot = __cursorH2PoolSnapshot();
		expect(snapshot).toHaveLength(8);
		// The first-established session is the oldest idle entry and is the
		// one evicted; Map iteration order breaks Date.now() ties the same way.
		expect(snapshot.map(entry => entry.key)).not.toContain(`${urls[0]}|`);
	});

	it("never evicts the ninth session before its first lease when older entries are leased", async () => {
		serveStream = respondOk;
		// Hold eight leases, then publish a ninth origin. Before acquire returns,
		// that new entry is the only zero-lease candidate; cap enforcement must
		// protect it long enough to issue its first lease.
		const urls: string[] = [];
		for (let index = 0; index < 9; index++) urls.push(await startServer());
		const leases = [];
		for (const url of urls) {
			const acquired = await acquireCursorH2(runArgs(url));
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			leases.push(acquired.lease);
		}
		const overCap = __cursorH2PoolSnapshot();
		expect(overCap).toHaveLength(9);
		expect(overCap.map(entry => entry.key)).toContain(`${urls[8]}|`);
		expect(overCap.find(entry => entry.key === `${urls[8]}|`)?.outstanding).toBe(1);

		// Once an older entry becomes idle it is eligible, so the deferred cap
		// enforcement removes that older victim without touching the leased ninth.
		leases[0]?.release();
		const settled = __cursorH2PoolSnapshot();
		expect(settled).toHaveLength(8);
		expect(settled.map(entry => entry.key)).not.toContain(`${urls[0]}|`);
		expect(settled.map(entry => entry.key)).toContain(`${urls[8]}|`);
		for (const lease of leases.slice(1)) lease.release();
	});

	it("refs the idle session for a lease, unrefs at zero, and re-refs on the next acquire", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;

		const first = await acquireCursorH2(runArgs(baseUrl));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(__cursorH2PoolSnapshot()).toEqual(
			expect.arrayContaining([expect.objectContaining({ outstanding: 1, draining: false, referenced: true })]),
		);

		first.lease.release();
		expect(poolIdleUnreferenced()).toBe(true);

		const second = await acquireCursorH2(runArgs(baseUrl));
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(totalSessions).toBe(1);
		expect(__cursorH2PoolSnapshot()).toEqual(
			expect.arrayContaining([expect.objectContaining({ outstanding: 1, draining: false, referenced: true })]),
		);
		second.lease.release();
		expect(poolIdleUnreferenced()).toBe(true);
	});

	it("shares one in-flight connect across concurrent acquisitions on a fresh baseUrl", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;

		// Both acquisitions race the same empty pool; the reservation
		// (reserve-before-connect) makes the second await the first's in-flight
		// connect instead of opening a duplicate session.
		const [a, b] = await Promise.all([acquireCursorH2(runArgs(baseUrl)), acquireCursorH2(runArgs(baseUrl))]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;

		expect(a.lease.request).not.toBe(b.lease.request);
		await waitFor(() => streamCount >= 2);
		expect(totalSessions).toBe(1);

		a.lease.release();
		b.lease.release();
		expect(poolOutstanding()).toBe(0);
	});

	it("drains an in-flight lease on GOAWAY and opens a fresh session on the next acquire", async () => {
		const baseUrl = await startServer();
		let goawaySent = false;
		const requestEnded = Promise.withResolvers<void>();
		serveStream = stream => {
			respondOk(stream);
			const session = stream.session;
			if (!goawaySent && session) {
				goawaySent = true;
				session.goaway();
			}
		};

		const first = await acquireCursorH2(runArgs(baseUrl));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// A real transport consumes the response to start the stream flowing;
		// without a data/response consumer Node's http2 client never emits `end`.
		first.lease.request.on("data", () => {});
		first.lease.request.once("end", () => requestEnded.resolve());

		// The in-flight lease completes even though the session received GOAWAY
		// mid-stream.
		await requestEnded.promise;
		// GOAWAY must mark the pooled entry draining before the release path.
		await waitFor(() => __cursorH2PoolSnapshot().some(entry => entry.draining));
		first.lease.release();
		expect(poolOutstanding()).toBe(0);

		// A draining session is never reused: the next acquire opens a fresh one.
		const second = await acquireCursorH2(runArgs(baseUrl));
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		await waitFor(() => streamCount >= 2);
		await waitFor(() => totalSessions === 2);
		second.lease.release();
		expect(poolOutstanding()).toBe(0);
	});

	it("rejects a pre-aborted acquisition instead of leasing, and leaks nothing", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;

		// Establish a pooled session first, so the aborted acquisition below would
		// otherwise take the synchronous pooled fast path.
		const warm = await acquireCursorH2(runArgs(baseUrl));
		expect(warm.ok).toBe(true);
		if (!warm.ok) return;
		warm.lease.release();
		expect(poolOutstanding()).toBe(0);

		// An abort that arrives mid-wait already rejects (joinEstablishment's
		// listener), so a pre-aborted signal rejects too rather than handing back
		// a lease whose request is already destroyed. The invariant either way is
		// that no lease survives the abort.
		const controller = new AbortController();
		controller.abort();
		await expect(acquireCursorH2({ ...runArgs(baseUrl), signal: controller.signal })).rejects.toThrow();
		expect(poolOutstanding()).toBe(0);
	});

	it("classifies an unreachable proxy tunnel as connect-tunnel unavailability, not a throw", async () => {
		// The proxy env vars are process-global, so the scenario runs in a child
		// process (pattern: cursor-proxy-env.test.ts) instead of mutating
		// Bun.env underneath concurrent test files.
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-h2-proxy-env.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const result = JSON.parse(stdout) as { ok: boolean; reason?: string };
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("connect-tunnel");
	}, 60_000);

	it("rejects a non-ALPN connect error instead of classifying it as unavailable", async () => {
		const port = await freeClosedPort();
		const promise = acquireCursorH2({
			baseUrl: `http://127.0.0.1:${port}`,
			requestPath: RUN_PATH,
			headers: {},
			provider: "cursor",
		});
		await expect(promise).rejects.toBeTruthy();
		expect(poolOutstanding()).toBe(0);
	});

	it("restores the lease count when session.request() throws synchronously", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;

		const warm = await acquireCursorH2(runArgs(baseUrl));
		expect(warm.ok).toBe(true);
		if (!warm.ok) return;
		const session = warm.lease.request.session as http2.ClientHttp2Session | undefined;
		warm.lease.release();
		expect(poolOutstanding()).toBe(0);
		if (!session) return;

		// Force a synchronous stream-creation failure on the pooled session: the
		// reserved lease slot must be restored before the error propagates so a
		// later acquire is not counted twice and the session stays reusable.
		// Test-only monkeypatch: `request` is a prototype method; shadow it on the
		// instance to force a synchronous stream-creation error.
		const requestHost = session as { request: typeof session.request };
		const originalRequest = requestHost.request.bind(session);
		requestHost.request = () => {
			throw new Error("forced synchronous request failure");
		};
		try {
			await expect(acquireCursorH2(runArgs(baseUrl))).rejects.toThrow("forced synchronous request failure");
		} finally {
			requestHost.request = originalRequest;
		}
		expect(poolOutstanding()).toBe(0);
		expect(poolIdleUnreferenced()).toBe(true);
		// The pooled session survives the aborted stream creation.
		const again = await acquireCursorH2(runArgs(baseUrl));
		expect(again.ok).toBe(true);
		if (again.ok) {
			await waitFor(() => streamCount >= 2);
			again.lease.release();
		}
		expect(poolOutstanding()).toBe(0);
	});

	it("does not deadlock when the fresh session is drained before its first lease", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;
		let hookCalls = 0;

		// Simulate a GOAWAY landing between connect and the first lease — a
		// window a real fixture cannot hit (Node delivers goaway only after the
		// establishing continuation's microtask has already leased), but exactly
		// the drained-before-first-lease condition that previously made the retry
		// re-acquire under its own unsettled reservation and hang forever.
		__setCursorH2FreshSessionHook((_key, entry) => {
			hookCalls++;
			if (!entry) return;
			entry.draining = true;
			entry.session.destroy();
		});
		try {
			// A bounded watchdog so a deadlock regression fails fast instead of
			// hanging the whole suite. Deterministic clock control cannot model
			// "never settles", which is what a deadlock is.
			const result = (await Promise.race([
				acquireCursorH2(runArgs(baseUrl)),
				(() => {
					const { promise, reject } = Promise.withResolvers<never>();
					setTimeout(
						() => reject(new Error("deadlock: acquire hung after fresh-session drain before first lease")),
						3000,
					);
					return promise;
				})(),
			])) as CursorH2Acquisition;

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// The retry built a fresh session to replace the drained one.
			await waitFor(() => totalSessions >= 2);
			result.lease.release();
			expect(poolOutstanding()).toBe(0);
		} finally {
			__setCursorH2FreshSessionHook(undefined);
		}
		expect(hookCalls).toBe(1);
	});

	it("dispose cancels a stalled in-flight connect instead of awaiting it forever", async () => {
		// A TCP sink that accepts but never performs the h2 handshake keeps the
		// client's establish in-flight forever. Disposal must terminate that
		// establishment via its cancellation handle — not by this test destroying
		// the socket — and settle within a bounded window.
		let stalledSocket: net.Socket | undefined;
		const sink = net.createServer(sock => {
			stalledSocket = sock;
			// Flow the socket so the peer's teardown (FIN / close) is processed
			// and `destroyed` flips true — on a paused socket Node never advances
			// the stream state and the assertion below would be a false negative.
			sock.resume();
		});
		const listening = Promise.withResolvers<void>();
		sink.once("error", listening.reject);
		sink.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = sink.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			// Wait for the real event that proves the establish is in-flight: the
			// client's TCP connection reached the sink.
			const acquirer = acquireCursorH2(runArgs(baseUrl)).catch(e => e);
			await waitFor(() => stalledSocket !== undefined, 2000);
			// The socket is still open — disposal, not this test, must tear it down.
			expect(stalledSocket?.destroyed).toBe(false);

			// Disposal must cancel the stalled establishment and resolve within a
			// bounded window; it must NOT hang until the socket is destroyed from
			// outside.
			const disposed = await Promise.race([
				disposeCursorH2Pool().then(() => true),
				(() => {
					const { promise, resolve } = Promise.withResolvers<false>();
					setTimeout(() => resolve(false), 3000);
					return promise;
				})(),
			]);
			expect(disposed).toBe(true);

			// Disposal's cancellation destroyed the stalled socket as part of
			// terminating the establishment.
			await waitFor(() => stalledSocket?.destroyed === true, 2000);
			expect(__cursorH2PoolSnapshot()).toHaveLength(0);

			// `acquirer` settles exactly when the establishment does; nothing live
			// may have been resurrected into the pool in that settlement.
			await acquirer;
			expect(__cursorH2PoolSnapshot()).toHaveLength(0);
		} finally {
			sink.close();
		}
	});

	it("dispose tears down a still-resolving proxy tunnel instead of leaving it live", async () => {
		// The proxy env vars are process-global, so the scenario runs in a child
		// process (pattern: cursor-proxy-env.test.ts) instead of mutating
		// Bun.env underneath concurrent test files. The child starts a silent
		// CONNECT proxy and reports each teardown observation.
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-h2-proxy-dispose.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const result = JSON.parse(stdout) as {
			tunnelLiveBeforeDispose: boolean;
			disposed: boolean;
			socketDestroyedAfterDispose: boolean;
			poolEmptyAfterDispose: boolean;
			poolEmptyAfterAcquirer: boolean;
		};
		// The pre-disposal tunnel is live: the peer accepted the CONNECT.
		expect(result.tunnelLiveBeforeDispose).toBe(true);
		expect(result.disposed).toBe(true);
		expect(result.socketDestroyedAfterDispose).toBe(true);
		expect(result.poolEmptyAfterDispose).toBe(true);
		expect(result.poolEmptyAfterAcquirer).toBe(true);
	}, 60_000);

	it("dispose does not resolve until the establishment body's done-teardown has fully run", async () => {
		// Frames the exact audit race: `cancel` rejects the outward acquisition
		// promise immediately, but the establishment body may still be in flight
		// and go on to CREATE an http2 session after cancellation, observe `done`,
		// and destroy it. The gate holds the body suspended immediately before it
		// creates its session — the window where `cancel` has no session to
		// destroy — so we can assert disposal has not completed while the body is
		// still running. Without the establishment-completion await, disposal
		// resolves the moment cancel rejects and this assertion fails (the body
		// tears its transiently-created session down a moment later).
		const baseUrl = await startServer();

		let releaseBody: (() => void) | undefined;
		const bodyAtGate = Promise.withResolvers<void>();
		__setCursorH2EstablishBodyGate(() => {
			bodyAtGate.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			releaseBody = resolve;
			return promise;
		});

		try {
			const acquirer = acquireCursorH2(runArgs(baseUrl)).catch(e => e);
			// The body reached the gate: it is suspended before creating its
			// session, so nothing is pooled or connected yet.
			await bodyAtGate.promise;
			expect(__cursorH2PoolSnapshot()).toHaveLength(0);

			// Disposal starts while the body is still held. It MUST NOT resolve
			// until the body has created its session, observed `done`, destroyed
			// it, and fully exited.
			let disposed = false;
			const disposing = disposeCursorH2Pool().then(() => {
				disposed = true;
			});
			await Bun.sleep(50);
			expect(disposed).toBe(false);

			// Release the body: it creates a session, hits `done`, destroys it,
			// and exits — and only after that teardown may disposal resolve.
			releaseBody?.();
			await disposing;
			expect(disposed).toBe(true);

			// The pre-disposal establishment left nothing live behind: the
			// session it transiently created (if it reached the fixture) was torn
			// down as part of the body's done-teardown before disposal returned.
			await waitFor(() => sessions.size === 0);

			await acquirer;
			expect(__cursorH2PoolSnapshot()).toHaveLength(0);
		} finally {
			__setCursorH2EstablishBodyGate(undefined);
		}
	});

	it("rejects a fresh establishment whose first lease throws synchronously, clears the reservation, and leaves the key reusable", async () => {
		// The failure class: the establishing body's very first `issueLease` (a
		// fresh establishment — nothing pooled yet) throws synchronously. That is
		// a top-level body throw the live-arm `settled.resolve()` cannot carry:
		// pre-fix the rejection arm swallowed it wholesale, so the outward
		// acquisition stayed pending forever AND the `connecting` reservation
		// (cleared only when the outward promise settles) remained installed,
		// hanging every subsequent acquisition for the key.
		const baseUrl = await startServer();
		serveStream = respondOk;
		let injected = false;
		let pooledSession: http2.ClientHttp2Session | undefined;
		let restoreRequest: (() => void) | undefined;

		// The fresh-session hook runs synchronously right before the body issues
		// its first lease. Monkeypatch the just-connected session's `request` to
		// throw on first call, forcing the synchronous stream-creation failure on
		// the FIRST-lease path (the pooled-session equivalent is covered by the
		// "restores the lease count" case above; this is the fresh-establishment
		// arm that previously never rejected).
		__setCursorH2FreshSessionHook((_key, entry) => {
			if (injected || !entry) return;
			injected = true;
			pooledSession = entry.session;
			const session = entry.session as { request: typeof entry.session.request };
			const originalRequest = session.request.bind(entry.session);
			session.request = () => {
				throw new Error("forced synchronous first-lease failure");
			};
			restoreRequest = () => {
				session.request = originalRequest;
			};
		});

		try {
			const first = acquireCursorH2(runArgs(baseUrl));
			// The acquisition must reject promptly; a bounded watchdog guards the
			// regression where the error was swallowed and the promise never
			// settled (no hang in the suite).
			const verdict = await Promise.race([
				first.then(
					() => "resolved",
					() => "rejected",
				),
				(() => {
					const { promise, resolve } = Promise.withResolvers<string>();
					setTimeout(() => resolve("hung"), 3000);
					return promise;
				})(),
			]);
			expect(verdict).toBe("rejected");
			await expect(first).rejects.toThrow("forced synchronous first-lease failure");
			expect(injected).toBe(true);
			// The failed first lease restored its slot; nothing is leaked.
			expect(poolOutstanding()).toBe(0);
			expect(poolIdleUnreferenced()).toBe(true);

			// Evict the broken pooled session so the second acquire must go
			// through the connecting reservation and a FRESH establishment — which
			// requires the pre-fix leaked reservation to have been cleared. A
			// stale never-settling reservation would hang this acquire.
			pooledSession?.destroy();
			await waitFor(() => __cursorH2PoolSnapshot().length === 0, 2000);

			// The failure is never cached and the key is not poisoned: a second
			// acquisition for the same key settles and succeeds via a fresh
			// establishment.
			const second = await acquireCursorH2(runArgs(baseUrl));
			expect(second.ok).toBe(true);
			if (second.ok) {
				await waitFor(() => streamCount >= 1);
				second.lease.release();
			}
			expect(poolOutstanding()).toBe(0);
		} finally {
			__setCursorH2FreshSessionHook(undefined);
			restoreRequest?.();
		}
	});

	it("rejects a stalled h2 handshake when the acquisition signal aborts", async () => {
		let stalledSocket: net.Socket | undefined;
		const sink = net.createServer(sock => {
			stalledSocket = sock;
			sock.resume();
		});
		const listening = Promise.withResolvers<void>();
		sink.once("error", listening.reject);
		sink.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = sink.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const baseUrl = `https://127.0.0.1:${port}`;
		const reason = new Error("stalled-handshake-aborted");

		try {
			const controller = new AbortController();
			const acquirer = acquireCursorH2({ ...runArgs(baseUrl), signal: controller.signal });
			await waitFor(() => stalledSocket !== undefined, 2000);
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters >= 1), 2000);
			controller.abort(reason);
			const verdict = await Promise.race([
				acquirer.then(
					() => "resolved" as const,
					(error: unknown) => error,
				),
				(() => {
					const { promise, resolve } = Promise.withResolvers<"hung">();
					setTimeout(() => resolve("hung"), 3000);
					return promise;
				})(),
			]);
			expect(verdict).toBe(reason);
			await waitFor(() => __cursorH2ConnectingSnapshot().length === 0, 2000);
			const disposed = await Promise.race([
				disposeCursorH2Pool().then(() => true),
				(() => {
					const { promise, resolve } = Promise.withResolvers<false>();
					setTimeout(() => resolve(false), 3000);
					return promise;
				})(),
			]);
			expect(disposed).toBe(true);
		} finally {
			sink.close();
		}
	});

	it("does not cancel a shared stalled connect until the last waiter aborts", async () => {
		let stalledSocket: net.Socket | undefined;
		const sink = net.createServer(sock => {
			stalledSocket = sock;
			sock.resume();
		});
		const listening = Promise.withResolvers<void>();
		sink.once("error", listening.reject);
		sink.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = sink.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const baseUrl = `https://127.0.0.1:${port}`;

		try {
			const firstController = new AbortController();
			const secondController = new AbortController();
			let firstSettled = false;
			let secondSettled = false;
			const first = acquireCursorH2({ ...runArgs(baseUrl), signal: firstController.signal }).then(
				() => {
					firstSettled = true;
					return "resolved" as const;
				},
				(error: unknown) => {
					firstSettled = true;
					return error;
				},
			);
			await waitFor(() => stalledSocket !== undefined, 2000);
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters >= 1), 2000);
			const second = acquireCursorH2({ ...runArgs(baseUrl), signal: secondController.signal }).then(
				() => {
					secondSettled = true;
					return "resolved" as const;
				},
				(error: unknown) => {
					secondSettled = true;
					return error;
				},
			);
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters === 2), 2000);

			firstController.abort(new Error("first-waiter-aborted"));
			expect(await first).toEqual(expect.objectContaining({ message: "first-waiter-aborted" }));
			expect(firstSettled).toBe(true);
			expect(secondSettled).toBe(false);
			expect(stalledSocket?.destroyed).toBe(false);
			expect(__cursorH2ConnectingSnapshot().some(entry => entry.waiters === 1)).toBe(true);

			secondController.abort(new Error("last-waiter-aborted"));
			expect(await second).toEqual(expect.objectContaining({ message: "last-waiter-aborted" }));
			expect(secondSettled).toBe(true);
			await waitFor(() => __cursorH2ConnectingSnapshot().length === 0, 2000);
		} finally {
			sink.close();
		}
	});

	it("keeps the owner's establishment lease writable after a joiner aborts during shared connect", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;
		const bodyAtGate = Promise.withResolvers<void>();
		let releaseBody: (() => void) | undefined;
		__setCursorH2EstablishBodyGate(() => {
			bodyAtGate.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			releaseBody = resolve;
			return promise;
		});
		try {
			const owner = acquireCursorH2(runArgs(baseUrl));
			await bodyAtGate.promise;
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters >= 1), 2000);
			const joinerController = new AbortController();
			const joiner = acquireCursorH2({ ...runArgs(baseUrl), signal: joinerController.signal });
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters === 2), 2000);

			joinerController.abort(new Error("joiner-aborted-during-establish"));
			await expect(joiner).rejects.toMatchObject({ message: "joiner-aborted-during-establish" });
			expect(__cursorH2ConnectingSnapshot().some(entry => entry.waiters === 1)).toBe(true);

			releaseBody?.();
			const result = await owner;
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lease.request.destroyed).toBe(false);
			expect(result.lease.request.writable).toBe(true);
			const wrote = result.lease.request.write(Buffer.from("owner-lease-still-live"));
			expect(wrote).toBe(true);
			await waitFor(() => streamCount >= 1);
			result.lease.release();
			expect(poolOutstanding()).toBe(0);
		} finally {
			__setCursorH2EstablishBodyGate(undefined);
		}
	});

	it("retries from an abort handler while the canceled establishment is still settling", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;
		const bodyAtGate = Promise.withResolvers<void>();
		let releaseBody: (() => void) | undefined;
		__setCursorH2EstablishBodyGate(() => {
			bodyAtGate.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			releaseBody = resolve;
			return promise;
		});
		try {
			const controller = new AbortController();
			const first = acquireCursorH2({ ...runArgs(baseUrl), signal: controller.signal });
			await bodyAtGate.promise;
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters >= 1), 2000);

			let retry: Promise<CursorH2Acquisition> | undefined;
			controller.signal.addEventListener(
				"abort",
				() => {
					retry = acquireCursorH2(runArgs(baseUrl));
				},
				{ once: true },
			);
			controller.abort(new Error("last-waiter-retried"));
			await expect(first).rejects.toMatchObject({ message: "last-waiter-retried" });
			expect(retry).toBeDefined();
			// The first establishment is still gated, so this retry cannot have
			// joined its rejected reservation; it must lease a replacement session.
			const result = await retry;
			expect(result?.ok).toBe(true);
			if (!result?.ok) return;
			expect(result.lease.request.destroyed).toBe(false);
			expect(result.lease.request.writable).toBe(true);
			expect(result.lease.request.write(Buffer.from("retry-after-cancel"))).toBe(true);
			await waitFor(() => streamCount >= 1);
			result.lease.release();
			expect(poolOutstanding()).toBe(0);
		} finally {
			releaseBody?.();
			__setCursorH2EstablishBodyGate(undefined);
		}
	});

	it("issues exactly one Run stream for a live joiner after the reservation owner aborts", async () => {
		const baseUrl = await startServer();
		const received: Buffer[] = [];
		serveStream = stream => {
			stream.on("data", (chunk: Buffer) => received.push(chunk));
			respondOk(stream);
		};
		const bodyAtGate = Promise.withResolvers<void>();
		let releaseBody: (() => void) | undefined;
		__setCursorH2EstablishBodyGate(() => {
			bodyAtGate.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			releaseBody = resolve;
			return promise;
		});
		try {
			const ownerController = new AbortController();
			const owner = acquireCursorH2({ ...runArgs(baseUrl), signal: ownerController.signal });
			await bodyAtGate.promise;
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters >= 1), 2000);

			const joiner = acquireCursorH2(runArgs(baseUrl));
			await waitFor(() => __cursorH2ConnectingSnapshot().some(entry => entry.waiters === 2), 2000);

			ownerController.abort(new Error("owner-aborted-during-establish"));
			await expect(owner).rejects.toMatchObject({ message: "owner-aborted-during-establish" });
			expect(__cursorH2ConnectingSnapshot().some(entry => entry.waiters === 1)).toBe(true);
			expect(streamCount).toBe(0);

			releaseBody?.();
			const result = await joiner;
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lease.request.destroyed).toBe(false);
			expect(result.lease.request.writable).toBe(true);
			expect(result.lease.request.write(Buffer.from("joiner-only"))).toBe(true);
			await waitFor(() => streamCount === 1);
			await waitFor(() => Buffer.concat(received).toString().includes("joiner-only"));
			expect(streamCount).toBe(1);
			result.lease.release();
			expect(poolOutstanding()).toBe(0);
		} finally {
			releaseBody?.();
			__setCursorH2EstablishBodyGate(undefined);
		}
	});

	it("does not reconnect a pre-disposal acquisition after readiness", async () => {
		const baseUrl = await startServer();
		serveStream = respondOk;
		const disposal = Promise.withResolvers<void>();
		__setCursorH2FreshSessionHook(() => {
			queueMicrotask(() => {
				void disposeCursorH2Pool().then(disposal.resolve, disposal.reject);
			});
		});
		try {
			const acquisition = acquireCursorH2(runArgs(baseUrl));
			await expect(acquisition).rejects.toThrow("HTTP/2 pool disposed during acquire");
			await disposal.promise;
			expect(__cursorH2ConnectingSnapshot()).toEqual([]);
			expect(__cursorH2PoolSnapshot()).toEqual([]);
			expect(totalSessions).toBe(1);
		} finally {
			__setCursorH2FreshSessionHook(undefined);
		}
	});
});

describe("direct HTTP/2 handshake deadline", () => {
	// Real platform timers: the deadline under test is a wall-clock socket
	// deadline inside the real http2 stack, which fake timers cannot drive.
	// The explicit test timeout turns a regression (no deadline at all) into
	// a fast failure instead of a hang.
	it("rejects a stalled handshake, releases its reservation, and lets a later acquire reconnect", async () => {
		__setCursorH2HandshakeTimeoutMs(60);
		const accepted: net.Socket[] = [];
		const srv = net.createServer(socket => {
			// Accept TCP but never answer the TLS ClientHello: the h2 session's
			// handshake never completes, so only the deadline can settle this
			// establishment — the shape an SDK caller with no AbortSignal hits
			// against a stalled gateway. (Plain-HTTP prior-knowledge connects
			// emit `connect` on socket open, so the stall needs TLS.) The
			// teardown follows the pool's cancel path; Bun's http2 cannot
			// close this peer socket itself (ERR_HTTP2_NO_SOCKET_MANIPULATION),
			// so the test asserts settlement, reservation release, and a fresh
			// reconnect rather than server-side socket death.
			accepted.push(socket);
		});
		const listening = Promise.withResolvers<void>();
		srv.once("error", listening.reject);
		srv.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = srv.address();
		if (!address || typeof address === "string") {
			throw new Error("expected silent fixture to bind a tcp port");
		}
		const baseUrl = `https://127.0.0.1:${address.port}`;

		const acquireExpectingTimeout = async (): Promise<unknown> => {
			try {
				const acquisition = await acquireCursorH2(runArgs(baseUrl));
				return acquisition.ok ? new Error("expected rejection, got a lease") : acquisition.unavailable;
			} catch (error) {
				return error;
			}
		};

		try {
			const first = await acquireExpectingTimeout();
			expect(String(first)).toContain("handshake timed out");
			// The stalled establishment must not keep its shared reservation.
			await waitFor(() => __cursorH2ConnectingSnapshot().length === 0);
			// A later acquisition connects afresh instead of joining the
			// stalled one: the silent server accepts a second connection.
			const second = await acquireExpectingTimeout();
			expect(String(second)).toContain("handshake timed out");
			expect(accepted.length).toBe(2);
		} finally {
			__setCursorH2HandshakeTimeoutMs(undefined);
			for (const socket of accepted) socket.destroy();
			const closed = Promise.withResolvers<void>();
			srv.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 2_000);
});

describe("cursor transport gRPC trailer decoding", () => {
	function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
		const frame = Buffer.alloc(5 + data.length);
		frame[0] = flags;
		frame.writeUInt32BE(data.length, 1);
		frame.set(data, 5);
		return frame;
	}

	function textDeltaFrame(text: string): Buffer {
		const message = create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
				}),
			},
		});
		return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
	}

	function turnEndedFrame(): Buffer {
		const message = create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
				}),
			},
		});
		return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
	}

	function makeModel(baseUrl: string): Model<"cursor-agent"> {
		return buildModel({
			id: "cursor-trailer-fixture",
			name: "Cursor trailer fixture",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
	}

	const context: Context = {
		messages: [{ role: "user", content: "trailer decoding", timestamp: 1 }],
	};

	it("records a nonzero grpc-status even when grpc-message is malformed percent-encoding", async () => {
		const baseUrl = await startServer();
		serveStream = stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => {
				// "50% o..." is not valid percent-encoding: a naive
				// decodeURIComponent throws on it inside the trailers
				// fulfillment handler.
				stream.sendTrailers({ "grpc-status": "13", "grpc-message": "50% of quota exhausted" });
			});
			stream.write(textDeltaFrame("hello"));
			stream.write(turnEndedFrame());
			stream.end();
		};

		const events: string[] = [];
		const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" });
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events.at(-1)).toBe("error");
		expect(events).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gRPC error 13");
		expect(result.errorMessage).toContain("50% of quota exhausted");
	});
});
