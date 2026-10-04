import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionState, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { NativeNode, NativeUiEvent } from "../native/node";
import type { ContextLineMode, StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "./schema";
import type { ActiveRepoContext, StatusLineSession } from "./host";
import type { LoopConditionConfig, LoopLimitRuntime } from "./loop";

export type { ContextLineMode, StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle };

/** Context-window occupancy shown by the status line and exposed to extensions. */
export interface ContextUsage {
	/** Estimated context tokens. */
	tokens: number;
	contextWindow: number;
	/** Context usage as percentage of context window. */
	percent: number;
}

/** Debounced footer snapshot a collab host broadcasts to guests. */
export type CollabSessionState = SessionState & {
	/**
	 * Host model (full catalog object). Guests apply it to their replica
	 * agent state so model display and context-window math are native.
	 */
	model?: Model;
	/** Host status-line context numbers (guest system prompt/tools differ, so local estimates drift). */
	contextUsage?: ContextUsage;
};

/** Collab session indicator + (guest-only) host-state override for segments. */
export interface CollabStatus {
	role: "host" | "guest";
	participantCount: number;
	/** Guest only: host footer snapshot that overrides locally computed values. */
	stateOverride?: CollabSessionState | null;
}

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
	/** Quota-window parts of the `usage` segment; each part shows unless set to `false`. `compact` drops the spaces and parentheses. */
	usage?: { showLabel?: boolean; showPercent?: boolean; showReset?: boolean; compact?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
	sessionAccent?: boolean;
	/** Drop the theme's `statusLineBg` fill and powerline caps so the bar
	 *  inherits the terminal's default background. */
	transparent?: boolean;
	/** Replace the model-segment icon with the thinking-level glyph and drop the
	 *  " · <level>" suffix, so the thinking level reads as a single compact icon. */
	compactThinkingLevel?: boolean;
	/** How the gap line between the left and right groups reacts to context
	 *  usage. `embedded` moves configured context segments into the annotated
	 *  gauge as percentage and window labels. Box composer only. */
	contextLine?: ContextLineMode;
}

export type EffectiveStatusLineSettings = Required<
	Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
> &
	StatusLineSettings;

// ═══════════════════════════════════════════════════════════════════════════
// Segment Rendering
// ═══════════════════════════════════════════════════════════════════════════

export type RGB = readonly [number, number, number];

export interface SegmentContext {
	session: StatusLineSession;
	/** Deterministic wall clock for previews/tests; production omits it. */
	now?: Date;
	/** Deterministic host label for previews/tests; production omits it. */
	hostname?: string;
	/** Focused subagent id while the view is proxied at its session, undefined otherwise. */
	focusedAgentId?: string | undefined;
	/** Effective `statusLine.sessionAccent`; `false` disables hash-derived accent colors, while `true` or omission enables them. */
	sessionAccent?: boolean;
	/** Stand-in session title for previews; `session_name` renders it when the session is unnamed. */
	previewTitle?: string;
	activeRepo: ActiveRepoContext | null;
	width: number;
	options: StatusLineSegmentOptions;
	/** Render the model segment's thinking level as a compact leading glyph. */
	compactThinkingLevel: boolean;
	/** Key-sorted extension/hook status values. Segment renderers sanitize before display. */
	hookStatuses?: readonly string[];
	planMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	prewalk: {
		enabled: boolean;
	} | null;
	loopMode: {
		state: "waiting" | "running" | "paused";
		limit?: LoopLimitRuntime;
		condition?: LoopConditionConfig;
	} | null;
	goalStatusInFooter?: boolean;
	goalMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	vibeMode: {
		enabled: boolean;
	} | null;
	/** Modal editing state, or null when `tui.vimMode` is off. */
	vim: {
		mode: "insert" | "normal" | "visual" | "visual-line";
		/** Half-typed operator/count (`"2d"`), empty when nothing is pending. */
		pending: string;
		/** Lines spanned by the active Visual selection; 0 outside Visual modes. */
		selectedLines: number;
		/** `tui.vimModeDisplay`: how the mode renders in the status line. */
		display: "text" | "icon" | "none";
	} | null;
	collab: CollabStatus | null;
	stream: { viewers: number } | null;
	/** A `/record` capture of this screen is running. */
	recording: boolean;
	// Cached values for performance (computed once per render)
	usageStats: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		orchestrationInput: number;
		orchestrationOutput: number;
		orchestrationCacheRead: number;
		premiumRequests: number;
		cost: number;
		/** Portion of `cost` carried by completed subagent task results. */
		subagentCost?: number;
		tokensPerSecond: number | null;
	};
	/** Context usage percent, or null when unknown (e.g. right after compaction). */
	contextPercent: number | null;
	contextTokens: number;
	contextWindow: number;
	autoCompactEnabled: boolean;
	/** Background speculative-compaction state (async compaction). */
	compactionSpeculation: "idle" | "running" | "armed";
	/** Blink phase for the running-speculation pulse; toggled by the component's timer. */
	speculationBlinkOn: boolean;
	subagentCount: number;
	/**
	 * Spend of every subagent under the main session (descendants included),
	 * from the Agent Hub projection; 0 while a subagent is focused or unknown.
	 */
	subagentTreeCost?: number;
	/**
	 * Active processing time accumulated this session, in ms — the union of
	 * every `agent_start`→`agent_end` window plus the currently-streaming
	 * window if the agent is running. Idle wall-clock never contributes, so
	 * this is what {@link StatusLineSegmentId.time_spent} renders instead of
	 * `Date.now() - sessionStart`.
	 */
	activeMs: number;
	/**
	 * Elapsed ms of the currently-running turn (the open `agent_start` window),
	 * or null when the agent is idle. Drives the `pi` segment's working
	 * spinner + turn timer.
	 */
	turnElapsedMs: number | null;
	/**
	 * Sampled foreground ANSI for the `pi` brand segment — tweened between dim
	 * gray (idle) and the accent (working) across turn edges (rust omp's
	 * status-band brand fade). Absent in direct-segment fixtures and previews,
	 * which fall back to the static dim color.
	 */
	brandFgAnsi?: string;
	git: {
		branch: string | null;
		status: { staged: number; unstaged: number; untracked: number } | null;
		pr: { number: number; url: string } | null;
	};
	/**
	 * Set when the path cwd is a *linked* git worktree, naming the shared
	 * primary checkout (the project). Lets the path segment collapse the
	 * base-prefixed `<base>/<project>/<worktree>` path to the project name —
	 * the worktree/branch is already shown by the git segment.
	 */
	worktree: { projectName: string; worktreeName: string } | null;
	usage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		daily?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
		monthly?: { percent: number; resetHours?: number };
		resetCredits?: {
			bankedCount: number;
			redeemableCount: number;
			expiryHours?: number;
			expired?: boolean;
			unavailableReason?: string;
		};
	} | null;
}

