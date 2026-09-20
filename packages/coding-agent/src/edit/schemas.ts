import { type } from "@oh-my-pi/omptype";
import { thenRunFieldSchema } from "../tools/action-fusion";

export const replaceEditSchema = type({
	path: "string",
	old_string: "string",
	new_string: "string",
	"replace_all?": "boolean",
	"then_run?": thenRunFieldSchema,
});

export type ReplaceParams = typeof replaceEditSchema.infer;

/** Internal batch form produced only by the Cursor exec bridge. */
export interface ReplaceBatchParams {
	path: string;
	edits: Omit<ReplaceParams, "path" | "then_run">[];
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
	"then_run?": thenRunFieldSchema,
});

export type PatchParams = typeof patchEditSchema.infer;

export const applyPatchSchema = type({
	input: "string",
	"then_run?": thenRunFieldSchema,
});

export type ApplyPatchParams = typeof applyPatchSchema.infer;

export const hashlineEditParamsSchema = type({
	input: "string",
	"then_run?": thenRunFieldSchema,
});

export type HashlineParams = typeof hashlineEditParamsSchema.infer;

export const sloppyEditSchema = type({
	input: "string",
	"then_run?": thenRunFieldSchema,
});

export type SloppyParams = typeof sloppyEditSchema.infer;
