/**
 * Shared helpers for tool-rendered UI components.
 */
import type { Theme, ThemeBg } from "../theme/theme";
import { padding, visibleWidth } from "../utils";
import type { State } from "./types";

/** Cached typed-array scratch space for hashing non-string primitives. */
const hashBuf = new ArrayBuffer(8);
const hashView = new DataView(hashBuf);
const hashBytes1 = new Uint8Array(hashBuf, 0, 1);
const hashBytes4 = new Uint8Array(hashBuf, 0, 4);
const hashBytes8 = new Uint8Array(hashBuf, 0, 8);

/**
 * Incremental xxHash64 key builder.
 *
 * Chains `Bun.hash.xxHash64` calls via seeding — each fed value
 * mixes into the running hash without intermediate string allocations.
 * Accepts strings, numbers (u32), booleans, bigints, and `undefined`/`null`
 * (hashed as a sentinel byte) natively.
 */
export class Hasher {
	#h = 0n;

	/** Feed a string. */
	str(s: string): this {
		hashView.setUint32(0, s.length);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		this.#h = Bun.hash.xxHash64(s, this.#h);
		return this;
	}

	/** Feed an unsigned 32-bit integer. */
	u32(n: number): this {
		hashView.setUint32(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		return this;
	}

	/** Feed a 64-bit bigint. */
	u64(n: bigint): this {
		hashView.setBigUint64(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes8, this.#h);
		return this;
	}

	/** Feed a boolean (single byte: 1 = true, 0 = false). */
	bool(b: boolean): this {
		hashView.setUint8(0, b ? 1 : 0);
		this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		return this;
	}

	/** Feed a value that may be `undefined` or `null` (hashed as a 0xFF sentinel byte). */
	optional(v: string | undefined | null): this {
		if (v == null) {
			hashView.setUint8(0, 0xff);
			this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		} else {
			this.#h = Bun.hash.xxHash64(v, this.#h);
		}
		return this;
	}

	/** Return the final hash digest. */
	digest(): bigint {
		return this.#h;
	}
}

/** Render-cache entry used by tool renderers. */
export interface RenderCache {
	key: bigint;
	lines: string[];
}

/** Build indentation and continuing branches for ancestor levels. */
export function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

/** Return the branch glyph for a final or continuing tree item. */
export function getTreeBranch(isLast: boolean, theme: Theme): string {
	return isLast ? theme.tree.last : theme.tree.branch;
}

/** Return the continuation prefix for subsequent lines of a tree item. */
export function getTreeContinuePrefix(isLast: boolean, theme: Theme): string {
	return isLast ? "   " : `${theme.tree.vertical}  `;
}

/** Pad visible text to a target width and optionally apply a background. */
export function padToWidth(text: string, width: number, bgFn?: (s: string) => string): string {
	if (width <= 0) return bgFn ? bgFn(text) : text;
	const paddingNeeded = Math.max(0, width - visibleWidth(text));
	const padded = paddingNeeded > 0 ? text + padding(paddingNeeded) : text;
	return bgFn ? bgFn(padded) : padded;
}

/** Resolve a tool output state to its background color token. */
export function getStateBgColor(state: State): ThemeBg {
	if (state === "success") return "toolSuccessBg";
	if (state === "error") return "toolErrorBg";
	return "toolPendingBg";
}
