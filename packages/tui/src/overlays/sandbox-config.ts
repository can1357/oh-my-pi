/**
 * `/sandbox` overlay: the OS sandbox's status and settings, keyboard-driven in
 * a plain terminal and a data-first `prefs` page in Tern.
 *
 * The component owns presentation and its own selection/draft state only. It
 * takes a plain-data {@link SandboxConfigModel} and reports every edit through
 * {@link SandboxConfigCallbacks}; the host writes the settings and pushes the
 * refreshed model back with {@link SandboxConfigOverlayComponent.setModel}
 * (and a rejected edit with {@link SandboxConfigOverlayComponent.setNotice}).
 *
 * Pages: Overview (status, enable, mode, scope, fallback, runtime warnings,
 * ignored project values), Filesystem (read scope and the writable/readable/
 * denied path lists), Network (mode, allowed hosts, hosts blocked this
 * session) and Effective policy (the resolved lists, read-only). A list is one
 * text row per entry plus an add action; clearing an entry's text removes it.
 */
import type { TspPrefsControl, TspPrefsProps, TspPrefsRow, TspPrefsSection } from "@oh-my-pi/pi-wire";
import { type Component, getKeybindings, Input, matchesKey, TabBar, truncateToWidth, visibleWidth } from "../index";
import { theme } from "../theme";
import { getTabBarTheme } from "../chrome/shared";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { col, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard, selectList } from "../native/overlay";
import { plainLine } from "../native/spans";
import { shortenPath } from "../render/render-utils";
import { padToWidth } from "../render/utils";

export type SandboxModeValue = "workspace-write" | "read-only";
export type SandboxNetworkValue = "allowlist" | "deny" | "allow";
export type SandboxScopeValue = "bash" | "eval" | "exec";
export type SandboxFallbackValue = "warn" | "block";
export type SandboxReadScopeValue = "all" | "workspace";

const MODES: readonly SandboxModeValue[] = ["workspace-write", "read-only"];
const NETWORK_MODES: readonly SandboxNetworkValue[] = ["allowlist", "deny", "allow"];
const SCOPES: readonly SandboxScopeValue[] = ["bash", "eval", "exec"];
const FALLBACKS: readonly SandboxFallbackValue[] = ["warn", "block"];
const READ_SCOPES: readonly SandboxReadScopeValue[] = ["all", "workspace"];

/** The runtime's status, as the overlay shows it. */
export type SandboxOverlayStatus =
	| { readonly state: "off" }
	| {
			readonly state: "active";
			readonly backend: string;
			readonly network: string;
			readonly warnings: readonly string[];
	  }
	| { readonly state: "unavailable"; readonly reason: string; readonly fallback: SandboxFallbackValue };

/** The editable path/host lists. */
export type SandboxListId = "allowWrite" | "allowRead" | "denyRead" | "allowedHosts";
const LIST_IDS: readonly SandboxListId[] = ["allowWrite", "allowRead", "denyRead", "allowedHosts"];

/** One scalar setting change, typed by setting. */
export type SandboxSettingChange =
	| { readonly id: "enabled"; readonly value: boolean }
	| { readonly id: "mode"; readonly value: SandboxModeValue }
	| { readonly id: "scope"; readonly value: readonly SandboxScopeValue[] }
	| { readonly id: "fallback"; readonly value: SandboxFallbackValue }
	| { readonly id: "readScope"; readonly value: SandboxReadScopeValue }
	| { readonly id: "networkMode"; readonly value: SandboxNetworkValue };
export type SandboxSettingId = SandboxSettingChange["id"];
const SETTING_IDS: readonly SandboxSettingId[] = ["enabled", "mode", "scope", "fallback", "readScope", "networkMode"];

/** Everything the overlay shows. */
export interface SandboxConfigModel {
	readonly status: SandboxOverlayStatus;
	/** Effective values (after the project-may-only-tighten rule). */
	readonly enabled: boolean;
	readonly mode: SandboxModeValue;
	readonly fallback: SandboxFallbackValue;
	readonly readScope: SandboxReadScopeValue;
	readonly networkMode: SandboxNetworkValue;
	/** Scope and the lists as the non-project layers hold them: what a global write replaces. */
	readonly scope: readonly SandboxScopeValue[];
	readonly allowWrite: readonly string[];
	readonly allowRead: readonly string[];
	readonly denyRead: readonly string[];
	readonly allowedHosts: readonly string[];
	/** Project-layer values dropped because they would loosen the sandbox. */
	readonly ignored: readonly { readonly id: string; readonly reason: string }[];
	/** Settings this panel cannot change here, with the reason; their rows are disabled. */
	readonly locked: Readonly<Partial<Record<SandboxSettingId | SandboxListId, string>>>;
	/** A note shown under a list (another layer narrows it here). */
	readonly listNotes: Readonly<Partial<Record<SandboxListId, string>>>;
	/** The resolved filesystem policy for this workspace; undefined when it cannot be computed. */
	readonly effective:
		| {
				readonly readwritePaths: readonly string[];
				readonly readonlyPaths: readonly string[];
				readonly deniedPaths: readonly string[];
		  }
		| undefined;
	/** Hosts the egress proxy refused this session. */
	readonly blockedHosts: readonly string[];
	/** Paths the user granted for this session through an access request (`write` implies read). */
	readonly sessionPaths: { readonly write: readonly string[]; readonly read: readonly string[] };
}

