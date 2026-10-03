/**
 * The character-array machine `omp if-bench` drives.
 *
 * Every action is generated from its absolute index, so a run is fully
 * reproducible: turn N of a run with array length L always issues the same
 * tokens, and the expected result is computed locally by {@link applyActions}
 * rather than trusted from the model. Actions are encoded as single glyphs
 * ({@link encodeAction}) whose meaning lives only in the system prompt,
 * so the model cannot lean on natural-language paraphrase.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Inclusive array-length bounds: `weave` needs an even split, `blocks` needs room for size 7. */
export const MIN_ARRAY_LENGTH = 8;
export const MAX_ARRAY_LENGTH = ALPHABET.length;

/** One machine instruction; positions are 1-based and inclusive. */
export type Action =
	| { kind: "swap"; first: number; second: number }
	| { kind: "rotate-left"; amount: number }
	| { kind: "rotate-right"; amount: number }
	| { kind: "reverse"; first: number; last: number }
	| { kind: "move"; from: number; to: number }
	| { kind: "swap-pairs" }
	| { kind: "odd-even" }
	| { kind: "reverse-blocks"; size: number }
	| { kind: "rotate-span"; first: number; last: number; amount: number }
	| { kind: "weave" };

/**
 * Opening state: `A..Z` truncated to `length` and shuffled by a fixed LCG.
 *
 * Scrambled on purpose — an alphabetical start lets a model reconstruct state
 * from memory instead of reading its own previous answer.
 *
 * @throws when `length` is odd or outside [{@link MIN_ARRAY_LENGTH}, {@link MAX_ARRAY_LENGTH}].
 */
export function initialArray(length: number): string {
	if (!Number.isInteger(length) || length < MIN_ARRAY_LENGTH || length > MAX_ARRAY_LENGTH) {
		throw new Error(`Array length must be an integer in [${MIN_ARRAY_LENGTH}, ${MAX_ARRAY_LENGTH}], got ${length}`);
	}
	if (length % 2 !== 0)
		throw new Error(`Array length must be even (the weave action splits it in half), got ${length}`);
	const chars = ALPHABET.slice(0, length).split("");
	let seed = 0x9e3779b9;
	for (let i = chars.length - 1; i > 0; i -= 1) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		const j = seed % (i + 1);
		[chars[i], chars[j]] = [chars[j]!, chars[i]!];
	}
	return chars.join("");
}

/**
 * The `count` actions starting at absolute index `start`.
 *
 * The kind cycles every 10 indices so each turn mixes local edits (swap, move)
 * with whole-array permutations (weave, odd-even) that invalidate every
 * remembered position.
 */
export function makeActions(length: number, start: number, count: number): Action[] {
	return Array.from({ length: count }, (_, offset) => action(length, start + offset));
}

function action(length: number, index: number): Action {
	const step = index + 1;
	switch (index % 10) {
		case 0: {
			const first = ((step * 5) % length) + 1;
			let second = ((step * 11 + 7) % length) + 1;
			if (first === second) second = (second % length) + 1;
			return { kind: "swap", first, second };
		}
		case 1:
			return { kind: "rotate-left", amount: ((step * 7) % (length - 1)) + 1 };
		case 2: {
			const first = ((step * 5) % (length - 1)) + 1;
			return { kind: "reverse", first, last: first + ((step * 3) % (length - first)) + 1 };
		}
		case 3: {
			const from = ((step * 11) % length) + 1;
			let to = ((step * 13 + 3) % length) + 1;
			if (from === to) to = (to % length) + 1;
			return { kind: "move", from, to };
		}
		case 4:
			return { kind: "rotate-right", amount: ((step * 9) % (length - 1)) + 1 };
		case 5:
			return { kind: "swap-pairs" };
		case 6:
			return { kind: "odd-even" };
		case 7:
			return { kind: "reverse-blocks", size: (step % 5) + 3 };
		case 8: {
			const first = ((step * 7) % (length - 1)) + 1;
			const last = first + ((step * 5) % (length - first)) + 1;
			return { kind: "rotate-span", first, last, amount: ((step * 3) % (last - first)) + 1 };
		}
		default:
			return { kind: "weave" };
	}
}

/** Run `actions` over `input` in order and return the resulting string. */
export function applyActions(input: string, actions: readonly Action[]): string {
	const chars = input.split("");
	for (const action of actions) {
		switch (action.kind) {
			case "swap":
				[chars[action.first - 1], chars[action.second - 1]] = [chars[action.second - 1]!, chars[action.first - 1]!];
				break;
			case "rotate-left":
				chars.push(...chars.splice(0, action.amount));
				break;
			case "rotate-right":
				chars.unshift(...chars.splice(chars.length - action.amount, action.amount));
				break;
			case "reverse":
				chars.splice(
					action.first - 1,
					action.last - action.first + 1,
					...chars.slice(action.first - 1, action.last).reverse(),
				);
				break;
			case "move":
				chars.splice(action.to - 1, 0, chars.splice(action.from - 1, 1)[0]!);
				break;
			case "swap-pairs":
				for (let index = 0; index + 1 < chars.length; index += 2) {
					[chars[index], chars[index + 1]] = [chars[index + 1]!, chars[index]!];
				}
				break;
			case "odd-even": {
				const reordered: string[] = [];
				for (let parity = 0; parity < 2; parity += 1) {
					for (let index = parity; index < chars.length; index += 2) reordered.push(chars[index]!);
				}
				chars.splice(0, chars.length, ...reordered);
				break;
			}
			case "reverse-blocks":
				for (let start = 0; start < chars.length; start += action.size) {
					let left = start;
					let right = Math.min(start + action.size, chars.length) - 1;
					while (left < right) {
						[chars[left], chars[right]] = [chars[right]!, chars[left]!];
						left += 1;
						right -= 1;
					}
				}
				break;
			case "rotate-span":
				chars.splice(action.first - 1, 0, ...chars.splice(action.last - action.amount, action.amount));
				break;
			case "weave": {
				const half = chars.length / 2;
				const woven: string[] = [];
				for (let index = 0; index < half; index += 1) woven.push(chars[half + index]!, chars[index]!);
				chars.splice(0, chars.length, ...woven);
				break;
			}
		}
	}
	return chars.join("");
}

/** Wire form of one action; the system prompt is the only place its glyph is defined. */
export function encodeAction(action: Action): string {
	switch (action.kind) {
		case "swap":
			return `⇄${action.first},${action.second}`;
		case "rotate-left":
			return `↶${action.amount}`;
		case "rotate-right":
			return `↷${action.amount}`;
		case "reverse":
			return `⌁${action.first},${action.last}`;
		case "move":
			return `↦${action.from},${action.to}`;
		case "swap-pairs":
			return "⨯";
		case "odd-even":
			return "≺";
		case "reverse-blocks":
			return `▥${action.size}`;
		case "rotate-span":
			return `⤵${action.first},${action.last},${action.amount}`;
		case "weave":
			return "⋈";
	}
}
