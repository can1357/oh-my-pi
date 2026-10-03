/**
 * Tern Surface Protocol (TSP) wire shapes.
 *
 * A TSP program describes its UI as a tree of semantic components and the
 * terminal lays it out, draws and animates it natively. Messages travel
 * in-band as APC strings on the pty:
 *
 *     ESC _ tsp ; <verb> [; <key>=<value>]* ; <body> ESC \
 *
 * `body` is UTF-8 JSON (base64 for blob chunks). Program → terminal verbs:
 * `q` query, `o` open, `f` frame, `b` blob, `t` palette, `x` close. Terminal →
 * program: `r` reply, `e` event (on the pty's input side).
 *
 * The normative spec is `crates/tern/SURFACE_PROTOCOL.md` in the Stencil
 * repository; these types mirror it. Unknown fields and verbs are ignored in
 * both directions, so every addition here is optional.
 */

/** Protocol version this build speaks. */
export const TSP_VERSION = 1;
/** APC identifier: every TSP message body starts with `tsp;`. */
export const TSP_APC_ID = "tsp";
/** Largest APC body a sender emits before chunking unless the hello reply says otherwise. */
export const TSP_DEFAULT_APC_LIMIT = 65_536;
/** Unacknowledged frames a sender may have in flight unless the hello reply says otherwise. */
export const TSP_DEFAULT_CREDITS = 2;

/** One-letter message verb. */
export type TspVerb = "q" | "o" | "f" | "b" | "t" | "x" | "r" | "e";

// ═══════════════════════════════════════════════════════════════════════════
// Vocabulary
// ═══════════════════════════════════════════════════════════════════════════

/** Every component kind in the v1 vocabulary. */
export const TSP_KINDS = [
	"col",
	"row",
	"card",
	"section",
	"rule",
	"spacer",
	"text",
	"md",
	"code",
	"diff",
	"ansi",
	"math",
	"image",
	"kv",
	"table",
	"tree",
	"badge",
	"kbd",
	"icon",
	"spinner",
	"shimmer",
	"elapsed",
	"progress",
	"rate",
	"list",
	"item",
	"tabs",
	"editor",
	"input",
	"status",
	"seg",
	"overlay",
	"toast",
	"rows",
	"picker",
	"prefs",
	"tool",
	"checklist",
	"agent",
	"chart",
	"meter",
	"effort",
] as const;

export type TspKind = (typeof TSP_KINDS)[number];

/** Semantic colour of a node's chrome. */
export type TspTone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";

/** Spacing step for `gap`/`size`. */
export type TspSpace = "none" | "xs" | "sm" | "md" | "lg";

/**
 * Size bound: `"40ch"`, `"10lines"`, or a fraction of the available extent
 * (`0.4`). Never pixels or cells.
 */
export type TspExtent = `${number}ch` | `${number}lines` | number;

/** Per-span visual effect, clocked by the terminal. */
export type TspEffect = "shimmer" | "pulse" | "none";

/**
 * One styled run of text. `s` holds space-separated semantic tokens
 * (`muted`, `dim`, `strong`, `em`, `accent`, `success`, `warning`, `error`,
 * `info`, `code`, `mono`, `path`, `key`, `link`, `num`, `ins`, `del`, `mark`,
 * `typo`, `icon`, `hide`) or omp theme token names (`thinkingText`,
 * `toolTitle`, …). `mark` highlights (a match, the selected row); `typo` is a
 * misspelled word, which the terminal underlines as its own spell checker does.
 * `icon` marks a run of icon glyphs (Nerd Font / Private Use Area codepoints):
 * the terminal draws it in its icon face and spaces it from neighbouring text
 * itself, so senders omit padding spaces around icons. `hide` takes the run
 * out of the drawing (an editor's mode sigil a chip stands in for).
 */
export interface TspSpan {
	t: string;
	s?: string;
	fx?: TspEffect;
	href?: string;
}

/** Text given either as one plain string or as styled spans. */
export type TspText = string | readonly TspSpan[];

/**
 * What a pointer gesture on a node does. `zoom` shows an `image` (and the images
 * beside it) large in the terminal's viewer; it is an image's click by default.
 */
export type TspAction = "toggle" | "copy" | "open" | "zoom" | "select" | "activate" | (string & {});

