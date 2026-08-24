import { truncateHeadBytes, truncateTailBytes } from "./streaming-output";

export const PROGRESS_PREVIEW_MAX_BYTES = 3_000;

export interface ProgressPreview {
	text?: string;
	head?: string;
	tail?: string;
	truncated: boolean;
}

const PROGRESS_PREVIEW_HEAD_BYTES = Math.floor(PROGRESS_PREVIEW_MAX_BYTES / 2);
const PROGRESS_PREVIEW_TAIL_BYTES = PROGRESS_PREVIEW_MAX_BYTES - PROGRESS_PREVIEW_HEAD_BYTES;

/** Drop a partial trailing line so a truncated head ends on a complete line. */
function snapHeadToLine(head: string): string {
	const cut = head.lastIndexOf("\n");
	return cut > 0 ? head.slice(0, cut) : head;
}

/** Drop a partial leading line so a truncated tail starts on a complete line. */
function snapTailToLine(tail: string): string {
	const cut = tail.indexOf("\n");
	return cut >= 0 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail;
}

/**
 * Build the UTF-8-safe wire preview. Windows that fit the byte budget keep
 * their exact text; only oversized windows split into a pure byte-split
 * head/tail pair whose middle bytes were dropped. `head + tail` always
 * rejoins to the exact retained text. Model delivery applies line snapping
 * separately in {@link buildLineSnappedPreview}.
 */
export function buildProgressPreview(text: string, sourceTruncated = false): ProgressPreview {
	const fullBytes = Buffer.byteLength(text, "utf8");
	if (fullBytes <= PROGRESS_PREVIEW_MAX_BYTES) {
		return { text, truncated: sourceTruncated };
	}
	const retainedBytes = Math.min(fullBytes, PROGRESS_PREVIEW_MAX_BYTES);
	const headBytes = Math.floor(retainedBytes / 2);
	const tailBytes = retainedBytes - headBytes;
	return {
		head: truncateHeadBytes(text, headBytes).text,
		tail: truncateTailBytes(text, tailBytes).text,
		truncated: true,
	};
}

/**
 * Model-facing variant of {@link buildProgressPreview}: head and tail snap to
 * complete lines so structured `<head>` / `<tail>` blocks never split a line.
 * Windows that fit the budget split at the newline nearest the midpoint;
 * single-line windows keep the byte split.
 */
export function buildLineSnappedPreview(text: string, sourceTruncated = false): ProgressPreview {
	const preview = buildProgressPreview(text, sourceTruncated);
	if (!preview.truncated) return preview;
	const fullBytes = Buffer.byteLength(text, "utf8");
	if (fullBytes <= PROGRESS_PREVIEW_MAX_BYTES) {
		const midpoint = Math.floor(text.length / 2);
		const before = text.lastIndexOf("\n", midpoint);
		const after = text.indexOf("\n", midpoint + 1);
		let cut = before;
		if (before <= 0) cut = after;
		else if (after >= 0 && after - midpoint < midpoint - before) cut = after;
		if (cut > 0 && cut < text.length - 1) {
			return { head: text.slice(0, cut), tail: text.slice(cut + 1), truncated: true };
		}
		return preview;
	}
	return {
		head: snapHeadToLine(preview.head ?? ""),
		tail: snapTailToLine(preview.tail ?? ""),
		truncated: true,
	};
}

/**
 * Incrementally retains one bounded progress preview. Once the byte budget is
 * exceeded, the prefix is fixed and only the rolling suffix changes, so a
 * chatty 200 ms window never needs to materialize its complete inline text.
 */
export class ProgressPreviewAccumulator {
	#text = "";
	#head = "";
	#tail = "";
	#truncated = false;
	#sourceTruncated = false;

	append(text: string, sourceTruncated = false): void {
		this.#sourceTruncated ||= sourceTruncated;
		if (text.length === 0) return;
		const chunk = this.#hasOutput() ? `\n${text}` : text;
		if (this.#truncated) {
			this.#tail = truncateTailBytes(`${this.#tail}${chunk}`, PROGRESS_PREVIEW_TAIL_BYTES).text;
			return;
		}

		const combined = `${this.#text}${chunk}`;
		if (Buffer.byteLength(combined, "utf8") <= PROGRESS_PREVIEW_MAX_BYTES) {
			this.#text = combined;
			return;
		}

		this.#head = truncateHeadBytes(combined, PROGRESS_PREVIEW_HEAD_BYTES).text;
		this.#tail = truncateTailBytes(combined, PROGRESS_PREVIEW_TAIL_BYTES).text;
		this.#text = "";
		this.#truncated = true;
	}

	appendPreview(preview: ProgressPreview): void {
		this.append(flattenPreviewText(preview), preview.truncated);
	}

	take(): ProgressPreview | undefined {
		if (!this.#hasOutput()) {
			if (!this.#sourceTruncated) return undefined;
			const preview = buildProgressPreview("", true);
			this.clear();
			return preview;
		}
		const preview = this.#truncated
			? { head: this.#head, tail: this.#tail, truncated: true }
			: buildProgressPreview(this.#text, this.#sourceTruncated);
		this.clear();
		return preview;
	}

	clear(): void {
		this.#text = "";
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
		this.#sourceTruncated = false;
	}

	#hasOutput(): boolean {
		return this.#text.length > 0 || this.#head.length > 0 || this.#tail.length > 0;
	}
}

/**
 * Flatten a preview back into running text for display or further merging.
 * Truncated head/tail pairs dropped their middle bytes, so the seam between
 * them is a fabricated boundary: snap both cut points to complete lines so
 * the seam never splits a line mid-way. Single-line sides keep the byte cut.
 */
export function flattenPreviewText(preview: ProgressPreview): string {
	if (preview.text !== undefined) return preview.text;
	const head = snapHeadToLine(preview.head ?? "");
	const tail = snapTailToLine(preview.tail ?? "");
	if (head.length === 0) return tail;
	if (tail.length === 0) return head;
	return `${head}\n${tail}`;
}
/** Merge two already-bounded windows while retaining only their outer head and tail. */
export function mergeProgressPreviews(left: ProgressPreview, right: ProgressPreview): ProgressPreview {
	const accumulator = new ProgressPreviewAccumulator();
	accumulator.appendPreview(left);
	accumulator.appendPreview(right);
	return accumulator.take() ?? { text: "", truncated: false };
}
