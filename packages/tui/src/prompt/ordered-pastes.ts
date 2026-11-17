export interface OrderedPastesOptions {
	deliver(text: string): void;
	/** Runs the action {@link OrderedPastes.holdAction} deferred, once every paste has settled. */
	run(): void;
	/** False once the owner can no longer take pastes (disposed, closed); completions then refuse. */
	live(): boolean;
	/** Runs after every completion that settles a slot (e.g. to request a render). */
	afterSettle?(): void;
}

interface Slot {
	settled: boolean;
	text: string | undefined;
}

/**
 * Delivers clipboard reads that finish out of order in reservation order; hosts call {@link begin}
 * synchronously so input later in the same chunk (Enter) waits.
 */
export class OrderedPastes {
	readonly #options: OrderedPastesOptions;
	#slots: Slot[] = [];
	#held = false;

	constructor(options: OrderedPastesOptions) {
		this.#options = options;
	}

	/**
	 * Reserves the next slot. Its completion returns whether it accepted text; `undefined` or empty
	 * releases the slot and cancels a held action, so a failed read never submits without its image.
	 */
	begin(): (text: string | undefined) => boolean {
		const slot: Slot = { settled: false, text: undefined };
		this.#slots.push(slot);
		return text => {
			if (!this.#options.live() || slot.settled) return false;
			slot.settled = true;
			slot.text = text;
			if (!text) this.#held = false;
			let delivered = 0;
			for (const paste of this.#slots) {
				if (!paste.settled) break;
				if (paste.text) this.#options.deliver(paste.text);
				delivered++;
			}
			if (delivered > 0) this.#slots.splice(0, delivered);
			if (this.#slots.length === 0 && this.#held) {
				this.#held = false;
				this.#options.run();
			}
			this.#options.afterSettle?.();
			return !!text;
		};
	}

	/** Delivers `text` now, or behind the pastes still pending. */
	paste(text: string): void {
		if (this.#slots.length === 0) this.#options.deliver(text);
		else this.begin()(text);
	}

	/** Defers the action until pastes settle and returns true; false when nothing is pending. */
	holdAction(): boolean {
		if (this.#slots.length === 0) return false;
		this.#held = true;
		return true;
	}

	/** Drops every slot and any held action; late completions then refuse. */
	clear(): void {
		for (const slot of this.#slots) slot.settled = true;
		this.#slots.length = 0;
		this.#held = false;
	}
}
