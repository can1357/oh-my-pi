/** Recorded merge-conflict region. */
export interface ConflictBlock {
	/** 1-indexed line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-indexed line of the `=======` separator. */
	separatorLine: number;
	/** 1-indexed line of the `>>>>>>>` marker. */
	endLine: number;
	/** 1-indexed line of the `|||||||` base marker (diff3 only). */
	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

/** Recorded merge-conflict identity and paths. */
export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

/** A selectable side of a recorded conflict. */
export type ConflictScope = "ours" | "theirs" | "base";

/** Reconstruct a marker line with its optional branch label. */
function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

/**
 * Materialise a conflict block for `conflict://<N>` reads (and their
 * `/ours` / `/theirs` / `/base` scopes).
 *
 * Returns:
 * - `lines`: the lines to render, ordered top-to-bottom.
 * - `startLine`: the 1-indexed file line number `lines[0]` corresponds
 *   to, so the read formatter can label hashline anchors with the
 *   original file positions.
 *
 * Bare (no scope) returns the full block including marker lines. A
 * scoped view returns only that side's body — `base` throws when the
 * recorded conflict is a 2-way merge with no base section.
 */
export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new Error(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}
