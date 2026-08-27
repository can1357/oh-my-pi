import { z } from "@oh-my-pi/omptype/zod";
import { imageContentSchema } from "./content";
import { presentationFactsSchema } from "./facts";
import { outputMetaSchema } from "./output-meta";

/**
 * Detail schemas for the producers the migration seam knows by name.
 *
 * These are the single runtime+static source for each shape: the producer's own
 * `BashToolDetails`/`EvalToolDetails`/`EditToolDetails` interfaces are pinned
 * against them, in both directions, by `test/presentation-schemas.test.ts`. A
 * renamed or retyped producer field therefore fails the type check rather than
 * making a validator silently reject every real result — the failure mode
 * a hand-written key-list validator would have to guard against by hand.
 */

export const asyncJobDetailsSchema = z.strictObject({
	state: z.enum(["running", "completed", "failed"]),
	jobId: z.string(),
	type: z.literal("bash"),
});

export const bashDetailsSchema = z.strictObject({
	meta: outputMetaSchema.optional(),
	timeoutSeconds: z.number().optional(),
	requestedTimeoutSeconds: z.number().optional(),
	timeoutDisabled: z.boolean().optional(),
	wallTimeMs: z.number().optional(),
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode: z.number().optional(),
	/**
	 * True when the command was killed by its timeout deadline.
	 *
	 * A timeout is a **failed** outcome (`#buildCompletedResult` already returns
	 * `isError: true` for the model); this flag exists only so a human surface can
	 * soften the severity to a warning border. The old "(not a failure)" comment
	 * on this field described the styling, not the outcome, and is gone.
	 */
	timedOut: z.boolean().optional(),
	/**
	 * Fact bodies a call declared for its own registered
	 * `modelContentProjection` (an escape hatch) — see
	 * `ToolResultBuilder#truncationFact`/`#truncationFactFromSummary`'s doc
	 * comments. Not read by the ACP mapper or any other `details.meta`
	 * consumer; `meta` above stays the single structural source for those.
	 */
	presentationFacts: presentationFactsSchema.optional(),
	async: asyncJobDetailsSchema.optional(),
});

/**
 * The agent loop's explicit result for a call that was announced by the model
 * but never entered a built-in executor. This is not a BashToolDetails escape
 * hatch: it is a separate, strict legacy-lifecycle shape that the ACP adapter
 * can classify without handing synthetic metadata to generic result walkers.
 */
export const syntheticToolResultDetailsSchema = z.strictObject({
	__synthetic: z.literal(true),
	source: z.enum([
		"assistant_stop_aborted",
		"assistant_stop_error",
		"assistant_stop_skipped",
		"assistant_stop_length",
		"interrupt_skipped",
	]),
	executed: z.literal(false),
	upstreamError: z.string().optional(),
});

/**
 * The agent loop's own explicit result for a call whose arguments failed
 * schema validation before dispatch (`runTool`'s `validationErrorMessage`
 * branch in `agent-loop.ts`, emitted for every built-in, not just bash).
 * Neither `BashToolDetails` nor the synthetic-lifecycle shape model this: an
 * unmodelled validation failure must not fail the built-in schema and poison
 * the ACP prompt, since it is a real, well-formed lifecycle outcome the
 * agent loop itself produces.
 */
export const validationFailureDetailsSchema = z.strictObject({
	isError: z.literal(true),
	error: z.string(),
});

/** Strict legacy details accepted for the built-in bash aliases. */
export const legacyBashDetailsSchema = z.union([
	bashDetailsSchema,
	syntheticToolResultDetailsSchema,
	validationFailureDetailsSchema,
]);

export const evalStatusEventSchema = z.strictObject({
	kind: z.string(),
	message: z.string().optional(),
	at: z.number().optional(),
});

export const evalCellSchema = z.looseObject({
	index: z.number(),
	title: z.string().optional(),
	code: z.string(),
	language: z.string().optional(),
	output: z.string(),
	status: z.enum(["pending", "running", "complete", "error"]),
	durationMs: z.number().optional(),
	exitCode: z.number().optional(),
	hasMarkdown: z.boolean().optional(),
});
export const evalTerminationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("interrupted") }),
	z.object({ kind: z.literal("timed_out"), timeoutMs: z.number() }),
]);

