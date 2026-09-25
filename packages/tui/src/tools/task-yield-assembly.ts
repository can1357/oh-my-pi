import type { YieldItem } from "./task";
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
	forceArray: boolean,
): void {
	const count = sectionCounts.get(label) ?? 0;
	const existing = sections[label];
	if (count === 0) {
		sections[label] = forceArray ? [value] : value;
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
 * termination by itself. A string `type` with omitted `data` makes the last
 * assistant turn the raw terminal result. Other string-typed yields contribute
 * the terminal labelled section. Untyped terminal yields keep the historical
 * "last yield wins" behavior unless no terminal yield exists, in which case
 * accumulated typed sections finalize on idle.
 */
export function assembleYieldResult(
	yieldItems: YieldItem[],
	lastAssistantText?: string,
	arrayLabels?: ReadonlySet<string>,
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
	let schemaOverridden = false;
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		schemaOverridden ||= item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		const resolved = resolveYieldPayload(item, lastAssistantText, labels);
		missingData ||= resolved.missingData;
		for (const label of labels) {
			appendYieldSection(sections, sectionCounts, label, resolved.value, arrayLabels?.has(label) ?? false);
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
		return { data: sections, schemaOverridden, rawText: false, missingData };
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
