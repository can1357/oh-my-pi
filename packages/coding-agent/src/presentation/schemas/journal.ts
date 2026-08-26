import { z } from "@oh-my-pi/omptype/zod";
import type { ToolFact } from "@oh-my-pi/pi-agent-core/presentation";
import { byteOffsetSchema, factIdSchema, nonZeroExitCodeSchema, streamIdSchema, toolExecutionIdSchema } from "./brands";
import { toolContentBlockSchema } from "./content";
import { diagnosticFactEntrySchema, limitFactMetaSchema, truncationFactMetaSchema } from "./facts";

/**
 * Zod schemas for the persisted v4 tool journal — see
 * `../journal.ts` for the type definitions and the groundwork-only scope note.
 *
 * `recordVersion`/`state`/`type` are `z.literal`s reached through a plain
 * `z.union` rather than `z.discriminatedUnion`, matching `schemas/facts.ts`'s
 * precedent: every arm is `.readonly()`-wrapped for type parity with the
 * source interfaces' `readonly` members, and the discriminated form reads its
 * discriminator off the unwrapped object shape. A record whose `recordVersion`
 * is missing or not the literal `1` therefore fails every arm — there is no
 * default/legacy branch for it to fall into ("a malformed new
 * record fails validation rather than falling back to legacy").
 */

// Mirrors `@oh-my-pi/pi-agent-core/presentation`'s `JsonValue` structurally
// (mutable arrays/index signature, matching that type exactly — not the
// `.readonly()` convention used elsewhere in this file, because `ToolCallRecord`'s
// `rawInput` is pinned against the real `JsonValue` type in the test).
type JsonValueArray = (string | number | boolean | null | JsonValueArray | JsonValueRecord)[];
type JsonValueRecord = { [key: string]: string | number | boolean | null | JsonValueArray | JsonValueRecord };
const jsonValueArraySchema: z.ZodType<JsonValueArray> = z.lazy(() => z.array(jsonValueSchema));
const jsonValueRecordSchema: z.ZodType<JsonValueRecord> = z.lazy(() => z.record(z.string(), jsonValueSchema));
const jsonValueSchema: z.ZodType<string | number | boolean | null | JsonValueArray | JsonValueRecord> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), jsonValueArraySchema, jsonValueRecordSchema]),
);

/**
 * `ToolCallRecord.rawInput`'s JSON-safety boundary.
 *
 * Exported because it is also the *write*-side narrowing: a live
 * `ToolCallPresentation` carries `rawInput?: { [key: string]: unknown }`, and
 * `toolCallRecordOf` (`../journal.ts`) has to cross that one untyped boundary
 * through a schema rather than an assertion before the record can be persisted.
 */
export const jsonRecordSchema = z.record(z.string(), jsonValueSchema).readonly();

const toolPresentationKindSchema = z.enum([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
]);

const toolPresentationLocationSchema = z
	.strictObject({
		path: z.string(),
		line: z.number().optional(),
	})
	.readonly();

/** The persisted-safe counterpart of `ToolCallPresentation` (`../record.ts` in `packages/agent`). */
export const toolCallRecordSchema = z
	.strictObject({
		toolCallId: z.string(),
		toolName: z.string(),
		title: z.string(),
		kind: toolPresentationKindSchema,
		locations: z.array(toolPresentationLocationSchema).readonly().optional(),
		sourceEcho: z.string().optional(),
		cwd: z.string().optional(),
		rawInput: jsonRecordSchema.optional(),
	})
	.readonly();

// ---------------------------------------------------------------------------
// ToolFact — the closed fact algebra, arm for arm, with identity baked in.
//
// `id` cannot ride alongside `schemas/facts.ts`'s `toolFactBodySchema` as an
// intersection: each arm there is a `z.strictObject`, and a strict object
// rejects the sibling's extra key from either intersection side. The ten arms
// are duplicated here with `id` folded in, reusing every nested meta schema so
// only the arm headers repeat. The closing `.transform` re-types the parsed
// value as the real `ToolFact` (rather than leaving it as a
// structurally-equivalent-but-distinct flat union) so every record embedding
// `facts: readonly ToolFact[]` pins exactly against its schema. `as ToolFact`
// rather than a return-type-checked arrow: the strict presentation project's
// `exactOptionalPropertyTypes` makes a schema-inferred `{ field?: T | undefined }`
// fail plain assignability against a hand-written `{ field?: T }`, even though
// `IsExact` (which does not perform assignability) correctly treats them as
// identical — this is the same normalized-optional-property fact
// `test/presentation-journal-schemas.test.ts`'s `IsExact` pin below relies on.
// *That* pin, not this cast, is what fails `bun check` when a `ToolFactBody`
// member is added upstream without a matching arm added here.
// ---------------------------------------------------------------------------

