/**
 * Line-framed duplex link between the IDA host protocol's two ends. A host in another process is
 * reached through an `IpcConnection`; a host that runs inside this omp process (contained mode,
 * where only omp holds the session's sandbox runtime) is reached through {@link createIdaLink}.
 * Both present the same surface, so the host and `IdaDatabase` serve either.
 */

/** The part of `IpcConnection` the IDA host protocol uses. */
export interface IdaLink {
	/** Begin delivery; `onClose` fires once, after the last frame (`null` = orderly close). */
	start(onLine: (line: string) => void, onClose: (reason: string | null) => void): void;
	send(line: string): unknown;
	/** Deliver what was sent, then close both sides. */
	end(): void;
	/** Close both sides now; undelivered frames are dropped. */
	destroy(): void;
}

class LinkEnd implements IdaLink {
	#peer: LinkEnd | undefined;
	#onLine: ((line: string) => void) | undefined;
	#onClose: ((reason: string | null) => void) | undefined;
	/** Frames received before `start`. */
	#early: string[] = [];
	#closed = false;
	#notified = false;

	static pair(): [LinkEnd, LinkEnd] {
		const a = new LinkEnd();
		const b = new LinkEnd();
		a.#peer = b;
		b.#peer = a;
		return [a, b];
	}

	start(onLine: (line: string) => void, onClose: (reason: string | null) => void): void {
		this.#onLine = onLine;
		this.#onClose = onClose;
		for (const line of this.#early.splice(0)) onLine(line);
		if (this.#closed) this.#notifyClose();
	}

	send(line: string): boolean {
		const peer = this.#peer;
		if (this.#closed || !peer) return false;
		// Delivered on a later microtask, like a socket: the sender never re-enters the receiver.
		queueMicrotask(() => peer.#receive(line));
		return true;
	}

	end(): void {
		// Queued after every frame already sent, so those still arrive.
		queueMicrotask(() => this.destroy());
	}

	destroy(): void {
		this.#close();
		const peer = this.#peer;
		if (peer) peer.#close();
	}

	#receive(line: string): void {
		if (this.#closed) return;
		if (this.#onLine) this.#onLine(line);
		else this.#early.push(line);
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#onClose) queueMicrotask(() => this.#notifyClose());
	}

	#notifyClose(): void {
		if (this.#notified) return;
		this.#notified = true;
		this.#onClose?.(null);
	}
}

/** Two connected ends: what one sends, the other receives. */
export function createIdaLink(): [IdaLink, IdaLink] {
	return LinkEnd.pair();
}
