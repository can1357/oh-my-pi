import { STDOUT_BACKLOG_CLEAR_BYTES } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "./virtual-terminal";

/** A controllable queue that notifies when the renderer can resume. */
export class BackloggedTerminal extends VirtualTerminal {
	#pendingBytes = 0;
	readonly drainListeners = new Set<() => void>();

	get pendingBytes(): number {
		return this.#pendingBytes;
	}

	set pendingBytes(value: number) {
		const previous = this.#pendingBytes;
		this.#pendingBytes = value;
		if (previous > STDOUT_BACKLOG_CLEAR_BYTES && value <= STDOUT_BACKLOG_CLEAR_BYTES) {
			for (const listener of this.drainListeners) listener();
		}
	}

	get pendingOutputBytes(): number {
		return this.pendingBytes;
	}

	onOutputDrain(callback: () => void): () => void {
		this.drainListeners.add(callback);
		return () => this.drainListeners.delete(callback);
	}
}
