import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	type Component,
	extractPrintableText,
	matchesKey,
	measureSettingsSidebarWidth,
	padding,
	parseSgrMouse,
	replaceTabs,
	type SgrMouseEvent,
	renderSettingsSidebarRow,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "@oh-my-pi/pi-tui/keybinding-matchers";
import { getSettingsListTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ProfileSnapshot, SetupMetadata } from "../../profiles/types";
import { buildProfilePreviewOverview } from "./profile-preview-content";

export type ProfileDashboardActiveControl = "model" | "agents" | "settings";
export type ProfileDashboardSetupRef =
	| { kind: "current" }
	| {
			kind: "saved";
			name: string;
			metadata?: SetupMetadata;
			/** Imported during this run of omp; marked "(New)" until omp exits. */
			imported?: boolean;
	  };
export type ProfileDashboardSavedSetupRef = Extract<ProfileDashboardSetupRef, { kind: "saved" }>;
/** Profiles the running session loaded; a name is absent once that part of the profile no longer applies. */
export interface ProfileDashboardActiveProfile {
	/** The profile whose settings apply. */
	settings?: string;
	/** The profile whose model roles apply. */
	models?: string;
}
type DashboardFocus = "profiles" | "details";
type DetailAction = "save" | ProfileDashboardActiveControl;

export interface ProfileDashboardProfileState {
	snapshot?: ProfileSnapshot;
	loading: boolean;
	/** Safe, user-facing summary only. Never pass raw child errors. */
	error?: string;
	/** A failed refresh keeps snapshot as the last-good value and annotates it. */
	refreshError?: string;
	/** This session's account usage reports; the overview shows the profile's providers. */
	usage?: readonly UsageReport[];
}

export interface ProfileDashboardCallbacks {
	requestRender(): void;
	close(): void;
	selected(setup: ProfileDashboardSetupRef): void;
	loadSetup(setup: ProfileDashboardSavedSetupRef): void | Promise<void>;
	editProfile(setup: ProfileDashboardSetupRef): void | Promise<void>;
	saveCurrentSetup(): void | Promise<void>;
	importProfile(): void | Promise<void>;
	exportProfile(setup: ProfileDashboardSetupRef): void | Promise<void>;
	deleteSetup(setup: ProfileDashboardSavedSetupRef): void | Promise<void>;
	renameSetup(setup: ProfileDashboardSavedSetupRef): void | Promise<void>;
	openActiveControl(control: ProfileDashboardActiveControl): void;
	/** Unload the session's profile; offered only while one applies. */
	unloadProfile(): void | Promise<void>;
}

export interface ProfileDashboardOptions {
	setups: readonly ProfileDashboardSetupRef[];
	terminalHeight?: number;
	callbacks: ProfileDashboardCallbacks;
}

interface HitZone {
	line: number;
	start: number;
	end: number;
	action:
		| "edit-profile"
		| "load"
		| "save"
		| "import"
		| "export"
		| "delete"
		| "rename"
		| "unload"
		| "close"
		| DetailAction;
}

interface FooterHint {
	text: string;
	action?: HitZone["action"];
}

interface SetupZone {
	top: number;
	bottom: number;
	start: number;
	end: number;
	key: string;
}

function cleanLine(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? "")))
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function setupKey(setup: ProfileDashboardSetupRef): string {
	return setup.kind === "current" ? "current" : `saved\0${setup.name}`;
}

/** Name with its emoji, plus "(New)" when imported during this run. */
function setupTitle(setup: ProfileDashboardSetupRef): string {
	if (setup.kind === "current") return "Current profile";
	const emoji = setup.metadata?.emoji ? `${cleanLine(setup.metadata.emoji)} ` : "";
	return `${emoji}${cleanLine(setup.name)}${setup.imported ? ` ${theme.fg("accent", "(New)")}` : ""}`;
}

/** What the current session loaded, e.g. "profile focus loaded" or "models from profile fast". */
function loadedText(active: ProfileDashboardActiveProfile): string {
	const { settings, models } = active;
	if (settings !== undefined && settings === models) return `profile ${cleanLine(settings)} loaded`;
	const parts: string[] = [];
	if (settings !== undefined) parts.push(`settings from profile ${cleanLine(settings)}`);
	if (models !== undefined) parts.push(`models from profile ${cleanLine(models)}`);
	return parts.length > 0 ? parts.join(" · ") : "profile loaded";
}

