/**
 * A fixed-capacity circular buffer that supports efficient push/pop/shift/unshift operations.
 * When the buffer is full, adding new items overwrites the oldest items (FIFO behavior).
 *
 * @template T The type of elements stored in the buffer.
 */
export class RingBuffer<T> {
	#buf: (T | undefined)[];
	#head = 0;
	#size = 0;

	/**
	 * Creates a new ring buffer with the specified capacity.
	 *
	 * @param capacity - The maximum number of elements the buffer can hold. Must be positive.
	 */
	constructor(public readonly capacity: number) {
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		this.#buf = new Array(capacity);
	}

	/**
	 * The number of elements currently in the buffer.
	 */
	get length(): number {
		return this.#size;
	}

	/**
	 * Whether the buffer is at full capacity.
	 */
	get isFull(): boolean {
		return this.#size === this.capacity;
	}

	/**
	 * Whether the buffer is empty (contains no elements).
	 */
	get isEmpty(): boolean {
		return this.#size === 0;
	}

	/**
	 * Adds an item to the end of the buffer.
	 * If the buffer is full, the oldest item is overwritten and returned.
	 *
	 * @param item - The item to add.
	 * @returns The overwritten item if the buffer was full, otherwise `undefined`.
	 */
	push(item: T): T | undefined {
		const idx = (this.#head + this.#size) % this.capacity;
		const overwritten = this.#size === this.capacity ? this.#buf[idx] : undefined;
		this.#buf[idx] = item;
		if (this.#size === this.capacity) {
			this.#head = (this.#head + 1) % this.capacity;
		} else {
			this.#size++;
		}
		return overwritten;
	}

	/**
	 * Removes and returns the first (oldest) item from the buffer.
	 *
	 * @returns The removed item, or `undefined` if the buffer is empty.
	 */
	shift(): T | undefined {
		if (this.#size === 0) return undefined;
		const item = this.#buf[this.#head];
		this.#buf[this.#head] = undefined;
		this.#head = (this.#head + 1) % this.capacity;
		this.#size--;
		return item;
	}

	/**
	 * Removes and returns the last (newest) item from the buffer.
	 *
	 * @returns The removed item, or `undefined` if the buffer is empty.
	 */
	pop(): T | undefined {
		if (this.#size === 0) return undefined;
		const idx = (this.#head + this.#size - 1) % this.capacity;
		const item = this.#buf[idx];
		this.#buf[idx] = undefined;
		this.#size--;
		return item;
	}

	/**
	 * Adds an item to the beginning of the buffer.
	 * If the buffer is full, the newest item is overwritten and returned.
	 *
	 * @param item - The item to add.
	 * @returns The overwritten item if the buffer was full, otherwise `undefined`.
	 */
	unshift(item: T): T | undefined {
		this.#head = (this.#head - 1 + this.capacity) % this.capacity;
		const overwritten = this.#size === this.capacity ? this.#buf[this.#head] : undefined;
		this.#buf[this.#head] = item;
		if (this.#size < this.capacity) this.#size++;
		return overwritten;
	}

	/**
	 * Returns the element at the specified index without removing it.
	 * Supports negative indices (e.g., `-1` for the last element).
	 *
	 * @param index - The zero-based index, or negative index from the end.
	 * @returns The element at the index, or `undefined` if the index is out of bounds.
	 */
	at(index: number): T | undefined {
		if (index < 0) index += this.#size;
		if (index < 0 || index >= this.#size) return undefined;
		return this.#buf[(this.#head + index) % this.capacity];
	}

	/**
	 * Returns the first (oldest) element without removing it.
	 *
	 * @returns The first element, or `undefined` if the buffer is empty.
	 */
	peek(): T | undefined {
		return this.at(0);
	}

	/**
	 * Returns the last (newest) element without removing it.
	 *
	 * @returns The last element, or `undefined` if the buffer is empty.
	 */
	peekBack(): T | undefined {
		return this.at(this.#size - 1);
	}

	/**
	 * Removes all elements from the buffer, resetting it to an empty state.
	 */
	clear(): void {
		this.#buf.fill(undefined, 0, this.capacity);
		this.#head = 0;
		this.#size = 0;
	}

	/**
	 * Returns an iterator that yields elements in logical order (oldest to newest).
	 * Allows the buffer to be used with `for...of` loops and spread syntax.
	 *
	 * @yields Elements in FIFO order.
	 */
	*[Symbol.iterator](): Iterator<T> {
		for (let i = 0; i < this.#size; i++) {
			yield this.#buf[(this.#head + i) % this.capacity] as T;
		}
	}

	/**
	 * Creates a new array containing all elements in logical order (oldest to newest).
	 *
	 * @returns A new array with all buffer elements.
	 */
	toArray(): T[] {
		if (this.#head + this.#size <= this.capacity) {
			return this.#buf.slice(this.#head, this.#head + this.#size) as T[];
		}
		const tail = this.#buf.slice(this.#head, this.capacity);
		const head = this.#buf.slice(0, (this.#head + this.#size) % this.capacity);
		return tail.concat(head) as T[];
	}
}
