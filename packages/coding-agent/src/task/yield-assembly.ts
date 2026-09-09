/**
 * Pure assembly of subagent `yield` calls into the final payload consumed by
 * output-schema validation.
 *
 * Lives apart from the subagent runtime in `executor.ts` so the rendering path
 * (`render.ts` → `extractIncrementalReviewResult`) can assemble incremental
 * yields without importing that runtime's dependency graph (`sdk`,
 * `session-manager`, the TUI tool renderers). It has no side effects and
 * depends only on the yield type and the output-schema validator.
 */
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator } from "../tools/output-schema-validator";
import type { YieldItem } from "./types";

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

/** True when `value` is a JSON-schema node whose instances are arrays. */
function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

/**
 * Top-level output-schema property names declared as arrays (JTD `elements` →
 * JSON `type: "array"`). An incremental yield section for such a label
 * accumulates into a list even when the agent emits exactly one — otherwise a
 * single `type: ["findings"]` yield would assemble as a bare object and fail
 * array-typed schema validation.
 */
export function arrayValuedLabels(outputSchema: unknown): ReadonlySet<string> {
	const labels = new Set<string>();
	// Use the JTD-converted JSON Schema (matches what validation runs against):
	// JTD `optionalProperties.findings.elements` becomes `properties.findings`
	// with `type: "array"`, which raw `normalizeSchema` would not expose.
	const { jsonSchema } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return labels;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const labelSchema = isRecord(dereferenced) ? dereferenced : jsonSchema;
	const properties = labelSchema.properties;
	if (!isRecord(properties)) return labels;
	for (const key in properties) {
		if (isArrayTypedSchema(properties[key])) labels.add(key);
	}
	return labels;
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