export const evalDetailsSchema = z.looseObject({
	cells: z.array(evalCellSchema).optional(),
	jsonOutputs: z.array(z.unknown()).optional(),
	images: z.array(imageContentSchema).optional(),
	isError: z.boolean().optional(),
	termination: evalTerminationSchema.optional(),
	meta: outputMetaSchema.optional(),
	language: z.string().optional(),
	languages: z.array(z.string()).optional(),
	notice: z.string().optional(),
	notices: z.array(z.string()).readonly().optional(),
	/**
	 * Fact bodies a call declared for its own registered
	 * `modelContentProjection` (an escape hatch) — see
	 * `ToolResultBuilder#truncationFactFromSummary`'s doc comment. Not read
	 * by the ACP mapper or any other `details.meta` consumer; `meta` above
	 * stays the single structural source for those.
	 */
	presentationFacts: presentationFactsSchema.optional(),
});

/**
 * The `FileDiagnosticsResult` an LSP writethrough attaches to an applied
 * file (`lsp/index.ts`). The presentation layer never reads it, but every
 * real edit result carries the key, so a strict bag has to model it —
 * leaving it out would mean either rejecting every real result or reopening
 * the object to unknown keys. Strict at this level too, per the two
 * dispositions in `output-meta.ts`: a renamed LSP diagnostics field is a
 * producer change that must fail loudly in dev/tests.
 */
const editDiagnosticsSchema = z.strictObject({
	server: z.string().optional(),
	messages: z.array(z.string()),
	summary: z.string(),
	errored: z.boolean(),
	/** Mirrors `FileFormatResult`, whose members are these two strings. */
	formatter: z.enum(["unchanged", "formatted"]).optional(),
});

/**
 * Presentation data every row of the legacy edit bag carries, whether it
 * describes one file inline or one entry of a `perFileResults` list.
 */
function editRowShape() {
	return {
		diff: z.string(),
		firstChangedLine: z.number().optional(),
		diagnostics: editDiagnosticsSchema.optional(),
		meta: outputMetaSchema.optional(),
	};
}

/**
 * The legacy `op`/`move`/`sourcePath` tags. Every mode except `replace`
 * emits them for an applied file (`legacyChangeTags` in `edit/legacy-bag.ts`);
 * nothing in the presentation layer reads them, so they are modelled to
 * shape only, without the non-empty constraints `path` carries.
 */
function editOperationShape() {
	return {
		op: z.enum(["create", "delete", "update"]).optional(),
		move: z.string().optional(),
		sourcePath: z.string().optional(),
	};
}

/**
 * The two snapshot states of an applied file, as separate arms rather than
 * three co-optional fields. This is what makes `snapshotsPruned: true`
 * beside a populated `oldText`/`newText` unrepresentable — the contradiction
 * `FileChangeEvidence` (`edit/types.ts`) closed on the producer side and
 * `pruneOversizedEditSnapshots` used to hold by convention alone.
 *
 * `snapshotsPruned: false` is accepted on the available arm even though no
 * producer writes it: it is the obvious encoding of "not pruned" and
 * rejecting it would buy nothing.
 */
function availableSnapshotShape() {
	return {
		snapshotsPruned: z.literal(false).optional(),
		oldText: z.string().optional(),
		newText: z.string().optional(),
	};
}

function prunedSnapshotShape() {
	return { snapshotsPruned: z.literal(true) };
}

/**
 * Fields shared by both applied arms of a `perFileResults` entry. `isError`
 * is declared as an optional `false` literal (never written by a producer)
 * so it stays a usable discriminant against the failed arm below instead of
 * a key consumers have to probe for.
 */
function editPerFileAppliedShape() {
	return {
		path: z.string().min(1),
		isError: z.literal(false).optional(),
		...editRowShape(),
		...editOperationShape(),
	};
}

export const editPerFileAvailableSchema = z.strictObject({
	...editPerFileAppliedShape(),
	...availableSnapshotShape(),
});

export const editPerFilePrunedSchema = z.strictObject({
	...editPerFileAppliedShape(),
	...prunedSnapshotShape(),
});

/**
 * A file the producer attempted and failed. Carries the error text and
 * nothing else: no snapshot, no diagnostics, no operation tag. A failed
 * entry claiming it also changed the file is exactly the contradiction
 * `EditFileOutcome`'s `failed` arm removed, and the strict arms make it
 * unparseable rather than merely unconventional.
 */
export const editPerFileFailedSchema = z.strictObject({
	path: z.string().min(1),
	diff: z.string(),
	isError: z.literal(true),
	errorText: z.string(),
	displayErrorText: z.string().optional(),
});

export const editPerFileSchema = z.union([
	editPerFileFailedSchema,
	editPerFilePrunedSchema,
	editPerFileAvailableSchema,
]);

