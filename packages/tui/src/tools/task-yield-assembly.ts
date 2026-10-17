import { isRecord } from "@oh-my-pi/pi-utils";
import type { YieldItem } from "./task";

/**
 * Output-schema shape of each declared top-level property, keyed by incremental yield label.
 * The read-only shape map is separate from optional schema-backed payload predicates.
 * `array` sections append items or batches into a list; `scalar` sections keep the
 * latest value. The item validator preserves arrays that themselves constitute one
 * valid item. Undeclared labels accumulate into a list only once repeated.
 */
export interface YieldSectionShapes {
	readonly shapes: ReadonlyMap<string, "array" | "scalar">;
	/** Prefer a schema-valid item at the current append offset over an equally valid batch. */
	readonly acceptsItem?: (label: string, value: unknown, offset?: number) => boolean;
	/** Mixed sections append array items/batches but keep independently valid scalar alternatives direct. */
	readonly acceptsArray?: (label: string, value: unknown, offset?: number) => boolean;
}

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

/** Multiple schema-bound labels carry independent values; a single label always carries direct data. */
export function resolveYieldSectionValue(
	data: unknown,
	labels: readonly string[],
	label: string,
	sectionShapes?: YieldSectionShapes,
): unknown {
	if (labels.length <= 1 || !sectionShapes || (!sectionShapes.acceptsItem && sectionShapes.shapes.size === 0))
		return data;
	if (!isRecord(data)) return data;
	return labels.every(key => Object.hasOwn(data, key)) ? data[label] : data;
}

/** Arrays satisfying the item schema retain their original single-item meaning. */
export function isYieldSectionBatch(
	value: unknown,
	label: string,
	acceptsItem?: YieldSectionShapes["acceptsItem"],
	offset = 0,
): value is unknown[] {
	return Array.isArray(value) && acceptsItem?.(label, value, offset) !== true;
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
	sectionArrayOwnership: Map<string, boolean>,
	label: string,
	value: unknown,
	shape: "array" | "scalar" | undefined,
	sectionShapes?: YieldSectionShapes,
	offset = 0,
): void {
	const ownsArray = sectionArrayOwnership.get(label);
	const existing = sections[label];
	if (shape === "scalar") {
		sections[label] = value;
		sectionArrayOwnership.set(label, false);
	} else if (shape === "array") {
		const values = isYieldSectionBatch(value, label, sectionShapes?.acceptsItem, offset) ? value : [value];
		if (ownsArray === undefined || !Array.isArray(existing)) {
			sections[label] = values.slice();
			sectionArrayOwnership.set(label, true);
		} else if (values.length > 0) {
			const accumulator = ownsArray ? existing : existing.slice();
			for (const element of values) accumulator.push(element);
			if (!ownsArray) {
				sections[label] = accumulator;
				sectionArrayOwnership.set(label, true);
			}
		}
	} else if (ownsArray === undefined) {
		sections[label] = value;
		sectionArrayOwnership.set(label, false);
	} else if (Array.isArray(existing)) {
		if (ownsArray) existing.push(value);
		else {
			sections[label] = [...existing, value];
			sectionArrayOwnership.set(label, true);
		}
	} else {
		sections[label] = [existing, value];
		sectionArrayOwnership.set(label, true);
	}
}

/**
 * Assemble typed yield calls into the final payload consumed by schema validation.
 *
 * A non-empty array `type` contributes incremental sections without terminating.
 * Single labels carry direct data; schema-bound multi-label mappings carry one value
 * per label. Explicit terminal payloads replace accumulated sections wholesale.
 * A data-less terminal keeps accumulated sections, or uses the last assistant text
 * if no sections exist. Repeated sections merge per `sectionShapes`.
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
	// Absent means unseen, false means borrowed payload, true means an owned array accumulator.
	const sectionArrayOwnership = new Map<string, boolean>();
	const overriddenScalars = new Set<string>();
	let schemaOverridden = false;
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		const overridden = item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		const resolved = resolveYieldPayload(item, lastAssistantText, labels);
		missingData ||= resolved.missingData;
		if (labels.length === 0) schemaOverridden ||= overridden;
		for (const label of labels) {
			const declaredShape = sectionShapes?.shapes.get(label);
			const value = resolveYieldSectionValue(resolved.value, labels, label, sectionShapes);
			const existing = sections[label];
			const offset = Array.isArray(existing) ? existing.length : 0;
			const shape =
				declaredShape === "array" && sectionShapes?.acceptsArray?.(label, value, offset) === false
					? "scalar"
					: declaredShape;
			appendYieldSection(sections, sectionArrayOwnership, label, value, shape, sectionShapes, offset);
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
			schemaOverridden: schemaOverridden || overriddenScalars.size > 0,
			rawText: false,
			missingData,
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
