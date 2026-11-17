import { Markdown, type SelectItem, SelectList, Spacer } from "@oh-my-pi/pi-tui";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { CLOSE_ACTION, dockedPicker, PICKER_KEY, pickerAction, pickerEvent } from "@oh-my-pi/pi-tui/native/picker";
import { getMarkdownTheme, getSelectListTheme } from "@oh-my-pi/pi-tui/theme";
import type { Settings } from "../../config/settings";
import { isModelRuleEnabled, matchesModel, type ModelRule } from "../../extensibility/model-rules";
import { cfgModelRules } from "../../extensibility/settings";

/** Inputs and callbacks for the model-rule selector. */
export interface ModelRulesSelectorOptions {
	rules: readonly ModelRule[];
	settings: Settings;
	modelKey: string | undefined;
	requestRender: () => void;
	onClose: () => void;
}

/** Toggles model rules and previews their markdown in terminal and native pickers. */
export class ModelRulesSelectorComponent extends OverlayPanel {
	readonly #rules: readonly ModelRule[];
	readonly #settings: Settings;
	readonly #modelKey: string | undefined;
	readonly #requestRender: () => void;
	readonly #onClose: () => void;
	readonly #selectList: SelectList;
	readonly #preview: Markdown;
	#selectedPath: string;

	constructor(options: ModelRulesSelectorOptions) {
		super("Model Rules", "omp.overlay.model-rules");
		this.#rules = options.rules;
		this.#settings = options.settings;
		this.#modelKey = options.modelKey;
		this.#requestRender = options.requestRender;
		this.#onClose = options.onClose;
		const firstRule = this.#rules[0]!;
		this.#selectedPath = firstRule.path;
		this.#selectList = new SelectList(this.#items(), Math.min(this.#rules.length, 8), getSelectListTheme());
		this.#preview = new Markdown(firstRule.body, 1, 0, getMarkdownTheme());
		this.#selectList.onSelect = item => {
			const rule = this.#rules.find(rule => rule.path === item.value);
			if (rule) this.#toggle(rule);
		};
		this.#selectList.onSelectionChange = item => {
			const rule = this.#rules.find(rule => rule.path === item.value);
			if (!rule) return;
			this.#selectedPath = rule.path;
			this.#preview.setText(rule.body);
			this.#requestRender();
		};
		this.#selectList.onCancel = () => this.#onClose();
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(this.#preview);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#describePicker() : super.describe(cx);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event, PICKER_KEY);
		if (!ev) return;
		if (ev.kind === "action") {
			if (ev.act === "close" || ev.act === "cancel") {
				this.#onClose();
			} else if (ev.act === "toggle") {
				const rule = this.#rules.find(rule => rule.path === this.#selectedPath);
				if (rule) this.#toggle(rule);
			}
			return;
		}
		const index = this.#rules.findIndex(rule => rule.path === ev.item);
		const rule = this.#rules[index];
		if (!rule) return;
		this.#selectedPath = rule.path;
		this.#selectList.setSelectedIndex(index);
		this.#preview.setText(rule.body);
		this.#requestRender();
		if (ev.kind === "activate") this.#toggle(rule);
	}

	#enabled(rule: ModelRule): boolean {
		return isModelRuleEnabled(rule, cfgModelRules.get(this.#settings));
	}

	#toggle(rule: ModelRule): void {
		const next = !this.#enabled(rule);
		const value = next === rule.enabledByDefault ? undefined : next;
		if (rule.scope === "project") cfgModelRules.setProjectEntry(this.#settings, rule.name, value);
		else cfgModelRules.setEntry(this.#settings, rule.name, value);
		this.#refresh();
	}

	#refresh(): void {
		this.#selectList.setItems(this.#items());
		this.#selectList.setSelectedValue(this.#selectedPath);
		this.invalidate();
		this.#requestRender();
	}

	#items(): SelectItem[] {
		return this.#rules.map(rule => {
			const matches = this.#modelKey !== undefined && matchesModel(rule.models, this.#modelKey);
			return {
				value: rule.path,
				label: `${this.#enabled(rule) ? "[x]" : "[ ]"} ${rule.name}`,
				description: `${rule.scope}${rule.overridesGlobal ? " (overrides global)" : ""} · ${rule.models.join(", ")}${matches ? " · active" : ""}`,
			};
		});
	}

	#describePicker(): NativeNode {
		const selectedRule = this.#rules.find(rule => rule.path === this.#selectedPath)!;
		return dockedPicker(
			{
				title: "Model rules",
				...(this.#modelKey ? { subtitle: `Active model: ${this.#modelKey}` } : {}),
				icon: "list",
				noun: "rules",
				layout: "rows",
				preview: "side",
				query: null,
				items: this.#rules.map(rule => {
					const matches = this.#modelKey !== undefined && matchesModel(rule.models, this.#modelKey);
					return {
						id: rule.path,
						label: rule.name,
						detail: rule.models.join(", "),
						dot: this.#enabled(rule) ? ("success" as const) : ("muted" as const),
						badges: [
							{ text: rule.scope },
							...(rule.overridesGlobal ? [{ text: "overrides global" }] : []),
							...(matches ? [{ text: "active", tone: "success" as const }] : []),
						],
					};
				}),
				selected: this.#selectedPath,
				actions: [
					pickerAction("toggle", this.#enabled(selectedRule) ? "Disable" : "Enable", "enter", { primary: true }),
					CLOSE_ACTION,
				],
			},
			[md(selectedRule.body)],
		);
	}
}
