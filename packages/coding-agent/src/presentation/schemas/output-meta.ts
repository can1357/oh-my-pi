import { z } from "@oh-my-pi/omptype/zod";

/**
 * `OutputMeta` and friends as zod schemas — the only validators for the shape.
 *
 * Two parsing dispositions, deliberately different:
 *
 * - **Built-in producers** parse `strict` at every nesting level: an unexpected
 *   or wrong-typed field is a producer bug and must fail loudly in dev/tests
 *   rather than silently dropping the fact it gated.
 * - **Persisted/external data** salvages sibling-by-sibling and *strips*
 *   unknown keys rather than rejecting the sibling carrying them. A malformed
 *   `limits` must not take a valid `truncation` down with it, and neither may
 *   an extension/MCP tool's own extra field: `truncation` marks a settled
 *   result as a display re-render (head/tail elision, column truncation) of
 *   what already reached the client on a different channel, so losing it to
 *   an unrelated malformed sibling would mis-report a re-render as fresh
 *   output.
 *
 * The dispositions therefore differ at every nesting level, so each nested
 * shape is minted twice from one factory instead of sharing a schema instance:
 * a renamed or retyped field still breaks both families at once.
 */

function lineRangeShape() {
	return { start: z.number(), end: z.number() };
}

const lineRangeSchema = z.strictObject(lineRangeShape());
const salvagedLineRangeSchema = z.object(lineRangeShape());

type LineRange = z.infer<typeof lineRangeSchema>;

function truncationMetaShape(lineRange: z.ZodType<LineRange, unknown>) {
	return {
		direction: z.enum(["head", "tail", "middle"]),
		truncatedBy: z.enum(["lines", "bytes", "middle"]),
		totalLines: z.number(),
		totalBytes: z.number(),
		outputLines: z.number(),
		outputBytes: z.number(),
		maxBytes: z.number().optional(),
		shownRange: lineRange.optional(),
		headRange: lineRange.optional(),
		tailRange: lineRange.optional(),
		elidedBytes: z.number().optional(),
		elidedLines: z.number().optional(),
		artifactId: z.string().optional(),
		nextOffset: z.number().optional(),
	};
}

export const truncationMetaSchema = z.strictObject(truncationMetaShape(lineRangeSchema));
const salvagedTruncationMetaSchema = z.object(truncationMetaShape(salvagedLineRangeSchema));

function sourceMetaShape<T extends "path" | "url" | "internal">(type: T) {
	return { type: z.literal(type), value: z.string() };
}

export const sourceMetaSchema = z.union([
	z.strictObject(sourceMetaShape("path")),
	z.strictObject(sourceMetaShape("url")),
	z.strictObject(sourceMetaShape("internal")),
]);
const salvagedSourceMetaSchema = z.union([
	z.object(sourceMetaShape("path")),
	z.object(sourceMetaShape("url")),
	z.object(sourceMetaShape("internal")),
]);

function diagnosticMetaShape() {
	return { summary: z.string(), messages: z.array(z.string()) };
}

export const diagnosticMetaSchema = z.strictObject(diagnosticMetaShape());
const salvagedDiagnosticMetaSchema = z.object(diagnosticMetaShape());

function limitCounterShape() {
	return { reached: z.number(), suggestion: z.number() };
}

function columnTruncatedShape() {
	return { maxColumn: z.number() };
}

const limitCounterSchema = z.strictObject(limitCounterShape());
const salvagedLimitCounterSchema = z.object(limitCounterShape());
const columnTruncatedSchema = z.strictObject(columnTruncatedShape());
const salvagedColumnTruncatedSchema = z.object(columnTruncatedShape());

export const limitsMetaSchema = z.strictObject({
	matchLimit: limitCounterSchema.optional(),
	resultLimit: limitCounterSchema.optional(),
	headLimit: limitCounterSchema.optional(),
	columnTruncated: columnTruncatedSchema.optional(),
});

export const outputMetaSchema = z.strictObject({
	truncation: truncationMetaSchema.optional(),
	source: sourceMetaSchema.optional(),
	diagnostics: diagnosticMetaSchema.optional(),
	limits: limitsMetaSchema.optional(),
});

export type PresentationTruncationMeta = z.infer<typeof truncationMetaSchema>;
export type PresentationSourceMeta = z.infer<typeof sourceMetaSchema>;
export type PresentationDiagnosticMeta = z.infer<typeof diagnosticMetaSchema>;
export type PresentationLimitsMeta = z.infer<typeof limitsMetaSchema>;
export type PresentationOutputMeta = z.infer<typeof outputMetaSchema>;

/**
 * Salvage an unvalidated `OutputMeta` — an extension/MCP tool's
 * `details.meta`, a corrupted `session/load` replay record. Each sibling is
 * validated independently and a malformed one is dropped rather than voiding
 * the rest. The sole read path for a producer-supplied `meta` that did not come
 * from `OutputMetaBuilder`.
 *
 * Returns `undefined` when nothing survived; every consumer treats an empty
 * meta and a missing one identically (no notice, no re-render signal).
 */
export function salvageOutputMeta(value: unknown): PresentationOutputMeta | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const source = value as { readonly [key: string]: unknown };
	const salvaged: {
		truncation?: PresentationTruncationMeta;
		source?: PresentationSourceMeta;
		diagnostics?: PresentationDiagnosticMeta;
		limits?: PresentationLimitsMeta;
	} = {};

	const truncation = salvagedTruncationMetaSchema.safeParse(source.truncation);
	if (truncation.success) salvaged.truncation = truncation.data;
	const sourceMeta = salvagedSourceMetaSchema.safeParse(source.source);
	if (sourceMeta.success) salvaged.source = sourceMeta.data;
	const diagnostics = salvagedDiagnosticMetaSchema.safeParse(source.diagnostics);
	if (diagnostics.success) salvaged.diagnostics = diagnostics.data;
	// `limits`' own four sub-fields salvage independently too: a bad `matchLimit`
	// must not discard a valid `columnTruncated` alongside it.
	const limits = salvageLimitsMeta(source.limits);
	if (limits !== undefined) salvaged.limits = limits;

	return Object.keys(salvaged).length > 0 ? salvaged : undefined;
}

function salvageLimitsMeta(value: unknown): PresentationLimitsMeta | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const source = value as { readonly [key: string]: unknown };
	const salvaged: {
		matchLimit?: z.infer<typeof limitCounterSchema>;
		resultLimit?: z.infer<typeof limitCounterSchema>;
		headLimit?: z.infer<typeof limitCounterSchema>;
		columnTruncated?: z.infer<typeof columnTruncatedSchema>;
	} = {};
	const match = salvagedLimitCounterSchema.safeParse(source.matchLimit);
	if (match.success) salvaged.matchLimit = match.data;
	const result = salvagedLimitCounterSchema.safeParse(source.resultLimit);
	if (result.success) salvaged.resultLimit = result.data;
	const head = salvagedLimitCounterSchema.safeParse(source.headLimit);
	if (head.success) salvaged.headLimit = head.data;
	const column = salvagedColumnTruncatedSchema.safeParse(source.columnTruncated);
	if (column.success) salvaged.columnTruncated = column.data;
	return Object.keys(salvaged).length > 0 ? salvaged : undefined;
}
