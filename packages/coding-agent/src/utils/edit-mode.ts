import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { $flag } from "@oh-my-pi/pi-utils";

import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { Settings } from "../config/settings";
import { cfgEditMode, editModelVariants } from "../edit/settings";

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

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = editVariantForModel(session.settings, activeModel);
	if (modelVariant) return modelVariant;

	const mode = cfgEditMode.get(session.settings);
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
			(identity.class === "glm" && identity.family === "flash" && identity.revision === "5.3.0")
		) {
			return "replace";
		}
	}
	return mode;
}
