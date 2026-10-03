/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type SettingValueOf } from "./registry";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import type { cfgDefaultThinkingLevel } from "../session/settings";

/** Display metadata for one model tag. */
export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

/** Model tags keyed by tag id (`modelTags`). */
export type ModelTagsSettings = Record<string, ModelTagDef>;

/**
 * One saved model preset (`modelPresets.<name>`): the role assignments and default thinking level
 * captured by `/modelpreset save` or the model hub, re-applied as a whole by `/modelpreset switch`.
 */
export interface ModelPreset {
	modelRoles: Record<string, string>;
	/** `defaultThinkingLevel` at save time; absent in hand-written presets that leave it alone. */
	defaultThinkingLevel?: SettingValueOf<typeof cfgDefaultThinkingLevel>;
}

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_UNKNOWN_RECORD: Record<string, unknown> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const EMPTY_MODEL_PRESETS_RECORD: Record<string, ModelPreset> = {};
const EMPTY_AUTH_ACCOUNT_POLICIES: AuthAccountPolicies = [];

// Auth broker — credentials proxied through a remote `omp auth-broker serve`
// host. Hidden from the UI; populate via env vars or hand-edited config.yml. Env takes
// precedence so per-machine overrides remain trivial. The connection itself is resolved by
// `@oh-my-pi/pi-ai/auth-broker/discover` from env + global config.yml only (project layers
// never redirect credentials); these definitions own validation, CLI, and `cfg://` display.
export const cfgAuthBrokerUrl = register({
	id: "auth.broker.url",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_URL",
});

export const cfgAuthBrokerToken = register({
	id: "auth.broker.token",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_TOKEN",
	credential: true,
});

export const cfgAuthAccountPolicies = register({
	id: "auth.accountPolicies",
	type: "array",
	default: EMPTY_AUTH_ACCOUNT_POLICIES,
});

export const cfgEnabledModels = register({
	id: "enabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});

export const cfgEnabledProviders = register({
	id: "enabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgDisabledProviders = register({
	id: "disabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgModelRoleStorage = register({
	id: "modelRoleStorage",
	type: "enum",
	values: ["global", "project"] as const,
	default: "global",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Model Role Storage",
		description: "Where model selector role assignments are saved",
		options: [
			{
				value: "global",
				label: "Global",
				description: "Save role models in the active profile config (current behavior)",
			},
			{
				value: "project",
				label: "Per-project",
				description: "Save project role models in .omp/config.yml; missing project roles use global defaults",
			},
		],
	},
});

export const cfgModelRoles = register({ id: "modelRoles", type: "record", default: EMPTY_STRING_RECORD });

/** Per-model Default role profiles plus named role presets, managed by the model hub. */
export const cfgModelRolePresets = register({
	id: "modelRolePresets",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
});

export const cfgModelRolePresetsAutoLoad = register({
	id: "modelRolePresets.autoLoad",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Model Roles",
		label: "Auto load configured model role presets",
		description:
			"Load the selected model's Default preset when changing models in /models. Off preserves supporting roles, even when built-in presets are enabled. Default remains active for editing; explicitly selected presets still apply.",
	},
});

export const cfgModelRolePresetsApplyOnSelect = register({
	id: "modelRolePresets.applyOnSelect",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Model Roles",
		label: "Apply built-in presets",
		description:
			"When changing the default model in /models, apply OMP's built-in preset if no saved Default exists. Off preserves supporting roles in that case. Saved Defaults and explicitly selected presets still apply.",
	},
});

export const cfgModelRolePresetsKeepRolesWhenUnset = register({
	id: "modelRolePresets.keepRolesWhenUnset",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Model Roles",
		label: "Keep roles when Default is unset",
		description:
			"When switching default models, preserve supporting roles omitted by the selected Default profile. Turn off to clear omitted roles instead.",
	},
});

export const cfgModelRolePresetsAutoSave = register({
	id: "modelRolePresets.autoSave",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Model Roles",
		label: "Auto-save active role preset",
		description:
			"When editing roles after applying a preset in /models, save each role change back to that preset. Off lets you press s to save it manually.",
	},
});

/** Named model presets; no settings-panel UI — managed by `/modelpreset` and the model hub. */
export const cfgModelPresets = register({
	id: "modelPresets",
	type: "record",
	default: EMPTY_MODEL_PRESETS_RECORD,
});

export const cfgModelTags = register({ id: "modelTags", type: "record", default: EMPTY_MODEL_TAGS_RECORD });

export const cfgModelProviderOrder = register({ id: "modelProviderOrder", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgCycleOrder = register({ id: "cycleOrder", type: "array", default: DEFAULT_CYCLE_ORDER });