export const toolFactSchema = z
	.union([
		z.strictObject({ id: factIdSchema, kind: z.literal("wall_time"), ms: z.number() }).readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("truncation"), meta: truncationFactMetaSchema }).readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("limit"), meta: limitFactMetaSchema }).readonly(),
		z
			.strictObject({
				id: factIdSchema,
				kind: z.literal("diagnostics"),
				entries: z.array(diagnosticFactEntrySchema).readonly(),
			})
			.readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("artifact"), artifactId: z.string() }).readonly(),
		z
			.strictObject({
				id: factIdSchema,
				kind: z.literal("model_guidance"),
				source: z.literal("ttsr"),
				text: z.string(),
			})
			.readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("stop_annotation"), text: z.string() }).readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("capability_notice"), text: z.string() }).readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("unreported_annotation"), text: z.string() }).readonly(),
		z.strictObject({ id: factIdSchema, kind: z.literal("notice"), text: z.string() }).readonly(),
	])
	.transform((value): ToolFact => value as ToolFact);

// ---------------------------------------------------------------------------
// ToolAttachment, RetainedStreamView/Gap
// ---------------------------------------------------------------------------

export const toolAttachmentSchema = z.union([
	z.strictObject({ kind: z.literal("image"), data: z.string(), mimeType: z.string() }).readonly(),
	z
		.strictObject({
			kind: z.literal("resource_link"),
			uri: z.string(),
			name: z.string(),
			mimeType: z.string().optional(),
		})
		.readonly(),
	z
		.strictObject({
			kind: z.literal("diff"),
			path: z.string(),
			oldText: z.string().nullable(),
			newText: z.string().nullable(),
		})
		.readonly(),
]);

const retainedStreamGapSchema = z
	.strictObject({
		fromByte: byteOffsetSchema,
		toByte: byteOffsetSchema,
	})
	.readonly();

const retainedStreamViewSchema = z
	.strictObject({
		streamId: streamIdSchema,
		startByte: byteOffsetSchema,
		endByte: byteOffsetSchema,
		text: z.string(),
		gaps: z.array(retainedStreamGapSchema).readonly(),
	})
	.readonly();

// ---------------------------------------------------------------------------
// ToolDisplayOutput, RetainedDisplay
// ---------------------------------------------------------------------------

const toolDisplayItemSchema = z.union([
	z.strictObject({ kind: z.literal("json"), value: jsonValueSchema }).readonly(),
	z.strictObject({ kind: z.literal("invalid_json") }).readonly(),
	z
		.strictObject({
			kind: z.literal("image_dimensions"),
			originalWidth: z.number(),
			originalHeight: z.number(),
			width: z.number(),
			height: z.number(),
		})
		.readonly(),
]);

const toolDisplayOutputSchema = z
	.strictObject({
		kind: z.literal("sequence"),
		items: z.array(toolDisplayItemSchema).readonly(),
	})
	.readonly();

/** The persisted-safe counterpart of `RetainedDisplay` (`../record.ts` in `packages/agent`). */
const retainedDisplaySchema = z
	.strictObject({
		atByte: byteOffsetSchema,
		display: toolDisplayOutputSchema,
	})
	.readonly();

// ---------------------------------------------------------------------------
// Presentation records: started / settled / interrupted
// ---------------------------------------------------------------------------

const presentationVersionSchema = z.literal(1);

export const startedPresentationRecordSchema = z
	.strictObject({
		version: presentationVersionSchema,
		facts: z.array(toolFactSchema).readonly(),
	})
	.readonly();

export const toolPresentationRecordSchema = z
	.strictObject({
		version: presentationVersionSchema,
		stream: retainedStreamViewSchema.optional(),
		facts: z.array(toolFactSchema).readonly(),
		attachments: z.array(toolAttachmentSchema).readonly(),
		displays: z.array(retainedDisplaySchema).readonly().optional(),
	})
	.readonly();

/** Structurally identical to `startedPresentationRecordSchema` today — see `../journal.ts`'s doc comment on why it is still its own type. */
export const interruptedPresentationRecordSchema = z
	.strictObject({
		version: presentationVersionSchema,
		facts: z.array(toolFactSchema).readonly(),
	})
	.readonly();

