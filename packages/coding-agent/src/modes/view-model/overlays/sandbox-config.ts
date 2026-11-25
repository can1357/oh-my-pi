/**
 * The `/sandbox` sheet's data side: the model the host supplies, the edits it
 * reports, and the pure rules the sheet (`ui/overlays/sandbox`) draws and
 * navigates by — the `prefs` sections of each page, row ids, where the
 * selection goes when the model changes, and how a choice steps.
 *
 * Pages: Overview (status, enable, mode, scope, fallback, runtime warnings,
 * ignored project values, host actions granted this session), Filesystem
 * (read scope, the writable/readable/denied path lists, paths granted this
 * session, protected paths sandboxed commands created), Network (mode,
 * allowed hosts, hosts blocked this session) and Effective policy (the
 * resolved lists, read-only). A list is one text row per entry plus an Add
 * row; clearing an entry's text removes it.
 */
import type { TspPrefsProps, TspPrefsRow, TspPrefsSection } from "@oh-my-pi/pi-wire";
import type { SandboxMode, SandboxNetworkMode, SandboxReadScope, SandboxScope } from "../../../sandbox/types";
import { plainLine } from "../../../extensibility/inventory/display-text";
import { shortenPath } from "../../../utils/render-utils";

type SandboxFallbackValue = "warn" | "block";

const MODES: readonly SandboxMode[] = ["workspace-write", "read-only"];
const NETWORK_MODES: readonly SandboxNetworkMode[] = ["allowlist", "deny", "allow"];
const SCOPES: readonly SandboxScope[] = ["bash", "eval", "exec"];
const FALLBACKS: readonly SandboxFallbackValue[] = ["warn", "block"];
const READ_SCOPES: readonly SandboxReadScope[] = ["all", "workspace"];

/** The runtime's status, as the sheet shows it. */
type SandboxOverlayStatus =
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
export const SANDBOX_LIST_IDS: readonly SandboxListId[] = ["allowWrite", "allowRead", "denyRead", "allowedHosts"];

/** One scalar setting change, typed by setting. */
export type SandboxSettingChange =
	| { readonly id: "enabled"; readonly value: boolean }
	| { readonly id: "mode"; readonly value: SandboxMode }
	| { readonly id: "scope"; readonly value: readonly SandboxScope[] }
	| { readonly id: "fallback"; readonly value: SandboxFallbackValue }
	| { readonly id: "readScope"; readonly value: SandboxReadScope }
	| { readonly id: "networkMode"; readonly value: SandboxNetworkMode };
export type SandboxSettingId = SandboxSettingChange["id"];
export const SANDBOX_SETTING_IDS: readonly SandboxSettingId[] = [
	"enabled",
	"mode",
	"scope",
	"fallback",
	"readScope",
	"networkMode",
];

/** Everything the sheet shows. */
export interface SandboxConfigModel {
	readonly status: SandboxOverlayStatus;
	/** Effective values (after the project-may-only-tighten rule). */
	readonly enabled: boolean;
	readonly mode: SandboxMode;
	readonly fallback: SandboxFallbackValue;
	readonly readScope: SandboxReadScope;
	readonly networkMode: SandboxNetworkMode;
	/** Network modes the host cannot enforce, with the reason (missing packages, blocked namespaces); never written. */
	readonly networkUnavailable: Readonly<Partial<Record<SandboxNetworkMode, string>>>;
	/** Scope and the lists as the non-project layers hold them: what a global write replaces. */
	readonly scope: readonly SandboxScope[];
	readonly allowWrite: readonly string[];
	readonly allowRead: readonly string[];
	readonly denyRead: readonly string[];
	readonly allowedHosts: readonly string[];
	/** Project-layer values dropped because they would loosen the sandbox. */
	readonly ignored: readonly { readonly id: string; readonly reason: string }[];
	/** Settings this sheet cannot change here, with the reason; their rows are disabled. */
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
	/** Actions omp performs on the host outside the sandbox, granted for this session (debug, computer, browser). */
	readonly sessionExec: readonly string[];
	/** Protected paths a sandboxed command created or replaced; omp skips them until trusted. */
	readonly created: readonly { readonly path: string; readonly exists: boolean }[];
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
	/** Withdraw an exec action granted for this session. */
	revokeExec(target: string): void;
	/** Trust a path a sandboxed command created: drop its record and allow writing it for the session. */
	trustCreated(path: string): void;
	/** Drop the record of a created path that no longer exists. */
	forgetCreated(path: string): void;
	close(): void;
}

