import type { YieldItem } from "./task";

/**
 * Output-schema shape of each declared top-level property, keyed by incremental yield label.
 * `array` sections accumulate into a list (even a lone yield); `scalar` sections keep the
 * latest yield, since the schema admits exactly one value. Undeclared labels accumulate
 * into a list only once repeated.
 */
export type YieldSectionShapes = ReadonlyMap<string, "array" | "scalar"> & {
	/** Prefer a schema-valid single item over a wrapper or batch when the input is ambiguous. */
	readonly acceptsItem?: (label: string, value: unknown) => boolean;
};

/** Outcome of folding a run's yield calls into one payload, with provenance flags. */
interface AssembledYieldResult {
	data: unknown;
	schemaOverridden: boolean;
	rawText: boolean;
	missingData: boolean;
}

function isIncrementalYieldType(type: YieldItem["type"]): type is string[] {
	return Array.isArray(type) && type.length > 0;
}

/** Labelled objects supply distinct values; a schema-valid item wins over a wrapper. */
export function resolveYieldSectionValue(
	data: unknown,
	labels: readonly string[],
	label: string,
	sectionShapes?: YieldSectionShapes,
): unknown {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
	if (sectionShapes?.acceptsItem && labels.every(key => sectionShapes.acceptsItem?.(key, data))) return data;
	const record = data as Record<string, unknown>;
	if (
		labels.every(key => Object.hasOwn(record, key)) &&
		(labels.length > 1 || Object.keys(record).every(key => key === label || record[key] === null))
	) {
		return record[label];
	}
	return data;
}

/** Arrays satisfying the item schema retain their original single-item meaning. */
export function isYieldSectionBatch(
	value: unknown,
	label: string,
	acceptsItem?: YieldSectionShapes["acceptsItem"],
): boolean {
	return Array.isArray(value) && acceptsItem?.(label, value) !== true;
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

function resolveYieldPayload(
	item: YieldItem,
	lastAssistantText: string | undefined,
	labels: string[],
): { value: unknown; fromLastAssistantText: boolean; missingData: boolean } {
	const hasData = item.data !== undefined;
	const shouldUseLastTurn = item.useLastTurn === true || (labels.length > 0 && !hasData);
	if (shouldUseLastTurn && lastAssistantText !== undefined) {
		return {
			value: lastAssistantText,
			fromLastAssistantText: true,
			missingData: lastAssistantText.length === 0,
		};
	}
	return {
		value: item.data,
		fromLastAssistantText: false,
		missingData: item.data === undefined || item.data === null,
	};
}

function appendYieldSection(
	sections: Record<string, unknown>,
	sectionCounts: Map<string, number>,
	label: string,
	value: unknown,
	shape: "array" | "scalar" | undefined,
	sectionShapes?: YieldSectionShapes,
): void {
	const count = sectionCounts.get(label) ?? 0;
	const existing = sections[label];
	if (
		shape === "scalar" ||
		(shape === "array" && value === null && sectionShapes?.acceptsItem?.(label, value) !== true)
	) {
		sections[label] = value;
	} else if (shape === "array") {
		const values = isYieldSectionBatch(value, label, sectionShapes?.acceptsItem) ? (value as unknown[]) : [value];
		if (count === 0 || !Array.isArray(existing)) {
			sections[label] = values.slice();
		} else {
			for (const element of values) existing.push(element);
		}
	} else if (count === 0) {
		sections[label] = value;
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
 * A non-empty array `type` contributes incremental sections and never decides
 * termination by itself. Labelled objects supply per-label values; array sections
 * append elements or batches without adding another array level. Explicit terminal
 * payloads replace the accumulated result. A data-less terminal closes accumulated
 * sections, or uses the last assistant text if none exist.
 */
export function assembleYieldResult(
	yieldItems: YieldItem[],
	lastAssistantText?: string,
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
	const overriddenLabels = new Set<string>();
	const missingLabels = new Set<string>();
	let schemaOverridden = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		const overridden = item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		const resolved = resolveYieldPayload(item, lastAssistantText, labels);
		if (labels.length === 0) schemaOverridden ||= overridden;
		for (const label of labels) {
			const shape = sectionShapes?.get(label);
			const value = resolveYieldSectionValue(resolved.value, labels, label, sectionShapes);
			appendYieldSection(sections, sectionCounts, label, value, shape, sectionShapes);
			if (
				shape === "scalar" ||
				(shape === "array" && value === null && sectionShapes?.acceptsItem?.(label, value) !== true)
			) {
				overriddenLabels.delete(label);
				missingLabels.delete(label);
			}
			if (overridden) overriddenLabels.add(label);
			if (resolved.missingData) missingLabels.add(label);
			hasSections = true;
		}
	}

	// An explicit terminal payload wins: an untyped final result or a
	// `type: "result"` finalize that carries `data` is the complete result, used
	// verbatim — never wrapped in a section.
	if (terminalItem && terminalItem.data !== undefined) {
		const resolved = resolveYieldPayload(terminalItem, lastAssistantText, []);
		return {
			data: resolved.value,
			schemaOverridden: terminalItem.schemaOverridden === true,
			rawText: resolved.fromLastAssistantText && typeof resolved.value === "string",
			missingData: resolved.missingData,
		};
	}

	// A data-less terminal finalize keeps accumulated sections; only when none
	// exist does the last assistant turn become the raw result.
	if (hasSections) {
		return {
			data: sections,
			schemaOverridden: schemaOverridden || overriddenLabels.size > 0,
			rawText: false,
			missingData: missingLabels.size > 0,
		};
	}

	if (!terminalItem) return undefined;
	const resolved = resolveYieldPayload(terminalItem, lastAssistantText, getYieldLabels(terminalItem.type));
	return {
		data: resolved.value,
		schemaOverridden: terminalItem.schemaOverridden === true,
		rawText: resolved.fromLastAssistantText && typeof resolved.value === "string",
		missingData: resolved.missingData,
	};
}
