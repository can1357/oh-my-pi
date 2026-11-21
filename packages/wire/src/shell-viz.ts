import type { ShellTraceState } from "./shell-trace";

/** Supported shell presentation modes. */
export type ShellVizView = "raw" | "pseudo";
/** Independently toggleable, non-executing presentation transformations. */
export type ShellVizLayer = "color" | "inline" | "idioms" | "effects" | "unwrap";
/** Every layer is explicit so persisted preferences have deterministic meaning. */
export interface ShellVizLayers {
	color: boolean;
	inline: boolean;
	idioms: boolean;
	effects: boolean;
	unwrap: boolean;
}
/** Per-tool-call preferences. Node identifiers are opaque native `unit:source:node` keys. */
export interface ShellVizPreferences {
	view: ShellVizView;
	layers: ShellVizLayers;
	split: boolean;
	/** Number of retained history records applied; absent means live. */
	cursor?: number;
	playing: boolean;
	speed: number;
	selectedNode?: string;
	expandedNodes: string[];
}
/** Semantic text. All ranges are UTF-16 [lo, hi) in the original outermost source. */
export interface ShellVizSegment {
	text: string;
	/** True only on an executing leaf span; dim other spans while presentation.running. */
	active?: boolean;
	/** Actual governing leaf outcome, including failures inside otherwise successful pipelines/chains. */
	state?: ShellTraceState;
	/** Actual last leaf CmdEnd clock/sequence; identity is executionNode (or node) + executionSeq. */
	executedAtNs?: number;
	executionSeq?: number;
	/** Space-separated semantic tokens; structural chip/badge tokens survive Color off. */
	style?: string;
	/** Source-token identity used only for selection and source links. */
	node?: string;
	/** Actual command owning state/completion when this token has a different source identity. */
	executionNode?: string;
	range?: [number, number];
	tip?: string;
	/** Complete original text revealed by inspection or expansion. */
	expanded?: string;
	/** Embedded language, with semantic tokenization already performed. */
	language?: string;
}
/** Heuristic effect annotation, never a guarantee of safety or completeness. */
export interface ShellVizEffect {
	kind: "network" | "write" | "destructive" | "secret" | "privilege" | "background";
	glyph: string;
	label: string;
	why: string;
}
/** One physical Raw/Pseudo presentation row; structural line breaks are separate rows, not terminal LF text. */
export interface ShellVizRow {
	id: string;
	depth: number;
	node?: string;
	range?: [number, number];
	/**
	 * This row contains an active executable leaf, or text that leaf runs (its inline script, heredoc, or untraced
	 * script), not merely an enclosing scope. Only rows with an active segment hold the executing span itself.
	 */
	active?: boolean;
	role?: "stmt" | "head" | "mid" | "tail" | "raw" | "document";
	state?: ShellTraceState;
	segments: ShellVizSegment[];
	effects: ShellVizEffect[];
	/** Actual last leaf completion, never copied onto enclosing scope/scaffold rows. */
	executedAtNs?: number;
	executionSeq?: number;
	/** Human-readable runtime metadata, not a machine-readable protocol. */
	meta?: string;
	detail?: string;
	/** Latest real variable values whose last setter is represented by this row; never a detached watch strip. */
	annotations?: ShellVizWatch[];
}
/** Latest observed setter of one scoped variable, never a statically guessed runtime value. */
export interface ShellVizWatch {
	name: string;
	value: string;
	fullLength?: number;
	scope?: string;
	/** Proven scope/process identity; unknown binding identity is not replaced with a guessed function frame. */
	scopeId?: string;
	/** Owning executable/header AST node, promoted from assignment/word event ids. Absent means unlocated. */
	node?: string;
	/** Actual setter span in original outer-script UTF-16 coordinates; absent for unlocated dynamic source. */
	range?: [number, number];
	/** Retained journal seq of the actual last setter, so replay moves or removes the annotation. */
	setterSeq?: number;
}
/** Browser-independent presentation shared by ANSI and native GUI renderers. */
export interface ShellVizPresentation {
	preferences: ShellVizPreferences;
	rows: ShellVizRow[];
	/** Raw counterpart for Pseudo split; empty when that pane is not requested. */
	original: ShellVizRow[];
	/** Actual captured stdout/stderr through the replay cursor, in event order. */
	output: string;
	/** At least one actual executable leaf is running; dim all inactive content. */
	running?: boolean;
	/** Native run has not ended, even when currently between executable leaves. */
	executing: boolean;
	/** Canonical latest observed values; consumers render row.annotations, not a detached strip. */
	watches: ShellVizWatch[];
	timeline: { length: number; cursor: number; elapsedNs: number; durationNs: number; trimmed?: boolean };
	message?: string;
}
