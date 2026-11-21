/**
 * Worker-owned `omp --mode rpc` sessions: one native messaging port to the omp native host ({@link NATIVE_HOST}) per
 * session. They outlive any panel (scheduled runs start them with no panel open); a panel drives them by key.
 */
import { type FromNativeHost, NATIVE_HOST, type RpcSessionInfo, type ToNativeHost } from "../messages";
import { connectChatRelay } from "./relay";
import { SessionValue } from "./session-store";

/** How long the native host may take to start omp before the open fails. */
const READY_TIMEOUT_MS = 30_000;

/** The rpc command line that stops a session's running turn (`modes/rpc/rpc-mode.ts`). */
export const RPC_ABORT_LINE = JSON.stringify({ type: "abort" });

interface Live {
	port: chrome.runtime.Port;
	/** Partial oversized lines by chunk id. */
	chunks: Map<number, string[]>;
}

/** Every rpc session this browser run started, with a native port for each one still running. */
export class RpcSessions {
	readonly #list = new SessionValue<RpcSessionInfo[]>("omp.rpcSessions", () => []);
	readonly #live = new Map<string, Live>();
	readonly #lineListeners = new Set<(sessionKey: string, line: string) => void>();
	readonly #changed: (sessions: RpcSessionInfo[]) => void;
	readonly #panelLine: (sessionKey: string, line: string) => void;
	/** Set once stored sessions from before a worker restart were marked exited. */
	#reconciled: Promise<RpcSessionInfo[]> | null = null;

	/**
	 * `changed` receives the full list whenever a session starts, exits or closes; `panelLine` every stdout line, for
	 * the panels (without the synthetic `rpc_exit` lines, which panels learn from `changed`).
	 */
	constructor(
		changed: (sessions: RpcSessionInfo[]) => void,
		panelLine: (sessionKey: string, line: string) => void,
	) {
		this.#changed = changed;
		this.#panelLine = panelLine;
	}

	/** Every session, live or exited, oldest first. */
	list(): Promise<RpcSessionInfo[]> {
		this.#reconciled ??= this.#list.get().then(sessions => {
			// Native ports die with the worker, and so do their hosts: a stored session without a port has exited.
			let stale = false;
			for (const session of sessions) {
				if (session.exited || this.#live.has(session.sessionKey)) continue;
				session.exited = { code: null, stderr: "the extension's service worker restarted" };
				stale = true;
			}
			if (stale) void this.#list.save();
			return sessions;
		});
		return this.#reconciled;
	}

	/** Every stdout line of every session, plus one final `{"type":"rpc_exit",code,stderr}` line when it ends. */
	onLine(listener: (sessionKey: string, line: string) => void): () => void {
		this.#lineListeners.add(listener);
		return () => this.#lineListeners.delete(listener);
	}

	/** The running session that works in `tabId`, if any. */
	async forTab(tabId: number): Promise<RpcSessionInfo | undefined> {
		const sessions = await this.list();
		return sessions.find(
			session => !session.exited && this.#live.has(session.sessionKey) && session.tabIds.includes(tabId),
		);
	}

	/** Start `omp --mode rpc` in `cwd`; resolves once the host reports it running. */
	async open(options: { cwd: string; title: string; tabIds: number[] }): Promise<RpcSessionInfo> {
		const sessions = await this.list();
		const info: RpcSessionInfo = {
			sessionKey: crypto.randomUUID(),
			cwd: options.cwd,
			title: options.title,
			startedAt: Date.now(),
			tabIds: [...options.tabIds],
		};
		const port = chrome.runtime.connectNative(NATIVE_HOST);
		const live: Live = { port, chunks: new Map() };
		this.#live.set(info.sessionKey, live);
		const ready = Promise.withResolvers<void>();
		let started = false;
		let relay: { receive(line: string): void; close(): void } | undefined;
		const timer = setTimeout(() => {
			ready.reject(new Error(`omp native host did not start omp within ${READY_TIMEOUT_MS / 1000}s`));
			port.disconnect();
			this.#live.delete(info.sessionKey);
		}, READY_TIMEOUT_MS);

		const exit = (code: number | null, stderr: string): void => {
			if (!this.#live.has(info.sessionKey)) return;
			this.#live.delete(info.sessionKey);
			clearTimeout(timer);
			if (!started) {
				ready.reject(new Error(stderr.trim() || `omp native host exited (${code ?? "disconnected"})`));
				return;
			}
			info.exited = { code, stderr };
			void this.#list.save();
			this.#changed(sessions);
			this.#ended(info.sessionKey, code, stderr);
		};

		port.onMessage.addListener((message: FromNativeHost) => {
			switch (message.t) {
				case "linked":
					relay = connectChatRelay(port);
					return;
				case "relay":
					relay?.receive(message.line);
					return;
				case "ready":
					started = true;
					clearTimeout(timer);
					ready.resolve();
					return;
				case "rpc":
					this.#deliver(info.sessionKey, message.line);
					return;
				case "chunk": {
					const parts = live.chunks.get(message.id) ?? [];
					parts[message.index] = message.data;
					if (!message.last) {
						live.chunks.set(message.id, parts);
						return;
					}
					live.chunks.delete(message.id);
					const line = parts.join("");
					if (message.relay) relay?.receive(line);
					else this.#deliver(info.sessionKey, line);
					return;
				}
				case "exit":
					exit(message.code, message.stderr);
					port.disconnect();
					return;
			}
		});
		port.onDisconnect.addListener(() => {
			relay?.close();
			exit(null, chrome.runtime.lastError?.message ?? "omp native host disconnected");
		});
		const open: ToNativeHost = { t: "open", cwd: options.cwd, extensionId: chrome.runtime.id };
		port.postMessage(open);

		await ready.promise;
		sessions.push(info);
		void this.#list.save();
		this.#changed(sessions);
		return info;
	}

	/** Write one rpc command line to the session's stdin. */
	send(sessionKey: string, line: string): void {
		const live = this.#live.get(sessionKey);
		if (!live) throw new Error(`rpc session ${sessionKey} is not running`);
		const frame: ToNativeHost = { t: "rpc", line };
		live.port.postMessage(frame);
	}

	/** Stop the session's process and forget it. */
	async close(sessionKey: string): Promise<void> {
		const sessions = await this.list();
		const live = this.#live.get(sessionKey);
		if (live) {
			this.#live.delete(sessionKey);
			live.port.disconnect();
			this.#ended(sessionKey, null, "closed");
		}
		const index = sessions.findIndex(session => session.sessionKey === sessionKey);
		if (index < 0) return;
		sessions.splice(index, 1);
		void this.#list.save();
		this.#changed(sessions);
	}

	#deliver(sessionKey: string, line: string): void {
		this.#panelLine(sessionKey, line);
		this.#notify(sessionKey, line);
	}

	/** Tell line listeners the session is over, so nothing waits on it forever. */
	#ended(sessionKey: string, code: number | null, stderr: string): void {
		this.#notify(sessionKey, JSON.stringify({ type: "rpc_exit", code, stderr }));
	}

	#notify(sessionKey: string, line: string): void {
		for (const listener of this.#lineListeners) {
			try {
				listener(sessionKey, line);
			} catch {
				// One listener's failure must not starve the others.
			}
		}
	}
}