/** Props every node accepts. */
export interface TspCommonProps {
	role?: string;
	key?: string;
	tone?: TspTone;
	hidden?: boolean;
	grow?: number;
	shrink?: number;
	basis?: "auto" | "content" | number;
	min?: { w?: TspExtent; h?: TspExtent };
	max?: { w?: TspExtent; h?: TspExtent };
	actions?: { click?: TspAction; dblclick?: TspAction; menu?: readonly TspAction[] };
	title?: string;
	/** Accessible name for icon-only or visual-only nodes. */
	aria?: string;
	/** Target of an `open` action on this node (a URL or `file://` path). */
	href?: string;
	/**
	 * Transient selection state drawn over the node without restyling it (the
	 * rewind page): `pick` marks the chosen point (adjacent picks read as one
	 * run), `drop` dims what the choice discards.
	 */
	mark?: TspMark;
}

/** A {@link TspCommonProps.mark}. */
export type TspMark = "pick" | "drop";

export type TspWrap = "word" | "char" | "none";
export type TspTruncate = "end" | "start" | "middle";
export type TspCardStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type TspPreview = { lines: number } | "auto";

export interface TspColProps {
	gap?: TspSpace;
	align?: "start" | "center" | "end" | "stretch";
}
export interface TspRowProps {
	gap?: TspSpace;
	align?: "start" | "center" | "baseline" | "end";
	justify?: "start" | "between" | "end";
	wrap?: boolean;
}
export interface TspCardProps {
	/** Header content, inline. */
	head?: TspText;
	status?: TspCardStatus;
	collapsible?: boolean;
	collapsed?: boolean;
	/** Body clamp while collapsed. */
	preview?: TspPreview;
	selected?: boolean;
	inset?: boolean;
	/** `bare`: no ring, fill or insets — a plain head row over the body, for grouped/compact presentations inside another frame. */
	variant?: "bare";
}
export interface TspSectionProps {
	head?: TspText;
	collapsible?: boolean;
	collapsed?: boolean;
	/** A finished thinking section (`omp.thinking*`): how long it thought, in ms, like a tool card's `took`. */
	took?: number;
}
export interface TspRuleProps {
	label?: TspText;
}
export interface TspSpacerProps {
	size?: TspSpace;
}
export interface TspTextProps {
	text?: string;
	spans?: readonly TspSpan[];
	wrap?: TspWrap;
	truncate?: TspTruncate;
	lines?: number;
	measure?: "prose" | "fill";
}
export interface TspMarkdownProps {
	text?: string;
	/** The tail is still arriving. */
	stream?: boolean;
	/** Literal runs drawn as these spans wherever they occur in prose (a sent prompt's chip tokens). */
	marks?: readonly TspSpan[];
}
export interface TspCodeProps {
	text?: string;
	lang?: string;
	path?: string;
	start?: number;
	numbers?: boolean;
	marks?: readonly { line: number; tone: TspTone }[];
	wrap?: boolean;
}
export interface TspDiffHunk {
	oldStart: number;
	newStart: number;
	lines: readonly string[];
}
export interface TspDiffProps {
	/** Unified diff text (or give `hunks`). */
	text?: string;
	hunks?: readonly TspDiffHunk[];
	path?: string;
	lang?: string;
	mode?: "unified" | "split" | "auto";
}
export interface TspAnsiProps {
	/** Raw terminal output (SGR, OSC 8, `\r`, `\b` allowed). */
	text?: string;
	/** Keep the tail in view as text arrives. */
	follow?: boolean;
	preview?: TspPreview;
	/** Wrap hint in cells. */
	cols?: number;
}
export interface TspMathProps {
	text?: string;
	display?: boolean;
}
/** Images the terminal ships (`image.p.builtin`): `omp` is omp's gradient mark. */
export type TspBuiltinImage = "omp";
export interface TspImageProps {
	/** Content address (sha256 hex) of a blob sent with verb `b`. */
	blob?: string;
	/** An image the terminal ships, drawn instead of any blob. */
	builtin?: TspBuiltinImage;
	alt?: string;
	w?: number;
	h?: number;
	max?: { w?: TspExtent; h?: TspExtent };
}
export interface TspKvProps {
	items: readonly { k: TspText; v: TspText }[];
	layout?: "grid" | "inline";
}
export interface TspTableColumn {
	id: string;
	head?: TspText;
	align?: "start" | "center" | "end";
	truncate?: TspTruncate;
	/** Lower priorities hide first when narrow. */
	priority?: number;
	grow?: number;
}
export interface TspTableProps {
	cols: readonly TspTableColumn[];
	rows: readonly { id: string; cells: Readonly<Record<string, TspText>> }[];
}
export interface TspTreeNode {
	id: string;
	label: TspText;
	icon?: string;
	open?: boolean;
	children?: readonly TspTreeNode[];
}
export interface TspTreeProps {
	nodes: readonly TspTreeNode[];
}
export interface TspBadgeProps {
	text: string;
}
export interface TspKbdProps {
	keys: readonly string[];
}
export interface TspIconProps {
	name: string;
}
export interface TspSpinnerProps {
	style?: "dots" | "braille" | "starburst" | "orbit";
	label?: TspText;
}
export interface TspShimmerProps {
	text?: string;
	spans?: readonly TspSpan[];
	mode?: "classic" | "kitt";
	palette?: { low?: string; mid?: string; high?: string };
}
export interface TspElapsedProps {
	/** Milliseconds already elapsed when the frame was written. */
	age: number;
	/** Freeze at this many milliseconds. */
	stopped?: number;
	format?: "short" | "clock";
}
export interface TspProgressProps {
	/** 0–1, or null for indeterminate. */
	value: number | null;
	label?: TspText;
}
export interface TspRateProps {
	value: number;
	unit?: string;
}
export interface TspListProps {
	selected?: string | null;
	filter?: string;
	empty?: TspText;
	max?: { lines: number } | number;
	virtual?: boolean;
}
export interface TspItemProps {
	label: TspText;
	detail?: TspText;
	icon?: string;
	hint?: readonly string[];
	disabled?: boolean;
	value?: TspText;
}
export interface TspTabsProps {
	items: readonly { id: string; label: TspText }[];
	active?: string;
}
export interface TspEditorDecoration {
	from: number;
	to: number;
	s: string;
	fx?: TspEffect;
}
export interface TspEditorProps {
	text?: string;
	/** Caret as a UTF-16 offset into `text`. */
	cursor?: number;
	/** Selection anchor, or null for none. */
	anchor?: number | null;
	decor?: readonly TspEditorDecoration[];
	/** Inline completion suffix drawn after the caret. */
	ghost?: string;
	placeholder?: string;
	prompt?: TspText;
	/** Mode label (vim). */
	mode?: string;
	/** The text is code in this language (`python`, `bash`): highlighted, in the mono face. */
	lang?: string;
	readonly?: boolean;
	/** Ready to accept an atomic `send` when advertised in `hello.features`.
	 *  Independent of text editability or keyboard focus; absent or false is not ready. */
	sendable?: boolean;
	maxLines?: number;
}
export type TspInputProps = Omit<TspEditorProps, "maxLines">;
export interface TspStatusProps {
	transparent?: boolean;
}
export interface TspSegProps {
	spans?: readonly TspSpan[];
	icon?: string;
	/** Higher priorities stay longer when space runs out. */
	priority?: number;
	min?: { w?: TspExtent; h?: TspExtent };
	/** Which side of the status bar the segment sits on. */
	side?: "left" | "right";
}
export type TspOverlayAnchor =
	| "center"
	| "top"
	| "bottom"
	| { node: string; side: "above" | "below" }
	| { caret: string };
