/** @jsxImportSource @oh-my-pi/pi-tui */
import type { Model } from "@oh-my-pi/pi-ai";
import type { KeyId } from "../../../../src/config/keybindings/key-id";
import type { ModelPickerOptions, ResolvedRoleModel } from "../../../../src/modes/view-model/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "../../../../src/utils/render-utils";
import { ModelPicker, type ModelPickerRegistry } from "../../../../src/ui/overlays/pickers/model-picker";
import { type Driver, pickerSuite } from "./harness";
import { MODELS, source } from "./model-fixtures";

function registry(models: Model[], refresh: () => Promise<boolean>): ModelPickerRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		refreshIfStale: refresh,
	};
}

const quickRoles: ResolvedRoleModel[] = [
	{ role: "default", model: MODELS[2]!, explicitThinkingLevel: false },
	{ role: "smol", model: MODELS[5]!, explicitThinkingLevel: true, thinkingLevel: "low" as ConfiguredThinkingLevel },
	{ role: "slow", model: MODELS[1]!, explicitThinkingLevel: false },
];

const full: ModelPickerOptions = {
	currentSelector: "demo/demo",
	currentContextTokens: 150_000,
	quickRoles,
	quickRoleOrder: ["default", "smol", "slow", "missing"],
	currentQuickRole: "smol",
	taskModeKeys: ["alt+p" as KeyId],
	taskSelector: "openai/gpt-5.6",
	thinkingLevelFor: () => "high" as ConfiguredThinkingLevel,
};

const CASES: Readonly<
	Record<string, { options: ModelPickerOptions; rows?: number; models?: Model[]; refresh?: () => Promise<boolean> }>
> = {
	"full-options": { options: full },
	"minimal-options": { options: {} },
	"short-terminal-no-quick-roles": { options: { ...full, quickRoles: [] }, rows: 10 },
	"refresh-fails": {
		options: full,
		refresh: async () => {
			throw new Error("models.yml: bad provider");
		},
	},
	"no-models": { options: full, models: [] },
};

const action =
	(act: string, value?: string) =>
	(d: Driver): void =>
		void d.emit({ type: "action", key: "", act, mods: [], ...(value !== undefined ? { value } : {}) });
const event =
	(type: "select" | "activate", item: string, key = "") =>
	(d: Driver): void =>
		void d.emit({ type, key, item });

pickerSuite({
	dir: "overlays/model-picker",
	mount(caseName) {
		const spec = CASES[caseName]!;
		const log: string[] = [];
		const settings = source({ default: "demo/demo", smol: "openai/gpt-5.6-mini" }, ["demo/demo", "openai/gpt-5.6"]);
		const models = spec.models ?? MODELS;
		return {
			view: () => (
				<ModelPicker
					source={settings}
					registry={registry(models, spec.refresh ?? (async () => false))}
					scopedModels={models.map(entry => ({ model: entry }))}
					callbacks={{
						onPick: (_m, selector, meta) =>
							log.push(`pick:${selector}:${meta.overContext}:${meta.thinkingLevel ?? "-"}`),
						onPickRole: entry => log.push(`role:${entry.role}`),
						onPickTask: (_m, selector) => log.push(`task:${selector}`),
						onKeepThinking: level => log.push(`keep:${level}`),
						onCancel: () => log.push("cancel"),
					}}
					options={spec.options}
					terminalRows={() => spec.rows ?? 40}
				/>
			),
			steps: {
				tick: () => Bun.sleep(0),
				"scope openai": action("scope", "provider:openai"),
				"scope bogus": action("scope", "provider:nope"),
				"select mini": event("select", "openai/gpt-5.6-mini"),
				"level low": action("level", "low"),
				"level bogus": action("level", "bogus"),
				"scope openai again → all": action("scope", "provider:openai"),
				"select tiny (no reasoning)": event("select", "local/tiny"),
				"level on frozen": action("level", "low"),
				"select demo-lite": event("select", "demo/demo-lite"),
				"task on": action("task"),
				"activate in task mode": event("activate", "anthropic/claude-opus-5"),
				"task off": action("task"),
				"typed query": d => {
					d.press("c");
					d.press("l");
				},
				clear: action("clear"),
				"clear empty": action("clear"),
				"activate demo": event("activate", "demo/demo"),
				"foreign key event": event("select", "demo/demo", "elsewhere"),
				close: action("close"),
			},
		};
	},
});
