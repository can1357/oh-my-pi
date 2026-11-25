import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { type KeyId } from "../../../config/keybindings/key-id";
import { AUTO_THINKING } from "../../../thinking/levels";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";
import type { ScopedModelItem } from "./model-hub";

/** Configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

export interface ModelPickerCallbacks {
	/**
	 * A model was chosen for a session-only switch. `selector` is `provider/id`.
	 * `overContext` is true when the session transcript exceeds the model's
	 * context window — the host must compact before switching. `thinkingLevel`
	 * is the slider's level clamped to `model`, absent when it was not moved.
	 */
	onPick: (
		model: Model,
		selector: string,
		meta: { overContext: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	) => void;
	/** A configured ctrl+p quick role was chosen. */
	onPickRole?: (entry: ResolvedRoleModel) => void;
	/**
	 * A model was chosen for Task subagents (task mode, toggled by pressing the
	 * picker shortcut again). Session-only: the host applies a runtime override.
	 */
	onPickTask?: (model: Model, selector: string) => void;
	/**
	 * The picker is closing on the current model's row with the slider moved: keep `level`
	 * (clamped to that model) as the session's thinking level. {@link onCancel} follows.
	 */
	onKeepThinking?: (level: ConfiguredThinkingLevel) => void;
	/** Returns the rebuilt scope; `undefined` means the session no longer has a scope. */
	onCatalogRefreshed?: () =>
		| ReadonlyArray<ScopedModelItem>
		| undefined
		| Promise<ReadonlyArray<ScopedModelItem> | undefined>;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are grayed and compact-first on pick. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Resolved role models in the same order used by the ctrl+p quick-role cycle. */
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	/** Complete ctrl+p order, including unavailable roles, to preserve segment colors. */
	quickRoleOrder?: ReadonlyArray<string>;
	/** Active quick role, highlighted when the search begins with `@`. */
	currentQuickRole?: string;
	/** Keys that toggle task-subagent mode while the picker is open; the first is shown in the footer. */
	taskModeKeys?: readonly KeyId[];
	/** `provider/id` highlighted and preselected in task mode (current Task subagent model). */
	taskSelector?: string;
	/**
	 * Level the untouched slider shows for `model` (clamped to its ladder): the
	 * session's current level. An untouched pick carries the session's own
	 * selection over instead. Enables the session-mode thinking slider; absent,
	 * the picker shows none.
	 */
	thinkingLevelFor?: (model: Model) => ConfiguredThinkingLevel | undefined;
}

/** The frozen slider's steps for a model without an effort to pick. */
const FROZEN_THINKING_STEPS: readonly ConfiguredThinkingLevel[] = [
	ThinkingLevel.Off,
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
];

/** The thinking slider for one model: its steps low to high, the shown step, and why it is frozen. */
export interface ThinkingSlider {
	steps: readonly ConfiguredThinkingLevel[];
	value: ConfiguredThinkingLevel;
	disabled?: string;
}

/** `model`'s slider steps (auto, off, its efforts), frozen when it has no effort to pick. */
function thinkingSteps(model: Model): { steps: readonly ConfiguredThinkingLevel[]; disabled?: string } {
	const efforts = getSupportedEfforts(model);
	if (efforts.length > 0) return { steps: [AUTO_THINKING, ThinkingLevel.Off, ...efforts] };
	return {
		steps: FROZEN_THINKING_STEPS,
		disabled: model.reasoning ? `${model.name} picks its own effort` : `${model.name} does not reason`,
	};
}

/** `level` as one of `model`'s live `steps`: unset or inherit as the model's default, an effort clamped to its ladder. */
function thinkingStep(
	model: Model,
	steps: readonly ConfiguredThinkingLevel[],
	level: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel {
	const wanted =
		level === undefined || level === ThinkingLevel.Inherit
			? (model.thinking?.defaultLevel ?? ThinkingLevel.Off)
			: level;
	if (steps.includes(wanted)) return wanted;
	if (wanted === AUTO_THINKING || wanted === ThinkingLevel.Off) return ThinkingLevel.Off;
	return clampThinkingLevelForModel(model, wanted) ?? ThinkingLevel.Off;
}

/**
 * `model`'s thinking slider showing `level` (clamped to its ladder; unset or inherit as its default level), frozen at
 * off when it has no effort to pick. The alt+p picker's slider, and RPC's `get_model_picker` rows.
 */
export function thinkingSlider(model: Model, level: ConfiguredThinkingLevel | undefined): ThinkingSlider {
	const { steps, disabled } = thinkingSteps(model);
	if (disabled) return { steps, value: ThinkingLevel.Off, disabled };
	return { steps, value: thinkingStep(model, steps, level) };
}