export interface TspOverlayProps {
	anchor?: TspOverlayAnchor;
	size?: "sm" | "md" | "lg" | "full";
	modal?: boolean;
	head?: TspText;
}
export interface TspToastProps {
	text: string;
	sub?: string;
	ttl?: number;
}
export interface TspRowsProps {
	/** Width the rows were rendered at. */
	cols: number;
	/** Pre-rendered ANSI rows (migration fallback only). */
	lines: readonly string[];
}

// ─── Data-first kinds (crates/tern/NATIVE_REDESIGN.md §3–§5) ─────────────

/** One selectable picker row. Every field but `id` and `label` is optional. */
export interface TspPickerItem {
	id: string;
	label: TspText;
	/** Second line (`cards`) or trailing dim text (`rows`). */
	detail?: TspText;
	/** Leading visual: a named icon, a provider/avatar mark, or a status dot. */
	icon?: string;
	mark?: { text: string; seed?: string };
	dot?: TspTone;
	/** Label is a machine string (model id, path): mono, dim prefix and strong tail by the `/`. */
	mono?: boolean;
	/** Values for `columns`, by column id. `bar` columns take a number 0–1. */
	facts?: Readonly<Record<string, TspText | number>>;
	badges?: readonly { text: string; tone?: TspTone; title?: string }[];
	/** Role-style chips after the label (`dot` = a thinking-level or state colour token). */
	chips?: readonly { text: string; on?: boolean; auto?: boolean; dot?: string }[];
	tone?: TspTone;
	/** Disabled, with the reason as tooltip. */
	disabled?: string | true;
	/** Search hits in the label as UTF-16 [from, to) ranges. */
	hits?: readonly (readonly [number, number])[];
	/** `timeline`: node style; `tree`: nesting. */
	node?: "user" | "assistant" | "tool" | "marker";
	depth?: number;
	open?: boolean;
	/** Leading glyph slot for tree/timeline rows (omp role → icon, e.g. `omp.tool.grep`). */
	role?: string;
	title?: string;
}

