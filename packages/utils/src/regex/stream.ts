/** Incremental search over a stream of UTF-16 chunks. */
export interface RegexStream {
	/** Appends a chunk without rescanning earlier chunks. */
	push(chunk: string): void;
	/** Whether the matcher accepts the text seen so far. */
	readonly matched: boolean;
}
