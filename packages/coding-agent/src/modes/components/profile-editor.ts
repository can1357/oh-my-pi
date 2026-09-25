import {
	type Component,
	padding,
	parseSgrMouse,
	replaceTabs,
	routeSelectListMouse,
	SelectList,
	type SelectItem,
	type SettingItem,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { bottomBorder, divider, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import {
	SettingsSelectorComponent,
	type SettingsRuntimeContext,
	type SettingsSelectorSection,
} from "@oh-my-pi/pi-tui/overlays/settings-selector";
import type { Settings } from "../../config/settings";
import { createSettingsHost } from "../../config/settings-ui";
import {
	deleteConfigPath,
	draftModelRoles,
	getSetupGroupSettings,
	readConfigPath,
	setDraftGroup,
	writeConfigPath,
} from "../../profiles/setups";
import {
	PROFILE_EMOJIS,
	PROFILE_SETTINGS_GROUPS,
	type ProfileDraft,
	type ProfileEmoji,
	type ProfileSettingsGroup,
} from "../../profiles/types";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "../../task/settings";

const EMOJI_SLOT_WIDTH = 2;
const PORTABLE_SETTINGS_NOTICE =
	"Portable settings only; credentials, endpoints and machine paths stay local. Service availability unverified.";

type ProfileEditorSectionItem = SettingsSelectorSection["items"][number];

function cleanImportedLine(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? "")))
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
export type ProfileEditorRuntimeContext = Partial<Omit<SettingsRuntimeContext, "settings" | "plugins">>;

export interface ProfileEmojiPickerOptions {
	value?: ProfileEmoji;
	name?: string;
	terminalHeight?: number;
	/** The choice is committed to the saved profile as soon as it is made. */
	saveImmediately?: boolean;
	onSelect(value: ProfileEmoji | undefined): void;
	onCancel(): void;
	requestRender(): void;
}

/** Curated emoji picker. It never accepts arbitrary Unicode input. */
export class ProfileEmojiPicker implements Component {
	readonly #list: SelectList;
	readonly #options: ProfileEmojiPickerOptions;
	#selectedValue: string;
	#error: string | undefined;
	#contentStart = 2;