/** A right-aligned fact column in a picker. */
export interface TspPickerColumn {
	id: string;
	head?: string;
	/** `elapsed`: the value is an age in ms at send; Tern clocks it (spec §9). */
	format?: "text" | "num" | "price" | "bar" | "time" | "elapsed" | "dim";
	/** Lower priorities hide first when narrow. */
	priority?: number;
	/** Minimum width in ch. */
	min?: number;
}

/** A row of a picker's scope column. */
export interface TspPickerScope {
	id: string;
	label: TspText;
	icon?: string;
	mark?: { text: string; seed?: string };
	count?: number;
	/** Group heading this scope sits under (consecutive scopes with the same group share a head). */
	group?: string;
	disabled?: string | true;
	/** Status dot: `success` ok, `warning` cached/empty, `error` unavailable, `muted` signed out. */
	dot?: TspTone;
}

/** A button of a picker's action bar. */
export interface TspPickerAction {
	/** Sent back as `action.act`. */
	id: string;
	label: string;
	/** Keycap(s) the program binds to it, shown in the button (`["enter"]`, `["alt","enter"]`). */
	keys?: readonly string[];
	primary?: boolean;
	danger?: boolean;
	/** Right-aligned group (close, help). */
	end?: boolean;
	/** A toggle's state (`Task model ⌥P`): drawn pressed when true. */
	on?: boolean;
	disabled?: string | true;
}

/** A group header inside a picker's `order`. */
export interface TspPickerGroup {
	group: string;
	label: TspText;
	count?: number;
}

/**
 * A data-first picker sheet (models, sessions, rewind, …). Children are the
 * selected item's preview. A picker under `layer` is itself the modal sheet.
 */
export interface TspPickerProps {
	/**
	 * What is being picked, e.g. "Models" (plain: it is also the common `title` prop, which a picker does not use as a
	 * tooltip). Absent: the head is the icon and the search, and the placeholder names the sheet.
	 */
	title?: string;
	subtitle?: TspText;
	icon?: string;
	/** Plural noun for counts and empty copy ("models", "sessions"). */
	noun?: string;
	size?: "md" | "lg" | "screen";
	layout?: "rows" | "cards" | "timeline" | "tree";
	/** The program's search text (keys stay the program's); `null` hides the field. */
	query?: string | null;
	/** Caret as a UTF-16 offset into `query`; absent puts it at the end. */
	cursor?: number;
	placeholder?: string;
	scopes?: readonly TspPickerScope[];
	scope?: string;
	tabs?: readonly { id: string; label: TspText; count?: number }[];
	tab?: string;
	columns?: readonly TspPickerColumn[];
	/** The catalogue, sent once and patched by id through `itemsAdd`/`itemsDel`. */
	items?: readonly TspPickerItem[];
	/** Upserts applied to `items`. */
	itemsAdd?: readonly TspPickerItem[];
	/** Removals applied to `items`. */
	itemsDel?: readonly string[];
	/** What to show, in order, after the program's filtering: item ids and group headers. Absent = `items` order. */
	order?: readonly (string | TspPickerGroup)[];
	/** Hit ranges per item id for the current query (kept apart so `items` never changes while typing). */
	hits?: Readonly<Record<string, readonly (readonly [number, number])[]>>;
	selected?: string | null;
	/** Items in use now (current model, current session). */
	current?: readonly string[];
	/** Total before filtering, for the head count ("12 of 1,604"). */
	total?: number;
	preview?: "side" | "below" | "none";
	actions?: readonly TspPickerAction[];
	/** A chip strip docked above the action bar (the model hub's role assignment). */
	strip?: {
		label?: TspText;
		items: readonly { id: string; label: TspText; on?: boolean; dot?: string }[];
		selected?: string;
	} | null;
	state?: "ready" | "loading" | "error";
	message?: TspText;
	empty?: TspText;
	confirm?: { text: TspText; act: string; label?: string } | null;
	/** Which region owns the keyboard now: the terminal draws the focus ring there. */
	focus?: "list" | "scopes" | "tabs" | "strip" | "preview";
}

