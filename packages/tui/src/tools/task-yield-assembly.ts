import type { YieldItem } from "./task";

/**
 * Output-schema shape of each declared top-level property, keyed by incremental yield label.
 * `array` sections accumulate into a list (even a lone yield); `scalar` sections keep the
 * latest yield, since the schema admits exactly one value. Undeclared labels accumulate
 * into a list only once repeated.
 */
export type YieldSectionShapes = ReadonlyMap<string, "array" | "scalar">;

/** Outcome of folding a run's yield calls into one payload, with provenance flags. */
interface AssembledYieldResult {
	data: unknown;
	schemaOverridden: boolean;
	missingData: boolean;
}

function isIncrementalYieldType(type: YieldItem["type"]): type is string[] {
	return Array.isArray(type) && type.length > 0;
}

function getYieldLabels(type: YieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		if (typeof value !== "string") continue;
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function appendYieldSection(
	sections: Record<string, unknown>,
	sectionCounts: Map<string, number>,
	label: string,
	value: unknown,
	shape: "array" | "scalar" | undefined,
): void {
	const count = sectionCounts.get(label) ?? 0;
	const existing = sections[label];
	if (shape === "scalar") {
		sections[label] = value;
	} else if (count === 0) {
		sections[label] = shape === "array" ? [value] : value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		sections[label] = [existing, value];
	}
	sectionCounts.set(label, count + 1);
}

/**
 * Assemble typed yield calls into the final payload consumed by schema validation.
 *
 * A non-empty array `type` contributes an incremental section and never decides
 * termination by itself. The last terminal yield carrying `data` is the whole
 * result; a data-less terminal yield (or none at all) finalizes the accumulated
 * sections. Repeated sections merge per `sectionShapes` (see {@link YieldSectionShapes}).
 */
export function assembleYieldResult(
	yieldItems: YieldItem[],
	sectionShapes?: YieldSectionShapes,
): AssembledYieldResult | undefined {
	if (yieldItems.length === 0) return undefined;

	// Terminal = the last non-incremental yield (untyped, or string-typed like
	// `type: "result"`). Array-typed yields are incremental sections and never
	// terminate on their own.
	let terminalItem: YieldItem | undefined;
	for (let index = yieldItems.length - 1; index >= 0; index--) {
		const item = yieldItems[index];
		if (item && !isIncrementalYieldType(item.type)) {
			terminalItem = item;
			break;
		}
	}

	// Sections come ONLY from incremental (array-typed) yields. A string `type`
	// is a terminal marker, never a section label: folding its data under the
	// label is what nested a finalize payload (`type: "result"`, `data: {…}`) one
	// level deep and made output-schema validation report every field missing.
	const sections: Record<string, unknown> = {};
	const sectionCounts = new Map<string, number>();
	const overriddenScalars = new Set<string>();
	let schemaOverridden = false;
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		const overridden = item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		missingData ||= item.data === undefined || item.data === null;
		if (labels.length === 0) schemaOverridden ||= overridden;
		for (const label of labels) {
			const shape = sectionShapes?.get(label);
			appendYieldSection(sections, sectionCounts, label, item.data, shape);
			if (shape === "scalar") {
				if (overridden) overriddenScalars.add(label);
				else overriddenScalars.delete(label);
			} else {
				schemaOverridden ||= overridden;
			}
			hasSections = true;
		}
	}

	// An explicit terminal payload wins: an untyped final result or a
	// `type: "result"` finalize that carries `data` is the complete result, used
	// verbatim — never wrapped in a section.
	if (terminalItem && terminalItem.data !== undefined) {
		return {
			data: terminalItem.data,
			schemaOverridden: terminalItem.schemaOverridden === true,
			missingData: terminalItem.data === null,
		};
	}

	// A data-less terminal finalize keeps the accumulated sections.
	if (hasSections) {
		return {
			data: sections,
			schemaOverridden: schemaOverridden || overriddenScalars.size > 0,
			missingData,
		};
	}

	if (!terminalItem) return undefined;
	return {
		data: terminalItem.data,
		schemaOverridden: terminalItem.schemaOverridden === true,
		missingData: true,
	};
}
