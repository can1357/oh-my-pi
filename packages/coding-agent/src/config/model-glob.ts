import type { Api, Model } from "@oh-my-pi/pi-ai";

/**
 * Whether a compiled model-scope glob (the `enabledModels` grammar, without a
 * `:level` suffix) matches `model`. The glob must be lowercased; matching runs
 * against both `provider/id` and the bare id, lowercased.
 */
export function globMatchesModel(glob: Bun.Glob, model: Pick<Model<Api>, "provider" | "id">): boolean {
	const fullId = `${model.provider}/${model.id}`;
	return glob.match(fullId.toLowerCase()) || glob.match(model.id.toLowerCase());
}

/** {@link globMatchesModel} for an uncompiled pattern; matching is case-insensitive. */
export function modelMatchesGlob(pattern: string, model: Pick<Model<Api>, "provider" | "id">): boolean {
	return globMatchesModel(new Bun.Glob(pattern.toLowerCase()), model);
}
