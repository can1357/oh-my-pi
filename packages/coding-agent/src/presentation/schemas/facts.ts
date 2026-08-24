import { z } from "zod";

/**
 * `ToolFactBody` and its nested metas as zod schemas.
 *
 * Needed because `details.presentationFacts` (an escape hatch — the
 * fact bodies a tool authors for its own registered `modelContentProjection`,
 * see `ToolResultBuilder#truncationFact`) reaches a producer whose details are
 * a *strictly* validated compatibility boundary: `bashDetailsSchema` is a
 * `z.strictObject` and `test/presentation-schemas.test.ts` pins it to
 * `BashToolDetails` with `IsExact`. `read`/`grep`/`glob` carry the same field
 * unvalidated only because the seam does not model their detail families at all
 * (`known-tool-result.ts`'s `BUILTIN_DETAIL_FAMILY`); the moment a modelled
 * family declares facts, the field needs a real validator rather than a
 * `z.unknown()` hole punched through an otherwise strict object.
 *
 * Strict at every nesting level, matching `output-meta.ts`'s built-in
 * disposition: these bodies are authored by built-in producers one function
 * call before `wrappedExecute` reads them, so an unexpected or wrong-typed
 * field is a producer bug that must fail loudly rather than silently dropping
 * the notice it gated. There is deliberately no salvage variant — unlike
 * `details.meta`, no external, extension, or pre-migration persisted record has
 * ever carried this field, so there is no untrusted arm to salvage.
 *
 * Every object is `.readonly()` because the source union
 * (`@oh-my-pi/pi-agent-core/presentation`'s `ToolFactBody`) declares `readonly`
 * members throughout, and `IsExact` compares modifiers.
 */

const lineWindowSchema = z
	.strictObject({
		start: z.number(),
		end: z.number(),
	})
	.readonly();

export const truncationFactMetaSchema = z
	.strictObject({
		direction: z.enum(["head", "tail", "middle"]),
		totalBytes: z.number(),
		retainedBytes: z.number(),
		totalLines: z.number().optional(),
		retainedLines: z.number().optional(),
		elidedBytes: z.number().optional(),
		elidedLines: z.number().optional(),
		shownLineRange: lineWindowSchema.optional(),
		headLineRange: lineWindowSchema.optional(),
		tailLineRange: lineWindowSchema.optional(),
		truncatedBy: z.enum(["lines", "bytes"]).optional(),
		maxBytes: z.number().optional(),
		nextOffset: z.number().optional(),
		artifactId: z.string().optional(),
	})
	.readonly();

export const limitFactMetaSchema = z.union([
	z
		.strictObject({
			limit: z.enum(["column", "inline_bytes"]),
			value: z.number(),
			droppedBytes: z.number().optional(),
			affectedLines: z.number().optional(),
		})
		.readonly(),
	z
		.strictObject({
			limit: z.literal("result_count"),
			value: z.number(),
			suggestedValue: z.number(),
		})
		.readonly(),
]);

export const diagnosticFactEntrySchema = z
	.strictObject({
		path: z.string(),
		severity: z.enum(["error", "warning", "info", "hint"]),
		message: z.string(),
		line: z.number().optional(),
		column: z.number().optional(),
	})
	.readonly();

/**
 * The closed fact union, arm for arm.
 *
 * A plain `z.union` rather than `z.discriminatedUnion`: the arms are
 * `.readonly()`-wrapped for type parity, and the discriminated form reads its
 * discriminator off the unwrapped object shape. The union is small and every
 * arm is strict, so the only cost is a longer error message on a producer bug.
 */
export const toolFactBodySchema = z.union([
	z.strictObject({ kind: z.literal("wall_time"), ms: z.number() }).readonly(),
	z.strictObject({ kind: z.literal("truncation"), meta: truncationFactMetaSchema }).readonly(),
	z.strictObject({ kind: z.literal("limit"), meta: limitFactMetaSchema }).readonly(),
	z
		.strictObject({ kind: z.literal("diagnostics"), entries: z.array(diagnosticFactEntrySchema).readonly() })
		.readonly(),
	z.strictObject({ kind: z.literal("artifact"), artifactId: z.string() }).readonly(),
	z.strictObject({ kind: z.literal("model_guidance"), source: z.literal("ttsr"), text: z.string() }).readonly(),
	z.strictObject({ kind: z.literal("stop_annotation"), text: z.string() }).readonly(),
	z.strictObject({ kind: z.literal("capability_notice"), text: z.string() }).readonly(),
	z.strictObject({ kind: z.literal("unreported_annotation"), text: z.string() }).readonly(),
	z.strictObject({ kind: z.literal("notice"), text: z.string() }).readonly(),
]);

/** A tool-authored fact body list, as it rides on `details.presentationFacts`. */
export const presentationFactsSchema = z.array(toolFactBodySchema).readonly();

export type PresentationTruncationFactMeta = z.infer<typeof truncationFactMetaSchema>;
export type PresentationLimitFactMeta = z.infer<typeof limitFactMetaSchema>;
export type PresentationDiagnosticFactEntry = z.infer<typeof diagnosticFactEntrySchema>;
export type PresentationToolFactBody = z.infer<typeof toolFactBodySchema>;