// ---------------------------------------------------------------------------
// ToolOutcome
// ---------------------------------------------------------------------------

const successfulProcessTerminationSchema = z.strictObject({ kind: z.literal("exited"), code: z.literal(0) }).readonly();

const failedProcessTerminationSchema = z.union([
	z.strictObject({ kind: z.literal("exited"), code: nonZeroExitCodeSchema }).readonly(),
	z.strictObject({ kind: z.literal("timed_out"), timeoutMs: z.number() }).readonly(),
	z.strictObject({ kind: z.literal("signaled"), signal: z.string() }).readonly(),
]);

const signaledProcessTerminationSchema = z.strictObject({ kind: z.literal("signaled"), signal: z.string() }).readonly();

const toolFailureSchema = z
	.strictObject({
		reason: z.enum([
			"process",
			"validation",
			"blocked",
			"permission_denied",
			"thrown",
			"hook",
			"tool_reported",
			"internal",
		]),
		message: z.string(),
	})
	.readonly();

export const toolOutcomeSchema = z.union([
	z.strictObject({ kind: z.literal("succeeded"), process: successfulProcessTerminationSchema.optional() }).readonly(),
	z
		.strictObject({
			kind: z.literal("failed"),
			failure: toolFailureSchema,
			process: failedProcessTerminationSchema.optional(),
		})
		.readonly(),
	z
		.strictObject({
			kind: z.literal("interrupted"),
			reason: z.string(),
			process: signaledProcessTerminationSchema.optional(),
		})
		.readonly(),
]);

// ---------------------------------------------------------------------------
// FrozenModelProjection, PersistedToolJournal, ReplayableToolExecution
// ---------------------------------------------------------------------------

const modelProjectionVersionSchema = z.literal(1);

export const frozenModelProjectionSchema = z
	.strictObject({
		version: modelProjectionVersionSchema,
		// `PresentationContentBlock` (`renderModelContent`'s own output type)
		// imported directly, matching `schemas/details.ts`'s precedent of
		// importing from `./content` rather than re-mirroring it.
		content: z.array(toolContentBlockSchema).readonly(),
	})
	.readonly();

const toolJournalRecordVersionSchema = z.literal(1);

export const startedToolJournalSchema = z
	.strictObject({
		type: z.literal("tool_execution_started"),
		recordVersion: toolJournalRecordVersionSchema,
		executionId: toolExecutionIdSchema,
		call: toolCallRecordSchema,
		presentation: startedPresentationRecordSchema,
	})
	.readonly();
export const settledToolJournalSchema = z
	.strictObject({
		type: z.literal("tool_execution_settled"),
		recordVersion: toolJournalRecordVersionSchema,
		executionId: toolExecutionIdSchema,
		outcome: toolOutcomeSchema,
		presentation: toolPresentationRecordSchema,
		modelProjection: frozenModelProjectionSchema,
	})
	.readonly();
export const persistedToolJournalSchema = z.union([startedToolJournalSchema, settledToolJournalSchema]);

export const replayableToolExecutionSchema = z.union([
	z
		.strictObject({
			state: z.literal("settled"),
			call: toolCallRecordSchema,
			outcome: toolOutcomeSchema,
			presentation: toolPresentationRecordSchema,
			modelProjection: frozenModelProjectionSchema,
		})
		.readonly(),
	z
		.strictObject({
			state: z.literal("interrupted"),
			call: toolCallRecordSchema,
			reason: z.string(),
			presentation: interruptedPresentationRecordSchema,
		})
		.readonly(),
]);

export type PresentationToolCallRecord = z.infer<typeof toolCallRecordSchema>;
export type PresentationToolFact = z.infer<typeof toolFactSchema>;
export type PresentationToolAttachment = z.infer<typeof toolAttachmentSchema>;
export type PresentationStartedPresentationRecord = z.infer<typeof startedPresentationRecordSchema>;
export type PresentationToolPresentationRecord = z.infer<typeof toolPresentationRecordSchema>;
export type PresentationInterruptedPresentationRecord = z.infer<typeof interruptedPresentationRecordSchema>;
export type PresentationToolOutcome = z.infer<typeof toolOutcomeSchema>;
export type PresentationFrozenModelProjection = z.infer<typeof frozenModelProjectionSchema>;
export type PresentationPersistedToolJournal = z.infer<typeof persistedToolJournalSchema>;
export type PresentationReplayableToolExecution = z.infer<typeof replayableToolExecutionSchema>;