function normalizeSetups(setups: readonly ProfileDashboardSetupRef[]): ProfileDashboardSetupRef[] {
	const savedNames = new Set<string>();
	const saved: ProfileDashboardSavedSetupRef[] = [];
	for (const setup of setups) {
		if (setup.kind !== "saved" || savedNames.has(setup.name)) continue;
		savedNames.add(setup.name);
		saved.push(setup);
	}
	return [{ kind: "current" }, ...saved];
}

function joinPanels(left: readonly string[], right: readonly string[], leftWidth: number): string[] {
	const height = Math.max(left.length, right.length);
	const separator = getSettingsListTheme().hint("│ ");
	const lines: string[] = [];
	for (let index = 0; index < height; index++) {
		const leftLine = truncateToWidth(left[index] ?? "", leftWidth);
		lines.push(
			`${leftLine}${padding(Math.max(0, leftWidth - visibleWidth(leftLine)))}${separator}${right[index] ?? ""}`,
		);
	}
	return lines;
}

/**
 * Profiles content embedded in Settings. It owns only view state; discovery,
 * snapshots, cancellation, cache generations, and overlay lifetime remain in
 * the controller.
 */
export class ProfileDashboard implements Component {
	#setups: ProfileDashboardSetupRef[];
	#filteredSetups: ProfileDashboardSetupRef[];
	readonly #callbacks: ProfileDashboardCallbacks;
	readonly #terminalHeight: number;
	readonly #states = new Map<string, ProfileDashboardProfileState>();

	#actionNotice: { text: string; tone: "error" | "success" | "info" } | undefined;
	#activeProfile: ProfileDashboardActiveProfile | undefined;
	#focus: DashboardFocus = "profiles";
	/** Last selected setup; remembered while a filter hides it so clearing the filter restores it. */
	#selectedKey = "current";
	#filter = "";
	#searching = false;
	#disposed = false;
	#listScroll = 0;
	#listVisibleCount = 1;
	#listHeight = 1;
	#listHitWidth = 0;
	#revealSelection = true;
	#detailScroll = 0;
	#detailTotal = 0;
	#detailHeight = 1;
	#detailScrollView: ScrollView | undefined;

	#bodyRowStart = 0;
	#detailRowStart = 0;
	#detailColStart = 0;
	#detailScrollWidth = 0;
	#detailScrollHitHeight = 0;
	#setupZones: SetupZone[] = [];
	#actionZones: HitZone[] = [];

	constructor(options: ProfileDashboardOptions) {
		this.#setups = normalizeSetups(options.setups);
		this.#filteredSetups = [...this.#setups];
		this.#callbacks = options.callbacks;
		this.#terminalHeight = options.terminalHeight ?? process.stdout.rows ?? 24;
	}

	/** The selected setup while the current filter shows it; a filtered-out selection is inert. */
	get selectedSetup(): ProfileDashboardSetupRef | undefined {
		return this.#filteredSetups.find(setup => setupKey(setup) === this.#selectedKey);
	}