export const SANDBOX_PAGES = ["overview", "filesystem", "network", "effective"] as const;
export type SandboxPage = (typeof SANDBOX_PAGES)[number];

/** The sheet's page strip. */
export const SANDBOX_PAGE_TABS: TspPrefsProps["pages"] = [
	{ id: "overview", label: "Overview", icon: "sliders" },
	{ id: "filesystem", label: "Filesystem", icon: "folder" },
	{ id: "network", label: "Network", icon: "globe" },
	{ id: "effective", label: "Effective policy", icon: "list" },
];

export function isSandboxPage(value: string): value is SandboxPage {
	return (SANDBOX_PAGES as readonly string[]).includes(value);
}

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
const BLOCKED_PREFIX = "blocked:";
const SESSION_PREFIX = "session:";
const EXEC_PREFIX = "exec:";
const TRUST_PREFIX = "created:trust:";
const FORGET_PREFIX = "created:remove:";
/**
 * Focus value for "nothing selected": it matches no row, so Enter does nothing and ←→ switch
 * pages until the user moves the selection. A freshly opened sheet pins its first selectable row;
 * after a page switch, or once the selected row vanished or got disabled, the selection is a row
 * that cannot widen access or change a setting on one more Enter (an enabled Add row, or a
 * narrowing Revoke/Remove row), else nothing.
 */
export const NO_FOCUS = "";

const DISABLED_EFFECTIVE = "Resolved policy (read-only)";
const DISABLED_UNAVAILABLE = "Unavailable on this host";
const UNAVAILABLE_SUFFIX = " (unavailable)";
const DISABLED_IGNORED = "Set by project config";
const DISABLED_WARNING = "Reported by the sandbox";

export function isSandboxListId(value: string): value is SandboxListId {
	return (SANDBOX_LIST_IDS as readonly string[]).includes(value);
}

function isSandboxSettingId(value: string): value is SandboxSettingId {
	return (SANDBOX_SETTING_IDS as readonly string[]).includes(value);
}

const ENTRY_SEGMENT = "entry:";

/** What {@link listEntryId} escapes: `%`, `=`, C0, DEL and C1 controls. */
const ID_ESCAPED = /[%=\x00-\x1F\x7F-\x9F]/g;

/**
 * A list entry's row id: `<list>:entry:<value>`, with `%`, `=` (it separates a menu row's option
 * from its row id) and every control character (tabs, line breaks, ESC: none may reach a native
 * prefs page, ids included) escaped as `%XX`, so any string, lone surrogates included, is a valid
 * id. Keyed by value, not position: a reload that removes or reorders entries leaves a selection
 * on its own entry or on nothing, never on a different entry that moved into its slot.
 */
export function listEntryId(list: SandboxListId, entry: string): string {
	return `${list}:${ENTRY_SEGMENT}${entry.replace(ID_ESCAPED, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}`;
}

/** The distinct entries of a list in order: the host removes or replaces every copy of a value at once. */
export function listEntries(model: SandboxConfigModel, list: SandboxListId): string[] {
	return [...new Set(model[list])];
}

type ListRow =
	| { readonly list: SandboxListId; readonly kind: "add" | "new" }
	| { readonly list: SandboxListId; readonly kind: "entry"; readonly entry: string };

/** `<list>:entry:<value>`, `<list>:add` or `<list>:new` split into its parts; undefined for any other id. */
export function parseListRow(id: string): ListRow | undefined {
	const colon = id.indexOf(":");
	if (colon < 0) return undefined;
	const list = id.slice(0, colon);
	if (!isSandboxListId(list)) return undefined;
	const rest = id.slice(colon + 1);
	if (rest === "add" || rest === "new") return { list, kind: rest };
	if (!rest.startsWith(ENTRY_SEGMENT)) return undefined;
	const entry = rest
		.slice(ENTRY_SEGMENT.length)
		.replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
	return { list, kind: "entry", entry };
}