	constructor(options: ProfileEmojiPickerOptions) {
		this.#options = options;
		const items: SelectItem[] = [
			{ value: "", label: "None", description: "Remove the profile emoji" },
			// Labels lead: terminals with older emoji-width tables can disagree
			// with Bun about a glyph's cell count, which must not shift the label.
			...PROFILE_EMOJIS.map(item => ({ value: item.emoji, label: `${item.label}  ${item.emoji}` })),
		];
		this.#list = new SelectList(items, Math.min(items.length, 14), getSelectListTheme(), { search: "never" });
		this.#selectedValue = options.value ?? "";
		this.#list.setSelectedValue(this.#selectedValue);
		this.#list.onSelectionChange = item => {
			this.#selectedValue = item.value;
			this.#error = undefined;
			this.#options.requestRender();
		};
		this.#list.onSelect = item => this.#options.onSelect(item.value ? (item.value as ProfileEmoji) : undefined);
		this.#list.onCancel = this.#options.onCancel;
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	setError(error: string): void {
		this.#error = error;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, this.#options.terminalHeight ?? process.stdout.rows ?? 24);
		const innerWidth = Math.max(1, width - 4);
		// Chrome: top border, notice, [error], divider, preview, bottom border. The
		// frame fills the terminal so bottom-anchored pointer rows line up.
		const contentRows = Math.max(1, height - 5 - (this.#error ? 1 : 0));
		this.#list.setMaxVisible(contentRows);
		const listLines = this.#list.render(innerWidth);
		const selected = PROFILE_EMOJIS.find(item => item.emoji === this.#selectedValue);
		const previewEmoji = selected?.emoji ?? padding(EMOJI_SLOT_WIDTH);
		const previewName = cleanImportedLine(this.#options.name ?? "Profile");
		const preview = `${previewEmoji}${padding(Math.max(0, EMOJI_SLOT_WIDTH - visibleWidth(previewEmoji)))}  ${
			previewName || "Profile"
		} · ${selected?.label ?? "No emoji"}`;
		const notice = this.#options.saveImmediately
			? "Choosing saves this profile emoji immediately"
			: "Curated labels only";
		const lines = [topBorder(width, "Profile emoji"), row(theme.fg("dim", notice), width)];
		if (this.#error) lines.push(row(theme.fg("error", `${theme.status.error} ${this.#error}`), width));
		this.#contentStart = lines.length;
		for (let index = 0; index < contentRows; index++) lines.push(row(listLines[index] ?? "", width));
		lines.push(divider(width));
		const action = this.#options.saveImmediately
			? "Enter to save · Esc to cancel"
			: "Enter to choose · Esc to cancel";
		lines.push(row(`Preview  ${preview}  ${theme.fg("dim", action)}`, width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) routeSelectListMouse(this.#list, event, event.row - this.#contentStart);
			return;
		}
		this.#list.handleInput(data);
	}
}

export interface ProfileEditorCallbacks {
	requestRender(): void;
	onEditRole(role: string, draft: ProfileDraft): Promise<ProfileDraft | undefined>;
	onSave(draft: ProfileDraft, saveAsNew: boolean): void | Promise<void>;
	/** Edit the draft's agents in the agents hub, opened on `initialAgent`. Resolves the edited draft, or undefined. */
	onEditAgents(draft: ProfileDraft, initialAgent?: string): Promise<ProfileDraft | undefined>;
	onCancel(): void;
	/**
	 * Commit only the emoji of an existing saved profile. Resolves true once
	 * written, false when the editor closed first. Omitted for drafts, whose
	 * emoji saves with the rest of the draft.
	 */
	onSaveEmoji?(value: ProfileEmoji | undefined): Promise<boolean>;
	/** Per-role warnings for `draft`, e.g. a model that is not available here. Re-read after each change. */
	roleWarnings?(draft: ProfileDraft): ReadonlyMap<string, string>;
}

export interface ProfileEditorOptions {
	draft: ProfileDraft;
	effectiveSettings: Settings;
	/** Base/workspace/CLI settings without the selected profile overlay. */
	inheritedSettings?: Settings;
	/** Leads the editor's banner, e.g. entries skipped while importing. */
	notice?: string;
	name?: string;
	title?: string;
	saveLabel?: string;
	agentNames?: readonly string[];
	allowSaveAsNew?: boolean;
	initialGroup?: ProfileSettingsGroup;
	settingsContext?: ProfileEditorRuntimeContext;
	terminalHeight?: number;
	callbacks: ProfileEditorCallbacks;
}

function draftAgents(
	draft: ProfileDraft,
	availableNames: readonly string[],
): Array<{ name: string; disabled: boolean; selector: string | string[] | null | undefined }> {
	const task = draft.config.task;
	const value = task && typeof task === "object" && !Array.isArray(task) ? (task as Record<string, unknown>) : {};
	const disabled = Array.isArray(value.disabledAgents)
		? value.disabledAgents.filter((name): name is string => typeof name === "string")
		: [];
	const overrides =
		value.agentModelOverrides &&
		typeof value.agentModelOverrides === "object" &&
		!Array.isArray(value.agentModelOverrides)
			? (value.agentModelOverrides as Record<string, unknown>)
			: {};
	const names = new Set([...availableNames, ...disabled, ...Object.keys(overrides)]);
	return [...names]
		.sort((a, b) => a.localeCompare(b))
		.map(name => {
			const selector = overrides[name];
			return {
				name,
				disabled: disabled.includes(name),
				selector:
					selector === null || typeof selector === "string" || Array.isArray(selector)
						? (selector as string | string[] | null)
						: undefined,
			};
		});
}

/** Isolated editor for a setup draft; nothing it changes affects the running session. */
export class ProfileEditorComponent implements Component {
	#draft: ProfileDraft;
	readonly #inheritedSettings: Settings;
	readonly #terminalHeight: number | undefined;
	readonly #name: string | undefined;
	readonly #saveLabel: string;
	readonly #allowSaveAsNew: boolean;
	readonly #agentNames: readonly string[];
	readonly #callbacks: ProfileEditorCallbacks;
	readonly #settingsHost: SettingsHost;
	readonly #selector: SettingsSelectorComponent;

	#nested: Component | undefined;
	#selectedId: string | undefined = "emoji";
	#pendingDisable: ProfileSettingsGroup | undefined;
	#busy = false;
	#error: string | undefined;

	constructor(options: ProfileEditorOptions) {
		this.#draft = structuredClone(options.draft);
		this.#inheritedSettings = options.inheritedSettings ?? options.effectiveSettings;
		this.#name = options.name;
		this.#saveLabel = options.saveLabel ?? "Save";
		this.#allowSaveAsNew = options.allowSaveAsNew ?? true;
		this.#agentNames = [...(options.agentNames ?? [])];
		this.#terminalHeight = options.terminalHeight;
		this.#callbacks = options.callbacks;

		const eligible = new Set<string>();
		for (const group of PROFILE_SETTINGS_GROUPS) {
			for (const setting of getSetupGroupSettings(group.id)) eligible.add(setting.id);
		}
		const fullHost = createSettingsHost({
			source: {
				get: setting => {
					const configured = readConfigPath(this.#draft.config, setting.segments);
					return configured.present ? configured.value : setting.layered(this.#inheritedSettings);
				},
				set: (setting, value) => writeConfigPath(this.#draft.config, setting.segments, structuredClone(value)),
				unset: setting => deleteConfigPath(this.#draft.config, setting.segments),
			},
		});
		this.#settingsHost = {
			...fullHost,
			entries: fullHost.entries.filter(entry => eligible.has(entry.path)),
		};
		const runtime: SettingsRuntimeContext = {
			settings: this.#settingsHost,
			availableThinkingLevels: options.settingsContext?.availableThinkingLevels ?? [],
			thinkingLevel: options.settingsContext?.thinkingLevel,
			availableThemes: options.settingsContext?.availableThemes ?? [],
			providers: options.settingsContext?.providers ?? [],
			model: options.settingsContext?.model,
			imageBudget: options.settingsContext?.imageBudget,
			composerPreviewStatus: options.settingsContext?.composerPreviewStatus,
			requestRender: this.#callbacks.requestRender,
		};
		const draftNotice = this.#callbacks.onSaveEmoji
			? "Emoji choices save immediately; other changes remain draft-only."
			: "Draft only; changes do not affect the active session.";
		this.#selector = new SettingsSelectorComponent(
			runtime,
			{
				onChange: () => {
					this.#error = undefined;
					this.#callbacks.requestRender();
				},
				onSave: () => {
					void this.#save(false);
				},
				onSelectionChange: id => {
					if (id !== this.#selectedId) this.#pendingDisable = undefined;
					this.#selectedId = id;
					this.#callbacks.requestRender();
				},
				onCancel: this.#callbacks.onCancel,
			},
			{
				includePlugins: false,
				title: options.title ?? "Edit profile",
				terminalHeight: this.#terminalHeight,
				notice: [options.notice, draftNotice, PORTABLE_SETTINGS_NOTICE].filter(Boolean).join(" "),
				sections: () => this.#buildSections(),
			},
		);
		if (options.initialGroup) this.#selector.selectItem(`group:${options.initialGroup}`);
	}

	get draft(): ProfileDraft {
		return structuredClone(this.#draft);
	}

	invalidate(): void {
		this.#selector.invalidate();
		this.#nested?.invalidate?.();
	}

	render(width: number): readonly string[] {
		return (this.#nested ?? this.#selector).render(width);
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (this.#nested) {
			this.#nested.handleInput?.(data);
			return;
		}
		this.#selector.handleInput(data);
	}

	#buildSections(): SettingsSelectorSection[] {
		const emoji = this.#draft.metadata.emoji;
		const emojiLabel = PROFILE_EMOJIS.find(item => item.emoji === emoji)?.label ?? "None";
		const sections: SettingsSelectorSection[] = [
			{
				id: "profile",
				label: "Profile",
				items: [
					{
						id: "emoji",
						label: "Emoji",
						currentValue: emoji ? `${emoji} ${emojiLabel}` : emojiLabel,
						description: this.#callbacks.onSaveEmoji
							? "Choose a curated emoji. This profile metadata change saves immediately."
							: "Choose a curated emoji for this profile draft.",
						onActivate: () => this.#openEmojiPicker(),
					},
				],
			},
		];
		const availablePaths = new Set(this.#settingsHost.entries.map(entry => entry.path));

		for (const group of PROFILE_SETTINGS_GROUPS) {
			const enabled = this.#draft.metadata.enabledGroups.includes(group.id);
			const groupSettings = getSetupGroupSettings(group.id);
			const configuredCount = groupSettings.filter(
				setting => readConfigPath(this.#draft.config, setting.segments).present,
			).length;
			const items: ProfileEditorSectionItem[] = [];
			if (group.id === "model") {
				const warnings = this.#callbacks.roleWarnings?.(this.#draft);
				for (const [role, selector] of Object.entries(draftModelRoles(this.#draft))) {
					const warning = warnings?.get(role);
					items.push({
						id: `role:${role}`,
						label: `Model role · ${cleanImportedLine(role)}`,
						currentValue: selector === null ? "Automatic" : cleanImportedLine(selector),
						description: "Edit this model role in the isolated profile draft.",
						// Resolver warnings quote the imported selector verbatim.
						warning: warning === undefined ? undefined : cleanImportedLine(warning),
						onActivate: () => {
							void this.#editRole(role);
						},
					});
				}
			}
			items.push({
				id: `group:${group.id}`,
				label: `${group.label} inclusion`,
				currentValue: enabled ? "ON" : "OFF",
				description: enabled
					? `${group.description}. ${configuredCount} saved value${configuredCount === 1 ? "" : "s"}.`
					: `${group.description}. Uses inherited local configuration until included.`,
				warning:
					this.#pendingDisable === group.id
						? "Disabling removes saved values. Press Enter again to confirm."
						: undefined,
				onActivate: () => this.#toggleSelectedGroup(group.id),
			});
			for (const { id } of groupSettings) {
				if (!availablePaths.has(id)) continue;
				items.push({
					setting: id,
					disabled: !enabled,
					descriptionSuffix: enabled
						? undefined
						: "Inherited from local configuration. Include this group to edit.",
				});
			}
			if (group.id === "tasks") {
				for (const agent of this.#draftAgentsForDisplay(enabled)) {
					const selector = Array.isArray(agent.selector)
						? agent.selector.map(cleanImportedLine).join(" → ")
						: agent.selector === null
							? "Automatic"
							: agent.selector === undefined
								? "No model override"
								: cleanImportedLine(agent.selector);
					items.push({
						id: `agent:${agent.name}`,
						label: `Agent · ${cleanImportedLine(agent.name)}`,
						currentValue: `${agent.disabled ? "Disabled" : "Enabled"} · ${selector}`,
						description: enabled
							? "Enter opens the agents hub on this draft to change models or availability."
							: "Inherited from local configuration. Include Agents & tasks to edit.",
						disabled: !enabled,
						onActivate: () => {
							void this.#editAgents(agent.name);
						},
					});
				}
			}
			sections.push({ id: group.id, label: group.label, items });
		}

		const actionItems: SettingItem[] = [];
		if (this.#error) {
			actionItems.push({
				id: "editor:error",
				label: "Last action failed",
				currentValue: "",
				description: this.#error,
				warning: this.#error,
				disabled: true,
			});
		}
		actionItems.push({
			id: "save",
			label: this.#saveLabel,
			currentValue: this.#busy ? "Working…" : "",
			description:
				this.#saveLabel === "Save" ? "Update this profile without activating it." : "Continue with this draft.",
			onActivate: () => {
				void this.#save(false);
			},
		});
		if (this.#allowSaveAsNew) {
			actionItems.push({
				id: "save-as-new",
				label: "Save as new",
				currentValue: "",
				description: "Create another profile without activating it.",
				onActivate: () => {
					void this.#save(true);
				},
			});
		}
		actionItems.push({
			id: "cancel",
			label: "Cancel",
			currentValue: "",
			description: "Discard this draft.",
			onActivate: this.#callbacks.onCancel,
		});
		sections.push({ id: "actions", label: "Actions", items: actionItems });
		return sections;
	}

	#draftAgentsForDisplay(enabled: boolean): Array<{
		name: string;
		disabled: boolean;
		selector: string | string[] | null | undefined;
	}> {
		if (enabled) return draftAgents(this.#draft, this.#agentNames);
		const inherited: ProfileDraft = {
			metadata: { version: 1, enabledGroups: [] },
			config: {
				task: {
					disabledAgents: structuredClone(cfgTaskDisabledAgents.get(this.#inheritedSettings)),
					agentModelOverrides: structuredClone(cfgTaskAgentModelOverrides.get(this.#inheritedSettings)),
				},
			},
		};
		return draftAgents(inherited, this.#agentNames);
	}

	#refresh(): void {
		this.#selector.refreshItems();
		this.#callbacks.requestRender();
	}

	#toggleSelectedGroup(group: ProfileSettingsGroup): void {
		const enabled = this.#draft.metadata.enabledGroups.includes(group);
		if (enabled && this.#pendingDisable !== group) {
			this.#pendingDisable = group;
			this.#refresh();
			return;
		}
		try {
			this.#draft = setDraftGroup(this.#draft, group, !enabled, this.#inheritedSettings);
			this.#pendingDisable = undefined;
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to change profile group");
		}
		if (this.#error) this.#selector.clearSearch();
		this.#refresh();
		if (this.#error) this.#selector.selectItem("editor:error");
	}

	#openEmojiPicker(): void {
		const picker = new ProfileEmojiPicker({
			name: this.#name,
			value: this.#draft.metadata.emoji,
			terminalHeight: this.#terminalHeight,
			saveImmediately: this.#callbacks.onSaveEmoji !== undefined,
			requestRender: this.#callbacks.requestRender,
			onSelect: value => {
				if (this.#callbacks.onSaveEmoji) {
					void this.#saveEmoji(this.#callbacks.onSaveEmoji, value, picker);
					return;
				}
				this.#setEmoji(value);
				this.#showMain();
			},
			onCancel: () => this.#showMain(),
		});
		this.#nested = picker;
		this.#callbacks.requestRender();
	}

	#setEmoji(value: ProfileEmoji | undefined): void {
		this.#draft = {
			...this.#draft,
			metadata: { ...this.#draft.metadata, emoji: value },
		};
		this.#error = undefined;
	}

	/** Commit the emoji alone; a failed write stays in the picker so the choice can be retried. */
	async #saveEmoji(
		saveEmoji: (value: ProfileEmoji | undefined) => Promise<boolean>,
		value: ProfileEmoji | undefined,
		picker: ProfileEmojiPicker,
	): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			if (!(await saveEmoji(value))) return;
			this.#setEmoji(value);
			this.#showMain();
		} catch (error) {
			picker.setError(cleanImportedLine(error instanceof Error ? error.message : error) || "Unable to save emoji");
			this.#callbacks.requestRender();
		} finally {
			this.#busy = false;
			if (!this.#nested) this.#refresh();
		}
	}

	async #editRole(role: string): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const next = await this.#callbacks.onEditRole(role, structuredClone(this.#draft));
			// An unchanged or cancelled pick returns to the editor with the draft intact.
			if (!next) return;
			this.#draft = structuredClone(next);
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to edit model role");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	async #editAgents(agent: string): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const next = await this.#callbacks.onEditAgents(structuredClone(this.#draft), agent);
			if (!next) return;
			this.#draft = structuredClone(next);
			this.#error = undefined;
		} catch (error) {
			this.#setError(error, "Unable to edit agent");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	async #save(saveAsNew: boolean): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#error = undefined;
		this.#refresh();
		try {
			await this.#callbacks.onSave(structuredClone(this.#draft), saveAsNew);
		} catch (error) {
			this.#setError(error, "Unable to save profile");
		} finally {
			this.#busy = false;
			if (this.#error) this.#selector.clearSearch();
			this.#refresh();
			if (this.#error) this.#selector.selectItem("editor:error");
		}
	}

	#setError(error: unknown, fallback: string): void {
		const message = cleanImportedLine(error instanceof Error ? error.message : error);
		this.#error = message || fallback;
	}

	#showMain(): void {
		this.#nested = undefined;
		this.#refresh();
	}
}