/** Host effects: settings writes, grants and closing. */
export interface SandboxConfigCallbacks {
	set(change: SandboxSettingChange): void;
	/** Drop the setting's global value so the default (or another layer) applies. */
	reset(id: SandboxSettingId): void;
	addEntry(list: SandboxListId, entry: string): void;
	removeEntry(list: SandboxListId, entry: string): void;
	replaceEntry(list: SandboxListId, previous: string, next: string): void;
	/** Allow a host the proxy blocked (added to the allowlist). */
	allowHost(host: string): void;
	/** Withdraw a path granted for this session. */
	revokePath(kind: "write" | "read", path: string): void;
	close(): void;
	requestRender(): void;
}

export const SANDBOX_PAGES = ["overview", "filesystem", "network", "effective"] as const;
export type SandboxPage = (typeof SANDBOX_PAGES)[number];

const PAGE_LABELS: Record<SandboxPage, string> = {
	overview: "Overview",
	filesystem: "Filesystem",
	network: "Network",
	effective: "Effective policy",
};
const PAGE_ICONS: Record<SandboxPage, string> = {
	overview: "sliders",
	filesystem: "folder",
	network: "globe",
	effective: "list",
};
const LIST_TITLES: Record<SandboxListId, string> = {
	allowWrite: "Writable",
	allowRead: "Readable",
	denyRead: "Denied",
	allowedHosts: "Allowed hosts",
};
const LIST_HINTS: Record<SandboxListId, string> = {
	allowWrite: "Writable beyond the workspace and the private temp dir (workspace-write mode).",
	allowRead: "Readable beyond the read scope.",
	denyRead: "Neither readable nor writable; outranks the other lists.",
	allowedHosts: "Reachable in allowlist mode; *.example.com matches subdomains.",
};
const LIST_ADD_LABELS: Record<SandboxListId, string> = {
	allowWrite: "Add path",
	allowRead: "Add path",
	denyRead: "Add path",
	allowedHosts: "Add host",
};
const BLOCKED_PREFIX = "blocked:";
const SESSION_PREFIX = "session:";

/** Row ids of the blocked hosts, keyed by the display-safe host. */
function blockedRowIds(model: SandboxConfigModel): string[] {
	return model.blockedHosts.map(host => `${BLOCKED_PREFIX}${plainLine(host)}`);
}

/** A session grant's row id, keyed by kind and the display-safe path. */
function sessionRowId(kind: "write" | "read", path: string): string {
	return `${SESSION_PREFIX}${kind}:${plainLine(path)}`;
}

function sessionRowIds(model: SandboxConfigModel): string[] {
	return [
		...model.sessionPaths.write.map(path => sessionRowId("write", path)),
		...model.sessionPaths.read.map(path => sessionRowId("read", path)),
	];
}
const DISABLED_EFFECTIVE = "Resolved policy (read-only)";
const DISABLED_IGNORED = "Set by project config";
const DISABLED_WARNING = "Reported by the sandbox";
/** Status (and notice) rows kept in the plain-terminal header before the rest is cut. */
const STATUS_ROWS = 3;

/** One ANSI line of the page: a section title, or a row (a multi row expands to one line per option). */
type Line =
	| { readonly kind: "title"; readonly title: string }
	| { readonly kind: "row"; readonly id: string; readonly row: TspPrefsRow; readonly option?: string };
type RowLine = Extract<Line, { kind: "row" }>;

function isListId(value: string): value is SandboxListId {
	return (LIST_IDS as readonly string[]).includes(value);
}

function isSettingId(value: string): value is SandboxSettingId {
	return (SETTING_IDS as readonly string[]).includes(value);
}

/** `<list>:<index>`, `<list>:add` or `<list>:new` split into its parts; undefined for any other id. */
function parseListRow(id: string): { list: SandboxListId; slot: number | "add" | "new" } | undefined {
	const colon = id.indexOf(":");
	if (colon < 0) return undefined;
	const list = id.slice(0, colon);
	if (!isListId(list)) return undefined;
	const rest = id.slice(colon + 1);
	if (rest === "add" || rest === "new") return { list, slot: rest };
	const index = Number(rest);
	return Number.isSafeInteger(index) && index >= 0 ? { list, slot: index } : undefined;
}

function choiceOptions(values: readonly string[]): { value: string; label: string }[] {
	return values.map(value => ({ value, label: value }));
}

/** A disabled row carrying only a warning (its control value is empty, so the label gets the width). */
function warningRow(id: string, label: string, warning: string, disabled: string): TspPrefsRow {
	return { id, label, warning, disabled, control: { k: "text", value: "" } };
}

