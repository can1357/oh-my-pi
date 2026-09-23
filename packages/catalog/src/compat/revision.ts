/**
 * Revision triples (`major.minor.patch`) extracted from model identifiers.
 *
 * The compat engine compares revisions as three unsigned 8-bit components;
 * omitted components are zero (`4.6` ≡ `4.6.0`). Shared by the compile-time
 * rule compiler and the runtime taxonomy/cascade.
 */

/** A parsed `major.minor.patch` revision. */
export type Revision = readonly [number, number, number];

function parseComponent(value: string): number | undefined {
	if (!value) return undefined;
	let out = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return undefined;
		out = out * 10 + (code - 48);
		if (out > 255) return undefined;
	}
	return out;
}

/**
 * Parses an explicit revision literal: one to three components separated by
 * `.` or `-` (`"4.6"`, `"4-6-1"`). Returns undefined on malformed input.
 */
export function parseRevision(value: string): Revision | undefined {
	const out: [number, number, number] = [0, 0, 0];
	let count = 0;
	for (const part of value.split(/[.-]/)) {
		if (count === 3) return undefined;
		const component = parseComponent(part);
		if (component === undefined) return undefined;
		out[count] = component;
		count++;
	}
	return count > 0 ? out : undefined;
}

/**
 * Extracts a leading revision from an identifier tail that begins with a
 * digit: up to three components separated by `.` or by `-` followed by a
 * digit (`"4-6-turbo"` → `[4, 6, 0]`). Mirrors o2 `parse_revision_prefix`.
 * A component whose digits run directly into a letter is a parameter-count
 * or size token (`qwen3-32b`, `llama-3.3-70b`), never a revision component.
 */
export function parseRevisionPrefix(value: string): Revision | undefined {
	const out: [number, number, number] = [0, 0, 0];
	let count = 0;
	let index = 0;
	while (count < 3) {
		const start = index;
		while (index < value.length && value.charCodeAt(index) >= 48 && value.charCodeAt(index) <= 57) {
			index++;
		}
		const trailing = index < value.length ? value.charCodeAt(index) : 0;
		const isSizeToken = (trailing >= 97 && trailing <= 122) || (trailing >= 65 && trailing <= 90);
		const component = isSizeToken ? undefined : parseComponent(value.slice(start, index));
		if (component === undefined) {
			return count > 0 ? out : undefined;
		}
		out[count] = component;
		count++;
		const separator = value[index];
		if (separator === undefined) break;
		const next = value.charCodeAt(index + 1);
		if ((separator !== "." && separator !== "-") || !(next >= 48 && next <= 57)) break;
		index++;
	}
	return out;
}

/** Lexicographic triple comparison: negative, zero, or positive. */
export function compareRevision(a: Revision, b: Revision): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Renders a revision as its canonical `major.minor.patch` string. */
export function formatRevision(revision: Revision): string {
	return `${revision[0]}.${revision[1]}.${revision[2]}`;
}

/** Comparison operator inside a `revision ">=2.5 <4"` cascade constraint. */
export type RevisionOp = ">=" | ">" | "<=" | "<" | "=";

/** One comparison term of a revision constraint conjunction. */
export interface RevisionTerm {
	op: RevisionOp;
	revision: Revision;
}

/** Whether `revision` satisfies every term of the conjunction. */
export function revisionSatisfies(revision: Revision, terms: readonly RevisionTerm[]): boolean {
	for (const term of terms) {
		const cmp = compareRevision(revision, term.revision);
		switch (term.op) {
			case ">=":
				if (cmp < 0) return false;
				break;
			case ">":
				if (cmp <= 0) return false;
				break;
			case "<=":
				if (cmp > 0) return false;
				break;
			case "<":
				if (cmp >= 0) return false;
				break;
			case "=":
				if (cmp !== 0) return false;
				break;
		}
	}
	return true;
}

/**
 * Parses a whitespace-separated conjunction of comparisons
 * (`">=2.5 <3.8"`). Operands allow one to three dot-separated components.
 * Returns undefined when empty or malformed.
 */
export function parseRevisionConstraint(expression: string): RevisionTerm[] | undefined {
	const terms: RevisionTerm[] = [];
	for (const raw of expression.split(/\s+/)) {
		if (!raw) continue;
		let op: RevisionOp;
		let operand: string;
		if (raw.startsWith(">=")) {
			op = ">=";
			operand = raw.slice(2);
		} else if (raw.startsWith("<=")) {
			op = "<=";
			operand = raw.slice(2);
		} else if (raw.startsWith(">")) {
			op = ">";
			operand = raw.slice(1);
		} else if (raw.startsWith("<")) {
			op = "<";
			operand = raw.slice(1);
		} else if (raw.startsWith("=")) {
			op = "=";
			operand = raw.slice(1);
		} else {
			return undefined;
		}
		// Constraint operands are dot-separated only (no `-`), per o2 grammar.
		if (operand.includes("-")) return undefined;
		const revision = parseRevision(operand);
		if (!revision) return undefined;
		terms.push({ op, revision });
	}
	return terms.length > 0 ? terms : undefined;
}
