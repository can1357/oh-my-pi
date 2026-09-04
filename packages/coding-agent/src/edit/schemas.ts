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
	input: "string",
});

export type SloppyParams = typeof sloppyEditSchema.infer;