	setSetupState(setup: ProfileDashboardSetupRef, state: ProfileDashboardProfileState): void {
		const key = setupKey(setup);
		if (this.#disposed || !this.#setups.some(item => setupKey(item) === key)) return;
		this.#states.set(key, state);
		if (key === this.#selectedKey) this.#revealSelection = true;
		this.#callbacks.requestRender();
	}

	setSetups(setups: readonly ProfileDashboardSetupRef[], selectedSetup?: ProfileDashboardSetupRef): void {
		if (this.#disposed) return;
		const previousKey = this.#selectedKey;
		this.#setups = normalizeSetups(setups);
		const liveKeys = new Set(this.#setups.map(setupKey));
		for (const key of this.#states.keys()) {
			if (!liveKeys.has(key)) this.#states.delete(key);
		}
		const explicitKey = selectedSetup ? setupKey(selectedSetup) : undefined;
		if (explicitKey && liveKeys.has(explicitKey)) {
			this.#selectedKey = explicitKey;
			if (this.#filter) {
				this.#filter = "";
				this.#searching = false;
			}
		} else if (!liveKeys.has(this.#selectedKey)) {
			this.#selectedKey = "current";
		}
		this.#rebuildFilteredSetups();
		this.#listScroll = 0;
		this.#revealSelection = true;
		if (this.#selectedKey !== previousKey) {
			this.#resetPreviewNavigation();
			const selected = this.selectedSetup;
			if (selected) this.#callbacks.selected(selected);
		}
		this.#callbacks.requestRender();
	}

	setActionNotice(message: string | undefined, tone: "error" | "success" | "info" = "info"): void {
		if (this.#disposed) return;
		const text = message ? cleanLine(message) : "";
		this.#actionNotice = text ? { text, tone } : undefined;
		this.#callbacks.requestRender();
	}

	/** Show what the session loaded; `undefined` when no profile applies, which also withholds Unload. */
	setActiveProfile(active: ProfileDashboardActiveProfile | undefined): void {
		if (this.#disposed) return;
		this.#activeProfile = active ? { ...active } : undefined;
		this.#callbacks.requestRender();
	}

	dispose(): void {
		this.#disposed = true;
		this.#detailScrollView?.dispose();
		this.#detailScrollView = undefined;
	}

	invalidate(): void {}

	render(width: number, allocatedHeight?: number, sidebarWidth?: number): readonly string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		const height = Math.max(0, Math.trunc(allocatedHeight ?? this.#terminalHeight));
		if (height === 0) return [];

		const notices: string[] = [];
		if (this.#actionNotice) {
			const color =
				this.#actionNotice.tone === "error"
					? "error"
					: this.#actionNotice.tone === "success"
						? "success"
						: "accent";
			const icon =
				this.#actionNotice.tone === "error"
					? theme.status.error
					: this.#actionNotice.tone === "success"
						? theme.status.success
						: theme.status.info;
			notices.push(theme.fg(color, `${icon} ${this.#actionNotice.text}`));
		}
		const footerLines = this.#footerLines(safeWidth).slice(0, Math.max(0, height - notices.length - 1));
		const bodyRows = Math.max(0, height - notices.length - footerLines.length);
		const selected = this.selectedSetup;
		const listWidth = Math.max(
			4,
			Math.trunc(sidebarWidth ?? measureSettingsSidebarWidth(this.#setups.map(setupTitle))),
		);
		const split = safeWidth >= 68 && bodyRows >= 3;
		const detailWidth = split ? Math.max(1, safeWidth - listWidth - 2) : safeWidth;

		this.#bodyRowStart = notices.length;
		this.#actionZones = [];
		this.#setupZones = [];
		this.#listHitWidth = 0;
		this.#detailRowStart = 0;
		this.#detailColStart = 0;
		this.#detailScrollWidth = 0;
		this.#detailScrollHitHeight = 0;

		let bodyLines: readonly string[];
		if (bodyRows === 0) {
			bodyLines = [];
		} else if (split) {
			const listLines = this.#renderSetupList(listWidth, bodyRows, this.#bodyRowStart, 0);
			this.#listHitWidth = listWidth;
			this.#detailRowStart = this.#bodyRowStart;
			this.#detailColStart = listWidth + 2;
			const detailLines = this.#renderDetails(selected, detailWidth, bodyRows);
			bodyLines = joinPanels(listLines, detailLines, listWidth);
		} else if (this.#focus === "profiles") {
			this.#listHitWidth = safeWidth;
			bodyLines = this.#renderSetupList(safeWidth, bodyRows, this.#bodyRowStart, 0);
		} else {
			this.#detailRowStart = this.#bodyRowStart;
			bodyLines = this.#renderDetails(selected, safeWidth, bodyRows);
		}
		const out = notices.map(line => truncateToWidth(line, safeWidth));
		for (let index = 0; index < bodyRows; index++) {
			out.push(truncateToWidth(bodyLines[index] ?? "", safeWidth));
		}
		const footerStart = out.length;
		for (const line of footerLines) out.push(truncateToWidth(line, safeWidth));
		this.#recordFooterZones(footerLines, footerStart);
		while (out.length < height) out.push("");
		return out.slice(0, height);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) this.routeMouse(event, event.row, event.col);
			return;
		}

		if (this.#searching) {
			if (matchesAppInterrupt(data)) {
				this.#searching = false;
				this.#setFilter("");
				this.#callbacks.requestRender();
				return;
			}
			if (matchesKey(data, "backspace")) {
				const chars = [...this.#filter];
				chars.pop();
				this.#setFilter(chars.join(""));
				this.#callbacks.requestRender();
				return;
			}
			const printable = extractPrintableText(data);
			if (printable !== undefined) {
				this.#setFilter(this.#filter + printable);
				this.#callbacks.requestRender();
				return;
			}
		}

		if (matchesAppInterrupt(data)) {
			if (this.#focus !== "profiles") {
				this.#focus = "profiles";
				this.#revealSelection = true;
				this.#callbacks.requestRender();
			} else {
				this.#callbacks.close();
			}
			return;
		}
		if (data === "/") {
			this.#beginSearch();
			return;
		}
		if (data === "l") {
			this.#loadSelectedSetup();
			return;
		}
		if (data === "s") {
			void this.#callbacks.saveCurrentSetup();
			return;
		}
		if (data === "i") {
			void this.#callbacks.importProfile();
			return;
		}
		if (data === "x") {
			const selected = this.selectedSetup;
			if (selected) void this.#callbacks.exportProfile(selected);
			return;
		}
		if (data === "e") {
			this.#editSelectedProfile();
			return;
		}
		const selectedSavedSetup = this.selectedSetup;
		if (selectedSavedSetup?.kind === "saved") {
			if (data === "d") {
				void this.#callbacks.deleteSetup(selectedSavedSetup);
				return;
			}
			if (data === "n") {
				void this.#callbacks.renameSetup(selectedSavedSetup);
				return;
			}
		}
		if (this.selectedSetup?.kind === "current") {
			if (data === "m") {
				this.#callbacks.openActiveControl("model");
				return;
			}
			if (data === "a") {
				this.#callbacks.openActiveControl("agents");
				return;
			}
			if (data === ",") {
				this.#callbacks.openActiveControl("settings");
				return;
			}
			if (data === "u" && this.#activeProfile) {
				void this.#callbacks.unloadProfile();
				return;
			}
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#focus === "profiles") {
				this.#focusPreview();
				return;
			}
			this.#focus = "profiles";
			this.#searching = false;
			this.#revealSelection = true;
			this.#callbacks.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || data === "\n" || data === "\r" || data === " ") {
			this.#editSelectedProfile();
			return;
		}

		if (this.#focus === "details") {
			if (matchesSelectUp(data) || matchesSelectDown(data)) {
				this.#scrollDetails(matchesSelectUp(data) ? -1 : 1);
				return;
			}
			if (matchesSelectPageUp(data) || matchesSelectPageDown(data)) {
				this.#scrollDetails(matchesSelectPageUp(data) ? -this.#detailHeight : this.#detailHeight);
			}
			return;
		}

		if (matchesSelectDown(data)) {
			this.#moveSetupSelection(1);
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveSetupSelection(-1);
			return;
		}
		if (matchesSelectPageUp(data) || matchesSelectPageDown(data)) {
			this.#scrollSetupList(matchesSelectPageUp(data) ? -this.#listVisibleCount : this.#listVisibleCount);
		}
	}

	#rebuildFilteredSetups(): void {
		const needle = this.#filter.trim().toLocaleLowerCase();
		this.#filteredSetups = needle
			? this.#setups.filter(setup => {
					const label = setup.kind === "current" ? "Current profile" : setup.name;
					return label.toLocaleLowerCase().includes(needle);
				})
			: [...this.#setups];
	}

	#setFilter(filter: string): void {
		const previousKey = this.#selectedKey;
		this.#filter = filter;
		this.#rebuildFilteredSetups();
		if (
			this.#filteredSetups.length > 0 &&
			!this.#filteredSetups.some(setup => setupKey(setup) === this.#selectedKey)
		) {
			this.#selectedKey = setupKey(this.#filteredSetups[0]!);
		}
		this.#listScroll = 0;
		this.#revealSelection = true;
		if (this.#selectedKey !== previousKey) {
			this.#resetPreviewNavigation();
			const selected = this.selectedSetup;
			if (selected) this.#callbacks.selected(selected);
		}
	}

	#selectSetupKey(key: string): void {
		if (key === this.#selectedKey) return;
		const setup = this.#setups.find(candidate => setupKey(candidate) === key);
		if (!setup) return;
		this.#selectedKey = key;
		this.#resetPreviewNavigation();
		this.#revealSelection = true;
		this.#callbacks.selected(setup);
		this.#callbacks.requestRender();
	}

	#moveSetupSelection(delta: -1 | 1): void {
		const index = this.#filteredSetups.findIndex(setup => setupKey(setup) === this.#selectedKey);
		if (index < 0) return;
		const next = index + delta;
		if (next < 0 || next >= this.#filteredSetups.length) return;
		this.#selectSetupKey(setupKey(this.#filteredSetups[next]!));
	}

	#scrollSetupList(delta: number): void {
		const max = Math.max(0, this.#filteredSetups.length - this.#listVisibleCount);
		this.#listScroll = Math.max(0, Math.min(max, this.#listScroll + delta));
		this.#revealSelection = false;
		this.#callbacks.requestRender();
	}

	#focusPreview(): void {
		if (!this.selectedSetup) return;
		this.#searching = false;
		this.#focus = "details";
		this.#callbacks.requestRender();
	}

	#resetPreviewNavigation(): void {
		this.#detailScroll = 0;
	}

	#editSelectedProfile(): void {
		const setup = this.selectedSetup;
		if (!setup) return;
		this.#searching = false;
		void this.#callbacks.editProfile(setup);
	}

	#loadSelectedSetup(): void {
		const setup = this.selectedSetup;
		if (setup?.kind !== "saved") return;
		void this.#callbacks.loadSetup(setup);
	}

	#renderSetupList(width: number, height: number, startRow: number, startCol: number): string[] {
		this.#listHeight = height;
		const lines = Array.from<string>({ length: height }).fill("");
		const count = this.#filteredSetups.length;
		const settingsTheme = getSettingsListTheme();
		if (count === 0) {
			lines[0] = settingsTheme.hint("  No matching profiles");
			this.#listScroll = 0;
			this.#listVisibleCount = 1;
			return lines;
		}

		this.#listVisibleCount = Math.max(1, height);
		const selectedIndex = this.#filteredSetups.findIndex(setup => setupKey(setup) === this.#selectedKey);
		if (this.#revealSelection && selectedIndex >= 0) {
			if (selectedIndex < this.#listScroll) this.#listScroll = selectedIndex;
			if (selectedIndex >= this.#listScroll + this.#listVisibleCount) {
				this.#listScroll = selectedIndex - this.#listVisibleCount + 1;
			}
			this.#revealSelection = false;
		}
		const maxScroll = Math.max(0, count - this.#listVisibleCount);
		this.#listScroll = Math.max(0, Math.min(maxScroll, this.#listScroll));

		const visible = this.#filteredSetups.slice(this.#listScroll, this.#listScroll + this.#listVisibleCount);
		for (let offset = 0; offset < visible.length; offset++) {
			const setup = visible[offset]!;
			const key = setupKey(setup);
			lines[offset] = renderSettingsSidebarRow(
				setupTitle(setup),
				width,
				key === this.#selectedKey,
				false,
				settingsTheme,
			);
			this.#setupZones.push({
				top: startRow + offset,
				bottom: startRow + offset + 1,
				start: startCol,
				end: startCol + width,
				key,
			});
		}
		return lines;
	}