/** A settings row's typed control. */
export type TspPrefsControl =
	| { k: "switch"; on: boolean }
	| {
			k: "choice";
			value: string;
			options: readonly { value: string; label: string; detail?: string }[];
			style?: "auto" | "segmented" | "menu";
			mono?: boolean;
	  }
	| {
			k: "number";
			value: number;
			min?: number;
			max?: number;
			step?: number;
			unit?: string;
			labels?: Readonly<Record<string, string>>;
	  }
	| { k: "text"; value: string; placeholder?: string; secret?: boolean; mono?: boolean }
	| { k: "keys"; keys: readonly (readonly string[])[] }
	| {
			k: "multi";
			values: readonly string[];
			options: readonly { value: string; label: string; detail?: string }[];
			ordered?: boolean;
	  }
	| { k: "action"; label: string; act: string };

/** One settings row. */
export interface TspPrefsRow {
	/** The setting path (`theme.dark`); sent back as `item`. */
	id: string;
	label: string;
	hint?: string;
	warning?: string;
	/** Differs from the default. */
	changed?: boolean;
	/** Default shown in the changed dot's title. */
	defaultLabel?: string;
	disabled?: string;
	control: TspPrefsControl;
}

/** A titled group of settings rows. */
export interface TspPrefsSection {
	id: string;
	title: string;
	/** Search results: the page this section belongs to. */
	page?: string;
	rows: readonly TspPrefsRow[];
}

/** A data-first settings page set (the terminal draws a native settings window). Children are previews placed by `role`. */
export interface TspPrefsProps {
	title: string;
	pages: readonly {
		id: string;
		label: string;
		icon?: string;
		changed?: number;
		group?: string;
		disabled?: string;
	}[];
	page: string;
	/** Lead text of the current page. */
	lead?: string;
	/** The program's search text; non-empty switches the page to search results. */
	query?: string;
	/** Caret as a UTF-16 offset into `query` while the program's search field has it; absent: no caret. */
	cursor?: number;
	sections: readonly TspPrefsSection[];
	/** Row with keyboard focus (the program's selection). */
	focus?: string | null;
	/** Row whose control the program has open for editing, with its draft (and its caret, a UTF-16 offset) for text rows. */
	editing?: { row: string; draft?: string; cursor?: number; option?: string } | null;
}

/**
 * One tool call (NATIVE_REDESIGN §7.2): data for the head plus generic
 * children for the body. The terminal draws the head, the single frame (or
 * none) and the status motion, and flattens nested `card`/`tool` children
 * into borderless sections.
 */
export interface TspToolProps {
	/** Tool name (`bash`, `edit`, `mcp__github__search`): icon, role styles. */
	name: string;
	/** The verb as users read it ("Bash", "Edit", "Read"; eval uses the model's title). */
	title: TspText;
	/** The primary argument, shown once: command, path, pattern, query. Mono. */
	target?: TspText;
	/** How to draw `target`: a shell command (highlighted), a path (dim dir, strong name), a pattern/query (quoted accent-ink). */
	targetKind?: "command" | "path" | "pattern" | "query" | "text";
	/** Language for `command` highlighting (`bash`, `python`, `js`). */
	lang?: string;
	/** `file://` link for path targets (⌘-click opens). */
	href?: string;
	/** Short facts after the target: `+8 −1`, `5 matches · 2 files`, `22 lines`. */
	meta?: readonly TspText[];
	/** Badges in the head (`you`, `background`, `new file`, `python`). */
	badges?: readonly { text: string; tone?: TspTone; title?: string }[];
	status: TspCardStatus;
	/** Running: ms already elapsed when sent. Done: total duration. */
	age?: number;
	took?: number;
	/** Non-zero exit renders as an error chip `exit 1`. */
	exit?: number | null;
	/** A one-word state note: "timed out", "cancelled", "partial". */
	note?: TspText;
	/** The model's intent line (`i` arg): shown in the working row while running, as the head's tooltip after. */
	intent?: string;
	/** `card`: one frame. `inline`: no ring, a head line plus a disclosed body. */
	frame?: "card" | "inline";
	collapsible?: boolean;
	collapsed?: boolean;
	/** Body clamp while collapsed: `{lines}` shows the head of the body, `{tail}` the end (bash output). */
	preview?: { lines: number } | { tail: number } | "none";
	/** Actions offered in the head on hover (`copy`, `rerun`, `open`). */
	tools?: readonly TspPickerAction[];
}

