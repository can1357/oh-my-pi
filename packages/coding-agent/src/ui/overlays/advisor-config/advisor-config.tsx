/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The advisor-configuration overlay: one `WATCHDOG.yml` (project or user) as
 * an editable roster of advisors plus the shared instructions.
 *
 * Natively it is a settings page (`prefs`): a page per advisor and one for
 * the shared instructions, the advisor's fields as typed rows, the file
 * actions, and the open editor over the page (a picker sheet for the model,
 * thinking level, review mode, sync backlog and tools; a card for the review
 * interval and the instructions). In the terminal the same node draws the
 * overlay's own frame (`styles/advisor-config/look.ts`): the roster beside
 * the highlighted entry's preview, then one screen per editor.
 *
 * All state lives here. Keys reach `onKey` (the screen's list, field or
 * editor); native page, picker and editor events arrive as UI events; the
 * look's pointer input arrives as `action pointer`.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	type PasteEvent,
	signal,
	type UiEvent,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspPickerItem, TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import {
	ADVISOR_REVIEW_MODES,
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorConfig,
	type AdvisorConfigScope,
	formatCompactQuota,
	type WatchdogConfigDoc,
} from "../../../advisor/advisor-config-types";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../../../thinking/levels";
import { fuzzyRank } from "../../../utils/fuzzy";
import { sanitizeDisplayWarnings } from "../../../utils/render-utils";
import {
	ADVISOR_CONFIG_ROLE,
	ADVISOR_POINTER_ACT,
	type AdvisorListOption,
	type AdvisorLookTerm,
	type AdvisorModelRow,
	type AdvisorPreviewLine,
	type AdvisorScreenLook,
} from "../../styles/advisor-config/look";
import { closeAction, pickerAction } from "../pickers/select-sheet";
import { editLine, type LineState } from "../settings/line-edit";
import {
	type AdvisorConfigCallbacks,
	type AdvisorConfigDeps,
	commitTools,
	describeSyncBacklogMode,
	formatAdvisorTools,
	formatCompactCount,
	formatReviewCadence,
	type ModelEntry,
	modelCatalogue,
	modelDetail,
	modelPrice,
	previewLineOrNone,
} from "./model";
import { actionKbd, actionKeyId, cancelKbd, confirmKbd, kbdOf } from "../../keys/hints";
import {
	appExternalEditorKeys,
	appFollowUpKeys,
	listKeyId,
	matchesAnyKey,
	matchesSelectCancel,
} from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { bindingGlyph, keyTitle, selectNavGlyphs } from "../../styles/panels/common";
import { ActionButton } from "../panels/common";

export interface AdvisorConfigOverlayProps {
	readonly deps: AdvisorConfigDeps;
	/** The file opened first. */
	readonly scope: AdvisorConfigScope;
	/** Its contents (edited in place). */
	readonly doc: WatchdogConfigDoc;
	readonly callbacks: AdvisorConfigCallbacks;
	/** Wall clock for quota reset times (default `Date.now`). */
	readonly now?: () => number;
}

/** Choice value for "no per-advisor override"; matches no sync-backlog mode. */
const SYNC_BACKLOG_INHERIT = "inherit";
/** The tools list's terminal-only "Done" row. */
const TOOLS_DONE = "__done";
/** Pages the browser's PgUp/PgDn move by. */
const MODEL_PAGE = 10;
const ESCAPE: KeyEvent = { id: "escape", kind: "press", raw: "\x1b" };
const ENTER: KeyEvent = { id: "enter", kind: "press", raw: "\r" };

const MODEL_COLUMNS = [
	{ format: "num", head: "Int", id: "int", priority: 4 },
	{ format: "num", head: "t/s", id: "speed", priority: 3 },
	{ format: "num", head: "Ctx", id: "ctx", priority: 1 },
	{ format: "price", head: "$/M", id: "price", priority: 2 },
] as const;

const ADVISOR_LEAD = "An advisor watches the session and leaves notes; set its model, tools and instructions here.";
const SHARED_LEAD = "Instructions every advisor gets before its own.";

/** What the overlay shows; every screen but the roster edits advisor `index` (-1: the shared instructions). */
type Screen =
	| { readonly k: "list"; readonly cursor: number }
	| { readonly k: "detail"; readonly index: number; readonly cursor: number }
	| { readonly k: "name"; readonly index: number; readonly line: LineState }
	| { readonly k: "model"; readonly index: number; readonly query: LineState; readonly selected: string | undefined }
	| {
			readonly k: "thinking";
			readonly index: number;
			readonly selector: string;
			readonly efforts: readonly string[];
			readonly cursor: number;
	  }
	| { readonly k: "review-mode"; readonly index: number; readonly cursor: number }
	| { readonly k: "review-interval"; readonly index: number; readonly line: LineState }
	| { readonly k: "sync-backlog"; readonly index: number; readonly cursor: number }
	| { readonly k: "tools"; readonly index: number; readonly selected: readonly string[]; readonly cursor: number }
	| { readonly k: "instructions"; readonly index: number; readonly text: string; readonly cursor: number };

type ListScreen = Extract<
	Screen,
	{ cursor: number; k: "list" | "detail" | "thinking" | "review-mode" | "sync-backlog" | "tools" }
>;

