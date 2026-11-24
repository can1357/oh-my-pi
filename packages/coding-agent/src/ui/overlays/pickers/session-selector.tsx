/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Resume a session (`/resume`): the sessions of this folder (Tab: all
 * projects, loaded on first switch) as a `cards` picker grouped by day, pins
 * first, ranked by the search (title matches lead, then literal matches by
 * recency, then strong fuzzy matches). The selected session's preview shows
 * its facts and conversation; it follows the selection once it rests.
 *
 * Enter resumes; Backspace (on an empty query) asks to delete; F2 renames in
 * a form that takes the sheet's place; Alt+K / Alt+Shift+K pin and unpin.
 */
import { batch, computed, type JSXNode, type KeyEvent, onCleanup, type Reactive, read, signal } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerGroup, TspPickerItem, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import {
	rankSessionSearchMatches,
	type SessionHistoryMatcher,
	type SessionListing,
	type SessionSelectorEntry,
	type SessionSelectorStatus,
} from "../../../modes/view-model/overlays/session-selector";
import { tokenHits } from "../../styles/pickers/common";
import "../../styles/pickers/sessions";
import type { SessionsLookTerm } from "../../styles/pickers/sessions";
import { applyEdit } from "../panels/common";
import { editLine, type LineState } from "../settings/line-edit";
import { pickerAge, pickerDate } from "./format";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import {
	appInterruptKeys,
	matchesAppInterrupt,
	matchesSelectCancel,
	selectKeyId,
} from "../../../config/keybindings/matchers";
import { shortenPath } from "../../../utils/render-utils";
import { replaceTabs } from "../../../utils/text-width";
import { actionKbd, confirmKbd, formatKeyHint, formatKeyHints, interruptKbd, kbdOf } from "../../keys/hints";
import { pickerAction } from "./select-sheet";

export interface SessionSelectorProps {
	readonly sessions: readonly SessionSelectorEntry[];
	onSelect(session: SessionSelectorEntry): void;
	onCancel(): void;
	onExit?(): void;
	onDelete?(session: SessionSelectorEntry): Promise<boolean>;
	onRename?(session: SessionSelectorEntry, title: string): Promise<string | undefined>;
	onSetPinned?(session: SessionSelectorEntry, pinned: boolean): Promise<void>;
	/** Every project's sessions (Tab); absent: no scope switch. */
	loadAllSessions?(): Promise<SessionListing>;
	/** The complete folder listing replacing the preliminary `sessions` once it settles. */
	readonly completeSessions?: Promise<readonly SessionSelectorEntry[]>;
	/** Session ids whose recorded prompts match a query (prompt history), merged into the ranking. */
	readonly historyMatcher?: SessionHistoryMatcher;
	readonly currentSessionPath?: string;
	readonly pinnedIds?: ReadonlySet<string>;
	/** The folder named in the search placeholder (default: the project directory's name). */
	readonly scopeLabel?: string;
	/** Heading in place of `Resume Session (…)` (an import picker's). */
	readonly title?: string;
	/** Always show each session's folder (default: only across folders). */
	readonly showCwd?: boolean;
	readonly projectName?: string;
	/** Terminal rows: the list's row budget, and how far Page Up/Down jump. */
	readonly terminalRows?: Reactive<number>;
	/** Stretch the terminal frame to `terminalRows`, its key hints pinned at the bottom (the fullscreen picker). */
	readonly fillHeight?: boolean;
	/** The picker is the whole program (`omp --resume`): Tern draws it filling the screen, not as a sheet. */
	readonly standalone?: boolean;
	/** Host lock while a picked session resumes (input is ignored). */
	readonly locked?: () => boolean;
	/** Clock of ages (default `Date.now`). */
	now?(): number;
	/** Local midnight of the day groups (default: from `now`). */
	dayStart?(): number;
}