/** One checklist item (§7.5). */
export interface TspChecklistItem {
	id: string;
	text: TspText;
	status: "pending" | "active" | "done" | "dropped" | "blocked";
	/** Blocker or note, shown under the item in `--t3` (blocked: `--warn`). */
	note?: TspText;
}
/** A checklist phase (§7.5). */
export interface TspChecklistPhase {
	id: string;
	title: TspText;
	items: readonly TspChecklistItem[];
	/** Completed phases fold to one line unless expanded. */
	collapsed?: boolean;
}
/** A todo list: the todo tool body, the dock HUD, or the reminder notice (§7.5). */
export interface TspChecklistProps {
	phases: readonly TspChecklistPhase[];
	/** `full` (the todo tool body), `hud` (dock pill + popover), `reminder` (inline notice listing open items). */
	mode?: "full" | "hud" | "reminder";
	/** Reminder count text ("reminder 1/3"). */
	note?: TspText;
}

/** One subagent as live data (§7.6). Children are the expanded content. */
export interface TspAgentProps {
	/** Display id ("SeqAudit"). */
	name: string;
	/** Agent type ("task", "explore") as a badge. */
	agent?: string;
	/** One-line task description (the assignment summary, never the raw "Complete assignment thoroughly:" prefix). */
	task?: TspText;
	status: "pending" | "running" | "done" | "failed" | "aborted" | "idle" | "parked";
	model?: string;
	/** Thinking level token (`thinkingLow`) for the model chip's dot. */
	thinking?: string;
	/** The tool running now, with its intent and age. */
	tool?: { name: string; intent?: TspText; age?: number } | null;
	stats?: {
		tools?: number;
		requests?: number;
		tokens?: number;
		context?: number;
		contextLabel?: string;
		/** The agent's own completion estimate, 0–1; drawn while running. */
		done?: number;
		cost?: number;
		age?: number;
		took?: number;
	};
	retry?: { attempt: number; max: number; age: number; delay: number; error?: string } | null;
	/** `background`, `read-only`, `isolated`. */
	badges?: readonly { text: string; tone?: TspTone }[];
	/** Nesting depth in a tree of agents. */
	depth?: number;
	collapsible?: boolean;
	collapsed?: boolean;
}

/**
 * A thinking-effort glyph: a small ring that fills rung by rung with the level and
 * turns into a flickering fireball at `max`. Leaf; the terminal draws everything.
 */
export interface TspEffortProps {
	/** `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; anything else (e.g. `auto`) draws an empty dashed ring. */
	level: string;
}

/**
 * A tick on a meter's track (compaction threshold, speculation point). A bar mark's `icon`
 * (a symbol name, e.g. `context.compaction`) sits on the track, which breaks for it.
 */
export interface TspMeterMark {
	/** Position, 0–1. */
	at: number;
	tone?: TspTone;
	title?: string;
	icon?: string;
}