	#renderDetails(setup: ProfileDashboardSetupRef | undefined, width: number, height: number): string[] {
		if (height <= 0) return [];
		this.#detailTotal = 0;
		this.#detailHeight = 1;
		this.#detailScrollWidth = width;
		this.#detailScrollHitHeight = height;
		if (!setup) {
			this.#detailScroll = 0;
			this.#detailScrollView?.dispose();
			this.#detailScrollView = undefined;
			return [theme.fg("muted", "No profile selected"), ...Array.from<string>({ length: height - 1 }).fill("")];
		}

		const state = this.#states.get(setupKey(setup));
		const snapshot = state?.snapshot;
		const focus = this.#focus === "details" ? `${theme.fg("accent", theme.nav.cursor)} ` : "";
		const header: string[] = [theme.bold(truncateToWidth(`${focus}${setupTitle(setup)}`, width))];
		const loaded = this.#activeProfile;
		let descriptor = `Active session · ${loaded ? loadedText(loaded) : "read-only summary"}`;
		if (setup.kind === "saved") {
			const loadState =
				loaded?.settings === setup.name ? "loaded" : loaded?.models === setup.name ? "models loaded" : "not loaded";
			descriptor = `Saved profile · read-only preview · ${loadState}`;
		}
		const status: string[] = [];
		if (state?.error && !snapshot) {
			status.push(theme.fg("error", `${theme.status.error} ${cleanLine(state.error)}`));
		}
		if (state?.refreshError && snapshot) {
			status.push(
				theme.fg("warning", `${theme.status.warning} ${cleanLine(state.refreshError)} · showing cached data`),
			);
		}
		if (state?.loading || !state) {
			status.push(theme.fg("muted", snapshot ? "Refreshing preview…" : "Loading preview…"));
		}
		if (status.length > 0) {
			const extra = status.length > 1 ? theme.fg("dim", ` · +${status.length - 1} more`) : "";
			header.push(truncateToWidth(`${status[0]}${extra}`, width));
		} else {
			header.push(theme.fg("dim", truncateToWidth(descriptor, width)));
		}
		if (!snapshot || header.length >= height) {
			if (!snapshot) {
				this.#detailScroll = 0;
				this.#detailScrollView?.dispose();
				this.#detailScrollView = undefined;
			}
			return [...header, ...Array.from<string>({ length: height }).fill("")].slice(0, height);
		}