const DAY_MS = 86_400_000;
const PREVIEW_EXCERPT_CHARS = 1200;
const PREVIEW_SETTLE_MS = 60;
/** Prompt-history lookups wait for typing to pause (they hit SQLite synchronously). */
const HISTORY_MERGE_DEBOUNCE_MS = 150;
const HISTORY_MERGE_MIN_QUERY = 2;

function statusTone(status: SessionSelectorStatus | undefined): TspTone | undefined {
	switch (status) {
		case "complete":
			return "success";
		case "interrupted":
			return "warning";
		case "aborted":
		case "error":
			return "error";
		case "pending":
			return "pending";
		default:
			return undefined;
	}
}

function statusSpan(status: SessionSelectorStatus | undefined): TspSpan | undefined {
	switch (status) {
		case "complete":
			return { t: "done", s: "success" };
		case "interrupted":
			return { t: "interrupted", s: "warning" };
		case "aborted":
			return { t: "aborted", s: "muted" };
		case "error":
			return { t: "error", s: "error" };
		case "pending":
			return { t: "pending", s: "accent" };
		default:
			return undefined;
	}
}

/** The name a session goes by: its title, else its first message on one line, else its id. */
export function sessionLabel(session: SessionSelectorEntry): string {
	return session.title?.trim() || session.firstMessage.replace(/\s+/g, " ").trim() || session.id;
}

/** Query edits that delete backward: a session-delete key that is one of these edits a typed query. */
const SEARCH_BACKWARD_DELETE = [
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteToLineStart",
] as const;

/** A folder as dim-prefix / strong-tail path spans. */
function cwdSpans(cwd: string): TspSpan[] {
	const cut = cwd.lastIndexOf("/") + 1;
	return cut > 0 && cut < cwd.length
		? [
				{ t: cwd.slice(0, cut), s: "path dim" },
				{ t: cwd.slice(cut), s: "path" },
			]
		: [{ t: cwd, s: "path" }];
}

function dayGroup(modified: number, startOfToday: number): { id: string; label: string } {
	if (modified >= startOfToday) return { id: "today", label: "Today" };
	if (modified >= startOfToday - DAY_MS) return { id: "yesterday", label: "Yesterday" };
	if (modified >= startOfToday - 6 * DAY_MS) return { id: "week", label: "This week" };
	return { id: "earlier", label: "Earlier" };
}

/** BCP 47 tag from the POSIX locale variables (`LC_ALL`, then `LC_TIME`, then `LANG`), or undefined for the runtime default. */
function systemDateLocale(env: Readonly<Record<string, string | undefined>>): string | undefined {
	const raw = env.LC_ALL || env.LC_TIME || env.LANG;
	const tag = raw?.replace(/[.@].*$/, "").replace(/_/g, "-");
	if (!tag || tag === "C" || tag === "POSIX") return undefined;
	try {
		return Intl.DateTimeFormat.supportedLocalesOf(tag)[0];
	} catch {
		return undefined;
	}
}

const dateLocale = systemDateLocale(process.env);

/** Relative age of a session's last change for the terminal rows (`3 hours ago`), its date after a week. */
function sessionAge(modified: Date, now: number): string {
	const diff = now - modified.getTime();
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / DAY_MS);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
	if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
	if (days === 1) return "1 day ago";
	if (days < 7) return `${days} days ago`;
	return modified.toLocaleDateString(dateLocale);
}

const dirname = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/")));