/** A value drawn as a bar, ring or block grid (§8.2): context %, usage windows, agent context. */
export interface TspMeterProps {
	/** 0–1, or null for unknown. */
	value: number | null;
	style?: "bar" | "ring" | "blocks";
	/** `blocks` only: exactly this many cells in one row, `round(value × steps)` of them filled (e.g. the effort chip's fallback meter). */
	steps?: number;
	/** Stacked parts instead of one fill (context breakdown); values sum to ≤ 1. */
	parts?: readonly { value: number; token?: string; label?: string; hatch?: boolean }[];
	marks?: readonly TspMeterMark[];
	/** Tone switches: at or above `warn` → warning, `bad` → error. */
	thresholds?: { warn?: number; bad?: number };
	/** The value as text (`74%`). */
	label?: TspText;
	/** The whole the track spans as text (a context window's `200K`). */
	total?: TspText;
	size?: "sm" | "md" | "lg";
}
/** Series data drawn natively: the usage heatmap, app dashboards (§9.2). */
export interface TspChartProps {
	kind: "heatmap" | "bars" | "spark";
	/** heatmap: rows × columns of 0–1 intensities (null = no data). */
	cells?: readonly (readonly (number | null)[])[];
	/** Column labels placed at column indexes (months). */
	cols?: readonly { at: number; label: string }[];
	/** Row labels (weekdays); empty strings skip a label. */
	rows?: readonly string[];
	/** Per-cell tooltips, same shape as `cells` (omit for none). */
	tips?: readonly (readonly (string | null)[])[];
	/** bars/spark: one series. */
	series?: readonly { label?: string; value: number; title?: string }[];
	/** Colour token of the fill (`accent`, `statusLineCost`). */
	token?: string;
	summary?: TspText;
	/** Pixel-free size hint: cell size step for heatmaps, height in lines for bars/spark. */
	size?: "sm" | "md" | "lg";
}

/** Kind-specific props, indexed by kind. */
export interface TspPropsByKind {
	col: TspColProps;
	row: TspRowProps;
	card: TspCardProps;
	section: TspSectionProps;
	rule: TspRuleProps;
	spacer: TspSpacerProps;
	text: TspTextProps;
	md: TspMarkdownProps;
	code: TspCodeProps;
	diff: TspDiffProps;
	ansi: TspAnsiProps;
	math: TspMathProps;
	image: TspImageProps;
	kv: TspKvProps;
	table: TspTableProps;
	tree: TspTreeProps;
	badge: TspBadgeProps;
	kbd: TspKbdProps;
	icon: TspIconProps;
	spinner: TspSpinnerProps;
	shimmer: TspShimmerProps;
	elapsed: TspElapsedProps;
	progress: TspProgressProps;
	rate: TspRateProps;
	list: TspListProps;
	item: TspItemProps;
	tabs: TspTabsProps;
	editor: TspEditorProps;
	input: TspInputProps;
	status: TspStatusProps;
	seg: TspSegProps;
	overlay: TspOverlayProps;
	toast: TspToastProps;
	rows: TspRowsProps;
	picker: TspPickerProps;
	prefs: TspPrefsProps;
	tool: TspToolProps;
	checklist: TspChecklistProps;
	agent: TspAgentProps;
	chart: TspChartProps;
	meter: TspMeterProps;
	effort: TspEffortProps;
}

/** Props of a node of kind `K`: its kind-specific props plus the common ones. */
export type TspProps<K extends TspKind = TspKind> = TspPropsByKind[K] & TspCommonProps;

/** Kinds whose primary text the `text` and `splice` ops address (the `text` prop). */
export const TSP_TEXT_KINDS = ["text", "md", "code", "ansi", "math", "editor", "input", "shimmer"] as const;

/** A node on the wire. */
export type TspNode = {
	[K in TspKind]: { id: string; k: K; p?: TspProps<K>; c?: readonly TspNode[] };
}[TspKind];

/** Fixed ids of a surface's three regions. */
export const TSP_REGION_IDS = { main: "main", dock: "dock", layer: "layer" } as const;

// ═══════════════════════════════════════════════════════════════════════════
// Ops and messages
// ═══════════════════════════════════════════════════════════════════════════

export type TspOp =
	| readonly [op: "add", id: string, parent: string, before: string | null, node: TspNode]
	| readonly [op: "set", id: string, props: Readonly<Record<string, unknown>>]
	| readonly [op: "text", id: string, mode: "append" | "replace", text: string]
	| readonly [op: "splice", id: string, at: number, del: number, text: string]
	| readonly [op: "move", id: string, parent: string, before: string | null]
	| readonly [op: "del", id: string]
	| readonly [op: "settle", id: string]
	| readonly [op: "focus", id: string | null]
	| readonly [op: "reveal", id: string, where: "start" | "end" | "nearest"]
	| readonly [op: "scroll", id: string, by: TspScrollBy]
	| readonly [op: "suspend"]
	| readonly [op: "resume"];

/**
 * How far a `scroll` op moves the scroller holding a node: a line, a
 * viewport less a line, or to an end (`end` makes a following `ansi` block
 * follow again). Sent only when `hello.features` lists `scroll`.
 */
