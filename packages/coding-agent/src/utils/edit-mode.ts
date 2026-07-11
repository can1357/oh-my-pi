import { $env, $flag } from "@pk-nerdsaver-ai/pi-utils";

export type EditMode = "replace" | "patch" | "hashline" | "apply_patch";

export const DEFAULT_EDIT_MODE: EditMode = "hashline";

const EDIT_MODE_IDS = {
	apply_patch: "apply_patch",
	hashline: "hashline",
	patch: "patch",
	replace: "replace",
} as const satisfies Record<string, EditMode>;

export const EDIT_MODES = Object.keys(EDIT_MODE_IDS) as EditMode[];

const HASHLINE_EXCLUDED_MODEL_MODES: Array<{ pattern: string; mode: EditMode }> = [
	{ pattern: "kimi", mode: "replace" },
];

function resolveHashlineExcludedModelMode(model: string | undefined): EditMode | null {
	if (!model) return null;
	const modelLower = model.toLowerCase();
	for (const entry of HASHLINE_EXCLUDED_MODEL_MODES) {
		if (modelLower.includes(entry.pattern)) return entry.mode;
	}
	return null;
}

export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	if (!mode) return undefined;
	return EDIT_MODE_IDS[mode as keyof typeof EDIT_MODE_IDS];
}

export interface EditModeSettingsLike {
	get(key: "edit.mode"): unknown;
	getEditVariantForModel?(model: string | undefined): EditMode | null;
}

export interface EditModeSessionLike {
	settings: EditModeSettingsLike;
	getActiveModelString?: () => string | undefined;
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = session.settings.getEditVariantForModel?.(activeModel);
	if (modelVariant) return modelVariant;

	const envMode = normalizeEditMode($env.PI_EDIT_VARIANT);
	if (envMode) return envMode;

	const settingsMode = normalizeEditMode(String(session.settings.get("edit.mode") ?? ""));
	const mode = settingsMode ?? DEFAULT_EDIT_MODE;
	if (mode === "hashline" && !$flag("PI_STRICT_EDIT_MODE")) {
		return resolveHashlineExcludedModelMode(activeModel) ?? mode;
	}
	return mode;
}