export function SessionSelector(props: SessionSelectorProps): JSXNode {
	const now = (): number => props.now?.() ?? Date.now();
	const titles = signal(new Map<string, string>());
	const deleted = signal(new Set<string>());
	const pins = signal<ReadonlySet<string>>(props.pinnedIds ?? new Set());
	const scope = signal<"folder" | "all">("folder");
	const global = signal<readonly SessionSelectorEntry[] | undefined>(undefined);
	const message = signal<{ kind: "loading" | "error"; text: string } | undefined>(undefined);
	const errorOpen = signal(false);
	const confirmDelete = signal<SessionSelectorEntry | undefined>(undefined);
	/** The delete question's highlighted answer in the terminal (`Yes` first). */
	const deleteAnswer = signal<"yes" | "no">("yes");
	const rename = signal<{ session: SessionSelectorEntry; line: LineState } | undefined>(undefined);
	const search = signal<LineState>({ text: "", cursor: 0 });
	const folderSessions = signal<readonly SessionSelectorEntry[]>(props.sessions);
	/** Prompt-history matches of `query` (the search they answered). */
	const history = signal<{ query: string; ids: string[] } | undefined>(undefined);
	let historyTimer: Timer | undefined;
	onCleanup(() => clearTimeout(historyTimer));
	let alive = true;
	onCleanup(() => {
		alive = false;
	});
	void props.completeSessions?.then(
		sessions => {
			if (alive) folderSessions.set(sessions);
		},
		() => {},
	);

	const withEdits = (list: readonly SessionSelectorEntry[]): SessionSelectorEntry[] =>
		list
			.filter(session => !deleted().has(session.path))
			.map(session => {
				const title = titles().get(session.path);
				return title === undefined ? session : { ...session, title };
			});
	const all = computed(() => withEdits(scope() === "all" ? (global() ?? []) : folderSessions()));
	const showCwd = (): boolean =>
		props.showCwd === true || scope() === "all" || new Set(folderSessions().map(s => dirname(s.path))).size > 1;
	const pinnedFirst = (list: readonly SessionSelectorEntry[]): SessionSelectorEntry[] => {
		const pinned = list.filter(session => pins().has(session.id));
		return pinned.length > 0 ? [...pinned, ...list.filter(session => !pins().has(session.id))] : [...list];
	};
	const tokens = (): string[] => {
		const trimmed = search().text.trim().toLowerCase();
		return trimmed ? trimmed.split(/\s+/) : [];
	};
	const visible = computed(() => {
		if (tokens().length === 0) return pinnedFirst(all());
		const found = history();
		const historyIds = found && found.query === search().text.trim() ? found.ids : [];
		return pinnedFirst(rankSessionSearchMatches([...all()], search().text, historyIds));
	});
	/** Look the query up in prompt history once typing pauses. */
	const scheduleHistory = (query: string): void => {
		clearTimeout(historyTimer);
		const matcher = props.historyMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		historyTimer = setTimeout(() => {
			if (search().text.trim() !== trimmed) return;
			const ids = matcher(trimmed);
			if (ids.length > 0) history.set({ query: trimmed, ids });
		}, HISTORY_MERGE_DEBOUNCE_MS);
	};
	const selectedPath = signal<string | null>(null);
	const pickCurrent = (): void => {
		const list = visible();
		const current = list.find(s => s.path === props.currentSessionPath);
		selectedPath.set((current ?? list[0])?.path ?? null);
	};
	pickCurrent();
	/** The selection, clamped onto a visible session. */
	const selectedIndex = computed(() => {
		const list = visible();
		const at = list.findIndex(s => s.path === selectedPath());
		return at >= 0 ? at : list.length > 0 ? 0 : -1;
	});
	const selected = (): SessionSelectorEntry | undefined => visible()[selectedIndex()];

	// The preview follows the selection once it rests (the first selection shows at once).
	const previewed = signal<SessionSelectorEntry | undefined>(selected());
	let settle: Timer | undefined;
	onCleanup(() => clearTimeout(settle));
	const followPreview = (): void => {
		clearTimeout(settle);
		settle = setTimeout(() => previewed.set(selected()), PREVIEW_SETTLE_MS);
	};
	const selectAt = (index: number): void => {
		const target = visible()[index];
		if (!target || target.path === selectedPath()) return;
		// The user picked a row: a late history merge must not reorder the list under it.
		clearTimeout(historyTimer);
		selectedPath.set(target.path);
		followPreview();
	};
	const move = (delta: number): void => {
		const list = visible();
		if (list.length === 0) return;
		selectAt(Math.max(0, Math.min(list.length - 1, selectedIndex() + delta)));
	};
	const terminalRows = (): number => read(props.terminalRows) ?? 40;
	/** Rows the session list may take: the frame, the search field, the hints and one spare row come off the terminal. */
	const lineBudget = (): number => Math.max(8, terminalRows() - 8);
	const pageSize = (): number => Math.max(2, Math.floor(lineBudget() / 4));

	const setQuery = (line: LineState): void => {
		const before = tokens().length > 0;
		const changed = line.text !== search().text;
		batch(() => {
			search.set(line);
			if (!changed) return;
			scheduleHistory(line.text);
			if (tokens().length > 0) selectedPath.set(visible()[0]?.path ?? null);
			else if (before) pickCurrent();
		});
	};
	const resume = (): void => {
		const session = selected();
		if (session) props.onSelect(session);
	};
	const requestDelete = (): void => {
		const session = selected();
		if (!session || !props.onDelete) return;
		batch(() => {
			deleteAnswer.set("yes");
			confirmDelete.set(session);
		});
	};
	const doDelete = async (): Promise<void> => {
		const session = confirmDelete();
		if (!session || !props.onDelete) return;
		confirmDelete.set(undefined);
		message.set(undefined);
		try {
			if (await props.onDelete(session)) {
				const index = selectedIndex();
				batch(() => {
					deleted.set(new Set([...deleted(), session.path]));
					const list = visible();
					selectedPath.set(list[Math.min(index, list.length - 1)]?.path ?? null);
				});
			}
		} catch (err) {
			showError(err);
		}
	};
	const showError = (err: unknown): void =>
		batch(() => {
			message.set({ kind: "error", text: `Error: ${err instanceof Error ? err.message : String(err)}` });
			errorOpen.set(true);
		});
	const requestRename = (): void => {
		const session = selected();
		if (!session || !props.onRename || confirmDelete() || rename()) return;
		const title = session.title ?? "";
		rename.set({ session, line: { text: title, cursor: title.length } });
	};
	const submitRename = async (): Promise<void> => {
		const dialog = rename();
		if (!dialog || !props.onRename) return;
		const value = dialog.line.text.trim();
		if (!value) return;
		const title = await props.onRename(dialog.session, value);
		batch(() => {
			if (title !== undefined) titles.set(new Map(titles()).set(dialog.session.path, title));
			rename.set(undefined);
		});
	};
	const setPinned = async (pinned?: boolean): Promise<void> => {
		const session = selected();
		if (!session || !props.onSetPinned) return;
		const next = pinned ?? !pins().has(session.id);
		// Pin on a pinned session (unpin on an unpinned one) is a no-op, not a toggle.
		if (next === pins().has(session.id)) return;
		// A pin that could not be stored keeps the order and says why.
		try {
			await props.onSetPinned(session, next);
		} catch (err) {
			showError(err);
			return;
		}
		const updated = new Set(pins());
		if (next) updated.add(session.id);
		else updated.delete(session.id);
		pins.set(updated);
	};
	let toggling = false;
	const toggleScope = async (): Promise<void> => {
		if (toggling || confirmDelete() || rename()) return;
		if (scope() === "all") {
			batch(() => {
				scope.set("folder");
				pickCurrent();
			});
			return;
		}
		if (!global()) {
			if (!props.loadAllSessions) return;
			toggling = true;
			message.set({ kind: "loading", text: "Loading all projects…" });
			try {
				const listing = await props.loadAllSessions();
				global.set(listing.sessions);
				message.set(undefined);
			} catch (err) {
				toggling = false;
				showError(err);
				return;
			}
			toggling = false;
		}
		batch(() => {
			scope.set("all");
			pickCurrent();
		});
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release" || props.locked?.()) return true;
		errorOpen.set(false);
		const dialog = rename();
		const keybindings = getKeybindings();
		if (dialog) {
			if (matchesSelectCancel(key, keybindings)) rename.set(undefined);
			else if (keybindings.matches(key, "tui.input.submit")) void submitRename();
			else {
				const next = editLine(dialog.line, key);
				if (next) rename.set({ ...dialog, line: next });
			}
			return true;
		}
		if (confirmDelete()) {
			if (matchesSelectCancel(key, keybindings)) confirmDelete.set(undefined);
			else if (keybindings.matches(key, "tui.select.confirm")) {
				if (deleteAnswer() === "yes") void doDelete();
				else confirmDelete.set(undefined);
			} else {
				const id = selectKeyId(key, keybindings);
				if (id === "up" || id === "down") deleteAnswer.set(deleteAnswer() === "yes" ? "no" : "yes");
			}
			return true;
		}
		// A delete key that also deletes backward in the query (Backspace, Ctrl+W, Ctrl+U by
		// default) edits a typed query; it deletes the session once the query is empty.
		if (
			keybindings.matches(key, "app.session.delete") &&
			(search().text.length === 0 || !SEARCH_BACKWARD_DELETE.some(action => keybindings.matches(key, action)))
		) {
			requestDelete();
			return true;
		}
		if (keybindings.matches(key, "app.session.pin")) {
			void setPinned(true);
			return true;
		}
		if (keybindings.matches(key, "app.session.unpin")) {
			void setPinned(false);
			return true;
		}
		if (matchesAppInterrupt(key, keybindings)) {
			props.onCancel();
			return true;
		}
		switch (selectKeyId(key, keybindings)) {
			case "f2":
				requestRename();
				return true;
			case "up":
				move(-1);
				return true;
			case "down":
				move(1);
				return true;
			case "pageUp":
				move(-pageSize());
				return true;
			case "pageDown":
				move(pageSize());
				return true;
			case "enter":
				resume();
				return true;
			case "ctrl+c":
				(props.onExit ?? props.onCancel)();
				return true;
			case "tab":
				if (props.loadAllSessions) void toggleScope();
				return true;
		}
		const next = editLine(search(), key);
		if (next) setQuery(next);
		return true;
	};

	const parentLabel = (file: string): string => {
		const parent = all().find(s => s.path === file);
		return parent ? sessionLabel(parent) : (file.split("/").pop() ?? file).replace(/\.jsonl$/, "");
	};
	const items = computed<TspPickerItem[]>(() => {
		const at = now();
		const cwd = showCwd();
		return all().map(session => {
			const first = session.firstMessage.replace(/\s+/g, " ").trim();
			const title = session.title?.trim() ?? "";
			const badges: NonNullable<TspPickerItem["badges"]>[number][] = [];
			if (session.parentSessionPath)
				badges.push({ text: "fork", title: `Forked from “${parentLabel(session.parentSessionPath)}”` });
			if (session.path === props.currentSessionPath) badges.push({ text: "current", tone: "accent" });
			const when = pickerDate(session.modified.getTime());
			const detail = cwd ? (session.cwd ? cwdSpans(session.cwd) : undefined) : title ? first : undefined;
			const dot = statusTone(session.status);
			return {
				id: session.path,
				label: title || first || session.id,
				...(detail ? { detail } : {}),
				facts: {
					when: pickerAge(session.modified.getTime(), at),
					size: formatBytes(session.size),
					...(session.model ? { model: session.model } : {}),
				},
				...(dot ? { dot } : {}),
				...(pins().has(session.id) ? { icon: "pin" } : {}),
				...(badges.length > 0 ? { badges } : {}),
				title: cwd && first ? `${first}\n${when}` : when,
			};
		});
	});
	const order = computed<(string | TspPickerGroup)[]>(() => {
		const list = visible();
		if (tokens().length > 0) return list.map(s => s.path);
		const start = props.dayStart?.() ?? new Date(new Date(now()).toDateString()).getTime();
		const groups = list.map(s =>
			pins().has(s.id) ? { id: "pinned", label: "Pinned" } : dayGroup(s.modified.getTime(), start),
		);
		const out: (string | TspPickerGroup)[] = [];
		for (let i = 0; i < list.length; i++) {
			const group = groups[i]!;
			if (i === 0 || groups[i - 1]!.id !== group.id) {
				let count = 1;
				while (i + count < list.length && groups[i + count]!.id === group.id) count++;
				out.push({ group: `${group.id}-${i}`, label: group.label, count });
			}
			out.push(list[i]!.path);
		}
		return out;
	});
	const hits = (): Record<string, [number, number][]> | undefined => {
		if (tokens().length === 0) return undefined;
		let out: Record<string, [number, number][]> | undefined;
		const labels = new Map(items().map(item => [item.id, item.label as string]));
		for (const session of visible()) {
			const ranges = tokenHits(labels.get(session.path) ?? "", tokens());
			if (ranges.length > 0) (out ??= {})[session.path] = ranges;
		}
		return out;
	};
	const actions = (): TspPickerAction[] => {
		const out = [pickerAction("resume", "Resume", confirmKbd(), { primary: true })];
		const [deleteKey] = getKeybindings().keysFor("app.session.delete");
		if (props.onDelete && deleteKey) out.push(pickerAction("delete", "Delete", kbdOf(deleteKey)));
		if (props.onRename) out.push(pickerAction("rename", "Rename", "f2"));
		const session = selected();
		if (props.onSetPinned && session) {
			const pinned = pins().has(session.id);
			out.push(
				pickerAction(
					"pin",
					pinned ? "Unpin" : "Pin",
					pinned ? actionKbd("app.session.unpin", "alt+shift+k") : actionKbd("app.session.pin", "alt+k"),
				),
			);
		}
		if (props.loadAllSessions)
			out.push(pickerAction("scope", scope() === "all" ? "This folder" : "All projects", "tab"));
		out.push(pickerAction("close", "Close", interruptKbd(), { end: true }));
		return out;
	};
	const folder = props.scopeLabel ?? props.projectName;
	const placeholder = (): string =>
		message()?.kind === "loading" || scope() === "all"
			? "Search all sessions…"
			: folder && !props.title
				? `Search sessions in ${folder}…`
				: "Search sessions…";
	const state = (): "ready" | "loading" | "error" =>
		message()?.kind === "loading" ? "loading" : errorOpen() && message()?.kind === "error" ? "error" : "ready";
	const preview = (): JSXNode => {
		const rested = previewed();
		if (!rested) return null;
		// The complete listing replaces the preliminary entries (it adds their folder, status and text).
		const session = all().find(entry => entry.path === rested.path) ?? rested;
		const shown = titles().has(session.path) ? { ...session, title: titles().get(session.path) } : session;
		const status = statusSpan(shown.status);
		const facts: { k: TspSpan[]; v: string | TspSpan[] }[] = [];
		if (shown.cwd) facts.push({ k: [{ t: "Folder", s: "muted" }], v: cwdSpans(shown.cwd) });
		if (shown.created && !Number.isNaN(shown.created.getTime()))
			facts.push({ k: [{ t: "Created", s: "muted" }], v: pickerDate(shown.created.getTime()) });
		facts.push({ k: [{ t: "Modified", s: "muted" }], v: pickerDate(shown.modified.getTime()) });
		facts.push({ k: [{ t: "Size", s: "muted" }], v: formatBytes(shown.size) });
		if (status) facts.push({ k: [{ t: "Status", s: "muted" }], v: [status] });
		if (shown.model) facts.push({ k: [{ t: "Model", s: "muted" }], v: shown.model });
		if (shown.parentSessionPath)
			facts.push({ k: [{ t: "Forked from", s: "muted" }], v: parentLabel(shown.parentSessionPath) });
		const first = shown.firstMessage.trim();
		const rest = shown.allMessagesText.startsWith(shown.firstMessage)
			? shown.allMessagesText.slice(shown.firstMessage.length).trim()
			: "";
		const conversation: JSXNode[] = [];
		if (first)
			conversation.push(
				<md
					text={first.length > PREVIEW_EXCERPT_CHARS ? `${first.slice(0, PREVIEW_EXCERPT_CHARS)}…` : first}
					tone="user"
				/>,
			);
		if (rest)
			conversation.push(
				<md text={rest.length > PREVIEW_EXCERPT_CHARS ? `…${rest.slice(-PREVIEW_EXCERPT_CHARS)}` : rest} />,
			);
		return [
			<text text={sessionLabel(shown)} role="omp.picker.title" />,
			<kv items={facts} />,
			conversation.length > 0 ? <section head="Conversation">{conversation}</section> : null,
		];
	};
	/** The key hints under the list, naming only what this picker can do. */
	const hints = (): string => {
		const keybindings = getKeybindings();
		const parts: string[] = [];
		const deleteKeys = props.onDelete ? keybindings.keysFor("app.session.delete") : [];
		if (deleteKeys.length > 0) parts.push(`${formatKeyHints(deleteKeys)} delete`);
		if (props.onRename) parts.push(`${formatKeyHint("f2")} rename`);
		if (props.onSetPinned) {
			const session = selected();
			const pinned = session !== undefined && pins().has(session.id);
			const [pinKey] = keybindings.keysFor(pinned ? "app.session.unpin" : "app.session.pin");
			if (pinKey) parts.push(`${formatKeyHint(pinKey)} ${pinned ? "unpin" : "pin"}`);
		}
		parts.push(`${formatKeyHint("enter")} select`);
		parts.push(`${formatKeyHint("tab")} ${scope() === "all" ? "current folder" : "all projects"}`);
		parts.push(`${formatKeyHint(appInterruptKeys(keybindings)[0] ?? "escape")} cancel`);
		return `[${parts.join(" · ")}]`;
	};
	const term = (): SessionsLookTerm => {
		const at = now();
		const cwd = showCwd();
		const choice = confirmDelete();
		const dialog = rename();
		return {
			look: "omp.sessions",
			title:
				props.title ??
				`Resume Session (${props.scopeLabel ?? (scope() === "all" ? "all projects" : "current folder")})`,
			field: search(),
			sessions: visible().map(session => ({
				id: session.path,
				title: session.title ?? "",
				first: replaceTabs(session.firstMessage.replace(/\n/g, " ").trim()),
				age: sessionAge(session.modified, at),
				size: formatBytes(session.size),
				current: session.path === props.currentSessionPath,
				pinned: pins().has(session.id),
				status: session.status,
				model: session.model ? replaceTabs(session.model) : "",
				fork: session.parentSessionPath !== undefined,
				// Folders show only across folders (all projects, worktrees) or when asked.
				cwd: cwd && session.cwd ? shortenPath(session.cwd) : "",
			})),
			message: message(),
			...(choice ? { confirm: { name: sessionLabel(choice), answer: deleteAnswer() } } : {}),
			...(dialog ? { rename: dialog.line } : {}),
			empty: cwd ? "No sessions found" : `No sessions in current folder. Press ${formatKeyHint("tab")} to view all.`,
			hints: hints(),
			budget: lineBudget(),
			...(props.fillHeight ? { fill: terminalRows() } : {}),
		};
	};

	const handleAction = (act: string): void => {
		if (props.locked?.()) return;
		errorOpen.set(false);
		const choice = confirmDelete();
		if (act === "delete-confirm") void doDelete();
		else if (act === "cancel") {
			if (choice) confirmDelete.set(undefined);
			else rename.set(undefined);
		} else if (act === "close") {
			if (choice) confirmDelete.set(undefined);
			else if (rename()) rename.set(undefined);
			else props.onCancel();
		} else if (choice || rename()) return;
		else if (act === "resume") resume();
		else if (act === "delete") requestDelete();
		else if (act === "rename") requestRename();
		else if (act === "pin") void setPinned();
		else if (act === "scope") {
			if (props.loadAllSessions) void toggleScope();
		} else if (act === "clear") setQuery({ text: "", cursor: 0 });
	};

	/** While renaming, the sheet gives way to the session card holding the rename form. */
	const renameCard = (): JSXNode => {
		const hint = (keys: string[][], label: string): JSXNode => (
			<row align="center" gap="xs">
				{keys.map(k => (
					<kbd keys={k} />
				))}
				<text spans={[{ t: label, s: "muted" }]} />
			</row>
		);
		return (
			<card
				head={props.title ?? (props.scopeLabel ? `Resume Session (${props.scopeLabel})` : "Resume Session")}
				role="omp.overlay.sessions"
				term={term}
				onKey={onKey}
			>
				{props.scopeLabel === undefined && props.loadAllSessions && (
					<tabs
						key="scope"
						items={[
							{ id: "folder", label: "Current folder" },
							{ id: "all", label: "All projects" },
						]}
						active={scope}
					/>
				)}
				<card head="Rename Session" role="omp.overlay">
					<col gap="sm" role="omp.form.field">
						<text spans={[{ t: "Rename session", s: "strong" }]} />
						<input
							text={() => rename()?.line.text ?? ""}
							cursor={() => rename()?.line.cursor ?? 0}
							prompt="> "
							sendable={false}
							onEdit={edit => {
								const dialog = rename();
								if (!dialog || props.locked?.()) return;
								const line = applyEdit(dialog.line, edit);
								if (line) rename.set({ ...dialog, line });
							}}
						/>
						<text hidden={true} text="" />
					</col>
				</card>
				<row key="hints" gap="md" role="omp.overlay.hints" wrap={true}>
					{hint(getKeybindings().keysFor("app.session.delete").map(kbdOf), "delete")}
					{hint([["f2"]], "rename")}
					{hint([actionKbd("app.session.pin", "alt+k")], "pin")}
					{hint([confirmKbd()], "select")}
					{hint([["tab"]], "all projects")}
					{hint([interruptKbd()], "cancel")}
				</row>
			</card>
		);
	};

	const renaming = computed(() => rename() !== undefined);
	return () =>
		renaming() ? (
			renameCard()
		) : (
			<picker
				icon="history"
				noun="sessions"
				size={props.standalone ? "screen" : "lg"}
				layout="cards"
				preview="side"
				query={() => search().text}
				cursor={() => search().cursor}
				placeholder={placeholder}
				columns={[
					{ id: "when", format: "time" },
					{ id: "size", format: "dim" },
					{ id: "model", format: "dim" },
				]}
				items={items}
				order={order}
				hits={hits}
				selected={() => selected()?.path ?? null}
				current={props.currentSessionPath ? [props.currentSessionPath] : []}
				total={() => all().length}
				actions={actions}
				state={state}
				message={() => (state() !== "ready" ? message()?.text : undefined)}
				empty={() =>
					scope() === "all" || !props.loadAllSessions ? "No sessions yet" : "No sessions in this folder yet"
				}
				confirm={() => {
					const choice = confirmDelete();
					return choice
						? {
								text: `Delete “${sessionLabel(choice)}”? This removes the session file.`,
								act: "delete-confirm",
								label: "Delete",
							}
						: null;
				}}
				term={term}
				onKey={onKey}
				onSelect={id => {
					if (props.locked?.() || confirmDelete() || rename()) return;
					errorOpen.set(false);
					const index = visible().findIndex(s => s.path === id);
					if (index >= 0) selectAt(index);
				}}
				onActivate={id => {
					if (props.locked?.() || confirmDelete() || rename()) return;
					const index = visible().findIndex(s => s.path === id);
					if (index < 0) return;
					selectAt(index);
					resume();
				}}
				onAction={handleAction}
			>
				{preview}
			</picker>
		);
}