export type TspScrollBy = "line-up" | "line-down" | "page-up" | "page-down" | "start" | "end";

/** Verb `f`: an atomic batch of ops for one surface. */
export interface TspFrame {
	/** Surface id. */
	sf: string;
	/** Monotonic per-surface sequence number. */
	s: number;
	ops: readonly TspOp[];
}

/** Verb `o`: open (or adopt) a surface. */
export interface TspOpen {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	adopt?: boolean;
}

/** Verb `x`: close a surface. */
export interface TspClose {
	id: string;
	/** Keep `main` in scrollback (true) or remove the surface (false). */
	keep: boolean;
}

/**
 * Verb `t`: the program's resolved theme for a surface, sent after `o` and
 * before its first `f`, and again whenever the theme or variant changes.
 * Each variant maps token names to `#rrggbb`; tokens left at the terminal
 * default are omitted. A program with one variant sends only that one.
 */
export interface TspPalette {
	/** Surface id. */
	sf: string;
	dark?: Readonly<Record<string, string>>;
	light?: Readonly<Record<string, string>>;
	/** Theme names behind each variant. */
	name?: { dark?: string; light?: string };
}

/** Verb `q`. */
export type TspQuery =
	| { q: "hello"; v: readonly number[]; app: string; ver?: string; features?: readonly string[] }
	| { q: "blobs"; ids: readonly string[] };

/** Verb `r`. */
export type TspReply =
	| {
			r: "hello";
			v: number;
			term: string;
			ver?: string;
			kinds: readonly string[];
			features?: readonly string[];
			apc?: number;
			credits?: number;
			cols?: number;
			cell?: { w: number; h: number };
			dark?: boolean;
			reduceMotion?: boolean;
	  }
	| { r: "blobs"; have: readonly string[] };

/** Verb `e`: terminal → program events. */
export type TspEvent =
	| { ev: "ack"; sf: string; s: number }
	| { ev: "resize"; sf?: string; cols: number; cell?: { w: number; h: number }; visible?: boolean }
	| { ev: "theme"; dark: boolean }
	| { ev: "motion"; reduce: boolean }
	| { ev: "visible"; sf?: string; visible: boolean }
	| { ev: "toggle"; sf: string; id: string; key?: string; collapsed: boolean }
	| { ev: "select"; sf: string; id: string; item: string }
	| { ev: "activate"; sf: string; id: string; item: string }
	| { ev: "action"; sf: string; id: string; act: string; value?: string; mods?: readonly string[] }
	/** A typed value changed by pointer (prefs rows, picker toggles); `null` resets to the default. */
	| {
			ev: "change";
			sf: string;
			id: string;
			item: string;
			value: boolean | number | string | readonly string[] | null;
	  }
	/**
	 * An edit over the terminal's selection in an `editor`/`input` node: replace
	 * `[from, to)` with `text`, caret to `cursor` (UTF-16 offsets; `len` is the
	 * text length the terminal saw, a mismatch makes the edit stale).
	 */
	| { ev: "edit"; sf: string; id: string; from: number; to: number; text: string; cursor: number; len: number }
	/**
	 * Undo the last change to the text of `editor`/`input` node `id` through the
	 * program's own undo history (an applied `edit` is one unit, as typing is); a
	 * no-op when there is nothing to undo. Sent only when `hello` lists `"undo"`.
	 */
	| { ev: "undo"; sf: string; id: string }
	/**
	 * Submit `text` as one prompt through the addressed composer's ordinary
	 * submission path, without paste or keyboard simulation. Sent only when
	 * the program's `hello.features` includes `"send"` and `sf`/`id` identify
	 * a live editable composer whose `sendable` is exactly true. Writable text
	 * or keyboard focus alone does not imply submission readiness. Blank text is
	 * a no-op; an existing draft is retained for local recall, not appended to
	 * the supplied prompt.
	 */
	| { ev: "send"; sf: string; id: string; text: string }
	/**
	 * The user clicked into node `id` (an `editor`/`input` without the focus, or
	 * a `prefs` sheet while the focus is outside it): the program moves its
	 * keyboard focus there, or ignores it (a modal overlay keeps the keys).
	 */
	| { ev: "focus"; sf: string; id: string }
	| { ev: "error"; sf?: string; s?: number; op?: number; msg: string }
	| { ev: "gone"; sf?: string; ids: readonly string[] };