export class SandboxConfigOverlayComponent implements Component {
	#model: SandboxConfigModel;
	readonly #cb: SandboxConfigCallbacks;
	readonly #tabBar: TabBar;
	/** Selected line id on the current page (ANSI keys and the native focus ring). */
	#focus: string | undefined;
	/** The list a pending new entry is being added to. */
	#adding: SandboxListId | undefined;
	/** The text row whose draft is open, and the draft. */
	#editing: { row: string; input: Input } | undefined;
	/** Why the last edit was rejected; cleared by the host after a successful write. */
	#notice: string | undefined;
	#native: { signature: string; node: NativeNode } | undefined;
	#nativeHints: NativeNode | undefined;
	/** First body row shown in a plain terminal (pages taller than the screen scroll). */
	#scroll = 0;

	constructor(model: SandboxConfigModel, callbacks: SandboxConfigCallbacks) {
		this.#model = model;
		this.#cb = callbacks;
		this.#tabBar = new TabBar(
			"",
			SANDBOX_PAGES.map(id => ({ id, label: PAGE_LABELS[id] })),
			getTabBarTheme(),
		);
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			this.#focus = undefined;
			this.#scroll = 0;
			this.#editing = undefined;
			this.#adding = undefined;
			this.#cb.requestRender();
		};
	}

	/** Replace the shown data (after a write, a settings reload or a runtime change). */
	setModel(model: SandboxConfigModel): void {
		const previous = this.#model;
		this.#model = model;
		const editing = this.#editing && parseListRow(this.#editing.row);
		if (editing && typeof editing.slot === "number" && editing.slot >= model[editing.list].length) {
			this.#editing = undefined;
		}
		// An allowed blocked host or a revoked session path leaves its list: keep the selection in
		// that list, on the next row still there, so Enter cannot land on an unrelated row.
		const focus = this.#focus;
		if (focus?.startsWith(BLOCKED_PREFIX)) {
			this.#keepAmong(focus, blockedRowIds(previous), blockedRowIds(model), "allowedHosts:add");
		} else if (focus?.startsWith(SESSION_PREFIX)) {
			this.#keepAmong(focus, sessionRowIds(previous), sessionRowIds(model), "allowWrite:add");
		}
		this.#cb.requestRender();
	}

	/** Move a vanished `focus` to the next of `before` still in `after`, else to `fallback`. */
	#keepAmong(focus: string, before: readonly string[], after: readonly string[], fallback: string): void {
		if (after.includes(focus)) return;
		this.#focus = before.slice(before.indexOf(focus) + 1).find(id => after.includes(id)) ?? fallback;
		this.#cb.requestRender();
	}

	/** Show why an edit was rejected (`undefined` clears it). */
	setNotice(message: string | undefined): void {
		this.#notice = message === undefined ? undefined : plainLine(message);
		this.#cb.requestRender();
	}

	get #page(): SandboxPage {
		return SANDBOX_PAGES.find(id => id === this.#tabBar.getActiveTab().id) ?? "overview";
	}

	// ───────────────────────────── rows ─────────────────────────────

	#statusText(): string {
		const status = this.#model.status;
		switch (status.state) {
			case "off":
				return "Off";
			case "active":
				return `Active · ${plainLine(status.backend)} · network ${plainLine(status.network)}`;
			case "unavailable":
				// The consequence first: a long reason is what gets cut.
				return `Unavailable · ${status.fallback === "block" ? "contained tools fail" : "running unsandboxed"} · ${plainLine(status.reason)}`;
		}
	}

	/** `row` disabled with the lock reason when `id` is locked. */
	#lockable(id: SandboxSettingId, row: TspPrefsRow): TspPrefsRow {
		const reason = this.#model.locked[id];
		return reason ? { ...row, disabled: plainLine(reason) } : row;
	}

	#listSection(list: SandboxListId): TspPrefsSection {
		const lockedReason = this.#model.locked[list];
		const locked = lockedReason ? plainLine(lockedReason) : undefined;
		const rows: TspPrefsRow[] = this.#model[list].map((entry, index) => ({
			id: `${list}:${index}`,
			label: list === "allowedHosts" ? "Host" : "Path",
			disabled: locked,
			control: { k: "text", value: entry, mono: true },
		}));
		if (this.#adding === list) {
			rows.push({
				id: `${list}:new`,
				label: list === "allowedHosts" ? "New host" : "New path",
				control: {
					k: "text",
					value: "",
					mono: true,
					placeholder: list === "allowedHosts" ? "example.com" : "~/path",
				},
			});
		}
		rows.push({
			id: `${list}:add`,
			label: LIST_ADD_LABELS[list],
			hint: LIST_HINTS[list],
			disabled: locked,
			control: { k: "action", label: "Add", act: "add" },
		});
		const note = this.#model.listNotes[list];
		if (note) rows.push(warningRow(`${list}:note`, "Note", plainLine(note), DISABLED_IGNORED));
		return { id: list, title: LIST_TITLES[list], rows };
	}

	/** "Allowed this session": the paths granted through access requests, each with Remove; none when empty. */
	#sessionSection(): TspPrefsSection[] {
		const rows: TspPrefsRow[] = [];
		for (const kind of ["write", "read"] as const) {
			for (const path of this.#model.sessionPaths[kind]) {
				rows.push({
					id: sessionRowId(kind, path),
					label: `${kind === "write" ? "Write" : "Read"}  ${shortenPath(plainLine(path))}`,
					control: { k: "action", label: "Remove", act: "remove" },
				});
			}
		}
		return rows.length > 0 ? [{ id: "session", title: "Allowed this session", rows }] : [];
	}

	#effectiveSection(id: string, title: string, paths: readonly string[] | undefined): TspPrefsSection {
		const rows: TspPrefsRow[] = (paths ?? []).map((entry, index) => ({
			id: `${id}:${index}`,
			label: "Path",
			disabled: DISABLED_EFFECTIVE,
			control: { k: "text", value: shortenPath(plainLine(entry)), mono: true },
		}));
		if (rows.length === 0) {
			rows.push({
				id: `${id}:none`,
				label: paths ? "(none)" : "Unavailable",
				disabled: DISABLED_EFFECTIVE,
				control: { k: "text", value: "" },
			});
		}
		return { id, title, rows };
	}

	/** The sections of `page`, as the native page draws them and the ANSI list walks them. */
	#sections(page: SandboxPage): TspPrefsSection[] {
		const model = this.#model;
		switch (page) {
			case "overview": {
				const sections: TspPrefsSection[] = [
					{
						id: "sandbox",
						title: "Sandbox",
						rows: [
							this.#lockable("enabled", {
								id: "enabled",
								label: "Enabled",
								hint: "Contain agent commands in an OS sandbox.",
								control: { k: "switch", on: model.enabled },
							}),
							this.#lockable("mode", {
								id: "mode",
								label: "Mode",
								hint: "workspace-write writes the workspace and a private temp dir; read-only writes the temp dir only.",
								control: { k: "choice", value: model.mode, options: choiceOptions(MODES), style: "segmented" },
							}),
							this.#lockable("scope", {
								id: "scope",
								label: "Applies to",
								hint: "Which kinds of execution run contained.",
								control: { k: "multi", values: model.scope, options: choiceOptions(SCOPES) },
							}),
							this.#lockable("fallback", {
								id: "fallback",
								label: "If unavailable",
								hint: "warn runs unsandboxed with a warning; block fails contained tool calls.",
								control: {
									k: "choice",
									value: model.fallback,
									options: choiceOptions(FALLBACKS),
									style: "segmented",
								},
							}),
						],
					},
				];
				if (model.status.state === "active" && model.status.warnings.length > 0) {
					sections.push({
						id: "warnings",
						title: "Warnings",
						rows: model.status.warnings.map((warning, index) =>
							warningRow(`warning:${index}`, "Warning", plainLine(warning), DISABLED_WARNING),
						),
					});
				}
				if (model.ignored.length > 0) {
					sections.push({
						id: "ignored",
						title: "Ignored project values",
						rows: model.ignored.map((entry, index) =>
							warningRow(
								`ignored:${index}`,
								plainLine(entry.id).replace(/^sandbox\./, ""),
								plainLine(entry.reason),
								DISABLED_IGNORED,
							),
						),
					});
				}
				return sections;
			}
			case "filesystem":
				return [
					{
						id: "read",
						title: "Reads",
						rows: [
							this.#lockable("readScope", {
								id: "readScope",
								label: "Read scope",
								hint: "all reads the whole filesystem except denied paths; workspace reads the workspace and tool paths.",
								control: {
									k: "choice",
									value: model.readScope,
									options: choiceOptions(READ_SCOPES),
									style: "segmented",
								},
							}),
						],
					},
					this.#listSection("allowWrite"),
					this.#listSection("allowRead"),
					this.#listSection("denyRead"),
					...this.#sessionSection(),
				];
			case "network": {
				const sections: TspPrefsSection[] = [
					{
						id: "network",
						title: "Network",
						rows: [
							this.#lockable("networkMode", {
								id: "networkMode",
								label: "Mode",
								hint: "allowlist reaches listed hosts through omp's proxy; deny blocks all; allow is unrestricted.",
								control: {
									k: "choice",
									value: model.networkMode,
									options: choiceOptions(NETWORK_MODES),
									style: "segmented",
								},
							}),
						],
					},
					this.#listSection("allowedHosts"),
				];
				if (model.blockedHosts.length > 0) {
					sections.push({
						id: "blocked",
						title: "Blocked this session",
						// Keyed by (display-safe) host: a refresh that reorders the list must not retarget an Allow.
						rows: model.blockedHosts.map(host => ({
							id: `${BLOCKED_PREFIX}${plainLine(host)}`,
							label: plainLine(host),
							control: { k: "action", label: "Allow", act: "allow" },
						})),
					});
				}
				return sections;
			}
			case "effective":
				return [
					this.#effectiveSection("rw", "Writable", model.effective?.readwritePaths),
					this.#effectiveSection("ro", "Readable", model.effective?.readonlyPaths),
					this.#effectiveSection("denied", "Denied", model.effective?.deniedPaths),
				];
		}
	}

	/** The page as ANSI lines: titles, and one line per row (per option of a multi row). */
	#lines(): Line[] {
		const lines: Line[] = [];
		for (const section of this.#sections(this.#page)) {
			lines.push({ kind: "title", title: section.title });
			for (const r of section.rows) {
				if (r.control.k === "multi") {
					for (const option of r.control.options) {
						lines.push({ kind: "row", id: `${r.id}=${option.value}`, row: r, option: option.value });
					}
				} else {
					lines.push({ kind: "row", id: r.id, row: r });
				}
			}
		}
		return lines;
	}

	#selectable(lines: readonly Line[]): RowLine[] {
		return lines.filter((line): line is RowLine => line.kind === "row" && !line.row.disabled);
	}

	/**
	 * The focused line id: the selection, a multi row's first option, the
	 * Add row of a list whose focused entry is gone, else the page's first
	 * selectable line.
	 */
	#focused(lines: readonly Line[]): string | undefined {
		const selectable = this.#selectable(lines);
		const focus = this.#focus;
		if (focus === undefined) return selectable[0]?.id;
		const found = selectable.find(line => line.id === focus || line.id.startsWith(`${focus}=`));
		if (found) return found.id;
		const parsed = parseListRow(focus);
		const add = parsed && selectable.find(line => line.id === `${parsed.list}:add`);
		return (add ?? selectable[0])?.id;
	}

	// ───────────────────────────── actions ─────────────────────────────

	#beginEdit(rowId: string, value: string): void {
		const input = new Input();
		input.prompt = "";
		input.setValue(value);
		input.focused = true;
		input.onSubmit = draft => this.#commit(rowId, draft);
		input.onEscape = () => this.#cancelEdit();
		this.#editing = { row: rowId, input };
		// A new draft is a new `input` child: the card must not reuse the previous one.
		this.#native = undefined;
		this.#focus = rowId;
		this.#cb.requestRender();
	}

	/** Drop the open draft; a cancelled new entry leaves the selection on its list's Add row. */
	#cancelEdit(): void {
		const parsed = this.#editing && parseListRow(this.#editing.row);
		if (parsed?.slot === "new") this.#focus = `${parsed.list}:add`;
		this.#editing = undefined;
		this.#adding = undefined;
		this.#cb.requestRender();
	}

	/** Apply a text row's value: a new entry adds, an emptied entry is removed, a changed one replaced. */
	#commit(rowId: string, raw: string): void {
		const value = raw.trim();
		const parsed = parseListRow(rowId);
		this.#editing = undefined;
		if (!parsed || this.#model.locked[parsed.list]) return;
		if (parsed.slot === "new") {
			this.#adding = undefined;
			this.#focus = `${parsed.list}:add`;
			if (value) this.#cb.addEntry(parsed.list, value);
		} else if (typeof parsed.slot === "number") {
			const previous = this.#model[parsed.list][parsed.slot];
			if (previous !== undefined) {
				if (!value) {
					// The next entry takes this slot; with none left, `#focused` lands on the list's Add row.
					this.#focus = rowId;
					this.#cb.removeEntry(parsed.list, previous);
				} else if (value !== previous) this.#cb.replaceEntry(parsed.list, previous, value);
			}
		}
		this.#cb.requestRender();
	}

	#toggleScope(option: string): void {
		const scope = SCOPES.find(value => value === option);
		if (!scope || this.#model.locked.scope) return;
		const current = this.#model.scope;
		const next = current.includes(scope) ? current.filter(value => value !== scope) : [...current, scope];
		this.#cb.set({ id: "scope", value: SCOPES.filter(value => next.includes(value)) });
	}

	/** Step a choice row by `delta` options, wrapping. */
	#cycleChoice(id: string, delta: number): void {
		if (isSettingId(id) && this.#model.locked[id]) return;
		const step = <T extends string>(values: readonly T[], current: T): T =>
			values[(values.indexOf(current) + delta + values.length) % values.length]!;
		const model = this.#model;
		switch (id) {
			case "mode":
				this.#cb.set({ id, value: step(MODES, model.mode) });
				return;
			case "fallback":
				this.#cb.set({ id, value: step(FALLBACKS, model.fallback) });
				return;
			case "readScope":
				this.#cb.set({ id, value: step(READ_SCOPES, model.readScope) });
				return;
			case "networkMode":
				this.#cb.set({ id, value: step(NETWORK_MODES, model.networkMode) });
				return;
		}
	}

	/** Enter on a line (or a native activate/click): toggle, step, open the draft or run the action. */
	#activate(id: string): void {
		const eq = id.indexOf("=");
		if (eq >= 0 && id.slice(0, eq) === "scope") {
			this.#toggleScope(id.slice(eq + 1));
			return;
		}
		if (id === "enabled") {
			if (!this.#model.locked.enabled) this.#cb.set({ id: "enabled", value: !this.#model.enabled });
			return;
		}
		if (id === "mode" || id === "fallback" || id === "readScope" || id === "networkMode") {
			this.#cycleChoice(id, 1);
			return;
		}
		if (id.startsWith(BLOCKED_PREFIX)) {
			const key = id.slice(BLOCKED_PREFIX.length);
			const host = this.#model.blockedHosts.find(blocked => plainLine(blocked) === key);
			if (host !== undefined) this.#cb.allowHost(host);
			return;
		}
		if (id.startsWith(SESSION_PREFIX)) {
			for (const kind of ["write", "read"] as const) {
				const path = this.#model.sessionPaths[kind].find(entry => sessionRowId(kind, entry) === id);
				if (path !== undefined) {
					this.#cb.revokePath(kind, path);
					return;
				}
			}
			return;
		}
		const parsed = parseListRow(id);
		if (!parsed || this.#model.locked[parsed.list]) return;
		if (parsed.slot === "add") {
			this.#adding = parsed.list;
			this.#beginEdit(`${parsed.list}:new`, "");
		} else if (typeof parsed.slot === "number") {
			const entry = this.#model[parsed.list][parsed.slot];
			if (entry !== undefined) this.#beginEdit(id, entry);
		}
	}

	/** A typed value from the native page (`null` resets a setting / removes an entry). */
	#change(item: string, value: boolean | number | string | readonly string[] | null): void {
		if (parseListRow(item)) {
			if (typeof value === "string") this.#commit(item, value);
			else if (value === null) this.#commit(item, "");
			return;
		}
		if (!isSettingId(item) || this.#model.locked[item]) return;
		if (value === null) {
			this.#cb.reset(item);
			return;
		}
		switch (item) {
			case "enabled":
				if (typeof value === "boolean") this.#cb.set({ id: item, value });
				return;
			case "mode": {
				const mode = MODES.find(m => m === value);
				if (mode) this.#cb.set({ id: item, value: mode });
				return;
			}
			case "fallback": {
				const fallback = FALLBACKS.find(m => m === value);
				if (fallback) this.#cb.set({ id: item, value: fallback });
				return;
			}
			case "readScope": {
				const readScope = READ_SCOPES.find(m => m === value);
				if (readScope) this.#cb.set({ id: item, value: readScope });
				return;
			}
			case "networkMode": {
				const networkMode = NETWORK_MODES.find(m => m === value);
				if (networkMode) this.#cb.set({ id: item, value: networkMode });
				return;
			}
			case "scope":
				if (Array.isArray(value)) this.#cb.set({ id: item, value: SCOPES.filter(scope => value.includes(scope)) });
				return;
		}
	}

	// ───────────────────────────── keyboard ─────────────────────────────

	handleInput(data: string): void {
		const editing = this.#editing;
		if (editing) {
			editing.input.handleInput(data);
			this.#cb.requestRender();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#cb.close();
			return;
		}
		const lines = this.#lines();
		const selectable = this.#selectable(lines);
		const focused = this.#focused(lines);
		const index = selectable.findIndex(line => line.id === focused);
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
			// A page with nothing to select (the resolved policy) scrolls instead.
			if (selectable.length === 0) this.#scroll = Math.max(0, this.#scroll + delta);
			else this.#focus = selectable[(index + delta + selectable.length) % selectable.length]!.id;
			this.#cb.requestRender();
			return;
		}
		// ←→ step a focused choice; otherwise they (and Tab) switch pages.
		if (
			focused &&
			selectable[index]?.row.control.k === "choice" &&
			(matchesKey(data, "left") || matchesKey(data, "right"))
		) {
			this.#cycleChoice(focused, matchesKey(data, "left") ? -1 : 1);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		if (focused === undefined) return;
		if (kb.matches(data, "tui.select.confirm") || data === " ") {
			this.#activate(focused);
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || kb.matches(data, "tui.editor.deleteCharForward")) {
			const parsed = parseListRow(focused);
			if (parsed && typeof parsed.slot === "number") this.#commit(focused, "");
		}
	}

	// ───────────────────────────── ANSI ─────────────────────────────

	#controlText(line: RowLine, width: number): string {
		const control: TspPrefsControl = line.row.control;
		if (this.#editing?.row === line.id) return this.#editing.input.render(width)[0] ?? "";
		switch (control.k) {
			case "switch":
				return control.on ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
			case "choice":
				return control.options
					.map(option =>
						option.value === control.value
							? theme.fg("accent", `[${option.label}]`)
							: theme.fg("dim", option.label),
					)
					.join(" ");
			case "multi":
				return control.values.includes(line.option ?? "") ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			case "text":
				return control.value ? plainLine(control.value) : theme.fg("dim", control.placeholder ?? "");
			case "action":
				return theme.fg(line.row.disabled ? "dim" : "accent", `[${control.label}]`);
			default:
				return "";
		}
	}

	/**
	 * Width of a line's label column. Action rows (a blocked host and its
	 * Allow) and read-only rows without a value (warnings, ignored values) give
	 * the label everything their control does not use.
	 */
	#labelWidth(line: RowLine, inner: number, column: number): number {
		const control = line.row.control;
		if (control.k === "action") return Math.max(column, inner - 3 - visibleWidth(`[${control.label}]`));
		if (line.row.disabled && control.k === "text" && !control.value) return Math.max(column, inner - 3);
		return column;
	}

	/** Why a row the panel cannot change is locked: on the setting's row, and on a locked list's Add row. */
	#lockReason(row: TspPrefsRow): string | undefined {
		if (isSettingId(row.id)) return this.#model.locked[row.id] && row.disabled;
		const parsed = parseListRow(row.id);
		return parsed?.slot === "add" && this.#model.locked[parsed.list] ? row.disabled : undefined;
	}

	/** `text` soft-wrapped to `width`, at most `max` rows (the last cut when more remain). */
	#wrapRows(content: string, width: number, max: number): string[] {
		const rows = Bun.wrapAnsi(content, Math.max(1, width), { hard: true }).split("\n");
		if (rows.length <= max) return rows;
		return [...rows.slice(0, max - 1), truncateToWidth(rows.slice(max - 1).join(" "), width)];
	}

	/**
	 * The frame fills the screen: tabs, the status (and a rejected edit's
	 * notice), the page's rows in a window that keeps the selection in view
	 * (or scrolls with ↑↓ on a read-only page), and the key hints.
	 */
	render(width: number): readonly string[] {
		const inner = Math.max(1, width - 4);
		const header = this.#tabBar.render(inner).map(line => truncateToWidth(line, inner));
		header.push(
			...this.#wrapRows(`Status: ${this.#statusText()}`, inner, STATUS_ROWS).map(r => theme.fg("muted", r)),
		);
		if (this.#notice) {
			header.push(...this.#wrapRows(`⚠ ${this.#notice}`, inner, STATUS_ROWS).map(r => theme.fg("warning", r)));
		}
		const bodyRows = Math.max(3, Math.max(12, process.stdout.rows || 40) - header.length - 5);
		const lines = this.#lines();
		const focused = this.#focused(lines);
		const column = Math.min(22, Math.max(8, Math.floor(inner / 3)));
		const body: string[] = [];
		let focusRow = -1;
		for (const line of lines) {
			if (line.kind === "title") {
				body.push(truncateToWidth(theme.bold(line.title), inner));
				continue;
			}
			const selected = line.id === focused;
			if (selected) focusRow = body.length;
			const marker = selected ? theme.fg("accent", "› ") : "  ";
			const labelWidth = this.#labelWidth(line, inner, column);
			const valueWidth = Math.max(1, inner - 2 - labelWidth - 1);
			const label = padToWidth(truncateToWidth(line.option ?? line.row.label, labelWidth), labelWidth);
			const styledLabel = line.row.disabled ? theme.fg("dim", label) : selected ? theme.fg("accent", label) : label;
			body.push(
				truncateToWidth(
					`${marker}${styledLabel} ${truncateToWidth(this.#controlText(line, valueWidth), valueWidth)}`,
					inner,
				),
			);
			// A locked multi row (scope) names its reason once, under its last option.
			const control = line.row.control;
			const last = !line.option || (control.k === "multi" && control.options.at(-1)?.value === line.option);
			const lock = last ? this.#lockReason(line.row) : undefined;
			if (lock) body.push(truncateToWidth(theme.fg("dim", `    ${lock}`), inner));
			if (line.row.warning && !line.option) {
				for (const warning of Bun.wrapAnsi(line.row.warning, Math.max(1, inner - 6), { hard: true }).split("\n")) {
					body.push(theme.fg("warning", `    ⚠ ${warning}`));
				}
			}
		}
		let scroll = this.#scroll;
		if (focusRow >= 0) {
			// Keep the selection, and the section title just above it, on screen.
			if (focusRow - 1 < scroll) scroll = Math.max(0, focusRow - 1);
			else if (focusRow >= scroll + bodyRows) scroll = focusRow - bodyRows + 1;
		}
		scroll = Math.min(scroll, Math.max(0, body.length - bodyRows));
		this.#scroll = scroll;
		const out = [topBorder(width, "Sandbox"), ...header.map(line => row(line, width)), divider(width)];
		for (let i = 0; i < bodyRows; i++) out.push(row(body[scroll + i] ?? "", width));
		const hints = this.#editing
			? "enter save · esc cancel · empty text removes the entry"
			: "↑↓ move · enter toggle/edit · ←→ change · tab page · del remove · esc close";
		out.push(divider(width), row(truncateToWidth(theme.fg("dim", hints), inner), width), bottomBorder(width));
		return out;
	}

	// ───────────────────────────── native ─────────────────────────────

	/** Docks beside the transcript, like `/settings`, where the terminal draws `prefs` with `aside`. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/** The `prefs` page where the terminal draws it, else a root card over the same rows. */
	describe(cx: DescribeContext): NativeNode {
		return cx.supports("prefs") ? this.#describePrefs() : this.#describeCard();
	}

	#describePrefs(): NativeNode {
		const lines = this.#lines();
		const focusLine = this.#focused(lines);
		// A multi row's options are one row natively.
		const focus = focusLine?.includes("=") ? focusLine.slice(0, focusLine.indexOf("=")) : (focusLine ?? null);
		const editing = this.#editing
			? { row: this.#editing.row, draft: this.#editing.input.getValue(), cursor: this.#editing.input.getCursor() }
			: null;
		const status = this.#statusText();
		const props: TspPrefsProps = {
			title: "Sandbox",
			pages: SANDBOX_PAGES.map(id => ({ id, label: PAGE_LABELS[id], icon: PAGE_ICONS[id] })),
			page: this.#page,
			lead: this.#notice ? `${status} — ${this.#notice}` : status,
			sections: this.#sections(this.#page),
			focus,
			editing,
		};
		const signature = `prefs:${JSON.stringify(props)}`;
		if (this.#native?.signature === signature) return this.#native.node;
		const root = node("prefs", props);
		this.#native = { signature, node: root };
		return root;
	}

	#describeCard(): NativeNode {
		const lines = this.#lines();
		const focused = this.#focused(lines);
		const items: NativeChild[] = [];
		for (const line of lines) {
			if (line.kind === "title") {
				items.push(
					node("item", { label: [span(line.title, "strong")], disabled: true }, undefined, `t:${line.title}`),
				);
				continue;
			}
			const control = line.row.control;
			const value =
				this.#editing?.row === line.id
					? "editing…"
					: control.k === "switch"
						? control.on
							? "on"
							: "off"
						: control.k === "choice"
							? control.value
							: control.k === "multi"
								? control.values.includes(line.option ?? "")
									? "✓"
									: "–"
								: control.k === "text"
									? plainLine(control.value)
									: control.k === "action"
										? control.label
										: "";
			const lock = this.#lockReason(line.row);
			items.push(
				node(
					"item",
					{
						label: line.option ?? line.row.label,
						value,
						detail: line.row.warning
							? [span(line.row.warning, "warning")]
							: lock
								? [span(lock, "dim")]
								: undefined,
						disabled: line.row.disabled !== undefined || undefined,
					},
					undefined,
					line.id,
				),
			);
		}
		const status = this.#statusText();
		const signature = `card:${JSON.stringify({ page: this.#page, status, notice: this.#notice, items, focused, editing: this.#editing?.row })}`;
		if (this.#native?.signature === signature) return this.#native.node;
		const children: NativeChild[] = [this.#tabBar, text([span(status, "muted")], { wrap: "word" })];
		if (this.#notice) children.push(text([span(this.#notice, "warning")], { wrap: "word" }));
		children.push(selectList("rows", items, { selected: focused ?? null }));
		// The draft describes itself (an `input`), so the terminal's own edits reach it directly.
		if (this.#editing) children.push(col([this.#editing.input], { role: "omp.sandbox.draft" }));
		this.#nativeHints ??= hintsRow([
			actionHint(["tui.select.up", "tui.select.down"], "move"),
			actionHint("tui.select.confirm", "toggle / edit"),
			actionHint("tui.select.cancel", "close"),
		]);
		children.push(this.#nativeHints);
		const root = overlayCard("omp.overlay.sandbox", "Sandbox", children);
		this.#native = { signature, node: root };
		return root;
	}

	/**
	 * Native events: a page click switches pages; a value change applies (a
	 * list entry's text commits like Enter: emptied removes); an action row adds
	 * an entry or allows a blocked host; closing the open draft cancels it and
	 * closing the page closes the overlay; draft edits go to the draft; picking
	 * another row while a draft is open cancels it. The card's tab strip is the
	 * {@link TabBar}'s own.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "edit" || event.type === "undo") {
			this.#editing?.input.handleNativeEvent(event);
			this.#cb.requestRender();
			return;
		}
		if ((event.type === "select" || event.type === "activate") && this.#editing && event.item !== this.#editing.row) {
			this.#cancelEdit();
		}
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) {
					this.#tabBar.selectTab(event.value);
				} else if (event.act === "close") {
					if (event.value !== undefined && this.#editing) this.#cancelEdit();
					else if (event.value === undefined) this.#cb.close();
				} else if ((event.act === "add" || event.act === "allow" || event.act === "remove") && event.value) {
					if (this.#editing) this.#cancelEdit();
					this.#activate(event.value);
				}
				return;
			case "change":
				this.#change(event.item, event.value);
				return;
			case "activate":
				if (this.#editing?.row !== event.item) this.#activate(event.item);
				return;
			case "select":
				this.#focus = event.item;
				this.#cb.requestRender();
				return;
			case "toggle":
			case "send":
				return;
		}
	}
}
