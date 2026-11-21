import { insideSurrogatePair } from "./alphabet";

/** Steps over a code point from a boundary, possibly one position past the text. */
export function stepCodePoint(text: string, position: number, backward: boolean): number {
	const step = backward ? -1 : 1;
	const adjacent = position + step;
	return insideSurrogatePair(text, adjacent) ? adjacent + step : adjacent;
}

/** JSC evaluates a single finite `v` atom, never the pattern around it. */
export class StringAtom {
	readonly nullable: boolean;
	readonly #forward: RegExp;
	#backward: RegExp | undefined;
	#whole: RegExp | undefined;

	constructor(source: string, flags: string) {
		this.#forward = new RegExp(source, `${flags}y`);
		this.nullable = this.#forward.test("");
	}

	/** The other end of the preferred match, or -1. */
	first(text: string, position: number, backward: boolean): number {
		// A sticky Unicode RegExp rounds down inside a surrogate pair. The VM must not.
		return insideSurrogatePair(text, position) ? -1 : this.#matchAt(text, position, backward);
	}

	/** The preferred match within the shorter prefix (or suffix) bounded by `limit`. */
	retry(text: string, position: number, limit: number, backward: boolean): number {
		const start = backward ? limit : position;
		const span = text.slice(start, backward ? position : limit);
		const end = this.#matchAt(span, backward ? span.length : 0, backward);
		return end < 0 ? -1 : start + end;
	}

	/** JSC can try empty before the singleton; all longer strings precede both. */
	singleAfterEmpty(text: string, position: number, backward: boolean): number {
		const end = stepCodePoint(text, position, backward);
		if (end < 0 || end > text.length) return -1;
		const whole = (this.#whole ??= new RegExp(
			`^(?:${this.#forward.source})(?![\\s\\S])`,
			this.#forward.flags.replace("y", ""),
		));
		const point = backward ? text.slice(end, position) : text.slice(position, end);
		return whole.test(point) ? end : -1;
	}

	#matchAt(text: string, position: number, backward: boolean): number {
		const forward = this.#forward;
		if (!backward) {
			forward.lastIndex = position;
			return forward.test(text) ? forward.lastIndex : -1;
		}
		const reverse = (this.#backward ??= new RegExp(`(?<=(${forward.source}))`, forward.flags));
		reverse.lastIndex = position;
		const match = reverse.exec(text);
		return match ? position - match[1]!.length : -1;
	}
}