/** Whether `id` names a list entry the model holds. */
function hasListEntry(model: SandboxConfigModel, id: string): boolean {
	const parsed = parseListRow(id);
	return parsed?.kind === "entry" && model[parsed.list].includes(parsed.entry);
}

/** Row ids of the blocked hosts, keyed by the display-safe host. */
function blockedRowId(host: string): string {
	return `${BLOCKED_PREFIX}${plainLine(host)}`;
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

function execRowId(target: string): string {
	return `${EXEC_PREFIX}${plainLine(target)}`;
}

/** The status line: the consequence first, so a long reason is what gets cut. */
export function sandboxStatusText(model: SandboxConfigModel): string {
	const status = model.status;
	switch (status.state) {
		case "off":
			return "Off";
		case "active":
			return `Active · ${plainLine(status.backend)} · network ${plainLine(status.network)}`;
		case "unavailable":
			return `Unavailable · ${status.fallback === "block" ? "contained tools fail" : "running unsandboxed"} · ${plainLine(status.reason)}`;
	}
}

function choiceOptions(values: readonly string[]): { value: string; label: string }[] {
	return values.map(value => ({ value, label: value }));
}

/** A reason as one display-safe line; never empty, so an unavailable option always names something. */
function unavailableReason(reason: string): string {
	return plainLine(reason) || DISABLED_UNAVAILABLE;
}

/** The network options with the unavailable ones labelled and carrying their reason as the detail. */
function networkOptions(
	unavailable: SandboxConfigModel["networkUnavailable"],
): { value: string; label: string; detail?: string }[] {
	return NETWORK_MODES.map(value => {
		const reason = unavailable[value];
		return reason === undefined
			? { value, label: value }
			: { value, label: `${value}${UNAVAILABLE_SUFFIX}`, detail: unavailableReason(reason) };
	});
}

/** A disabled row carrying only a warning (its control value is empty). */
function warningRow(id: string, label: string, warning: string, disabled: string): TspPrefsRow {
	return { id, label, warning, disabled, control: { k: "text", value: "" } };
}

/** `row` disabled with the lock reason when `id` is locked. */
function lockable(model: SandboxConfigModel, id: SandboxSettingId, row: TspPrefsRow): TspPrefsRow {
	const reason = model.locked[id];
	return reason ? { ...row, disabled: plainLine(reason) } : row;
}

function listSection(
	model: SandboxConfigModel,
	list: SandboxListId,
	adding: SandboxListId | undefined,
): TspPrefsSection {
	const lockedReason = model.locked[list];
	const locked = lockedReason ? plainLine(lockedReason) : undefined;
	const host = list === "allowedHosts";
	const rows: TspPrefsRow[] = listEntries(model, list).map(entry => ({
		id: listEntryId(list, entry),
		label: host ? "Host" : "Path",
		disabled: locked,
		control: { k: "text", value: plainLine(entry), mono: true },
	}));
	if (adding === list) {
		rows.push({
			id: `${list}:new`,
			label: host ? "New host" : "New path",
			control: { k: "text", value: "", mono: true, placeholder: host ? "example.com" : "~/path" },
		});
	}
	rows.push({
		id: `${list}:add`,
		label: host ? "Add host" : "Add path",
		hint: LIST_HINTS[list],
		disabled: locked,
		control: { k: "action", label: "Add", act: "add" },
	});
	const note = model.listNotes[list];
	if (note) rows.push(warningRow(`${list}:note`, "Note", plainLine(note), DISABLED_IGNORED));
	return { id: list, title: LIST_TITLES[list], rows };
}

/** "Allowed this session": the paths granted through access requests, each with Remove; none when empty. */
function sessionSection(model: SandboxConfigModel): TspPrefsSection[] {
	const rows: TspPrefsRow[] = [];
	for (const kind of ["write", "read"] as const) {
		for (const path of model.sessionPaths[kind]) {
			rows.push({
				id: sessionRowId(kind, path),
				label: `${kind === "write" ? "Write" : "Read"}  ${shortenPath(plainLine(path))}`,
				control: { k: "action", label: "Remove", act: "remove" },
			});
		}
	}
	return rows.length > 0 ? [{ id: "session", title: "Allowed this session", rows }] : [];
}

/** "Host actions allowed this session": exec grants, each with Revoke; none when empty. */
function execSection(model: SandboxConfigModel): TspPrefsSection[] {
	const rows: TspPrefsRow[] = model.sessionExec.map(target => ({
		id: execRowId(target),
		label: plainLine(target),
		control: { k: "action", label: "Revoke", act: "revoke" },
	}));
	return rows.length > 0 ? [{ id: "exec", title: "Host actions allowed this session", rows }] : [];
}

/** "Created by sandboxed commands": per record a Trust row and a Remove row (disabled while the path exists). */
function createdSection(model: SandboxConfigModel): TspPrefsSection[] {
	const rows = model.created.flatMap(({ path, exists }): TspPrefsRow[] => {
		const shown = shortenPath(plainLine(path));
		return [
			{
				id: `${TRUST_PREFIX}${plainLine(path)}`,
				label: exists ? shown : `${shown} (gone)`,
				hint: "Created or replaced by a sandboxed command; omp skips it until you trust it.",
				control: { k: "action", label: "Trust", act: "trust" },
			},
			{
				id: `${FORGET_PREFIX}${plainLine(path)}`,
				label: "Remove record",
				...(exists ? { disabled: "Still exists: trust it, or delete it first" } : {}),
				control: { k: "action", label: "Remove", act: "remove" },
			},
		];
	});
	return rows.length > 0 ? [{ id: "created", title: "Created by sandboxed commands", rows }] : [];
}

function effectiveSection(id: string, title: string, paths: readonly string[] | undefined): TspPrefsSection {
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

/** Disabled warning rows naming why each of `modes` the host cannot enforce is unavailable; none for the others. */
function unavailableRows(model: SandboxConfigModel, modes: readonly SandboxNetworkMode[]): TspPrefsRow[] {
	return modes.flatMap(mode => {
		const reason = model.networkUnavailable[mode];
		return reason === undefined
			? []
			: [warningRow(`networkUnavailable:${mode}`, mode, unavailableReason(reason), DISABLED_UNAVAILABLE)];
	});
}

/** The sections of `page`; `adding` is the list a new entry is being typed into. */
export function sandboxSections(
	model: SandboxConfigModel,
	page: SandboxPage,
	adding: SandboxListId | undefined,
): TspPrefsSection[] {
	switch (page) {
		case "overview": {
			const sections: TspPrefsSection[] = [
				{
					id: "sandbox",
					title: "Sandbox",
					rows: [
						lockable(model, "enabled", {
							id: "enabled",
							label: "Enabled",
							hint: "Contain agent commands in an OS sandbox.",
							control: { k: "switch", on: model.enabled },
						}),
						lockable(model, "mode", {
							id: "mode",
							label: "Mode",
							hint: "workspace-write writes the workspace and a private temp dir; read-only writes the temp dir only.",
							control: { k: "choice", value: model.mode, options: choiceOptions(MODES), style: "segmented" },
						}),
						lockable(model, "scope", {
							id: "scope",
							label: "Applies to",
							hint: "Which kinds of execution run contained.",
							control: { k: "multi", values: model.scope, options: choiceOptions(SCOPES) },
						}),
						lockable(model, "fallback", {
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
			// An active sandbox already lists the reason among its warnings; otherwise say why the mode is denied.
			const degraded = model.status.state === "active" ? [] : unavailableRows(model, [model.networkMode]);
			if (degraded.length > 0) sections.push({ id: "network-unavailable", title: "Network", rows: degraded });
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
			sections.push(...execSection(model));
			return sections;
		}
		case "filesystem":
			return [
				{
					id: "read",
					title: "Reads",
					rows: [
						lockable(model, "readScope", {
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
				listSection(model, "allowWrite", adding),
				listSection(model, "allowRead", adding),
				listSection(model, "denyRead", adding),
				...sessionSection(model),
				...createdSection(model),
			];
		case "network": {
			const sections: TspPrefsSection[] = [
				{
					id: "network",
					title: "Network",
					rows: [
						lockable(model, "networkMode", {
							id: "networkMode",
							label: "Mode",
							hint: "allowlist reaches listed hosts through omp's proxy; deny blocks all; allow is unrestricted.",
							control: {
								k: "choice",
								value: model.networkMode,
								options: networkOptions(model.networkUnavailable),
								style: "segmented",
							},
						}),
						...unavailableRows(model, NETWORK_MODES),
					],
				},
				listSection(model, "allowedHosts", adding),
			];
			if (model.blockedHosts.length > 0) {
				sections.push({
					id: "blocked",
					title: "Blocked this session",
					// Keyed by (display-safe) host: a refresh that reorders the list must not retarget an Allow.
					rows: model.blockedHosts.map(host => ({
						id: blockedRowId(host),
						label: plainLine(host),
						control: { k: "action", label: "Allow", act: "allow" },
					})),
				});
			}
			return sections;
		}
		case "effective":
			return [
				effectiveSection("rw", "Writable", model.effective?.readwritePaths),
				effectiveSection("ro", "Readable", model.effective?.readonlyPaths),
				effectiveSection("denied", "Denied", model.effective?.deniedPaths),
			];
	}
}

/** The rows of `sections` in order. */
export function sectionRows(sections: readonly TspPrefsSection[]): TspPrefsRow[] {
	return sections.flatMap(section => section.rows);
}

/**
 * The row `focus` selects: the row itself when enabled; for a list entry that no longer resolves
 * (it vanished or is disabled), its list's Add row when that is enabled; else nothing (as after
 * {@link NO_FOCUS}). Never falls back onto a setting. On a page with no enabled row (the resolved
 * policy) the selection may rest on a disabled row, so the list scrolls.
 */
export function resolveSandboxFocus(sections: readonly TspPrefsSection[], focus: string): TspPrefsRow | undefined {
	if (focus === NO_FOCUS) return undefined;
	const rows = sectionRows(sections);
	const selectable = rows.filter(row => !row.disabled);
	if (selectable.length === 0) return rows.find(row => row.id === focus);
	const found = selectable.find(row => row.id === focus);
	if (found) return found;
	const parsed = parseListRow(focus);
	return parsed && selectable.find(row => row.id === `${parsed.list}:add`);
}

/**
 * Where the selection goes once `next` replaces `previous`: a vanished row moves onto a row whose
 * Enter cannot widen access — an allowed host to its list's Add row, a revoked session path to the
 * next session path (else the Writable Add row), a revoked host action to the previous one (else
 * nothing), a trusted or forgotten record to the nearest enabled Remove row (else the Writable Add
 * row). `renamed` is an entry edit awaiting the write: once the new value is listed (and the old
 * one gone), the selection follows the entry to it.
 */
export function followSandboxFocus(
	focus: string,
	previous: SandboxConfigModel,
	next: SandboxConfigModel,
	renamed?: { readonly from: string; readonly to: string },
): string {
	if (renamed && focus === renamed.from && !hasListEntry(next, renamed.from) && hasListEntry(next, renamed.to)) {
		return renamed.to;
	}
	const keepAmong = (before: readonly string[], after: readonly string[], fallback: string): string =>
		after.includes(focus)
			? focus
			: (before.slice(before.indexOf(focus) + 1).find(id => after.includes(id)) ?? fallback);
	if (focus.startsWith(BLOCKED_PREFIX)) {
		// Allow widens access: the next blocked host must not take the selection, or a second Enter allows it too.
		return next.blockedHosts.map(blockedRowId).includes(focus) ? focus : "allowedHosts:add";
	}
	if (focus.startsWith(SESSION_PREFIX))
		return keepAmong(sessionRowIds(previous), sessionRowIds(next), "allowWrite:add");
	if (focus.startsWith(EXEC_PREFIX)) {
		// Revoking the last grant must not land on a setting: the previous grant, else nothing.
		const before = previous.sessionExec.map(execRowId);
		const after = next.sessionExec.map(execRowId);
		const earlier = before.slice(0, Math.max(0, before.indexOf(focus))).reverse();
		return keepAmong(before, after, earlier.find(id => after.includes(id)) ?? NO_FOCUS);
	}
	if (focus.startsWith(TRUST_PREFIX) || focus.startsWith(FORGET_PREFIX)) return followCreated(focus, previous, next);
	return focus;
}

/**
 * A created-path row vanished or became disabled: the nearest record whose Remove row is enabled
 * (the next, else the previous), else `allowWrite:add`. Always a Remove row, never a Trust row, so
 * the Enter that follows a Trust or a Remove cannot grant a write. A Remove row is enabled only
 * while its path is gone.
 */
function followCreated(focus: string, previous: SandboxConfigModel, next: SandboxConfigModel): string {
	const trust = focus.startsWith(TRUST_PREFIX);
	const key = focus.slice((trust ? TRUST_PREFIX : FORGET_PREFIX).length);
	const before = previous.created.map(({ path }) => plainLine(path));
	const removable = new Set(next.created.filter(({ exists }) => !exists).map(({ path }) => plainLine(path)));
	const present = trust ? next.created.some(({ path }) => plainLine(path) === key) : removable.has(key);
	if (present) return focus;
	const index = before.indexOf(key);
	const target =
		before.slice(index + 1).find(path => removable.has(path)) ??
		before
			.slice(0, Math.max(index, 0))
			.reverse()
			.find(path => removable.has(path));
	return target === undefined ? "allowWrite:add" : `${FORGET_PREFIX}${target}`;
}

/** What an edit asks of the host: a write, a reset, or (refused) a notice naming why. */
export type SandboxEdit =
	| { readonly k: "set"; readonly change: SandboxSettingChange }
	| { readonly k: "reset"; readonly id: SandboxSettingId }
	| { readonly k: "notice"; readonly message: string };

/** The scope with `option` toggled, in canonical order; undefined for an unknown option or a locked scope. */
export function toggleSandboxScope(model: SandboxConfigModel, option: string): SandboxEdit | undefined {
	const scope = SCOPES.find(value => value === option);
	if (!scope || model.locked.scope) return undefined;
	const current = model.scope;
	const next = current.includes(scope) ? current.filter(value => value !== scope) : [...current, scope];
	return { k: "set", change: { id: "scope", value: SCOPES.filter(value => next.includes(value)) } };
}

/**
 * Step choice row `id` by `delta` options, wrapping. The network mode skips the options the host
 * cannot enforce; when every step lands on one, nothing is written and the first one's reason is
 * the notice instead. Undefined for a locked or non-choice row.
 */
export function stepSandboxChoice(model: SandboxConfigModel, id: string, delta: number): SandboxEdit | undefined {
	if (isSandboxSettingId(id) && model.locked[id]) return undefined;
	const step = <T extends string>(values: readonly T[], current: T): T =>
		values[(values.indexOf(current) + delta + values.length) % values.length]!;
	switch (id) {
		case "mode":
			return { k: "set", change: { id, value: step(MODES, model.mode) } };
		case "fallback":
			return { k: "set", change: { id, value: step(FALLBACKS, model.fallback) } };
		case "readScope":
			return { k: "set", change: { id, value: step(READ_SCOPES, model.readScope) } };
		case "networkMode": {
			const count = NETWORK_MODES.length;
			const start = NETWORK_MODES.indexOf(model.networkMode);
			let blocked: string | undefined;
			for (let offset = 1; offset < count; offset++) {
				const candidate = NETWORK_MODES[(((start + delta * offset) % count) + count) % count]!;
				const reason = model.networkUnavailable[candidate];
				if (reason === undefined) return { k: "set", change: { id, value: candidate } };
				blocked ??= reason;
			}
			return blocked === undefined ? undefined : { k: "notice", message: unavailableReason(blocked) };
		}
		default:
			return undefined;
	}
}

/**
 * A typed value for setting row `item` (a Tern control, the terminal's switch or menu): `null`
 * resets. Undefined for a locked or unknown setting, or a value of the wrong type; an unavailable
 * network mode is refused with its reason.
 */
export function sandboxValueEdit(
	model: SandboxConfigModel,
	item: string,
	value: boolean | number | string | readonly string[] | null,
): SandboxEdit | undefined {
	if (!isSandboxSettingId(item) || model.locked[item]) return undefined;
	if (value === null) return { k: "reset", id: item };
	switch (item) {
		case "enabled":
			return typeof value === "boolean" ? { k: "set", change: { id: item, value } } : undefined;
		case "mode": {
			const mode = MODES.find(m => m === value);
			return mode ? { k: "set", change: { id: item, value: mode } } : undefined;
		}
		case "fallback": {
			const fallback = FALLBACKS.find(m => m === value);
			return fallback ? { k: "set", change: { id: item, value: fallback } } : undefined;
		}
		case "readScope": {
			const readScope = READ_SCOPES.find(m => m === value);
			return readScope ? { k: "set", change: { id: item, value: readScope } } : undefined;
		}
		case "networkMode": {
			const networkMode = NETWORK_MODES.find(m => m === value);
			if (!networkMode) return undefined;
			const reason = model.networkUnavailable[networkMode];
			return reason !== undefined
				? { k: "notice", message: unavailableReason(reason) }
				: { k: "set", change: { id: item, value: networkMode } };
		}
		case "scope":
			return Array.isArray(value)
				? { k: "set", change: { id: item, value: SCOPES.filter(scope => value.includes(scope)) } }
				: undefined;
	}
}

/** What an action row does, by row id, against the current model; undefined when it names nothing there. */
export type SandboxRowAction =
	| { readonly k: "allow"; readonly host: string }
	| { readonly k: "revoke"; readonly kind: "write" | "read"; readonly path: string }
	| { readonly k: "revokeExec"; readonly target: string }
	| { readonly k: "trust"; readonly path: string }
	| { readonly k: "forget"; readonly path: string };

/** The grant or record action row `id` names, resolved to the raw host, path or target it acts on. */
export function sandboxRowAction(model: SandboxConfigModel, id: string): SandboxRowAction | undefined {
	if (id.startsWith(BLOCKED_PREFIX)) {
		const host = model.blockedHosts.find(blocked => blockedRowId(blocked) === id);
		return host === undefined ? undefined : { k: "allow", host };
	}
	if (id.startsWith(SESSION_PREFIX)) {
		for (const kind of ["write", "read"] as const) {
			const path = model.sessionPaths[kind].find(entry => sessionRowId(kind, entry) === id);
			if (path !== undefined) return { k: "revoke", kind, path };
		}
		return undefined;
	}
	if (id.startsWith(EXEC_PREFIX)) {
		const target = model.sessionExec.find(entry => execRowId(entry) === id);
		return target === undefined ? undefined : { k: "revokeExec", target };
	}
	if (id.startsWith(TRUST_PREFIX) || id.startsWith(FORGET_PREFIX)) {
		const trust = id.startsWith(TRUST_PREFIX);
		const key = id.slice((trust ? TRUST_PREFIX : FORGET_PREFIX).length);
		const entry = model.created.find(created => plainLine(created.path) === key);
		if (entry === undefined) return undefined;
		if (trust) return { k: "trust", path: entry.path };
		return entry.exists ? undefined : { k: "forget", path: entry.path };
	}
	return undefined;
}

/** The value a disabled row shows in a plain terminal: its control's value and the reason it is disabled. */
export function disabledRowValue(row: TspPrefsRow): string | undefined {
	if (!row.disabled) return undefined;
	if (row.warning) return row.warning;
	if (row.disabled === DISABLED_EFFECTIVE) return undefined;
	const control = row.control;
	let value: string;
	switch (control.k) {
		case "switch":
			value = String(control.on);
			break;
		case "choice":
			value = control.value;
			break;
		case "multi":
			value = control.values.join(", ") || "none";
			break;
		case "text":
			value = control.value;
			break;
		default:
			value = "";
	}
	return value ? `${value} · ${row.disabled}` : row.disabled;
}
