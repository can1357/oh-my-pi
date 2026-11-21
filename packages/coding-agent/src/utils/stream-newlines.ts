/**
 * Normalizes `\r\n` and lone `\r` to `\n` across streamed chunks. A PTY read can
 * end between the `\r` and `\n` of one line ending; normalizing each chunk on its
 * own would turn that pair into two newlines.
 */
export class StreamNewlineNormalizer {
	#pendingCr = false;

	push(chunk: string): string {
		if (!chunk) return "";
		const text = this.#pendingCr && chunk.charCodeAt(0) === 0x0a ? chunk.slice(1) : chunk;
		this.#pendingCr = chunk.charCodeAt(chunk.length - 1) === 0x0d;
		return text.replace(/\r\n?/gu, "\n");
	}
}
