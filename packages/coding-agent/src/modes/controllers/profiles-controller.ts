import * as path from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { type Component, type OverlayHandle, Text } from "@oh-my-pi/pi-tui";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { replaceTabs, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAvailableThemes, theme } from "@oh-my-pi/pi-tui/theme";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { getProjectDir, isRecord, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { orderedSettings } from "../../config/all-settings";
import { cfgModelRoles, cfgModelRoleStorage } from "../../config/model-settings";
import { resolveModelRoleValue } from "../../config/model-resolver";
import type { AnySetting } from "../../config/registry";
import { type RawSettings, Settings } from "../../config/settings";
import { applySetupModelRoles } from "../../profiles/apply-model-roles";
import {
	createSetupDraft,
	deleteSavedSetup,
	draftModelRoles,
	type ImportedProfile,
	listSavedSetups,
	loadSavedSetup,
	modelsOnlyDraft,
	parseProfileText,
	readConfigPath,
	readProfileFile,
	renameSavedSetup,
	type SavedSetupDescriptor,
	SetupError,
	safetySensitiveSettings,
	saveSetup,
	serializeSetup,
	setSavedSetupEmoji,
	shareableDraft,
	writeProfileFile,
} from "../../profiles/setups";
import { buildProfileSnapshot, projectProfileRoles } from "../../profiles/snapshot";
import type { ProfileDraft, ProfileEmoji, ProfileSnapshot } from "../../profiles/types";
import {
	ProfileDashboard,
	type ProfileDashboardActiveControl,
	type ProfileDashboardActiveProfile,
	type ProfileDashboardSavedSetupRef,
	type ProfileDashboardSetupRef,
} from "../components/profile-dashboard";
import { ProfileEditorComponent } from "../components/profile-editor";
import { createAgentsHubDeps } from "../agents-hub-deps";
import { resolveRoleModelFull } from "../../session/role-models";
import { cfgDefaultThinkingLevel } from "../../session/settings";
import { cfgTaskDisabledAgents } from "../../task/settings";
import { createModelBrowserSource } from "../model-browser-source";
import { resolveToCwd } from "../../tools/path-utils";
import { copyToClipboard, readTextFromClipboard } from "../../utils/clipboard";
import type { InteractiveModeContext } from "../types";
import type { AgentsDashboardHostOptions, ModelHubHostOptions } from "./selector-controller";

/** Selector-controller capabilities the Profiles tab reuses instead of duplicating. */
export interface ProfilesHost {
	showFullscreenMenu(component: Component): OverlayHandle;
	showModelHub(options: ModelHubHostOptions): () => void;
	showAgentsDashboard(options: AgentsDashboardHostOptions): Promise<() => void>;
	acquireDefaultRoleMutation(): Promise<() => void>;
}

interface Notice {
	message: string;
	tone: "error" | "success";
}

const CURRENT_SETUP: ProfileDashboardSetupRef = { kind: "current" };
const APPLY_MODELS_CHOICE = "Apply models to this conversation";
const NEW_SESSION_CHOICE = "Start a new session";
const FROM_FILE = "From file";
const FROM_CLIPBOARD = "From clipboard";
const WHOLE_PROFILE = "Whole profile";
const MODELS_ONLY = "Models only";
const TO_FILE = "Save to file";
const TO_CLIPBOARD = "Copy to clipboard";
const REVIEW_IMPORT = "Yes, review it first";
const SAVE_IMPORT = "No, save it now";

interface EditorOptions {
	/** Entries the saved file holds that this version could not load; an overwrite drops them. */
	skipped?: readonly string[];
	title?: string;
	name?: string;
	notice?: string;
}

function skippedSummary(warnings: readonly string[]): string {
	return `${warnings.length} entr${warnings.length === 1 ? "y" : "ies"} this version of omp cannot load: ${cleanText(warnings[0])}`;
}

function setupKey(setup: ProfileDashboardSetupRef): string {
	return setup.kind === "current" ? "current" : `saved\0${setup.name}`;
}

function cleanText(value: unknown, max?: number): string {
	const sanitized = replaceTabs(sanitizeText(String(value ?? "")));
	return oneLineLabel(sanitized, max ?? (sanitized.length || 1));
}

/**
 * Safety settings by their Settings-menu labels, e.g. "1 safety setting: Tool Approval".
 * With `config`, each label also shows the value `config` sets.
 */
function safetySettingsText(settings: readonly AnySetting[], config?: RawSettings): string {
	const entries = settings.map(setting => {
		const label = cleanText(setting.ui?.label ?? setting.id);
		if (!config) return label;
		const { value } = readConfigPath(config, setting.segments);
		return `${label} = ${cleanText(typeof value === "string" ? value : JSON.stringify(value), TRUNCATE_LENGTHS.TITLE)}`;
	});
	return `${settings.length} safety setting${settings.length === 1 ? "" : "s"}: ${entries.join(", ")}`;
}

/** Whether a setup layer node still sets anything, counting a `null` role that masks a configured one. */
function setsAnything(value: unknown): boolean {
	return isRecord(value) ? Object.values(value).some(setsAnything) : value !== undefined;
}

/** The model and thinking a session takes from the default role under some settings. */
interface DefaultSelection {
	/** The configured default role; `undefined` is Automatic, which keeps the session's model. */
	selector: string | undefined;
	/** `undefined` when the role selects no model this session can use. */
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/** Whether two selections put the session on the same model and thinking; unusable ones compare by selector. */
function selectionsEqual(left: DefaultSelection, right: DefaultSelection): boolean {
	const sameModel =
		left.model || right.model ? modelsAreEqual(left.model, right.model) : left.selector === right.selector;
	return sameModel && left.thinkingLevel === right.thinkingLevel;
}

/** "profile focus", or "profiles focus and fast" when settings and models came from different profiles. */
function loadedProfileLabel(active: ProfileDashboardActiveProfile): string {
	const names = [...new Set([active.settings, active.models])]
		.filter((name): name is string => name !== undefined)
		.map(name => cleanText(name));
	return names.length === 0 ? "the loaded profile" : `profile${names.length === 1 ? "" : "s"} ${names.join(" and ")}`;
}

function errorText(error: unknown, fallback: string): string {
	return cleanText(error instanceof Error ? error.message : fallback);
}

function listFailureText(error: unknown): string {
	return `Unable to list saved profiles: ${errorText(error, "unknown error")}`;
}

/**
 * The Profiles tab inside Settings: lists saved setups, previews what each one
 * resolves to, and edits, saves, renames, deletes, or loads them. Previews are
 * built in process from read-only settings, so selecting a setup never changes
 * the running session; only an explicit load does.
 */
export class ProfilesController {
	#dashboard: ProfileDashboard | undefined;
	#selector: SettingsSelectorComponent | undefined;
	#overlay: OverlayHandle | undefined;
	#closeSettings: (() => void) | undefined;
	#descriptors: SavedSetupDescriptor[] = [];
	readonly #snapshots = new Map<string, ProfileSnapshot>();
	readonly #previews = new Map<string, Promise<void>>();
	/** Bumped whenever cached previews go stale; in-flight builds from an older generation are dropped. */
	#generation = 0;
	#busy = false;
	#dialogs = new AbortController();
	#closeChild: (() => void) | undefined;
	/** This session's usage reports, once fetched for the current mount. */
	#usage: UsageReport[] | undefined;
	/** Profiles imported during this run of omp, marked "(New)". Kept across Settings mounts. */
	readonly #imported = new Set<string>();
	/**
	 * Names of the profiles this run loaded: the one whose settings the session's
	 * setup layer holds and the one whose model roles it holds. Kept across
	 * Settings mounts; shown only while the layer still sets that part.
	 */
	#loaded: ProfileDashboardActiveProfile = {};

	constructor(
		private readonly ctx: InteractiveModeContext,
		private readonly host: ProfilesHost,
	) {}

	/** Show the Profiles tab in `selector`, or rediscover setups when it is already shown there. */
	async mount(selector: SettingsSelectorComponent, overlay: OverlayHandle, closeSettings: () => void): Promise<void> {
		if (this.#dashboard && this.#selector === selector) {
			const dashboard = this.#dashboard;
			if (this.#busy) return;
			// Settings starts this without awaiting it, where a rejection ends omp.
			try {
				await this.#refresh(dashboard.selectedSetup);
			} catch (error) {
				logger.warn("Failed to list saved setups", { error: String(error) });
				if (this.#dashboard !== dashboard) return;
				dashboard.setActionNotice(listFailureText(error), "error");
				this.ctx.ui.requestRender();
			}
			return;
		}
		this.close();
		this.#selector = selector;
		this.#overlay = overlay;
		this.#closeSettings = closeSettings;
		this.#dialogs = new AbortController();
		let descriptors: SavedSetupDescriptor[];
		try {
			descriptors = await listSavedSetups(this.ctx.settings.getAgentDir());
		} catch (error) {
			logger.warn("Failed to list saved setups", { error: String(error) });
			if (this.#selector === selector) {
				selector.setProfilesContent(new Text(theme.fg("error", listFailureText(error)), 1, 0));
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (this.#selector !== selector) return;
		this.#descriptors = descriptors;
		const dashboard = new ProfileDashboard({
			setups: this.#setupRefs(),
			terminalHeight: this.ctx.ui.terminal.rows,
			callbacks: {
				requestRender: () => {
					if (this.#dashboard === dashboard) this.ctx.ui.requestRender();
				},
				close: () => this.#closeSettings?.(),
				selected: setup => {
					if (!this.#busy) void this.#preview(setup);
				},
				loadSetup: setup => this.#loadSetup(setup),
				editProfile: setup => this.#editSetup(setup),
				saveCurrentSetup: () => this.#editSetup(CURRENT_SETUP),
				importProfile: () => this.#importProfile(),
				exportProfile: setup => this.#exportProfile(setup),
				deleteSetup: setup => this.#deleteSetup(setup),
				renameSetup: setup => this.#renameSetup(setup),
				openActiveControl: control => this.#openActiveControl(control),
				unloadProfile: () => this.#unloadProfile(),
			},
		});
		this.#dashboard = dashboard;
		dashboard.setActiveProfile(this.#activeProfile());
		selector.setProfilesContent(dashboard);
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
		void this.#loadUsage(dashboard);
		await this.#preview(dashboard.selectedSetup ?? CURRENT_SETUP);
	}

	/** Abort dialogs and previews and close child overlays. The Settings overlay itself is closed by its owner. */
	close(): void {
		this.#generation++;
		this.#dialogs.abort();
		this.#closeChild?.();
		this.#closeChild = undefined;
		this.#dashboard?.dispose();
		this.#dashboard = undefined;
		this.#selector = undefined;
		this.#overlay = undefined;
		this.#closeSettings = undefined;
		this.#snapshots.clear();
		this.#previews.clear();
		this.#usage = undefined;
		this.#busy = false;
	}

	#setupRefs(): ProfileDashboardSetupRef[] {
		return [
			CURRENT_SETUP,
			...this.#descriptors.map(item => ({
				kind: "saved" as const,
				name: item.name,
				metadata: item.metadata,
				...(this.#imported.has(item.name) ? { imported: true } : {}),
			})),
		];
	}

	#agentDir(): string {
		return this.ctx.settings.getAgentDir();
	}

	/** Rediscover saved setups and rebuild previews, keeping `selected` when it still exists. */
	async #refresh(selected?: ProfileDashboardSetupRef): Promise<void> {
		const dashboard = this.#dashboard;
		if (!dashboard) return;
		const descriptors = await listSavedSetups(this.#agentDir());
		if (this.#dashboard !== dashboard) return;
		this.#descriptors = descriptors;
		this.#generation++;
		this.#snapshots.clear();
		this.#previews.clear();
		dashboard.setSetups(this.#setupRefs(), selected);
		dashboard.setActiveProfile(this.#activeProfile());
		await this.#preview(dashboard.selectedSetup ?? CURRENT_SETUP);
	}

	/** Which loaded profiles the setup layer still applies; undefined when it sets nothing. */
	#activeProfile(): ProfileDashboardActiveProfile | undefined {
		const { modelRoles, ...rest } = this.ctx.settings.getSetupLayer();
		const models = setsAnything(modelRoles);
		const settings = setsAnything(rest);
		if (!models && !settings) return undefined;
		return {
			settings: settings ? this.#loaded.settings : undefined,
			models: models ? this.#loaded.models : undefined,
		};
	}

	#preview(setup: ProfileDashboardSetupRef): Promise<void> {
		const key = setupKey(setup);
		const dashboard = this.#dashboard;
		if (!dashboard || this.#snapshots.has(key)) return Promise.resolve();
		const pending = this.#previews.get(key);
		if (pending) return pending;
		const generation = this.#generation;
		const unreadable =
			setup.kind === "saved" ? this.#descriptors.find(item => item.name === setup.name)?.error : undefined;
		if (unreadable) {
			dashboard.setSetupState(setup, { loading: false, error: cleanText(unreadable) });
			return Promise.resolve();
		}
		dashboard.setSetupState(setup, { loading: true });
		const run = this.#buildSnapshot(setup).then(
			snapshot => {
				if (generation !== this.#generation || this.#dashboard !== dashboard) return;
				this.#snapshots.set(key, snapshot);
				dashboard.setSetupState(setup, { snapshot, loading: false, usage: this.#usage });
			},
			(error: unknown) => {
				if (generation !== this.#generation || this.#dashboard !== dashboard) return;
				logger.warn("Failed to preview setup", { setup: key, error: String(error) });
				dashboard.setSetupState(setup, {
					loading: false,
					error: errorText(error, "Unable to preview this profile"),
				});
			},
		);
		this.#previews.set(key, run);
		return run.finally(() => {
			if (this.#previews.get(key) === run) this.#previews.delete(key);
		});
	}

	/**
	 * Fetch this session's account usage once per mount, the same reports `/usage`
	 * shows, and attach them to every preview; each overview shows the providers
	 * its profile uses. A failure or an empty result leaves the section out, as
	 * `/usage` does.
	 */
	async #loadUsage(dashboard: ProfileDashboard): Promise<void> {
		const { session } = this.ctx;
		let reports: UsageReport[] | null;
		try {
			reports = await session.fetchUsageReports(this.#dialogs.signal);
		} catch (error) {
			if (!this.#dialogs.signal.aborted) logger.warn("Failed to fetch usage for Profiles", { error: String(error) });
			return;
		}
		if (this.#dashboard !== dashboard || !reports || reports.length === 0) return;
		this.#usage = reports;
		for (const setup of this.#setupRefs()) {
			const snapshot = this.#snapshots.get(setupKey(setup));
			if (snapshot) dashboard.setSetupState(setup, { snapshot, loading: false, usage: reports });
		}
	}

	async #buildSnapshot(setup: ProfileDashboardSetupRef): Promise<ProfileSnapshot> {
		const { session, sessionManager } = this.ctx;
		const cwd = sessionManager.getCwd();
		if (setup.kind === "current") {
			return buildProfileSnapshot({
				cwd,
				settings: this.ctx.settings,
				modelRegistry: session.modelRegistry,
				currentModel: session.model ?? undefined,
				currentThinkingLevel: session.configuredThinkingLevel(),
			});
		}
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const snapshot = await buildProfileSnapshot({
			cwd,
			settings: this.ctx.settings.previewSetup(loaded.config),
			modelRegistry: session.modelRegistry,
		});
		snapshot.warnings.push(...loaded.warnings);
		return snapshot;
	}

	/** Run one modal flow with the Settings overlay hidden; at most one runs at a time. */
	async #interaction(run: () => Promise<Notice | undefined>): Promise<void> {
		const dashboard = this.#dashboard;
		if (!dashboard || this.#busy) return;
		this.#busy = true;
		this.#overlay?.setHidden(true);
		let notice: Notice | undefined;
		try {
			notice = await run();
		} catch (error) {
			if (!this.#dialogs.signal.aborted) {
				logger.warn("Profiles action failed", { error: String(error) });
				notice = { message: errorText(error, "The Profiles action failed"), tone: "error" };
			}
		} finally {
			this.#busy = false;
			if (this.#dashboard === dashboard) {
				this.#overlay?.setHidden(false);
				if (this.#selector) this.ctx.ui.setFocus(this.#selector);
				if (notice) dashboard.setActionNotice(notice.message, notice.tone);
				this.ctx.ui.requestRender();
			}
		}
	}

	#currentDraft(): ProfileDraft {
		const model = this.ctx.session.model;
		return createSetupDraft(
			this.ctx.settings,
			model
				? { provider: model.provider, id: model.id, thinkingLevel: this.ctx.session.configuredThinkingLevel() }
				: undefined,
		);
	}

	#editSetup(setup: ProfileDashboardSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const loaded = setup.kind === "saved" ? await loadSavedSetup(setup.name, this.#agentDir()) : undefined;
			const draft = loaded ?? this.#currentDraft();
			const saved = await this.#openEditor(
				setup,
				{ metadata: draft.metadata, config: draft.config },
				{ skipped: loaded?.warnings },
			);
			if (saved === undefined) return undefined;
			await this.#refresh({ kind: "saved", name: saved });
			return { message: `Saved profile ${cleanText(saved)}. Load it to use it.`, tone: "success" };
		});
	}

	/**
	 * Save an edited draft, prompting for a name when it is new. Resolves the
	 * saved name, or undefined when cancelled. `skipped` lists entries the
	 * existing file holds that this version could not load; overwriting drops them.
	 */
	async #saveDraft(
		setup: ProfileDashboardSetupRef,
		draft: ProfileDraft,
		saveAsNew: boolean,
		skipped: readonly string[],
	): Promise<string | undefined> {
		const signal = this.#dialogs.signal;
		if (setup.kind === "saved" && !saveAsNew) {
			const drops = skipped.length > 0 ? `\nSaving also drops ${skippedSummary(skipped)}` : "";
			const confirmed = await this.ctx.showHookConfirm(
				`Save changes to ${cleanText(setup.name)}?`,
				`This replaces the saved profile only. The current session does not change.${drops}`,
				{ signal },
			);
			if (!confirmed) return undefined;
			await saveSetup(setup.name, draft, { agentDir: this.#agentDir(), overwrite: true });
			return setup.name;
		}
		let prompt = "Save profile as";
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, "Profile name", { signal });
			if (input === undefined) return undefined;
			try {
				return (await saveSetup(input, draft, { agentDir: this.#agentDir() })).name;
			} catch (error) {
				if (!(error instanceof SetupError) || (error.kind !== "invalid-name" && error.kind !== "exists"))
					throw error;
				prompt = `${cleanText(error.message)}\nSave profile as`;
			}
		}
	}

	/** Commit one saved profile's emoji now; the rest of the open draft stays unsaved. */
	async #saveEmoji(name: string, emoji: ProfileEmoji | undefined, isClosed: () => boolean): Promise<boolean> {
		if (isClosed() || this.#dialogs.signal.aborted) return false;
		const saved = await setSavedSetupEmoji(name, emoji, this.#agentDir());
		this.#descriptors = this.#descriptors.map(item => (item.name === saved.name ? saved : item));
		this.#dashboard?.setSetups(this.#setupRefs(), { kind: "saved", name: saved.name });
		return !isClosed();
	}

	/** Open the isolated draft editor. Resolves the saved profile name, or undefined when the edit was cancelled. */
	async #openEditor(
		setup: ProfileDashboardSetupRef,
		draft: ProfileDraft,
		options: EditorOptions = {},
	): Promise<string | undefined> {
		const skipped = options.skipped ?? [];
		const effectiveSettings = this.#isolatedDraftSettings(draft);
		// A saved profile replaces any loaded one, so it inherits the configuration without the setup layer.
		const inherited = setup.kind === "saved" ? this.ctx.settings.previewSetup(undefined) : this.ctx.settings;
		const availableThemes = await getAvailableThemes();
		const models = this.ctx.session.modelRegistry.getAll();
		const draftModel = resolveModelRoleValue(effectiveSettings.getModelRole("default"), models, {
			settings: effectiveSettings,
		}).model;
		if (this.#dialogs.signal.aborted) return undefined;
		const result = Promise.withResolvers<string | undefined>();
		let finished = false;
		const finish = (name: string | undefined): void => {
			if (finished) return;
			finished = true;
			handle.hide();
			if (this.#closeChild === cancel) this.#closeChild = undefined;
			result.resolve(name);
		};
		const cancel = (): void => finish(undefined);
		const reveal = (): void => {
			if (finished) return;
			handle.setHidden(false);
			this.ctx.ui.setFocus(editor);
			this.ctx.ui.requestRender();
		};
		const editor = new ProfileEditorComponent({
			draft,
			effectiveSettings,
			inheritedSettings: inherited,
			name: options.name ?? (setup.kind === "saved" ? setup.name : "Current profile"),
			title: options.title ?? "Edit profile",
			notice: options.notice,
			saveLabel: "Save",
			allowSaveAsNew: setup.kind === "saved",
			terminalHeight: this.ctx.ui.terminal.rows,
			agentNames: this.#snapshots.get(setupKey(CURRENT_SETUP))?.agents.map(agent => agent.name) ?? [],
			settingsContext: {
				availableThinkingLevels: [...(draftModel ? getSupportedEfforts(draftModel) : THINKING_EFFORTS)],
				availableThemes,
				providers: [...new Set(models.map(model => model.provider))].sort((a, b) => a.localeCompare(b)),
				model: draftModel,
				imageBudget: this.ctx.ui.imageBudget,
				composerPreviewStatus: this.ctx.statusLine,
			},
			callbacks: {
				requestRender: () => {
					if (!finished) this.ctx.ui.requestRender();
				},
				onEditRole: async (role, value) => {
					handle.setHidden(true);
					try {
						return await this.#chooseRole(role, value);
					} finally {
						reveal();
					}
				},
				onEditAgents: async (value, agent) => {
					handle.setHidden(true);
					try {
						return await this.#editAgents(value, agent);
					} finally {
						reveal();
					}
				},
				onSave: async (value, saveAsNew) => {
					handle.setHidden(true);
					try {
						const name = await this.#saveDraft(setup, value, saveAsNew || setup.kind === "current", skipped);
						if (name !== undefined) finish(name);
					} finally {
						reveal();
					}
				},
				onCancel: cancel,
				onSaveEmoji:
					setup.kind === "saved" ? emoji => this.#saveEmoji(setup.name, emoji, () => finished) : undefined,
				roleWarnings: value => this.#roleWarnings(value),
			},
		});
		const handle = this.host.showFullscreenMenu(editor);
		this.#closeChild = cancel;
		return result.promise;
	}

	/** The preview's per-role warnings for `draft`, so the editor flags models that are not available here. */
	#roleWarnings(draft: ProfileDraft): ReadonlyMap<string, string> {
		const roles = draftModelRoles(draft);
		const rows = projectProfileRoles({
			cwd: this.ctx.sessionManager.getCwd(),
			settings: this.#isolatedDraftSettings(draft),
			modelRegistry: this.ctx.session.modelRegistry,
		});
		const warnings = new Map<string, string>();
		for (const row of rows) {
			if (row.warning && Object.hasOwn(roles, row.role)) warnings.set(row.role, row.warning);
		}
		return warnings;
	}

	/**
	 * Isolated settings describing `draft` on top of the effective configuration.
	 * Kept in one global scope: a profile is a single overlay, not a global/project pair.
	 */
	#isolatedDraftSettings(draft: ProfileDraft): Settings {
		const overrides: Record<string, unknown> = {};
		for (const setting of orderedSettings()) {
			const saved = readConfigPath(draft.config, setting.segments);
			overrides[setting.id] = saved.present ? saved.value : setting.get(this.ctx.settings);
		}
		overrides[cfgModelRoles.id] = { ...this.ctx.settings.getModelRoles(), ...draftModelRoles(draft) };
		overrides[cfgModelRoleStorage.id] = "global";
		return Settings.isolated(overrides, { storage: this.ctx.settings.getStorage() });
	}

	/** A model-hub source whose role lookups read `draft`; `focusRole` is tagged as the draft's. */
	#draftSource(draft: ProfileDraft, focusRole?: string): ModelHubSource {
		const roles = draftModelRoles(draft);
		const baseSource = createModelBrowserSource(this.#isolatedDraftSettings(draft));
		return {
			...baseSource,
			getModelRole: candidate =>
				Object.hasOwn(roles, candidate) ? (roles[candidate] ?? undefined) : baseSource.getModelRole(candidate),
			getRoleInfo: candidate => {
				const info = baseSource.getRoleInfo(candidate);
				if (candidate !== focusRole) return info;
				return { ...info, tag: `PROFILE DRAFT · ${info.tag ?? info.name ?? candidate}` };
			},
		};
	}

	/** Pick a model for one draft role in the focused model hub. Resolves the changed draft, or undefined. */
	async #chooseRole(role: string, draft: ProfileDraft): Promise<ProfileDraft | undefined> {
		if (this.#dialogs.signal.aborted) return undefined;
		const staged = structuredClone(draft);
		const roles = draftModelRoles(staged);
		staged.config.modelRoles = roles;
		const result = Promise.withResolvers<ProfileDraft | undefined>();
		let changed = false;
		let finished = false;
		const close = this.host.showModelHub({
			initialAssignRole: role,
			source: this.#draftSource(staged, role),
			roleCallbacks: {
				onAssign: (model, assignedRole, thinkingLevel, selector) => {
					if (finished || assignedRole !== role) return false;
					roles[role] = formatModelSelectorValue(selector ?? `${model.provider}/${model.id}`, thinkingLevel);
					changed = true;
					return true;
				},
				onUnassign: assignedRole => {
					if (finished || assignedRole !== role) return false;
					roles[role] = null;
					changed = true;
					return true;
				},
			},
			onDone: () => {
				finished = true;
				result.resolve(this.#dialogs.signal.aborted || !changed ? undefined : staged);
			},
		});
		const previousChild = this.#closeChild;
		this.#closeChild = close;
		try {
			return await result.promise;
		} finally {
			if (this.#closeChild === close) this.#closeChild = previousChild;
		}
	}

	/**
	 * Edit the draft's agents in the agents hub. The hub reads a preview with the
	 * draft loaded and writes into a copy of the draft, never into live settings;
	 * a hub reload reads that copy back, so its edits stay visible. Agent creation
	 * is not offered. Resolves the edited draft, or undefined when nothing changed.
	 */
	async #editAgents(source: ProfileDraft, initialAgent: string | undefined): Promise<ProfileDraft | undefined> {
		if (this.#dialogs.signal.aborted) return undefined;
		const { session } = this.ctx;
		const staged = structuredClone(source);
		const draftDefault = draftModelRoles(staged).default ?? undefined;
		const previewDeps = (): AgentsHubDeps =>
			createAgentsHubDeps(
				getProjectDir(),
				this.ctx.settings.previewSetup(staged.config),
				session.modelRegistry,
				() => session.effectiveExtensionRoots,
				draftDefault,
				draftDefault,
			);
		const stagedTask = (): RawSettings => {
			if (!isRecord(staged.config.task)) staged.config.task = {};
			return staged.config.task as RawSettings;
		};
		let edited = false;
		const deps: AgentsHubDeps = {
			...previewDeps(),
			browserSource: this.#draftSource(staged),
			loadAgents: () => previewDeps().loadAgents(),
			setAgentDisabled: (name, disabled) => {
				const task = stagedTask();
				const current = Array.isArray(task.disabledAgents)
					? task.disabledAgents.filter((item): item is string => typeof item === "string")
					: cfgTaskDisabledAgents.get(this.ctx.settings.previewSetup(staged.config));
				const others = current.filter(item => item !== name);
				task.disabledAgents = disabled ? [...others, name] : others;
				edited = true;
			},
			setAgentOverride: (property, name, value) => {
				const task = stagedTask();
				const key =
					property === "model" ? "agentModelOverrides" : property === "prewalk" ? "agentPrewalk" : "agentAdvisor";
				if (!isRecord(task[key])) task[key] = {};
				// null is Automatic (or the agent's own default) and masks the user's override once loaded.
				(task[key] as Record<string, string | null>)[name] = value ?? null;
				edited = true;
			},
			generateAgent: undefined,
			saveAgent: undefined,
		};
		const done = Promise.withResolvers<void>();
		const close = await this.host.showAgentsDashboard({
			deps,
			title: "Agents · profile draft",
			initialAgent,
			isCancelled: () => this.#dialogs.signal.aborted,
			onDone: () => done.resolve(),
		});
		// Cancelled while loading: the hub never opened and never reports done.
		if (this.#dialogs.signal.aborted) return undefined;
		const previousChild = this.#closeChild;
		this.#closeChild = close;
		try {
			await done.promise;
		} finally {
			if (this.#closeChild === close) this.#closeChild = previousChild;
		}
		return edited && !this.#dialogs.signal.aborted ? staged : undefined;
	}

	#renameSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const input = await this.ctx.showHookInput("Rename profile", setup.name, { signal: this.#dialogs.signal });
			if (input === undefined) return undefined;
			const renamed = await renameSavedSetup(setup.name, input, this.#agentDir());
			if (this.#imported.delete(setup.name)) this.#imported.add(renamed);
			if (this.#loaded.settings === setup.name) this.#loaded.settings = renamed;
			if (this.#loaded.models === setup.name) this.#loaded.models = renamed;
			await this.#refresh({ kind: "saved", name: renamed });
			return { message: `Renamed profile ${cleanText(setup.name)} to ${cleanText(renamed)}`, tone: "success" };
		});
	}

	#deleteSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const confirmed = await this.ctx.showHookConfirm(
				`Delete profile ${cleanText(setup.name)}?`,
				"This deletes only the saved profile file. The current session and your settings are unchanged.",
				{ signal: this.#dialogs.signal },
			);
			if (!confirmed) return undefined;
			await deleteSavedSetup(setup.name, this.#agentDir());
			this.#imported.delete(setup.name);
			await this.#refresh(CURRENT_SETUP);
			return { message: `Deleted profile ${cleanText(setup.name)}`, tone: "success" };
		});
	}

	#importProfile(): Promise<void> {
		return this.#interaction(async () => {
			const source = await this.ctx.showHookSelector(
				"Import profile",
				[
					{ label: FROM_FILE, description: "Read an exported profile file" },
					{ label: FROM_CLIPBOARD, description: "Read profile text copied from omp" },
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			const imported =
				source === FROM_FILE
					? await this.#readImportFile()
					: source === FROM_CLIPBOARD
						? parseProfileText(await readTextFromClipboard())
						: undefined;
			if (!imported) return undefined;
			const draft: ProfileDraft = { metadata: imported.metadata, config: imported.config };
			const unavailable = this.#roleWarnings(draft).size;
			const withheld = imported.withheld.length > 0 ? safetySettingsText(imported.withheld) : undefined;
			const findings = [
				...(unavailable > 0
					? [`${unavailable} model${unavailable === 1 ? "" : "s"} not available on this machine`]
					: []),
				...(imported.warnings.length > 0
					? [`${imported.warnings.length} entr${imported.warnings.length === 1 ? "y" : "ies"} skipped`]
					: []),
				...(withheld ? [`left out ${withheld}`] : []),
			];
			const review = await this.ctx.showHookSelector(
				"Look over the imported profile before saving it?",
				[
					{
						label: REVIEW_IMPORT,
						description: `Open the full settings menu to check or change it${findings.length > 0 ? ` (${findings.join(", ")})` : ""}`,
					},
					{ label: SAVE_IMPORT, description: "Name it and save it as a new profile" },
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			let saved: string | undefined;
			if (review === SAVE_IMPORT) {
				saved = await this.#saveDraft(CURRENT_SETUP, draft, true, []);
			} else if (review === REVIEW_IMPORT) {
				saved = await this.#openEditor(CURRENT_SETUP, draft, {
					title: "Import profile",
					name: "Imported profile",
					notice: [
						"Not imported yet: review it, fix any ⚠ model, then Ctrl+S to save it as a new profile (Esc discards).",
						...(imported.warnings.length > 0 ? [`Skipped ${skippedSummary(imported.warnings)}.`] : []),
						...(withheld ? [`Left out ${withheld}; imports never change safety settings.`] : []),
					].join(" "),
				});
			}
			if (saved === undefined) return undefined;
			this.#imported.add(saved);
			await this.#refresh({ kind: "saved", name: saved });
			const leftOut = withheld ? ` (left out ${withheld})` : "";
			return { message: `Imported profile ${cleanText(saved)}${leftOut}. Load it to use it.`, tone: "success" };
		});
	}

	/** Prompt for an exported profile file until one reads; undefined when cancelled or left empty. */
	async #readImportFile(): Promise<ImportedProfile | undefined> {
		let prompt = "Import profile from file";
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, "Path to an exported profile", {
				signal: this.#dialogs.signal,
			});
			if (!input?.trim()) return undefined;
			try {
				const target = resolveToCwd(input.trim(), this.ctx.sessionManager.getCwd());
				return await readProfileFile(target, this.#displayPath(target));
			} catch (error) {
				if (!(error instanceof SetupError)) throw error;
				prompt = `${cleanText(error.message)}\nImport profile from file`;
			}
		}
	}

	#exportProfile(setup: ProfileDashboardSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const signal = this.#dialogs.signal;
			const label = setup.kind === "saved" ? setup.name : "Current profile";
			let source: ProfileDraft;
			let skipped: readonly string[] = [];
			if (setup.kind === "saved") {
				const loaded = await loadSavedSetup(setup.name, this.#agentDir());
				const scope = await this.ctx.showHookSelector(
					`Export profile ${cleanText(label)}`,
					[
						{ label: WHOLE_PROFILE, description: "Every model role and setting this profile includes" },
						{ label: MODELS_ONLY, description: "Model roles and thinking only" },
						"Cancel",
					],
					{ signal },
				);
				if (scope !== WHOLE_PROFILE && scope !== MODELS_ONLY) return undefined;
				source = scope === WHOLE_PROFILE ? loaded : modelsOnlyDraft(loaded);
				skipped = loaded.warnings;
			} else {
				// The current profile is already models-only; save it first to share settings groups.
				source = this.#currentDraft();
			}
			const { draft, withheld } = shareableDraft(source);
			const destination = await this.ctx.showHookSelector(
				`Export profile ${cleanText(label)}`,
				[
					{ label: TO_FILE, description: "Write a profile file; an existing file is never replaced" },
					{ label: TO_CLIPBOARD, description: "Copy the profile text" },
					"Cancel",
				],
				{ signal },
			);
			let where: string;
			if (destination === TO_CLIPBOARD) {
				await copyToClipboard(serializeSetup(draft));
				where = "the clipboard";
			} else if (destination === TO_FILE) {
				const written = await this.#writeExportFile(draft, setup.kind === "saved" ? setup.name : "profile");
				if (written === undefined) return undefined;
				where = this.#displayPath(written);
			} else {
				return undefined;
			}
			const leftOut = withheld.length > 0 ? ` (left out ${safetySettingsText(withheld)})` : "";
			const without = skipped.length > 0 ? `, without ${skippedSummary(skipped)}` : "";
			return {
				message: `Exported profile ${cleanText(label)} to ${cleanText(where)}${leftOut}${without}`,
				tone: "success",
			};
		});
	}

	/** Prompt for an export path (empty accepts the suggestion) until the create-only write succeeds. */
	async #writeExportFile(draft: ProfileDraft, baseName: string): Promise<string | undefined> {
		const cwd = this.ctx.sessionManager.getCwd();
		const suggested = path.join(cwd, `${baseName}.profile.yml`);
		const title = `Export profile to file (empty saves ${this.#displayPath(suggested)})`;
		let prompt = title;
		for (;;) {
			const input = await this.ctx.showHookInput(prompt, suggested, { signal: this.#dialogs.signal });
			if (input === undefined) return undefined;
			const target = input.trim() ? resolveToCwd(input.trim(), cwd) : suggested;
			try {
				await writeProfileFile(target, draft, this.#displayPath(target));
				return target;
			} catch (error) {
				if (!(error instanceof SetupError)) throw error;
				prompt = `${cleanText(error.message)}\n${title}`;
			}
		}
	}

	/** `target` relative to the session folder when inside it, so prompts and notices stay readable. */
	#displayPath(target: string): string {
		const relative = path.relative(this.ctx.sessionManager.getCwd(), target);
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
	}

	#loadSetup(setup: ProfileDashboardSavedSetupRef): Promise<void> {
		return this.#interaction(async () => {
			const choice = await this.ctx.showHookSelector(
				`Load profile ${cleanText(setup.name)}`,
				[
					{
						label: APPLY_MODELS_CHOICE,
						description:
							"Switch model roles and thinking now; this conversation and other settings, including a loaded profile's, stay as they are",
					},
					{
						label: NEW_SESSION_CHOICE,
						description: "Save this conversation and start a new one with every setting the profile includes",
					},
					"Cancel",
				],
				{ signal: this.#dialogs.signal },
			);
			if (choice === APPLY_MODELS_CHOICE) return this.#applyModels(setup);
			if (choice === NEW_SESSION_CHOICE) return this.#startSession(setup);
			return undefined;
		});
	}

	async #applyModels(setup: ProfileDashboardSavedSetupRef): Promise<Notice> {
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const release = await this.host.acquireDefaultRoleMutation();
		try {
			await applySetupModelRoles({
				session: this.ctx.session,
				settings: this.ctx.settings,
				roles: draftModelRoles(loaded),
				signal: this.#dialogs.signal,
				getBlockReason: () =>
					this.ctx.session.isStreaming
						? "Wait for the current response to finish before changing models"
						: undefined,
			});
		} finally {
			release();
		}
		this.#loaded.models = loaded.name;
		await this.#refresh(CURRENT_SETUP);
		return {
			message: `This conversation now uses the models from profile ${cleanText(loaded.name)}`,
			tone: "success",
		};
	}

	/**
	 * Start a new session in this process with the whole setup applied. The
	 * setup becomes the session's setup layer, so it outranks persisted config
	 * until it is unloaded, another setup is loaded, or omp restarts.
	 */
	async #startSession(setup: ProfileDashboardSavedSetupRef): Promise<Notice | undefined> {
		const loaded = await loadSavedSetup(setup.name, this.#agentDir());
		const name = cleanText(loaded.name);
		const safety = safetySensitiveSettings(loaded);
		const confirmed = await this.ctx.showHookConfirm(
			`Start a new session with profile ${name}?`,
			[
				"This conversation is saved and can be resumed. The profile applies until you unload it, load another profile, or restart omp.",
				...(safety.length > 0 ? [`It also sets ${safetySettingsText(safety, loaded.config)}.`] : []),
			].join("\n"),
			{ signal: this.#dialogs.signal },
		);
		if (!confirmed) return undefined;
		this.#closeSettings?.();
		if (!(await this.ctx.startNewSession(`New session with profile ${loaded.name}`))) {
			// Settings is already closed, so a dashboard notice would never show.
			this.ctx.showWarning(`Profile ${name} was not loaded: the new session did not start`);
			return undefined;
		}
		try {
			this.ctx.settings.applySetupLayer(loaded.config);
		} catch (error) {
			this.ctx.showWarning(`Profile ${name} was not loaded: ${errorText(error, "a setting it holds is invalid")}`);
			return undefined;
		}
		this.#loaded = { settings: loaded.name, models: loaded.name };
		await this.ctx.session.refreshBaseSystemPrompt();
		await this.#useDefault(this.#defaultSelection(this.ctx.settings), `Profile ${name}`);
		if (loaded.warnings.length > 0) {
			this.ctx.showWarning(
				`Profile ${name} skipped ${loaded.warnings.length} entr${loaded.warnings.length === 1 ? "y" : "ies"}: ${cleanText(loaded.warnings[0])}`,
			);
		}
		return undefined;
	}

	/**
	 * Drop the session's setup layer so the user's own settings and models apply
	 * again. When that changes the model or thinking the default role selects,
	 * even through an alias such as `@slow`, the session moves to the default
	 * that applies now.
	 */
	#unloadProfile(): Promise<void> {
		return this.#interaction(async () => {
			const active = this.#activeProfile();
			if (!active) return undefined;
			const label = loadedProfileLabel(active);
			const confirmed = await this.ctx.showHookConfirm(
				`Unload ${label}?`,
				"Your own settings and models apply again. This conversation continues, and nothing is saved.",
				{ signal: this.#dialogs.signal },
			);
			if (!confirmed) return undefined;
			const { session, settings } = this.ctx;
			const release = await this.host.acquireDefaultRoleMutation();
			try {
				const baseline = this.#defaultSelection(settings.previewSetup(undefined));
				const defaultChanges = !selectionsEqual(this.#defaultSelection(settings), baseline);
				if (defaultChanges && session.isStreaming) {
					return {
						message: "Wait for the current response to finish before unloading the profile",
						tone: "error",
					};
				}
				settings.applySetupLayer(undefined);
				this.#loaded = {};
				await session.refreshBaseSystemPrompt();
				if (defaultChanges) await this.#useDefault(baseline, `Unloaded ${label}`);
			} finally {
				release();
			}
			await this.#refresh(CURRENT_SETUP);
			return { message: `Unloaded ${label}; your own settings and models apply again`, tone: "success" };
		});
	}

	/**
	 * What the default role selects under `settings` (live or a preview), with
	 * startup's thinking precedence: the role's explicit thinking suffix, else the
	 * model's own default level, else the Thinking Level setting.
	 */
	#defaultSelection(settings: Settings): DefaultSelection {
		const { session } = this.ctx;
		const selector = settings.getModelRole("default");
		const resolved = resolveRoleModelFull(settings, "default", session.getAvailableModels(), session.model);
		const model =
			selector === undefined
				? session.model
				: resolved.model && session.modelRegistry.hasConfiguredAuth(resolved.model)
					? resolved.model
					: undefined;
		const thinkingLevel =
			model && resolved.explicitThinkingLevel
				? resolved.thinkingLevel
				: (model?.thinking?.defaultLevel ?? parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings)));
		return { selector, model, thinkingLevel };
	}

	/**
	 * Put the session on `selection` without persisting a model or thinking choice.
	 * When its model is unavailable, warn (led by `subject`) and keep the current
	 * model; the selection's thinking still applies.
	 */
	async #useDefault(selection: DefaultSelection, subject: string): Promise<void> {
		const { session } = this.ctx;
		const { selector, model, thinkingLevel } = selection;
		if (model && !modelsAreEqual(session.model, model)) {
			await session.setModelTemporary(model, thinkingLevel);
			return;
		}
		if (!model && selector !== undefined) {
			const current = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
			this.ctx.showWarning(
				`${subject}: default model ${cleanText(selector)} is not available; keeping ${cleanText(current)}`,
			);
		}
		if (thinkingLevel !== undefined && session.configuredThinkingLevel() !== thinkingLevel) {
			session.setThinkingLevel(thinkingLevel);
		}
	}

	#openActiveControl(control: ProfileDashboardActiveControl): void {
		if (this.#dashboard?.selectedSetup?.kind !== "current" || this.#busy) return;
		if (control === "settings") {
			this.#selector?.selectTab("appearance");
			return;
		}
		void this.#interaction(async () => {
			const done = Promise.withResolvers<void>();
			if (control === "model") {
				// setClose also tracks a hub reopened after a /login round-trip.
				this.host.showModelHub({
					isCancelled: () => this.#dialogs.signal.aborted,
					setClose: close => {
						this.#closeChild = close;
					},
					onDone: () => done.resolve(),
				});
			} else {
				this.#closeChild = await this.host.showAgentsDashboard({
					isCancelled: () => this.#dialogs.signal.aborted,
					onDone: () => done.resolve(),
				});
				// Cancelled while loading: the hub never opened and never reports done.
				if (this.#dialogs.signal.aborted) return undefined;
			}
			await done.promise;
			this.#closeChild = undefined;
			await this.#refresh(CURRENT_SETUP);
			return undefined;
		});
	}
}