export interface RenderedSegment {
	content: string; // The segment text (may include ANSI color codes)
	visible: boolean; // Whether to render (e.g., git hidden when not in repo)
}

/**
 * A segment described for a TSP terminal: styled spans (theme/semantic
 * tokens, no ANSI), a named icon, a tone, and terminal-clocked nodes
 * (`spinner`, `elapsed`, `rate`) laid out after the spans.
 */
export interface SegmentView {
	readonly spans: readonly TspSpan[];
	readonly icon?: string;
	readonly tone?: TspTone;
	readonly motion?: readonly NativeNode[];
	/** Tooltip on the segment. */
	readonly title?: string;
}

/**
 * The status line's facts for the native composer. A TSP terminal shows no
 * status strip: the tab title carries the session, the pane header the path
 * and branch, and the composer the rest.
 */
export interface ComposerFacts {
	/**
	 * `meter` (role `omp.composer.context`): context usage along the composer's top edge,
	 * the whole window wide, with the speculation and compaction points as icon marks,
	 * the share as `label` and the window as `total`.
	 */
	readonly context: NativeNode;
	/** The model chip's label: name plus the advisor, fast-mode and slow-mode marks. */
	readonly model: SegmentView;
	/**
	 * `status` (role `omp.composer.extras`, `grow: 1`) of the other configured
	 * segments as `seg`s; the bar's flexible space, so present even when empty.
	 */
	readonly extras: NativeNode;
	/** `text` (role `omp.composer.usage`): the session cost (empty when there is none). */
	readonly usage: NativeNode;
}

/** Supplies {@link ComposerFacts} and takes the clicks on them (`status.*` actions). */
export interface ComposerFactsSource {
	describeComposerFacts(): ComposerFacts;
	handleNativeEvent(event: NativeUiEvent): void;
}

export interface StatusLineSegment {
	id: StatusLineSegmentId;
	render(ctx: SegmentContext): RenderedSegment;
	/** Native description; null when the segment is hidden. */
	describe(ctx: SegmentContext): SegmentView | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Separator Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface SeparatorDef {
	left: string; // Character for left→right segments
	right: string; // Character for right→left segments (reversed)
	endCaps?: {
		left: string; // Cap for right segments (points left)
		right: string; // Cap for left segments (points right)
		useBgAsFg: boolean;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Preset Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface PresetDef {
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	separator: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
}
