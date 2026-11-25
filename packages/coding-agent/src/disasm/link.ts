/**
 * In-process tunnel between `client.ts` and a `disasm` unit hosted in this omp process (while the OS
 * sandbox is active, see `daemon/modules/disasm.ts` `openLocalDisasmUnit`). One end is the unit's
 * {@link ModuleTunnel}; the other has the part of a daemon tunnel the client uses ({@link UnitLink}),
 * so the client and the unit serve either kind of tunnel.
 */
import type { ModuleClient, ModuleTunnel } from "../daemon/module";

/** The part of a `DaemonTunnel` the disassembler client uses. */
export interface UnitLink {
	/** Begin delivery; `onClose` fires once, after the last chunk (`null` = orderly close). */
	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void;
	send(data: string | Uint8Array): boolean;
	/** Close both sides; chunks already sent are still delivered. */
	close(): void;
}

const encoder = new TextEncoder();

class LinkEnd implements UnitLink, ModuleTunnel {
	readonly client: ModuleClient;
	#peer: LinkEnd | undefined;
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: ((reason: string | null) => void) | undefined;
	/** Chunks received before `start`. */
	#early: Uint8Array[] = [];
	#closed = false;
	#notified = false;

	private constructor(client: ModuleClient) {
		this.client = client;
	}

	static pair(client: ModuleClient): [LinkEnd, LinkEnd] {
		const a = new LinkEnd(client);
		const b = new LinkEnd(client);
		a.#peer = b;
		b.#peer = a;
		return [a, b];
	}

	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void {
		this.#onData = onData;
		this.#onClose = onClose;
		for (const chunk of this.#early.splice(0)) onData(chunk);
		if (this.#closed) this.#notifyClose();
	}

	send(data: string | Uint8Array): boolean {
		const peer = this.#peer;
		if (this.#closed || !peer) return false;
		const chunk = typeof data === "string" ? encoder.encode(data) : data;
		// Delivered on a later microtask, like a socket: the sender never re-enters the receiver.
		queueMicrotask(() => peer.#receive(chunk));
		return true;
	}

	drained(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {
		// Queued after every chunk already sent, so those still arrive.
		queueMicrotask(() => {
			this.#close();
			const peer = this.#peer;
			if (peer) peer.#close();
		});
	}

	#receive(chunk: Uint8Array): void {
		if (this.#closed) return;
		if (this.#onData) this.#onData(chunk);
		else this.#early.push(chunk);
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

/** Two connected ends: the client's and the unit's; what one sends, the other receives. */
export function createUnitLink(client: ModuleClient): [UnitLink, ModuleTunnel] {
	return LinkEnd.pair(client);
}