/** A list screen's option: its value, the terminal label and description. */
interface Item {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

function isListScreen(screen: Screen): screen is ListScreen {
	return (
		screen.k === "list" ||
		screen.k === "detail" ||
		screen.k === "thinking" ||
		screen.k === "review-mode" ||
		screen.k === "sync-backlog" ||
		screen.k === "tools"
	);
}

function wrapIndex(index: number, count: number): number {
	return count === 0 ? 0 : ((index % count) + count) % count;
}

/** One logical line's start and end around `at`. */
function lineBounds(text: string, at: number): { start: number; end: number } {
	const start = text.lastIndexOf("\n", at - 1) + 1;
	const next = text.indexOf("\n", at);
	return { start, end: next < 0 ? text.length : next };
}

/** A key applied to multi-line text (Enter is a newline; Home/End/↑/↓ work per line). */
function editText(state: LineState, key: KeyEvent): LineState | undefined {
	const { text, cursor } = state;
	switch (key.id) {
		case "enter":
		case "shift+enter":
		case "alt+enter":
			return { text: `${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor: cursor + 1 };
		case "home":
		case "ctrl+a":
			return { text, cursor: lineBounds(text, cursor).start };
		case "end":
		case "ctrl+e":
			return { text, cursor: lineBounds(text, cursor).end };
		case "up":
		case "down": {
			const { start } = lineBounds(text, cursor);
			const column = cursor - start;
			if (key.id === "up") {
				if (start === 0) return { text, cursor: 0 };
				const previous = lineBounds(text, start - 1);
				return { text, cursor: Math.min(previous.start + column, previous.end) };
			}
			const { end } = lineBounds(text, cursor);
			if (end >= text.length) return { text, cursor: text.length };
			const next = lineBounds(text, end + 1);
			return { text, cursor: Math.min(next.start + column, next.end) };
		}
	}
	return editLine(state, key);
}

/** The instructions editor's submit key: Ctrl+Q leads (Ctrl+Enter does not reach every terminal, #1903). */
function followUpKey(): string {
	const keys = appFollowUpKeys();
	return keys.includes("ctrl+q") ? "ctrl+q" : (keys[0] ?? "ctrl+q");
}

/** Case-insensitive first occurrence of `query` in `label`, as a picker hit range. */
function hitRange(label: string, query: string): [number, number][] | undefined {
	const needle = query.trim().toLowerCase();
	if (!needle) return undefined;
	const at = label.toLowerCase().indexOf(needle);
	return at < 0 ? undefined : [[at, at + needle.length]];
}

export function AdvisorConfigOverlay(props: AdvisorConfigOverlayProps): JSXNode {
	const { deps, callbacks: cb } = props;
	const now = props.now ?? Date.now;
	const scope = signal<AdvisorConfigScope>(props.scope);
	const doc = signal<WatchdogConfigDoc>(props.doc);
	/** Bumped on every in-place edit of the doc. */
	const revision = signal(0);
	const dirty = signal(false);
	const reports = signal<UsageReport[] | null>(null);
	const screen = signal<Screen>({ k: "list", cursor: 0 });
	/** Bumped whenever the preview's scroll resets. */
	const previewEpoch = signal(0);

	const otherScope = (): AdvisorConfigScope => (scope() === "project" ? "user" : "project");
	const advisors = (): AdvisorConfig[] => {
		revision();
		return doc().advisors;
	};
	const edit = (change: (current: WatchdogConfigDoc) => void, markDirty = true): void => {
		batch(() => {
			change(untrack(doc));
			revision.update(n => n + 1);
			if (markDirty) dirty.set(true);
		});
	};
	const setScreen = (next: Screen): void => {
		batch(() => {
			screen.set(next);
			previewEpoch.update(n => n + 1);
		});
	};
	const fail = (err: unknown): void =>
		cb.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);

	const ensureRosterVisible = (): void => {
		if (untrack(doc).advisors.length === 0) edit(current => current.advisors.push({ name: "default" }), false);
	};
	ensureRosterVisible();
	if (cb.getUsageReports) {
		void cb
			.getUsageReports()
			.then(result => reports.set(result))
			.catch(() => {});
	}

	const modelLabel = (advisor: AdvisorConfig): string =>
		advisor.model?.trim() || deps.defaultModelLabel || "advisor role default";
	const syncBacklogLabel = (advisor: AdvisorConfig): string =>
		advisor.syncBacklog ?? `${deps.syncBacklog ?? "off"} (inherited)`;

	// ─── Lists ──────────────────────────────────────────────────────────────

	const rosterItems = (): Item[] => {
		const items: Item[] = advisors().map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${advisor.enabled === false ? "○" : "●"} ${advisor.name || "(unnamed)"}`,
			description: `${modelLabel(advisor)} · ${formatAdvisorTools(advisor.tools)} · review ${advisor.reviewMode ?? "turn"}/${advisor.reviewInterval ?? 1}`,
		}));
		items.push(
			{ value: "add", label: "+ Add advisor" },
			{ value: "shared", label: "Shared instructions", description: previewLineOrNone(doc().instructions) },
			{ value: "scope", label: `Scope: ${scope()}`, description: `→ ${otherScope()}` },
			{ value: "save", label: "Save & apply" },
			{ value: "close", label: "Close" },
		);
		return items;
	};

	const detailItems = (advisor: AdvisorConfig): Item[] => {
		const items: Item[] = [
			{ value: "name", label: "Name", description: advisor.name },
			{ value: "toggleEnabled", label: "Enabled", description: advisor.enabled === false ? "○ off" : "● on" },
			{ value: "model", label: "Model", description: modelLabel(advisor) },
			{ value: "reviewMode", label: "Review mode", description: advisor.reviewMode ?? "turn" },
			{ value: "reviewInterval", label: "Review interval", description: String(advisor.reviewInterval ?? 1) },
			{ value: "syncBacklog", label: "Sync backlog", description: syncBacklogLabel(advisor) },
		];
		if (advisor.model?.trim()) items.push({ value: "resetModel", label: "Reset model to advisor-role default" });
		items.push(
			{ value: "tools", label: "Tools", description: formatAdvisorTools(advisor.tools) },
			{ value: "instructions", label: "Instructions", description: previewLineOrNone(advisor.instructions) },
			{ value: "delete", label: "Delete this advisor" },
			{ value: "back", label: "Back" },
		);
		return items;
	};

	const reviewItems = (advisor: AdvisorConfig): Item[] => {
		const current = advisor.reviewMode ?? "turn";
		return ADVISOR_REVIEW_MODES.map(mode => ({
			value: mode,
			label: mode === current ? `${mode} (current)` : mode,
			description:
				mode === "turn"
					? "Review every primary turn (tool-call round)."
					: "Review only at agent end (once per run).",
		}));
	};

	const syncItems = (advisor: AdvisorConfig): Item[] => {
		const current = advisor.syncBacklog;
		return [
			{
				value: SYNC_BACKLOG_INHERIT,
				label: current === undefined ? "inherit (current)" : "inherit",
				description: `Follow the global advisor.syncBacklog setting (currently "${deps.syncBacklog ?? "off"}").`,
			},
			...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
				value: mode,
				label: mode === current ? `${mode} (current)` : mode,
				description: describeSyncBacklogMode(mode),
			})),
		];
	};

	const toolItems = (selected: readonly string[]): Item[] => [
		...deps.availableToolNames.map(name => ({
			value: name,
			label: `${selected.includes(name) ? "[x]" : "[ ]"} ${name}`,
		})),
		{ value: TOOLS_DONE, label: "Done" },
	];

	const thinkingItems = (efforts: readonly string[]): Item[] => [
		{ value: "", label: "(model default thinking)" },
		...efforts.map(effort => ({ value: effort, label: effort })),
	];

	const itemsOf = (current: ListScreen): Item[] => {
		if (current.k === "list") return rosterItems();
		const advisor = advisors()[current.index];
		switch (current.k) {
			case "detail":
				return advisor ? detailItems(advisor) : [];
			case "review-mode":
				return advisor ? reviewItems(advisor) : [];
			case "sync-backlog":
				return advisor ? syncItems(advisor) : [];
			case "tools":
				return toolItems(current.selected);
			case "thinking":
				return thinkingItems(current.efforts);
		}
	};

	// ─── Screens ────────────────────────────────────────────────────────────

	const showList = (): void => {
		ensureRosterVisible();
		setScreen({ k: "list", cursor: 0 });
	};

	const showDetail = (index: number): void => {
		if (!untrack(advisors)[index]) {
			showList();
			return;
		}
		setScreen({ k: "detail", index, cursor: 0 });
	};

	const catalogue = (): ModelEntry[] => {
		let models = deps.scopedModels.map(scoped => scoped.model);
		if (models.length === 0) {
			try {
				models = deps.getAvailableModels();
			} catch {
				models = [];
			}
		}
		return modelCatalogue(models, deps.mruOrder);
	};
	const models = computed(catalogue);

	/** The catalogue entry the advisor runs (whatever thinking suffix it carries). */
	const currentModel = (index: number): string | undefined => {
		const model = advisors()[index]?.model?.trim();
		if (!model) return undefined;
		return models().find(entry => model === entry.selector || model.startsWith(`${entry.selector}:`))?.selector;
	};

	const visibleModels = (query: string): ModelEntry[] => {
		const all = models();
		if (!query.trim()) return all;
		const matched = new Set(fuzzyRank(all, query, entry => entry.selector).map(result => result.item));
		return all.filter(entry => matched.has(entry));
	};

	const showModelPicker = (index: number): void => {
		const current = untrack(() => currentModel(index));
		setScreen({
			k: "model",
			index,
			query: { text: "", cursor: 0 },
			selected: current ?? untrack(models)[0]?.selector,
		});
	};

	const showThinkingPicker = (index: number, selector: string, efforts: readonly string[]): void => {
		const model = untrack(advisors)[index]?.model?.trim();
		const current =
			model === selector ? "" : model?.startsWith(`${selector}:`) ? model.slice(selector.length + 1) : undefined;
		const cursor =
			current === undefined
				? 0
				: Math.max(
						0,
						thinkingItems(efforts).findIndex(item => item.value === current),
					);
		setScreen({ k: "thinking", index, selector, efforts, cursor });
	};

	const pickModel = (index: number, selector: string): void => {
		const entry = untrack(models).find(candidate => candidate.selector === selector);
		if (!entry) return;
		const efforts = getSupportedEfforts(entry.model);
		if (efforts.length > 0) {
			showThinkingPicker(index, selector, efforts);
			return;
		}
		edit(current => {
			current.advisors[index]!.model = selector;
		});
		showDetail(index);
	};

	const showInstructionsEditor = (index: number): void => {
		const current = untrack(doc);
		const text = (index < 0 ? current.instructions : current.advisors[index]?.instructions) ?? "";
		setScreen({ k: "instructions", index, text, cursor: text.length });
	};

	const listSelect = async (value: string): Promise<void> => {
		switch (value) {
			case "add":
				edit(current => current.advisors.push({ name: `Advisor ${current.advisors.length + 1}` }));
				showDetail(untrack(advisors).length - 1);
				return;
			case "shared":
				showInstructionsEditor(-1);
				return;
			case "scope": {
				if (untrack(dirty)) {
					cb.notify('Unsaved changes — "Save & apply" or Close before switching scope.');
					return;
				}
				const next = untrack(otherScope);
				const loaded = await cb.loadDoc(next);
				batch(() => {
					doc.set(loaded);
					scope.set(next);
				});
				// The host reports the opening file's problems itself; switches report the new file's.
				if (loaded.warnings?.length) {
					const message = `WATCHDOG.yml: ${sanitizeDisplayWarnings(loaded.warnings).join("; ")}`;
					if (cb.warn) cb.warn(message);
					else cb.notify(message);
				}
				showList();
				return;
			}
			case "save": {
				const current = untrack(doc);
				await cb.save(untrack(scope), isSyntheticDefault(current) ? { ...current, advisors: [] } : current);
				// The rewritten file holds only normalized entries: the load-time warnings no longer apply.
				batch(() => {
					edit(saved => {
						saved.warnings = undefined;
					}, false);
					dirty.set(false);
				});
				showList();
				return;
			}
			case "close":
				cb.close();
				return;
		}
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) showDetail(Number(match[1]));
	};

	const runListSelect = (value: string): void => void listSelect(value).catch(fail);

	const detailSelect = (index: number, field: string): void => {
		const advisor = untrack(advisors)[index];
		switch (field) {
			case "toggleEnabled":
				if (!advisor) return;
				edit(() => {
					advisor.enabled = advisor.enabled === false ? undefined : false;
				});
				showDetail(index);
				return;
			case "name":
				if (advisor) setScreen({ k: "name", index, line: { text: advisor.name, cursor: advisor.name.length } });
				return;
			case "model":
				showModelPicker(index);
				return;
			case "reviewMode": {
				if (!advisor) return showList();
				const cursor = ADVISOR_REVIEW_MODES.indexOf(advisor.reviewMode ?? "turn");
				setScreen({ k: "review-mode", index, cursor });
				return;
			}
			case "reviewInterval": {
				if (!advisor) return showList();
				const text = String(advisor.reviewInterval ?? 1);
				setScreen({ k: "review-interval", index, line: { text, cursor: text.length } });
				return;
			}
			case "syncBacklog": {
				if (!advisor) return showList();
				const current = advisor.syncBacklog;
				const cursor = current === undefined ? 0 : ADVISOR_SYNC_BACKLOG_MODES.indexOf(current) + 1;
				setScreen({ k: "sync-backlog", index, cursor });
				return;
			}
			case "tools":
				if (!advisor) return;
				setScreen({ k: "tools", index, selected: [...(advisor.tools ?? deps.defaultToolNames)], cursor: 0 });
				return;
			case "resetModel":
				if (!advisor) return;
				edit(() => {
					advisor.model = undefined;
				});
				showDetail(index);
				return;
			case "instructions":
				if (advisor) showInstructionsEditor(index);
				return;
			case "delete":
				edit(current => current.advisors.splice(index, 1));
				showList();
				return;
			default:
				showList();
		}
	};

	const commitToolsAndReturn = (index: number, selected: readonly string[]): void => {
		edit(current => {
			const advisor = current.advisors[index];
			if (advisor) advisor.tools = commitTools(selected, deps.availableToolNames, deps.defaultToolNames);
		});
		showDetail(index);
	};

	/** Enter on a list screen's option. */
	const activateListItem = (current: ListScreen, item: Item): void => {
		switch (current.k) {
			case "list":
				runListSelect(item.value);
				return;
			case "detail":
				detailSelect(current.index, item.value);
				return;
			case "thinking":
				edit(doc => {
					const advisor = doc.advisors[current.index];
					if (advisor) advisor.model = item.value ? `${current.selector}:${item.value}` : current.selector;
				});
				showDetail(current.index);
				return;
			case "review-mode":
				edit(doc => {
					const advisor = doc.advisors[current.index];
					if (advisor) advisor.reviewMode = item.value === "turn" ? undefined : "agent-end";
				});
				showDetail(current.index);
				return;
			case "sync-backlog":
				edit(doc => {
					const advisor = doc.advisors[current.index];
					if (advisor) advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === item.value);
				});
				showDetail(current.index);
				return;
			case "tools": {
				if (item.value === TOOLS_DONE) {
					commitToolsAndReturn(current.index, current.selected);
					return;
				}
				const selected = current.selected.includes(item.value)
					? current.selected.filter(name => name !== item.value)
					: [...current.selected, item.value];
				screen.set({ ...current, selected });
				return;
			}
		}
	};

	/** Esc on a list screen. */
	const cancelList = (current: ListScreen): void => {
		switch (current.k) {
			case "list":
				cb.close();
				return;
			case "thinking":
				showModelPicker(current.index);
				return;
			case "tools":
				commitToolsAndReturn(current.index, current.selected);
				return;
			case "detail":
				showList();
				return;
			default:
				showDetail(current.index);
		}
	};

	/** Move a list screen's cursor; the roster's move resets the preview scroll. */
	const moveList = (current: ListScreen, cursor: number): void => {
		const count = untrack(() => itemsOf(current).length);
		const next = { ...current, cursor: wrapIndex(cursor, count) };
		if (current.k === "list") setScreen(next);
		else screen.set(next);
	};

	const submitInstructions = (current: Extract<Screen, { k: "instructions" }>): void => {
		const text = current.text.trim() ? current.text : undefined;
		edit(doc => {
			if (current.index < 0) doc.instructions = text;
			else {
				const advisor = doc.advisors[current.index];
				if (advisor) advisor.instructions = text;
			}
		});
		if (current.index < 0) showList();
		else showDetail(current.index);
	};

	const leaveInstructions = (index: number): void => {
		if (index < 0) showList();
		else showDetail(index);
	};

	const submitInterval = (current: Extract<Screen, { k: "review-interval" }>): void => {
		const interval = Number(current.line.text.trim());
		if (!Number.isSafeInteger(interval) || interval < 1) {
			cb.notify("Review interval must be a positive integer.");
			return;
		}
		edit(doc => {
			const advisor = doc.advisors[current.index];
			if (advisor) advisor.reviewInterval = interval === 1 ? undefined : interval;
		});
		showDetail(current.index);
	};

	const submitName = (current: Extract<Screen, { k: "name" }>): void => {
		const name = current.line.text.trim();
		if (name) {
			edit(doc => {
				const advisor = doc.advisors[current.index];
				if (advisor) advisor.name = name;
			});
		}
		showDetail(current.index);
	};

	/** Move the model browser's selection by `delta` visible models. */
	const moveModel = (current: Extract<Screen, { k: "model" }>, delta: number, wrap: boolean): void => {
		const visible = untrack(() => visibleModels(current.query.text));
		if (visible.length === 0) return;
		const at = visible.findIndex(entry => entry.selector === current.selected);
		const target = at + delta;
		const index = wrap ? wrapIndex(target, visible.length) : Math.max(0, Math.min(visible.length - 1, target));
		screen.set({ ...current, selected: visible[index]!.selector });
	};

	const cancelModel = (current: Extract<Screen, { k: "model" }>): void => {
		if (current.query.text) screen.set({ ...current, query: { text: "", cursor: 0 } });
		else showDetail(current.index);
	};

	const setQuery = (current: Extract<Screen, { k: "model" }>, query: LineState): void => {
		const visible = untrack(() => visibleModels(query.text));
		const keep = visible.some(entry => entry.selector === current.selected);
		screen.set({ ...current, query, selected: keep ? current.selected : visible[0]?.selector });
	};

	const runExternalEditor = (current: Extract<Screen, { k: "instructions" }>): void => {
		const external = deps.externalEditor;
		if (!external) return;
		void external(current.text)
			.then(result => {
				if (result === null || untrack(screen) !== current) return;
				screen.set({ ...current, text: result, cursor: result.length });
			})
			.catch(fail);
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const current = untrack(screen);
		if (isListScreen(current)) {
			const items = untrack(() => itemsOf(current));
			switch (listKeyId(key)) {
				case "up":
					moveList(current, current.cursor - 1);
					return true;
				case "down":
					moveList(current, current.cursor + 1);
					return true;
				case "enter": {
					const item = items[current.cursor];
					if (item) activateListItem(current, item);
					return true;
				}
				case "escape":
					cancelList(current);
					return true;
			}
			return false;
		}
		switch (current.k) {
			case "name":
			case "review-interval": {
				if (getKeybindings().matches(key, "tui.input.submit")) {
					if (current.k === "name") submitName(current);
					else submitInterval(current);
					return true;
				}
				if (matchesSelectCancel(key)) {
					showDetail(current.index);
					return true;
				}
				const line = editLine(current.line, key);
				if (!line) return false;
				screen.set({ ...current, line });
				return true;
			}
			case "model": {
				switch (listKeyId(key)) {
					case "up":
						moveModel(current, -1, true);
						return true;
					case "down":
						moveModel(current, 1, true);
						return true;
					case "pageUp":
						moveModel(current, -MODEL_PAGE, false);
						return true;
					case "pageDown":
						moveModel(current, MODEL_PAGE, false);
						return true;
					case "enter":
						if (current.selected) pickModel(current.index, current.selected);
						return true;
					case "escape":
						cancelModel(current);
						return true;
				}
				const query = editLine(current.query, key);
				if (!query) return false;
				setQuery(current, query);
				return true;
			}
			case "instructions": {
				if (matchesAnyKey(key, appFollowUpKeys())) {
					submitInstructions(current);
					return true;
				}
				if (matchesSelectCancel(key)) {
					leaveInstructions(current.index);
					return true;
				}
				if (matchesAnyKey(key, appExternalEditorKeys())) {
					runExternalEditor(current);
					return true;
				}
				const next = editText(current, key);
				if (!next) return false;
				screen.set({ ...current, ...next });
				return true;
			}
		}
	};

	const onPaste = (paste: PasteEvent): boolean => {
		const current = untrack(screen);
		if (current.k !== "instructions") return true;
		const text = paste.text.replace(/\r\n?/g, "\n");
		screen.set({
			...current,
			text: current.text.slice(0, current.cursor) + text + current.text.slice(current.cursor),
			cursor: current.cursor + text.length,
		});
		return true;
	};

	// ─── Native events ──────────────────────────────────────────────────────

	/** The advisor a page shows: the edited one, else the roster's highlighted advisor, else the first. */
	const pageIndex = (): number => {
		const current = screen();
		if (current.k !== "list") return current.index >= 0 ? current.index : 0;
		const value = rosterItems()[current.cursor]?.value ?? "";
		const match = /^advisor:(\d+)$/.exec(value);
		return match ? Number(match[1]) : value === "shared" ? -1 : 0;
	};

	/** The look's pointer: a row click activates it, the wheel moves the list, a model click selects then picks. */
	const pointer = (value: string): void => {
		const current = untrack(screen);
		const colon = value.indexOf(":");
		const op = value.slice(0, colon);
		const arg = value.slice(colon + 1);
		if (op === "pick" && current.k === "model") {
			if (arg === current.selected) pickModel(current.index, arg);
			else screen.set({ ...current, selected: arg });
			return;
		}
		if (!isListScreen(current)) return;
		if (op === "wheel") {
			moveList(current, current.cursor + Number(arg));
			return;
		}
		if (op === "click") {
			const index = Number(arg);
			const item = untrack(() => itemsOf(current))[index];
			if (!item) return;
			const moved = { ...current, cursor: index };
			if (index !== current.cursor) {
				if (current.k === "list") setScreen(moved);
				else screen.set(moved);
			}
			activateListItem(moved, item);
		}
	};

	const onEvent = (event: UiEvent): void => {
		// The review-interval card's buttons, on its Enter and Esc paths.
		if (event.type === "action" && (event.act === "field-save" || event.act === "field-cancel")) {
			const current = untrack(screen);
			if (current.k !== "review-interval") return;
			if (event.act === "field-save") submitInterval(current);
			else showDetail(current.index);
			return;
		}
		if (event.type === "action" && event.act === ADVISOR_POINTER_ACT) {
			if (event.value) pointer(event.value);
			return;
		}
		const index = untrack(pageIndex);
		switch (event.type) {
			case "action": {
				if (event.act === "page" && event.value) {
					const match = /^advisor:(\d+)$/.exec(event.value);
					if (match) showDetail(Number(match[1]));
					else if (event.value === "shared") showInstructionsEditor(-1);
					return;
				}
				if (event.act === "close") {
					if (event.value !== undefined) onKey(ESCAPE);
					else cb.close();
					return;
				}
				if (event.act === "save" || event.act === "add" || event.act === "scope") {
					runListSelect(event.act);
					return;
				}
				if (event.value === "shared") showInstructionsEditor(-1);
				else if (index >= 0 && event.value) detailSelect(index, event.act === "delete" ? "delete" : event.value);
				return;
			}
			case "change": {
				const advisor = index < 0 ? undefined : untrack(advisors)[index];
				if (!advisor || !("item" in event)) return;
				const value = event.value;
				if (event.item === "toggleEnabled" && typeof value === "boolean") {
					if (value !== (advisor.enabled !== false)) detailSelect(index, "toggleEnabled");
					return;
				}
				let changed = false;
				if (event.item === "tools" && Array.isArray(value)) {
					const tools = commitTools(value.map(String), deps.availableToolNames, deps.defaultToolNames);
					edit(() => {
						advisor.tools = tools;
					});
					changed = true;
				} else if (event.item === "name" && typeof value === "string" && value.trim()) {
					edit(() => {
						advisor.name = value.trim();
					});
					changed = true;
				} else if (event.item === "reviewMode" && (typeof value === "string" || value === null)) {
					// `turn` is the default, stored as an omitted field; `null` resets to it.
					const mode = value === null ? "turn" : ADVISOR_REVIEW_MODES.find(m => m === value);
					if (!mode) return;
					edit(() => {
						advisor.reviewMode = mode === "turn" ? undefined : mode;
					});
					changed = true;
				} else if (event.item === "reviewInterval" && (typeof value === "number" || value === null)) {
					const interval = value ?? 1;
					if (!Number.isSafeInteger(interval) || interval < 1) return;
					edit(() => {
						advisor.reviewInterval = interval === 1 ? undefined : interval;
					});
					changed = true;
				} else if (event.item === "syncBacklog" && (typeof value === "string" || value === null)) {
					// The inherit sentinel and `null` match no mode: the override clears.
					edit(() => {
						advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === value);
					});
					changed = true;
				}
				if (changed) showDetail(index);
				return;
			}
			case "activate":
				if (event.item === "shared") showInstructionsEditor(-1);
				else if (index >= 0) detailSelect(index, event.item);
				return;
			case "select": {
				const current = untrack(screen);
				if (current.k !== "detail") return;
				const at = untrack(() => itemsOf(current)).findIndex(item => item.value === event.item);
				if (at >= 0) screen.set({ ...current, cursor: at });
				return;
			}
		}
	};

	/** An event of the editor's picker sheet, on the path of the key it stands for. */
	const onPickerEvent = (event: UiEvent): void => {
		const current = untrack(screen);
		if (current.k === "model") {
			if (event.type === "select" || event.type === "activate") {
				if (!untrack(models).some(entry => entry.selector === event.item)) return;
				if (event.type === "activate") pickModel(current.index, event.item);
				else screen.set({ ...current, selected: event.item });
			} else if (event.type === "action") {
				if (event.act === "close") cancelModel(current);
				else if (event.act === "use" && current.selected) pickModel(current.index, current.selected);
			}
			return;
		}
		if (!isListScreen(current)) return;
		const items = untrack(() => itemsOf(current));
		if (event.type === "select" || event.type === "activate") {
			const at = items.findIndex(item => item.value === event.item);
			if (at < 0) return;
			const moved = { ...current, cursor: at };
			screen.set(moved);
			if (event.type === "activate") activateListItem(moved, items[at]!);
			return;
		}
		if (event.type !== "action") return;
		// The tools sheet applies on its Esc action.
		if (event.act === "apply" || event.act === "close") onKey(ESCAPE);
		else if (event.act === "confirm") onKey(ENTER);
	};

	/** A native text edit on the open field (`len` guards against stale edits). */
	const onFieldEdit = (event: Extract<UiEvent, { type: "edit" }>): void => {
		const current = untrack(screen);
		const apply = (text: string): LineState | undefined =>
			event.len === text.length
				? { text: text.slice(0, event.from) + event.text + text.slice(event.to), cursor: event.cursor }
				: undefined;
		if (current.k === "instructions") {
			const next = apply(current.text);
			if (next) screen.set({ ...current, ...next });
		} else if (current.k === "review-interval" || current.k === "name") {
			const line = apply(current.line.text);
			if (line) screen.set({ ...current, line });
		}
	};

	const onHookAction = (act: string): void => {
		const current = untrack(screen);
		if (current.k !== "instructions") return;
		if (act === "submit") submitInstructions(current);
		else if (act === "cancel") leaveInstructions(current.index);
	};

	// ─── Native page ────────────────────────────────────────────────────────

	const pages = computed(() => {
		const out: TspPrefsProps["pages"][number][] = advisors().map((advisor, i) => ({
			id: `advisor:${i}`,
			label: advisor.name || "(unnamed)",
			icon: "advisor",
			group: "Advisors",
		}));
		out.push({ id: "shared", label: "Shared instructions", icon: "doc", group: "All advisors" });
		return out;
	});

	const sections = computed(() => {
		const current = doc();
		const index = pageIndex();
		const advisor = index < 0 ? undefined : advisors()[index];
		const out: TspPrefsProps["sections"][number][] = [];
		if (current.warnings?.length) {
			out.push({
				id: "warnings",
				title: "Config problems",
				rows: sanitizeDisplayWarnings(current.warnings).map((warning, i) => ({
					id: `warning:${i}`,
					label: "Dropped while loading",
					warning,
					control: { k: "action", label: "Save to rewrite", act: "save" },
				})),
			});
		}
		if (advisor) {
			const model = advisor.model?.trim();
			const rows: TspPrefsRow[] = [
				{
					id: "toggleEnabled",
					label: "Enabled",
					hint: "Run this advisor alongside the session.",
					control: { k: "switch", on: advisor.enabled !== false },
				},
				{ id: "name", label: "Name", control: { k: "text", value: advisor.name } },
				{
					id: "model",
					label: "Model",
					hint: model ? undefined : `Uses the advisor role default (${deps.defaultModelLabel ?? "unset"}).`,
					changed: model ? true : undefined,
					defaultLabel: model ? (deps.defaultModelLabel ?? "advisor role default") : undefined,
					control: { k: "action", label: modelLabel(advisor), act: "edit" },
				},
				{
					id: "reviewMode",
					label: "Review mode",
					hint: "turn reviews every primary turn; agent-end reviews only final yields.",
					changed: advisor.reviewMode !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.reviewMode ?? "turn",
						options: ADVISOR_REVIEW_MODES.map(mode => ({ value: mode, label: mode })),
						style: "segmented",
					},
				},
				{
					id: "reviewInterval",
					label: "Review interval",
					hint: "Review every Nth eligible update; skipped updates join the next review.",
					changed: advisor.reviewInterval !== undefined ? true : undefined,
					control: { k: "number", value: advisor.reviewInterval ?? 1, min: 1, step: 1 },
				},
				{
					id: "syncBacklog",
					label: "Sync backlog",
					hint: `Catch-up policy; inherit follows advisor.syncBacklog (currently ${deps.syncBacklog ?? "off"}).`,
					changed: advisor.syncBacklog !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.syncBacklog ?? SYNC_BACKLOG_INHERIT,
						options: [
							{ value: SYNC_BACKLOG_INHERIT, label: "inherit" },
							...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
								value: mode,
								label: mode,
								detail: describeSyncBacklogMode(mode),
							})),
						],
						style: "menu",
					},
				},
				{
					id: "tools",
					label: "Tools",
					hint: "None means no tools; read, grep and glob are the default.",
					control: {
						k: "multi",
						values: advisor.tools ?? [...deps.defaultToolNames],
						options: deps.availableToolNames.map(name => ({ value: name, label: name })),
					},
				},
				{
					id: "instructions",
					label: "Instructions",
					hint: previewLineOrNone(advisor.instructions),
					control: { k: "action", label: "Edit…", act: "edit" },
				},
				{ id: "delete", label: "Delete this advisor", control: { k: "action", label: "Delete", act: "delete" } },
			];
			out.push({ id: "advisor", title: advisor.name || "Advisor", rows });
		} else {
			out.push({
				id: "shared",
				title: "Shared instructions",
				rows: [
					{
						id: "shared",
						label: "Instructions",
						hint: previewLineOrNone(current.instructions),
						control: { k: "action", label: "Edit…", act: "edit" },
					},
				],
			});
		}
		out.push({
			id: "file",
			title: `WATCHDOG.yml · ${scope()}`,
			rows: [
				{
					id: "save",
					label: "Save & apply",
					hint: "Write this file and reload the live advisors without a restart.",
					warning: dirty() ? "Unsaved changes" : undefined,
					control: { k: "action", label: "Save", act: "save" },
				},
				{
					id: "add",
					label: "Add advisor",
					hint: "Create a new advisor entry, then set its model, tools and instructions.",
					control: { k: "action", label: "Add", act: "add" },
				},
				{
					id: "scope",
					label: "Scope",
					hint: `Editing the ${scope()} file. Switch to the ${otherScope()} file.`,
					control: { k: "action", label: `Open ${otherScope()}`, act: "scope" },
				},
			],
		});
		return out;
	});

	const focus = (): string | null => {
		const current = screen();
		return current.k === "detail" ? (itemsOf(current)[current.cursor]?.value ?? null) : null;
	};

	const editing = (): TspPrefsProps["editing"] => {
		const current = screen();
		return current.k === "name" ? { row: "name", draft: current.line.text, cursor: current.line.cursor } : null;
	};

	// ─── Terminal look ──────────────────────────────────────────────────────

	const preview = (cursor: number): AdvisorPreviewLine[] => {
		const current = doc();
		const lines: AdvisorPreviewLine[] = [];
		// The fullscreen overlay hides the host's warning toasts: the file's load problems stay pinned on top.
		if (current.warnings?.length) {
			lines.push({ text: "⚠ Config problems — dropped while loading:", style: "warning" });
			for (const warning of sanitizeDisplayWarnings(current.warnings))
				lines.push({ text: warning, style: "warning", wrap: true });
			lines.push({ text: "" });
		}
		const value = rosterItems()[cursor]?.value ?? "";
		const match = /^advisor:(\d+)$/.exec(value);
		const advisor = match ? advisors()[Number(match[1])] : undefined;
		if (advisor) {
			lines.push(...advisorPreview(advisor));
			return lines;
		}
		if (value === "shared") {
			const text = current.instructions?.trim();
			lines.push(
				{ text: "Shared instructions", style: "strong" },
				{ text: "" },
				text ? { text, wrap: true } : { text: "(none)", style: "muted" },
			);
			return lines;
		}
		const help =
			value === "add"
				? "Create a new advisor entry, then edit its model, tools, and instructions."
				: value === "scope"
					? `Switch between the project and user WATCHDOG.yml. Currently editing the ${scope()}-level file.`
					: value === "save"
						? "Write this scope's WATCHDOG.yml and reload the live advisors without a restart."
						: value === "close"
							? "Close the editor. Unsaved changes are discarded."
							: "";
		lines.push({ text: help, style: "muted", wrap: true });
		return lines;
	};

	const advisorPreview = (advisor: AdvisorConfig): AdvisorPreviewLine[] => {
		const instructions = advisor.instructions?.trim();
		const lines: AdvisorPreviewLine[] = [
			{ text: advisor.name || "(unnamed)", style: "strong" },
			{ text: "" },
			{ label: "Enabled:", text: advisor.enabled === false ? "○ off" : "● on" },
			{ label: "Model:", text: modelLabel(advisor) },
			{ label: "Tools:", text: formatAdvisorTools(advisor.tools) },
			{ label: "Review:", text: formatReviewCadence(advisor) },
			{ label: "Sync backlog:", text: syncBacklogLabel(advisor) },
			{ text: "" },
			{ text: "Instructions:", style: "dim" },
			instructions ? { text: instructions, wrap: true } : { text: "(none)", style: "muted" },
		];
		const stat = cb.stats?.().find(s => s.name === (advisor.name || "default"));
		if (stat && (stat.status === "running" || stat.status === "quota_exhausted")) {
			const spend = [`${stat.tokens.input.toLocaleString()} in`, `${stat.tokens.output.toLocaleString()} out`];
			if (stat.tokens.cacheRead > 0) spend.push(`${stat.tokens.cacheRead.toLocaleString()} cache`);
			lines.push(
				{ text: "" },
				{ text: "Usage:", style: "dim" },
				{ text: `  Tokens: ${spend.join(", ")}`, style: "dim" },
			);
			if (stat.cost > 0) lines.push({ text: `  Cost: $${stat.cost.toFixed(4)}`, style: "dim" });
			if (stat.contextWindow > 0) {
				const pct = Math.round((stat.contextTokens / stat.contextWindow) * 100);
				lines.push({
					text: `  Context: ${stat.contextTokens.toLocaleString()}/${stat.contextWindow.toLocaleString()} (${pct}%)`,
					style: "dim",
				});
			}
		}
		const provider = (advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? stat?.model?.provider;
		const available = reports();
		if (available && provider) {
			const quota = formatCompactQuota(
				provider,
				available,
				now(),
				cb.getQuotaLimitFilter?.(provider, stat?.sessionId),
			);
			if (quota) lines.push({ text: `  ${quota}`, style: "dim" });
		}
		return lines;
	};

	const options = (items: readonly Item[]): AdvisorListOption[] =>
		items.map(item => ({ label: item.label, detail: item.description }));

	const modelLook = (current: Extract<Screen, { k: "model" }>): AdvisorScreenLook => {
		const visible = visibleModels(current.query.text);
		const rows: AdvisorModelRow[] = [];
		let recent = false;
		for (const entry of visible) {
			if (!entry.recent && recent) rows.push({ sep: true });
			recent = entry.recent;
			rows.push({
				id: entry.selector,
				provider: entry.provider,
				name: entry.id,
				ctx: formatCompactCount(entry.model.contextWindow ?? 0),
				price: modelPrice(entry.model, "/"),
			});
		}
		const selected = visible.find(entry => entry.selector === current.selected);
		return {
			k: "models",
			query: current.query.text,
			cursor: current.query.cursor,
			rows,
			selected: current.selected,
			detail: selected ? modelDetail(selected.model) : "",
		};
	};

	const footer = (current: Screen): string => {
		const ok = bindingGlyph("tui.select.confirm", "enter");
		const save = bindingGlyph("tui.input.submit", "enter");
		const esc = bindingGlyph("tui.select.cancel", "escape");
		switch (current.k) {
			case "list":
				return `${selectNavGlyphs()} move · ${ok} / click select · scroll preview on the right · ${esc} close`;
			case "detail":
				return `Editing "${advisors()[current.index]?.name ?? ""}" · ${ok} / click edit field · ${esc} back`;
			case "name":
				return `Type a name · ${save} save · ${esc} cancel`;
			case "model":
				return `Type to search · ${ok} / click twice picks · ${esc} back`;
			case "thinking":
				return `Thinking effort for ${current.selector} · ${ok} / click pick · ${esc} back`;
			case "review-mode":
				return `${ok} / click choose review mode · ${esc} back`;
			case "review-interval":
				return `Type a positive integer · ${save} save · ${esc} cancel`;
			case "sync-backlog":
				return `${ok} / click choose catch-up policy · ${esc} back`;
			case "tools":
				return `${ok} / click toggle · select Done or ${esc} to apply (empty = no tools; read/grep/glob = default)`;
			case "instructions":
				return "";
		}
	};

	const term = computed((): AdvisorLookTerm => {
		const current = screen();
		let look: AdvisorScreenLook;
		if (current.k === "list") {
			look = {
				k: "roster",
				options: options(rosterItems()),
				cursor: current.cursor,
				preview: preview(current.cursor),
			};
		} else if (isListScreen(current)) {
			look = { k: "list", options: options(itemsOf(current)), cursor: current.cursor };
		} else if (current.k === "name" || current.k === "review-interval") {
			look = { k: "input", text: current.line.text, cursor: current.line.cursor };
		} else if (current.k === "model") {
			look = modelLook(current);
		} else {
			const title =
				current.index < 0
					? "Shared advisor instructions"
					: `Instructions — ${advisors()[current.index]?.name ?? ""}`;
			look = { k: "editor", title, text: current.text, cursor: current.cursor };
		}
		return {
			role: ADVISOR_CONFIG_ROLE,
			title: `Advisor configuration · ${scope()}${dirty() ? "  ● unsaved" : ""}`,
			footer: footer(current),
			previewKey: String(previewEpoch()),
			screen: look,
		};
	});

	// ─── Editors over the page ──────────────────────────────────────────────

	const advisorName = (index: number, fallback: string): string => advisors()[index]?.name || fallback;

	const listSheet = (current: ListScreen): JSXNode => {
		const items = itemsOf(current);
		const advisor = current.k === "list" ? undefined : advisors()[current.index];
		let sheet: {
			title: string;
			subtitle: string;
			icon: string;
			noun: string;
			current: string[];
			items: TspPickerItem[];
			actions: TspPickerAction[];
		};
		const select = [pickerAction("confirm", "Select", confirmKbd(), { primary: true }), closeAction()];
		switch (current.k) {
			case "thinking": {
				const model = advisor?.model?.trim();
				const level =
					model === current.selector
						? ""
						: model?.startsWith(`${current.selector}:`)
							? model.slice(current.selector.length + 1)
							: undefined;
				sheet = {
					title: "Thinking level",
					subtitle: `How hard ${advisor?.name || "the advisor"} reasons on ${current.selector}.`,
					icon: "thinking",
					noun: "levels",
					current: level === undefined ? [] : [level],
					items: items.map(item => {
						if (!item.value) return { id: "", label: "Model default", detail: "No level; the provider decides." };
						const parsed = parseThinkingLevel(item.value);
						return {
							id: item.value,
							label: item.label,
							detail: parsed ? getThinkingLevelMetadata(parsed).description : undefined,
							chips: [{ text: "", dot: `thinking${item.value.charAt(0).toUpperCase()}${item.value.slice(1)}` }],
						};
					}),
					actions: [pickerAction("confirm", "Use level", confirmKbd(), { primary: true }), closeAction()],
				};
				break;
			}
			case "review-mode":
				sheet = {
					title: "Review mode",
					subtitle: `When ${advisor?.name || "the advisor"} reviews the session.`,
					icon: "review",
					noun: "modes",
					current: [advisor?.reviewMode ?? "turn"],
					items: items.map(item => ({ id: item.value, label: item.value, detail: item.description })),
					actions: select,
				};
				break;
			case "sync-backlog":
				sheet = {
					title: "Sync backlog",
					subtitle: `How long the session waits for ${advisor?.name || "the advisor"}'s pending reviews.`,
					icon: "time",
					noun: "policies",
					current: [advisor?.syncBacklog ?? SYNC_BACKLOG_INHERIT],
					items: items.map(item => ({ id: item.value, label: item.value, detail: item.description })),
					actions: select,
				};
				break;
			case "tools":
				sheet = {
					title: "Tools",
					subtitle: `What ${advisor?.name || "the advisor"} may call. None grants no tools; read, grep and glob are the default.`,
					icon: "tools",
					noun: "tools",
					current: [...current.selected],
					items: items
						.filter(item => item.value !== TOOLS_DONE)
						.map(item => ({ id: item.value, label: item.value })),
					actions: [
						pickerAction("confirm", "Toggle", confirmKbd()),
						pickerAction("apply", "Apply", cancelKbd(), { primary: true, end: true }),
					],
				};
				break;
			default:
				return null;
		}
		return (
			<picker
				{...sheet}
				size="md"
				layout="rows"
				preview="none"
				query={null}
				confirm={null}
				selected={items[current.cursor]?.value ?? null}
				onEvent={onPickerEvent}
			/>
		);
	};

	const modelSheet = (current: Extract<Screen, { k: "model" }>): JSXNode => {
		const catalogue = models();
		const visible = visibleModels(current.query.text);
		const query = current.query.text;
		const order: (string | { count: number; group: string; label: string })[] = [];
		const recent = visible.filter(entry => entry.recent);
		const rest = visible.filter(entry => !entry.recent);
		if (recent.length > 0)
			order.push({ count: recent.length, group: "recent", label: "Recent" }, ...recent.map(e => e.selector));
		if (rest.length > 0)
			order.push(
				{ count: rest.length, group: "rest", label: query.trim() ? "Matches" : "All" },
				...rest.map(e => e.selector),
			);
		let hits: Record<string, [number, number][]> | undefined;
		if (query.trim()) {
			hits = {};
			for (const entry of visible) {
				const range = hitRange(entry.selector, query);
				if (range) hits[entry.selector] = range;
			}
		}
		const modelCurrent = currentModel(current.index);
		const selected = catalogue.find(entry => entry.selector === current.selected);
		const fallback = deps.defaultModelLabel ?? "the advisor role default";
		return (
			<picker
				title="Advisor model"
				subtitle={`${advisorName(current.index, "This advisor")} reviews with this model. Unset, it uses ${fallback}.`}
				icon="model"
				noun="models"
				size="md"
				layout="rows"
				preview="below"
				placeholder="Search models…"
				items={catalogue.map(entry => ({
					id: entry.selector,
					label: entry.selector,
					mono: true,
					mark: {
						icon: `provider:${entry.provider}`,
						seed: entry.provider,
						text: entry.provider.charAt(0).toUpperCase() + entry.provider.slice(1, 2),
					},
					facts: { ctx: entry.model.contextWindow ?? 0, price: modelPrice(entry.model, "·") },
				}))}
				order={order}
				columns={MODEL_COLUMNS}
				current={modelCurrent ? [modelCurrent] : undefined}
				selected={current.selected ?? null}
				query={query}
				cursor={current.query.cursor}
				hits={hits}
				total={catalogue.length}
				empty="No models available"
				actions={[
					pickerAction("use", "Use for advisor", confirmKbd(), { primary: true }),
					query.length > 0 ? closeAction("Clear search") : closeAction(),
				]}
				onEvent={onPickerEvent}
			>
				{selected ? (
					<kv
						layout="inline"
						items={[
							{ k: "ctx", v: formatCompactCount(selected.model.contextWindow ?? 0) },
							{ k: "out", v: formatCompactCount(selected.model.maxTokens ?? 0) },
							{ k: "price", v: `${modelPrice(selected.model, "/")} per M` },
							{ k: "reasoning", v: selected.model.reasoning ? "yes" : "no" },
						]}
					/>
				) : null}
				{selected && selected.selector === modelCurrent ? (
					<row gap="xs" wrap>
						<badge text="current" tone="success" />
					</row>
				) : null}
			</picker>
		);
	};

	const actionButton = (id: string, label: string, keys: string[], title: string, accent: boolean): JSXNode => (
		<ActionButton id={id} label={label} title={title} tone={accent ? "accent" : undefined} keys={keys} />
	);

	const intervalCard = (current: Extract<Screen, { k: "review-interval" }>): JSXNode => (
		<col role="omp.prefs.editor">
			<card
				role="omp.overlay.advisor.interval"
				head={`Review interval · ${advisorName(current.index, "this advisor")}`}
			>
				<text
					spans={[{ t: "Review every Nth eligible update; skipped updates join the next review.", s: "muted" }]}
					wrap="word"
				/>
				<input
					text={current.line.text}
					cursor={current.line.cursor}
					prompt="> "
					sendable={false}
					onEdit={onFieldEdit}
				/>
				<row key="actions" role="omp.actions" align="center" gap="sm">
					<spacer grow={1} />
					{actionButton(
						"field-cancel",
						"Cancel",
						cancelKbd(),
						`Cancel  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`,
						false,
					)}
					{actionButton(
						"field-save",
						"Save",
						actionKbd("tui.input.submit", "enter"),
						`Save  ${keyTitle(actionKeyId("tui.input.submit", "enter"))}`,
						true,
					)}
				</row>
			</card>
		</col>
	);

	const instructionsCard = (current: Extract<Screen, { k: "instructions" }>): JSXNode => (
		<col role="omp.prefs.editor">
			<col role="omp.overlay.hook-editor" onAction={onHookAction}>
				<col key="head" role="omp.hook-editor.head" gap="xs">
					<text
						key="title"
						role="omp.hook-editor.title"
						spans={[
							{
								t:
									current.index < 0
										? "Shared advisor instructions"
										: `Instructions — ${advisors()[current.index]?.name ?? ""}`,
							},
						]}
						wrap="word"
					/>
				</col>
				<col role="omp.hook-editor.field">
					<editor
						key="input"
						text={current.text}
						cursor={current.cursor}
						maxLines={18}
						placeholder={current.text ? undefined : [{ t: "Type here" }]}
						sendable={false}
						onEdit={onFieldEdit}
					/>
				</col>
				<row key="actions" role="omp.actions" align="center" gap="sm">
					<spacer grow={1} />
					{actionButton(
						"cancel",
						"Cancel",
						cancelKbd(),
						`Cancel  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`,
						false,
					)}
					{actionButton(
						"submit",
						"Submit",
						kbdOf(followUpKey()),
						`Submit  ${keyTitle(followUpKey())} · New line  ${keyTitle("enter")}`,
						true,
					)}
				</row>
			</col>
		</col>
	);

	const sheet = (): JSXNode => {
		const current = screen();
		if (current.k === "model") return modelSheet(current);
		if (current.k === "review-interval") return intervalCard(current);
		if (current.k === "instructions") return instructionsCard(current);
		if (isListScreen(current) && current.k !== "list" && current.k !== "detail") return listSheet(current);
		return null;
	};

	return (
		<prefs
			title={() => (dirty() ? "Advisors · unsaved" : "Advisors")}
			pages={pages}
			page={() => {
				const index = pageIndex();
				return index < 0 ? "shared" : `advisor:${index}`;
			}}
			lead={() => (pageIndex() < 0 ? SHARED_LEAD : ADVISOR_LEAD)}
			sections={sections}
			focus={focus}
			editing={editing}
			term={term}
			onKey={onKey}
			onPaste={onPaste}
			onEvent={onEvent}
		>
			{sheet}
		</prefs>
	);
}

/** The roster's seeded placeholder, which saving drops again. */
function isSyntheticDefault(doc: WatchdogConfigDoc): boolean {
	if (doc.advisors.length !== 1) return false;
	const advisor = doc.advisors[0]!;
	return (
		advisor.name === "default" &&
		!advisor.model?.trim() &&
		advisor.tools === undefined &&
		advisor.reviewMode === undefined &&
		advisor.reviewInterval === undefined &&
		advisor.syncBacklog === undefined &&
		!advisor.instructions?.trim() &&
		advisor.enabled !== false &&
		advisor.maxNotesPerUpdate === undefined &&
		advisor.scope === undefined &&
		advisor.includeReasoning === undefined
	);
}
