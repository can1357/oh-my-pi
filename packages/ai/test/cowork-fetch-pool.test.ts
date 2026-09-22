import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { coworkFetch, directAgent, MAX_SOCKETS_PER_HOST } from "@oh-my-pi/pi-ai/providers/cowork-fetch";

/**
 * The Cowork transport shares one keepalive agent across every Anthropic
 * request in the process, and a streaming turn holds its socket until the
 * response ends. These tests drive it against a TCP server that accepts
 * connections and then says nothing: the TLS handshake never completes, so each
 * admitted request parks a socket the server can count while the requests
 * behind the cap stay visible in the agent's queue.
 */
const EXTRA_REQUESTS = 8;

/** Accepts and holds sockets so the pool's admission decisions are observable server-side. */
class HoldingServer {
	readonly #server = net.createServer();
	readonly #held = new Set<net.Socket>();
	readonly #watchers: Array<{ target: number; resolve: () => void }> = [];
	opened = 0;
	live = 0;
	peakLive = 0;
	port = 0;

	async listen(): Promise<void> {
		this.#server.on("connection", socket => {
			this.opened++;
			this.live++;
			this.peakLive = Math.max(this.peakLive, this.live);
			this.#held.add(socket);
			// A reset arrives as an error on the server side too; nothing to do but let it close.
			socket.on("error", () => {});
			socket.once("close", () => {
				this.live--;
				this.#held.delete(socket);
			});
			for (const watcher of this.#watchers.splice(0)) {
				if (this.opened >= watcher.target) watcher.resolve();
				else this.#watchers.push(watcher);
			}
		});
		const listening = Promise.withResolvers<void>();
		this.#server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = this.#server.address();
		if (address === null || typeof address === "string") throw new Error("server did not bind a port");
		this.port = address.port;
	}

	/** Resolves once `target` connections have been accepted in total. */
	whenOpened(target: number): Promise<void> {
		if (this.opened >= target) return Promise.resolve();
		const watcher = Promise.withResolvers<void>();
		this.#watchers.push({ target, resolve: watcher.resolve });
		return watcher.promise;
	}

	url(path: string): string {
		return `https://localhost:${this.port}${path}`;
	}

	/** Resets held sockets, the way a provider drops connections mid-flight. */
	reset(count: number): void {
		for (const socket of [...this.#held].slice(0, count)) socket.destroy();
	}

	async close(): Promise<void> {
		this.reset(Number.POSITIVE_INFINITY);
		const closed = Promise.withResolvers<void>();
		this.#server.close(() => closed.resolve());
		await closed.promise;
	}
}

type Attempt = { promise: Promise<void>; outcome: string | null };

/**
 * Starts one request. `coworkFetch` reaches `https.request` synchronously, so
 * the agent's books already reflect the call when this returns.
 */
function fire(url: string, signal?: AbortSignal): Attempt {
	const attempt: Attempt = { outcome: null, promise: Promise.resolve() };
	attempt.promise = coworkFetch(url, { headers: { accept: "*/*" }, signal } as RequestInit).then(
		() => {
			attempt.outcome = "resolved";
		},
		(error: Error) => {
			attempt.outcome = `rejected:${error.name}`;
		},
	);
	return attempt;
}

function queuedRequests(): number {
	return Object.values(directAgent.requests).reduce((total, queue) => total + (queue?.length ?? 0), 0);
}

function openSockets(): number {
	return Object.values(directAgent.sockets).reduce((total, sockets) => total + (sockets?.length ?? 0), 0);
}

describe("coworkFetch connection pool", () => {
	let server: HoldingServer;
	let attempts: Attempt[];

	beforeEach(async () => {
		server = new HoldingServer();
		attempts = [];
		await server.listen();
	});

	afterEach(async () => {
		// Tear the pool down before awaiting anything: a failed assertion can
		// leave a full cap of held sockets, and destroying the agent first is
		// what stops cleanup from waiting on them.
		directAgent.destroy();
		await server.close();
		await Promise.all(attempts.map(attempt => attempt.promise));
		expect(queuedRequests()).toBe(0);
	});

	it("holds a host to one cap of sockets and dials the queued rest as slots free", async () => {
		for (let index = 0; index < MAX_SOCKETS_PER_HOST + EXTRA_REQUESTS; index++) {
			attempts.push(fire(server.url(`/v1/messages?i=${index}`)));
		}
		// Without a cap the agent hands every one of them a socket outright.
		expect(queuedRequests()).toBe(EXTRA_REQUESTS);

		await server.whenOpened(MAX_SOCKETS_PER_HOST);
		// Nothing has closed yet, so live and peak are the admitted set itself.
		expect(server.opened).toBe(MAX_SOCKETS_PER_HOST);
		expect(server.live).toBe(MAX_SOCKETS_PER_HOST);
		expect(server.peakLive).toBe(MAX_SOCKETS_PER_HOST);

		server.reset(MAX_SOCKETS_PER_HOST);
		await server.whenOpened(MAX_SOCKETS_PER_HOST + EXTRA_REQUESTS);

		// Counting live sockets here would race the closing ones, so the proof
		// after the drain is the totals: every queued request dialed, none
		// beyond them did, and the pool never holds more than a cap of sockets.
		expect(queuedRequests()).toBe(0);
		expect(server.opened).toBe(MAX_SOCKETS_PER_HOST + EXTRA_REQUESTS);
		expect(openSockets()).toBeLessThanOrEqual(MAX_SOCKETS_PER_HOST);
	});

	it("settles an aborted request that is still queued instead of holding its place", async () => {
		for (let index = 0; index < MAX_SOCKETS_PER_HOST; index++) {
			attempts.push(fire(server.url(`/v1/messages?i=${index}`)));
		}
		await server.whenOpened(MAX_SOCKETS_PER_HOST);

		const controller = new AbortController();
		const queued = fire(server.url("/v1/messages?i=queued"), controller.signal);
		attempts.push(queued);
		expect(queuedRequests()).toBe(1);

		controller.abort();
		// The queue lets go in the same tick as the abort, before any socket frees.
		expect(queuedRequests()).toBe(0);

		// Every socket stays held, so the only way this request could reach a
		// socket is the pool handing it one — which the race would report.
		const settled = await Promise.race([
			queued.promise.then(() => "settled"),
			server.whenOpened(MAX_SOCKETS_PER_HOST + 1).then(() => "dialed"),
		]);

		expect(settled).toBe("settled");
		expect(queued.outcome).toBe("rejected:AbortError");
		expect(server.opened).toBe(MAX_SOCKETS_PER_HOST);
	});

	it("frees the slot of a socket the peer resets", async () => {
		for (let index = 0; index < MAX_SOCKETS_PER_HOST; index++) {
			attempts.push(fire(server.url(`/v1/messages?i=${index}`)));
		}
		await server.whenOpened(MAX_SOCKETS_PER_HOST);

		const queued = fire(server.url("/v1/messages?i=queued"));
		attempts.push(queued);
		expect(queuedRequests()).toBe(1);

		server.reset(1);
		await server.whenOpened(MAX_SOCKETS_PER_HOST + 1);
		// The killed request settles on its own error; wait for that rather than
		// assume the accept above already carried it.
		await Promise.race(attempts.map(attempt => attempt.promise));

		// The reset killed exactly one request; the queued one took its slot and
		// is still waiting on the server, so the pool lost nothing to the error.
		expect(attempts.filter(attempt => attempt.outcome !== null)).toHaveLength(1);
		expect(queued.outcome).toBeNull();
		expect(queuedRequests()).toBe(0);
		expect(server.opened).toBe(MAX_SOCKETS_PER_HOST + 1);
		expect(openSockets()).toBeLessThanOrEqual(MAX_SOCKETS_PER_HOST);
	});
});
