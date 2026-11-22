import { type } from "@oh-my-pi/omptype";

export const replaceEditSchema = type({
	path: "string",
	old_string: "string",
	new_string: "string",
	"replace_all?": "boolean",
});

export type ReplaceParams = typeof replaceEditSchema.infer;

/** Internal batch form produced only by the Cursor exec bridge. */
export interface ReplaceBatchParams {
	path: string;
	edits: Omit<ReplaceParams, "path">[];
}

export const patchEditEntrySchema = type({
	"op?": "'create' | 'delete' | 'update'",
	"rename?": "string",
	"diff?": "string",
});

export type PatchEditEntry = typeof patchEditEntrySchema.infer;

export const patchEditSchema = type({
	path: "string",
	edits: patchEditEntrySchema.array(),
});

export type PatchParams = typeof patchEditSchema.infer;

export const applyPatchSchema = type({
	input: "string",
});

export type ApplyPatchParams = typeof applyPatchSchema.infer;

export const hashlineEditParamsSchema = type({
	input: "string",
});

export type HashlineParams = typeof hashlineEditParamsSchema.infer;

export const sloppyEditSchema = type({
	input: type("string").describe(
		"Complete patch. Use `*** Replace Block: opener` plus new code for a whole block. For `*** Find`, include the action (Replace, Insert, Cut, or Paste) in this SAME string before sending.",
	),
});

export type SloppyParams = typeof sloppyEditSchema.infer;

/** `edit.mode: magic`: changes in words, per file; an auxiliary model writes the patches. */
export const magicEditSchema = type({
	input: type("string").describe("One section per file: the file, then the changes to it in words."),
});

export type MagicEditParams = typeof magicEditSchema.infer;
