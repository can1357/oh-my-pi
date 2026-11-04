import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { $flag } from "@oh-my-pi/pi-utils";

import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { Settings } from "../config/settings";
import { cfgEditMode, type EditModeSetting, editModelVariants } from "../edit/settings";

/** First `edit.modelVariants` entry whose pattern occurs in `model` (case-insensitive). */
export function editVariantForModel(settings: Settings, model: string | undefined): EditMode | undefined {
	if (!model) return undefined;
	const modelLower = model.toLowerCase();
	return editModelVariants.get(settings).find(variant => modelLower.includes(variant.patternLower))?.mode;
}

export interface EditModeSessionLike {
	settings: Settings;
	getActiveModelString?: () => string | undefined;
}

/**
 * Edit tool variant for the active model, or `"none"` when `edit.mode` removes the tool.
 * `"none"` wins over `edit.modelVariants`: tool registration follows the setting, not the model.
 */
export function resolveEditMode(session: EditModeSessionLike): EditModeSetting {
	const mode = cfgEditMode.get(session.settings);
	if (mode === "none") return mode;

	const activeModel = session.getActiveModelString?.();
	const modelVariant = editVariantForModel(session.settings, activeModel);
	if (modelVariant) return modelVariant;
	// `PI_EDIT_VARIANT` pins the mode exactly; only settings-derived hashline adapts to the model.
	if (cfgEditMode.provenance(session.settings) === "env") return mode;
	if (mode === "hashline" && !$flag("PI_STRICT_EDIT_MODE") && activeModel) {
		const identity = classifyModel("", activeModel, { lenient: true });
		if (
			identity.class === "kimi" ||
			identity.class === "mimo" ||
			identity.class === "minimax" ||
			identity.class === "deepseek" ||
			identity.class === "stepfun" ||
			identity.family === "codex-spark" ||
			(identity.class === "glm" && identity.family === "flash" && identity.revision === "5.3.0") ||
			(identity.class === "qwen" && identity.revision === "3.8.0")
		) {
			return "replace";
		}
	}
	return mode;
}