		const bodyHeight = Math.max(0, height - header.length);
		if (bodyHeight === 0) return header.slice(0, height);

		let bodyWidth = Math.max(1, width);
		let lines = buildProfilePreviewOverview({
			setup,
			snapshot,
			width: bodyWidth,
			usage: state?.usage,
		});
		if (lines.length > bodyHeight && bodyWidth > 1) {
			bodyWidth -= 1;
			lines = buildProfilePreviewOverview({
				setup,
				snapshot,
				width: bodyWidth,
				usage: state?.usage,
			});
		}

		return [...header, ...this.#detailViewport(lines, width, bodyHeight)].slice(0, height);
	}

	#detailViewport(lines: string[], width: number, height: number): string[] {
		this.#detailTotal = lines.length;
		this.#detailHeight = Math.max(1, height);
		if (height <= 0) {
			this.#detailScrollView?.dispose();
			this.#detailScrollView = undefined;
			return [];
		}
		const max = Math.max(0, lines.length - height);
		this.#detailScroll = Math.max(0, Math.min(this.#detailScroll, max));
		this.#detailScrollView?.dispose();
		const view = new ScrollView(lines, {
			height,
			scrollbar: "auto",
			theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
		});
		this.#detailScrollView = view;
		view.setScrollOffset(this.#detailScroll);
		return [...view.render(width)];
	}