/**
 * A bag that describes exactly one file inline. Mutually exclusive with the
 * multi-file arm below: `perFileResults` and `unattemptedPaths` are pinned
 * absent, which is what retires the `perFileResults ?? [details]` idiom the
 * ACP view used to resolve "both populated" by convention.
 */
function editSingleFileShape() {
	return {
		...editRowShape(),
		...editOperationShape(),
		/** Absent on hashline's no-op result, which describes no file at all. */
		path: z.string().min(1).optional(),
		perFileResults: z.undefined().optional(),
		unattemptedPaths: z.undefined().optional(),
	};
}

export const editSingleFileAvailableSchema = z.strictObject({
	...editSingleFileShape(),
	...availableSnapshotShape(),
});

export const editSingleFilePrunedSchema = z.strictObject({
	...editSingleFileShape(),
	...prunedSnapshotShape(),
});

/**
 * A multi-file bag. Carries per-file rows and nothing inline — no `path`,
 * no snapshot, no operation tag — so an aggregate can no longer describe a
 * file its own `perFileResults` list does not mention.
 *
 * `unattemptedPaths` requires a failed entry: skipping files is only
 * meaningful as the consequence of an earlier failure, the lockstep
 * `aggregateEditOutcome` enforces for built-in producers and this arm
 * enforces for anything arriving from outside.
 */
export const editMultiFileSchema = z
	.strictObject({
		...editRowShape(),
		perFileResults: z.array(editPerFileSchema).min(1),
		unattemptedPaths: z.array(z.string().min(1)).min(1).optional(),
	})
	.refine(
		details => details.unattemptedPaths === undefined || details.perFileResults.some(entry => entry.isError === true),
		{ error: "unattemptedPaths requires at least one failed perFileResults entry" },
	);

/** The legacy edit bag: one file inline, or a per-file list. Never both. */
export const editBagDetailsSchema = z.union([
	editMultiFileSchema,
	editSingleFilePrunedSchema,
	editSingleFileAvailableSchema,
]);

/**
 * The details a built-in edit call that **threw** produces: the agent loop
 * emits the thrown message as content and an empty `details`, because the
 * producer never got far enough to build a bag (`edit/index.ts` builds the
 * bag only on the success path).
 *
 * Its own arm rather than a relaxation of `diff`: the bag's required `diff`
 * is what tells the adapter an empty visual diff was intentional, and
 * keeping that required while admitting `{}` separately is the difference
 * between "no diff to show" and "no result at all". Before this arm existed
 * every failed edit on the live ACP route (a stale hashline tag, a patch
 * context mismatch, a plan-mode rejection) failed the built-in schema and
 * poisoned the whole prompt with a JSON-RPC internal error.
 */
export const editThrownFailureDetailsSchema = z.strictObject({});

/**
 * Strict legacy details accepted for the built-in edit aliases: the bag, or
 * one of the three lifecycle results the agent loop itself produces for a
 * call that never returned a bag. Mirrors `legacyBashDetailsSchema` — the
 * synthetic and validation-failure shapes are emitted for *every* built-in,
 * not just bash, and a real lifecycle outcome must settle as a typed failed
 * frame rather than fail the built-in schema.
 */
export const editDetailsSchema = z.union([
	editBagDetailsSchema,
	editThrownFailureDetailsSchema,
	validationFailureDetailsSchema,
	syntheticToolResultDetailsSchema,
]);

export type PresentationBashDetails = z.infer<typeof bashDetailsSchema>;
export type PresentationLegacyBashDetails = z.infer<typeof legacyBashDetailsSchema>;
export type PresentationSyntheticToolResultDetails = z.infer<typeof syntheticToolResultDetailsSchema>;
export type PresentationValidationFailureDetails = z.infer<typeof validationFailureDetailsSchema>;
export type PresentationEvalDetails = z.infer<typeof evalDetailsSchema>;
export type PresentationEditDetails = z.infer<typeof editDetailsSchema>;
export type PresentationEditBagDetails = z.infer<typeof editBagDetailsSchema>;
export type PresentationEditPerFileResult = z.infer<typeof editPerFileSchema>;
/** The bag arm that carries a per-file list. */
export type PresentationMultiFileEditDetails = z.infer<typeof editMultiFileSchema>;
/** The bag arms that describe one file inline instead of via `perFileResults`. */
export type PresentationSingleFileEditDetails =
	| z.infer<typeof editSingleFileAvailableSchema>
	| z.infer<typeof editSingleFilePrunedSchema>;
export type PresentationEvalTermination = z.infer<typeof evalTerminationSchema>;
