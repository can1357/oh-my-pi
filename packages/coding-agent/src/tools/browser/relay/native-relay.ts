/**
 * The browser relay half of the native host: what a `link` port does (`native-host.ts` hands it over).
 *
 * Every browser running the omp extension keeps one link port open, so each has a native host on this path. The
 * first to bind the relay port leads: it runs the relay server (`server.ts`) and links its own browser into the
 * bridge in-process. Any other browser's host follows: it forwards its browser's relay messages to the leader's
 * `/ext` websocket. When the leader goes away (its browser quit, or it restarted for an omp upgrade) the followers
 * elect again: one binds the port, the rest follow it. The extension hears `linked` each time it has a relay (and
 * says hello) and `unlinked` when it lost one.
 *
 * The relay therefore runs exactly while some browser with the extension does; there is nothing else to start.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { FromNativeHost, ToNativeHost } from "../../../../../browser-relay/extension/messages";
import type { RelaySocket } from "./bridge";
import { publishRelayEndpoint } from "./discovery";
import { isOlderOmpVersion } from "./protocol";
import { type RelayServer, startRelayServer } from "./server";

/** First pause before electing again when neither leading nor following worked. */
const RELINK_MIN_MS = 250;
/** Longest pause between elections while something that is not a relay holds the port. */
const RELINK_MAX_MS = 5_000;
/** Time the 202 of an accepted restart gets to reach the asking omp before the server stops. */
const RESTART_GRACE_MS = 100;

/** What {@link serveRelayLink} needs from the host's port. */
export interface RelayLinkPort {
	/** Port the relay serves on. */
	port: number;
	/** The linked extension's id. */
	extensionId: string;
	/** Next extension message; null once the port closed. */
	next(): Promise<ToNativeHost | null>;
	/** Send a control frame (`linked`, `unlinked`) to the extension. */
	send(message: FromNativeHost): void;
	/** Send one relay → extension message, chunked as needed. */
	relayLine(line: string): void;
	/** Diagnostics; never stdout. */
	log(message: string): void;
}

/**
 * Keep this browser linked to a relay until the extension disconnects or this host, as leader, accepts a restart.
 * Resolves then; the caller exits so Chrome can start the next host from the installed omp.
 */
export function serveRelayLink(port: RelayLinkPort): Promise<void> {
	return new BrowserLink(port).run();
}

/** One link from this browser to a relay. */
interface Upstream {
	/** Forward one extension → relay message. */
	send(line: string): void;
	/** The extension left: drop the link. */
	close(): void;
	/** Settles with the reason the link ended. */
	ended: Promise<string>;
}

class BrowserLink {
	readonly #port: RelayLinkPort;
	readonly #left = Promise.withResolvers<void>();
	/** Set while this host leads. */
	#server: RelayServer | null = null;
	#upstream: Upstream | null = null;
	#gone = false;
	#restarting = false;

	constructor(port: RelayLinkPort) {
		this.#port = port;
	}

	async run(): Promise<void> {
		void this.#pump();
		let pause = RELINK_MIN_MS;
		while (!this.#gone && !this.#restarting) {
			const upstream = this.#lead() ?? (this.#port.port === 0 ? null : await this.#follow());
			if (upstream === null) {
				await Promise.race([Bun.sleep(pause), this.#left.promise]);
				pause = Math.min(pause * 2, RELINK_MAX_MS);
				continue;
			}
			// The extension may have left while the link was forming.
			if (this.#gone) {
				upstream.close();
				break;
			}
			pause = RELINK_MIN_MS;
			this.#upstream = upstream;
			const unpublish = this.#port.port === 0 && this.#server
				? await publishRelayEndpoint(this.#server.port).catch(error => {
					this.#port.log(`cannot publish relay endpoint: ${String(error)}`);
					return undefined;
				})
				: undefined;
			this.#port.send({ t: "linked" });
			const reason = await upstream.ended;
			await unpublish?.();
			this.#upstream = null;
			if (this.#gone || this.#restarting) break;
			this.#port.send({ t: "unlinked", reason });
		}
		this.#server?.stop();
	}

	/** Extension → relay until the port closes. Messages between links are dropped: the extension says hello again on the next `linked`. */
	async #pump(): Promise<void> {
		for (;;) {
			const message = await this.#port.next();
			if (message === null) break;
			if (message.t === "relay") this.#upstream?.send(message.line);
			else this.#port.log(`ignoring ${message.t} on a relay link`);
		}
		this.#gone = true;
		this.#upstream?.close();
		this.#left.resolve();
	}

	/** Link in-process, starting the server unless this host already leads; null when another process holds the port. */
	#lead(): Upstream | null {
		const server = this.#server ?? this.#serve();
		if (server === null) return null;
		const { bridge } = server;
		const ended = Promise.withResolvers<string>();
		const socket: RelaySocket = {
			send: line => this.#port.relayLine(line),
			// The bridge retires this browser's link (it told it to reload, or it linked again); like a websocket close,
			// the bridge hears of it after the call returns.
			close: () => {
				queueMicrotask(() => bridge.extClosed(socket));
				ended.resolve("the relay dropped this browser");
			},
		};
		bridge.extConnected(socket, this.#port.extensionId);
		return {
			send: line => bridge.extMessage(socket, line),
			close: () => {
				bridge.extClosed(socket);
				ended.resolve("the extension left");
			},
			ended: ended.promise,
		};
	}

	#serve(): RelayServer | null {
		try {
			this.#server = startRelayServer({
				port: this.#port.port,
				log: (message, data) => logger.debug(`browser relay: ${message}`, data),
				onRestart: request => this.#restart(request),
			});
			return this.#server;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE"))
				this.#port.log(`cannot serve the relay: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** Forward to the leader's `/ext`; null when nothing accepts the connection. */
	async #follow(): Promise<Upstream | null> {
		const ws = new WebSocket(`ws://127.0.0.1:${this.#port.port}/ext`, {
			headers: { Origin: `chrome-extension://${this.#port.extensionId}` },
		});
		const opened = Promise.withResolvers<boolean>();
		const ended = Promise.withResolvers<string>();
		ws.onopen = () => opened.resolve(true);
		ws.onmessage = event => {
			if (typeof event.data === "string") this.#port.relayLine(event.data);
		};
		ws.onclose = event => {
			opened.resolve(false);
			ended.resolve(event.reason || "the relay went away");
		};
		if (!(await opened.promise)) return null;
		return { send: line => ws.send(line), close: () => ws.close(), ended: ended.promise };
	}

	/** A newer omp asks this leader to make way; it stops shortly after accepting, and `run` resolves. */
	#restart(request: { version: string; idleOnly: boolean }): boolean {
		// Only an older relay gives way, or two omp versions would keep replacing each other's.
		if (this.#restarting || !isOlderOmpVersion(VERSION, request.version)) return false;
		if (request.idleOnly && (this.#server?.bridge.cdpClientCount ?? 0) > 0) return false;
		this.#restarting = true;
		setTimeout(() => this.#upstream?.close(), RESTART_GRACE_MS);
		return true;
	}
}