	#scrollDetails(delta: number): void {
		const max = Math.max(0, this.#detailTotal - this.#detailHeight);
		this.#detailScroll = Math.max(0, Math.min(max, this.#detailScroll + delta));
		this.#callbacks.requestRender();
	}

	#activateDetailAction(action: DetailAction): void {
		if (action === "save") {
			void this.#callbacks.saveCurrentSetup();
			return;
		}
		this.#callbacks.openActiveControl(action);
	}

	#footerHints(): FooterHint[] {
		const selected = this.selectedSetup;
		const hints: FooterHint[] = [{ text: "Enter/Space to customize", action: "edit-profile" }];
		if (selected?.kind === "saved") {
			hints.push(
				{ text: "l to load", action: "load" },
				{ text: "d to delete profile", action: "delete" },
				{ text: "n to rename profile", action: "rename" },
			);
		}
		hints.push(
			{ text: "s to save current", action: "save" },
			{ text: "i to import profile", action: "import" },
			{ text: "x to export profile", action: "export" },
		);
		if (selected?.kind === "current") {
			hints.push(
				{ text: "m to choose model", action: "model" },
				{ text: "a to edit agents", action: "agents" },
				{ text: ", to edit settings", action: "settings" },
			);
			if (this.#activeProfile) hints.push({ text: "u to unload profile", action: "unload" });
		}
		if (this.#focus === "profiles") {
			hints.push({ text: "↑/↓ to select profile" });
		} else {
			hints.push({ text: "↑/↓ to scroll overview" });
		}
		hints.push({
			text: this.#focus === "profiles" ? "Esc to close" : "Esc to go back",
			action: "close",
		});
		return hints;
	}

	#footerLines(width: number): string[] {
		if (this.#searching) {
			const search = truncateToWidth(`Search: ${cleanLine(this.#filter)}_`, Math.max(0, width));
			const hint = theme.fg("dim", truncateToWidth("Type to search · Esc to exit search", Math.max(0, width)));
			return visibleWidth(search) + 2 + visibleWidth(hint) <= width ? [`${search}  ${hint}`] : [search, hint];
		}

		const lines: string[] = [];
		let line = "";
		for (const { text } of this.#footerHints()) {
			const shown = truncateToWidth(text, Math.max(0, width));
			const next = line ? `${line} · ${shown}` : shown;
			if (line && visibleWidth(next) > width) {
				lines.push(theme.fg("dim", line));
				line = shown;
			} else {
				line = next;
			}
		}
		if (line) lines.push(theme.fg("dim", line));
		return lines;
	}

	#recordFooterZones(lines: readonly string[], startLine: number): void {
		for (const { text, action } of this.#footerHints()) {
			if (!action) continue;
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				const plain = Bun.stripANSI(lines[lineIndex] ?? "");
				const start = plain.indexOf(text);
				if (start < 0) continue;
				this.#actionZones.push({
					line: startLine + lineIndex,
					start,
					end: start + text.length,
					action,
				});
				break;
			}
		}
	}

	#beginSearch(): void {
		this.#searching = true;
		this.#focus = "profiles";
		this.#setFilter("");
		this.#callbacks.requestRender();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#disposed) return;
		const overList =
			this.#listHitWidth > 0 &&
			line >= this.#bodyRowStart &&
			line < this.#bodyRowStart + this.#listHeight &&
			col >= 0 &&
			col < this.#listHitWidth;
		if (overList && event.wheel !== null) {
			this.#focus = "profiles";
			this.#scrollSetupList(event.wheel);
			return;
		}
		if (event.leftClick) {
			const setupZone = this.#setupZones.find(
				zone => line >= zone.top && line < zone.bottom && col >= zone.start && col < zone.end,
			);
			if (setupZone) {
				const focusChanged = this.#focus !== "profiles";
				const selectionChanged = setupZone.key !== this.#selectedKey;
				this.#focus = "profiles";
				this.#selectSetupKey(setupZone.key);
				if (focusChanged && !selectionChanged) this.#callbacks.requestRender();
				return;
			}
		}
		if (overList && event.leftClick) {
			const focusChanged = this.#focus !== "profiles";
			this.#focus = "profiles";
			this.#revealSelection = true;
			if (focusChanged) this.#callbacks.requestRender();
			return;
		}

		const detailLine = line - this.#detailRowStart;
		const detailCol = col - this.#detailColStart;
		const overOverview =
			this.#detailScrollWidth > 0 &&
			detailLine >= 0 &&
			detailLine < this.#detailScrollHitHeight &&
			detailCol >= 0 &&
			detailCol < this.#detailScrollWidth;
		if (overOverview && event.wheel !== null) {
			this.#focus = "details";
			this.#scrollDetails(event.wheel);
			return;
		}
		if (overOverview && event.leftClick && this.#focus !== "details") {
			this.#focus = "details";
			this.#callbacks.requestRender();
			return;
		}

		if (!event.leftClick) return;
		const zone = this.#actionZones.find(item => item.line === line && col >= item.start && col < item.end);
		if (zone) this.#activateZone(zone.action);
	}

	#activateZone(action: HitZone["action"]): void {
		switch (action) {
			case "edit-profile":
				this.#editSelectedProfile();
				break;
			case "load":
				this.#loadSelectedSetup();
				break;
			case "delete": {
				const setup = this.selectedSetup;
				if (setup?.kind === "saved") void this.#callbacks.deleteSetup(setup);
				break;
			}
			case "rename": {
				const setup = this.selectedSetup;
				if (setup?.kind === "saved") void this.#callbacks.renameSetup(setup);
				break;
			}
			case "unload":
				if (this.selectedSetup?.kind === "current" && this.#activeProfile) void this.#callbacks.unloadProfile();
				break;
			case "import":
				void this.#callbacks.importProfile();
				break;
			case "export": {
				const setup = this.selectedSetup;
				if (setup) void this.#callbacks.exportProfile(setup);
				break;
			}
			case "close":
				if (this.#focus !== "profiles") {
					this.#focus = "profiles";
					this.#revealSelection = true;
					this.#callbacks.requestRender();
				} else {
					this.#callbacks.close();
				}
				break;
			case "save":
			case "model":
			case "agents":
			case "settings":
				this.#activateDetailAction(action);
				break;
		}
	}
}
