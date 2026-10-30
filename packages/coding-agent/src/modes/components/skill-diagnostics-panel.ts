/**
 * `/skills diagnostics`: a fullscreen list and inspector over the session's shared
 * {@link SkillDiagnosticController}. Each row is a skill name; the inspector shows the selected row's
 * issues, copies, provenance and its current and previous model result together.
 *
 * The panel only reads controller state and cancels work that is already running. Anything that sends
 * files to a model or writes a decision needs its own consent dialog, so those keys close the panel with
 * a typed result for the host (`slash-commands/skill-diagnostics-panel.ts`) to confirm and perform before
 * reopening it. Opening and navigating never call a model.
 */
import {
	type Component,
	Ellipsis,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKey, editorKeys } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "@oh-my-pi/pi-tui/keybinding-matchers";
import { col, compact, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import {
	type DescribeContext,
	leafKey,
	type NativeNode,
	type NativeScroll,
	type NativeUiEvent,
} from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, hintsRow, type NativeHint } from "@oh-my-pi/pi-tui/native/overlay";
import { sanitizeDisplaySingleLine as line } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	type SidebarEntry,
	type SidebarStyle,
} from "@oh-my-pi/pi-tui/overlays/hub-frame";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type {
	SkillAnalysisStatus,
	SkillDiagnosticAnalysisRecord,
	SkillDiagnosticController,
	SkillDiagnosticIssue,
	SkillDiagnosticItem,
} from "../../extensibility/skill-diagnostic-controller";
import type { SkillDiagnosticEntry } from "../../extensibility/skill-diagnostics";
import { SELECTION_REASONS } from "../utils/skill-diagnostics";

/** How the panel closed; analyze and apply are performed by the host after its consent dialogs. */
export type SkillDiagnosticsPanelResult =
	| { readonly action: "close"; readonly selected: string | undefined }
	| {
			readonly action: "analyze";
			readonly selected: string;
			/** A plan some other client prepared; it is consented to and started as is. */
			readonly prepared: SkillDiagnosticAnalysisRecord | undefined;
	  }
	| { readonly action: "apply"; readonly selected: string; readonly record: SkillDiagnosticAnalysisRecord };

/** A one-off message shown above the inspector until the next key. */
export interface SkillDiagnosticsPanelNotice {
	readonly tone: "info" | "success" | "error";
	readonly text: string;
}

export interface SkillDiagnosticsPanelOptions {
	/** Skill name to select first; falls back to the first row when it is gone. */
	readonly initialName?: string;
	readonly notice?: SkillDiagnosticsPanelNotice;
	readonly done: (result: SkillDiagnosticsPanelResult) => void;
}

type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

/** One inspector paragraph, wrapped to the pane; the same model feeds the text and native surfaces. */
interface Para {
	readonly text: string;
	readonly tone: Tone;
	readonly strong?: boolean;
	/** Columns of indent, kept on wrapped rows. */
	readonly indent?: number;
}

type AddPara = (value: string, tone?: Tone, extra?: { strong?: boolean; indent?: number }) => void;

const SIDEBAR_BOUNDS = { min: 24, max: 46 } as const;
const BODY_MIN_WIDTH = 36;
const MAX_NOTICE_LINES = 5;
const MAX_OMISSIONS_SHOWN = 4;

const ISSUE_WORD: Record<SkillDiagnosticIssue, string> = {
	conflict: "conflict",
	redundancy: "redundant",
	"missing-provenance": "no origin",
};
const ISSUE_TEXT: Record<SkillDiagnosticIssue, string> = {
	conflict: "Conflict: several active variants share this name; only one is the default.",
	redundancy: "Redundant: identical or same-origin copies exist and are not loaded.",
	"missing-provenance": "Provenance is missing: a copy does not declare where it came from.",
};
/** Per-status word, row/heading tone and `theme.status` glyph key; the glyph is read at render so theme changes apply. */
const RESULT: Record<SkillAnalysisStatus, { word: string; tone: Tone; icon: keyof typeof theme.status }> = {
	prepared: { word: "prepared", tone: "warning", icon: "pending" },
	running: { word: "analyzing", tone: "accent", icon: "running" },
	complete: { word: "analyzed", tone: "success", icon: "success" },
	failed: { word: "failed", tone: "error", icon: "error" },
	cancelled: { word: "cancelled", tone: "dim", icon: "aborted" },
	applied: { word: "applied", tone: "success", icon: "success" },
	stale: { word: "stale", tone: "warning", icon: "warning" },
};
const NOTICE_TONE: Record<SkillDiagnosticsPanelNotice["tone"], Tone> = {
	info: "accent",
	success: "success",
	error: "error",
};

const EMPTY_PARAS: readonly Para[] = [{ text: "No skills are loaded in this session.", tone: "dim" }];

/** A plain letter key in either case, as the legacy and kitty keyboard protocols deliver it. */
const isLetter = (data: string, letter: "a" | "c"): boolean =>
	matchesKey(data, letter) || matchesKey(data, `shift+${letter}`) || data === letter.toUpperCase();

/** The lead issue's word, plus how many more the row has: `conflict +2`. */
function issueWord(item: SkillDiagnosticItem): string | undefined {
	const [lead] = item.issues;
	if (lead === undefined) return undefined;
	return item.issues.length === 1 ? ISSUE_WORD[lead] : `${ISSUE_WORD[lead]} +${item.issues.length - 1}`;
}

/** Icon, tone and the short annotation of a row: issues or clean, plus the latest result state. */
function rowState(item: SkillDiagnosticItem): { tone: Tone; icon: string; word: string } {
	const record = item.analysis ?? item.lastAnalysis;
	const word = issueWord(item) ?? "clean";
	if (record) {
		return {
			tone: RESULT[record.status].tone,
			icon: theme.status[RESULT[record.status].icon],
			word: `${word === "clean" ? "" : `${word} · `}${RESULT[record.status].word}`,
		};
	}
	// Only comparable groups call for action; a lone copy's missing origin stays quiet.
	return item.canAnalyze
		? { tone: "warning", icon: theme.status.warning, word }
		: { tone: "dim", icon: theme.status.enabled, word };
}

const NOTHING_TO_APPLY = "Nothing to apply: analyze first (Enter). Nothing is applied automatically.";

/** Why `record` must not be applied, or undefined when it may be offered for confirmation. */
function applyBlocker(record: SkillDiagnosticAnalysisRecord): string | undefined {
	switch (record.status) {
		case "applied":
			// A reload that failed after the choice was saved is retried by applying again.
			return record.error
				? undefined
				: "Nothing to apply: this recommendation is already applied. Restore with: omp config reset diagnostics.resourceExclusions";
		case "running":
			return "Nothing to apply yet: an analysis is running. Wait for it to finish, or press C to cancel it.";
		case "prepared":
			return "Nothing to apply: this analysis has not run yet. Enter asks for consent first.";
		case "failed":
			return "Nothing to apply: the analysis failed. Analyze again (Enter).";
		case "cancelled":
			return "Nothing to apply: the analysis was cancelled. Analyze again (Enter).";
		case "stale":
			return "Nothing to apply: the files or session changed, so this result can no longer be applied. Analyze again (Enter).";
		case "complete":
			break;
	}
	const recommendation = record.result?.recommendation;
	if (!recommendation) return NOTHING_TO_APPLY;
	if (recommendation.action !== "prefer" || recommendation.preferredId === undefined) {
		return "The analysis recommends keeping every copy; there is nothing to apply.";
	}
	if (record.candidates.some(candidate => !candidate.complete)) {
		return "Coverage was incomplete, so this result is advisory and cannot be used to hide a copy.";
	}
	if (!record.candidates.some(candidate => candidate.id === recommendation.preferredId)) {
		return "The recommendation names a copy that was not reviewed, so it cannot be applied.";
	}
	return undefined;
}

/**
 * The current result an Apply would act on, or why there is none. Applying hides copies in OMP, so only a
 * finished, fully covered analysis that names one of its own copies qualifies, or an applied one whose session
 * reload failed (applying again retries it). Superseded results stay viewable but the controller only applies
 * its current plan, so they are never offered. The controller re-checks the contents and session when the host
 * applies it.
 */
function applicability(
	item: SkillDiagnosticItem,
): { readonly record: SkillDiagnosticAnalysisRecord } | { readonly reason: string } {
	const record = item.analysis;
	if (!record) return { reason: NOTHING_TO_APPLY };
	const reason = applyBlocker(record);
	return reason === undefined ? { record } : { reason };
}

function describeEntry(entry: SkillDiagnosticEntry, add: AddPara): void {
	add(`File: ${shortenPath(entry.filePath)}`, "text", { indent: 2 });
	add(`Source: ${entry.source}${entry.pluginName ? `; package ${entry.pluginName}` : ""}`, "muted", { indent: 2 });
	add(
		entry.repository
			? `Origin: ${entry.repository}${entry.version ? ` ${entry.version}` : ""}`
			: "Origin: not declared",
		"muted",
		{ indent: 2 },
	);
}

function describeRecord(record: SkillDiagnosticAnalysisRecord, label: string, add: AddPara, current: boolean): void {
	const candidate = (id: string): string => {
		const found = record.candidates.find(entry => entry.id === id);
		return found ? `${id} (${shortenPath(found.root)})` : id;
	};
	add(`${label}: ${RESULT[record.status].word}`, RESULT[record.status].tone, { strong: true });
	add(
		`${record.model} · ${(record.bytes / 1024).toFixed(1)} KiB · ${new Date(record.createdAt).toLocaleString()}`,
		"dim",
		{ indent: 2 },
	);
	for (const entry of record.candidates) {
		add(
			`${entry.id}  ${shortenPath(entry.root)} · ${entry.files} file${entry.files === 1 ? "" : "s"} · ${entry.complete ? "complete" : "PARTIAL"}`,
			entry.complete ? "muted" : "warning",
			{ indent: 2 },
		);
		for (const omission of entry.omissions.slice(0, MAX_OMISSIONS_SHOWN)) {
			add(`not inspected: ${omission}`, "dim", { indent: 6 });
		}
		if (entry.omissions.length > MAX_OMISSIONS_SHOWN) {
			add(`… ${entry.omissions.length - MAX_OMISSIONS_SHOWN} more not inspected`, "dim", { indent: 6 });
		}
	}
	switch (record.status) {
		case "prepared":
			add("Prepared. Nothing has been sent; Enter asks for consent first.", "warning", { indent: 2 });
			break;
		case "running":
			add(`Sending the listed files to ${record.model}. Press C to cancel.`, "accent", { indent: 2 });
			break;
		case "cancelled":
			add("Cancelled. This result is not kept.", "dim", { indent: 2 });
			break;
		case "stale":
			add(
				"The files or session changed after this analysis was prepared, so it cannot be applied. Analyze again.",
				"warning",
				{ indent: 2 },
			);
			break;
		case "applied":
			add(
				record.error
					? "Your choice is saved, but reloading skills in this session failed, so the other copies may still be active here. Press A to retry. Restore with: omp config reset diagnostics.resourceExclusions"
					: "Applied by you: the other copies are hidden in OMP. Files remain installed for other harnesses. Restore with: omp config reset diagnostics.resourceExclusions",
				record.error ? "warning" : "success",
				{ indent: 2 },
			);
			break;
		case "failed":
		case "complete":
			break;
	}
	if (record.error) add(`Error: ${record.error}`, "error", { indent: 2 });
	const { result } = record;
	if (!result) return;
	add(`Relationship: ${result.relationship}`, "text", { indent: 2 });
	const { recommendation } = result;
	add(
		recommendation.action === "prefer" && recommendation.preferredId !== undefined
			? `Recommendation: prefer ${candidate(recommendation.preferredId)}; the others could be hidden in OMP once you confirm`
			: "Recommendation: keep all copies",
		"accent",
		{ indent: 2 },
	);
	add(`Reason (model-generated): ${recommendation.reason}`, "text", { indent: 2 });
	if (result.evidence.length > 0) add("Evidence", "text", { strong: true, indent: 2 });
	for (const item of result.evidence) {
		add(
			`- ${candidate(item.candidateId)} ${item.file}: "${item.quote}"${item.explanation ? ` — ${item.explanation}` : ""}`,
			"muted",
			{ indent: 4 },
		);
	}
	if (result.differences.length > 0) add("Differences", "text", { strong: true, indent: 2 });
	for (const item of result.differences) add(`- ${item}`, "muted", { indent: 4 });
	if (result.limitations.length > 0) add("Limitations", "text", { strong: true, indent: 2 });
	for (const item of result.limitations) add(`- ${item}`, "muted", { indent: 4 });
	add("Advisory and model-generated; it compares file content only, not authorship, origin or trust.", "dim", {
		indent: 2,
	});
	if (current && record.status === "complete") {
		add(applyBlocker(record) ?? "Apply is a separate action (A) with its own confirmation.", "muted", { indent: 2 });
	}
}

/** Everything the inspector shows for one row, as sanitized paragraphs. */
function inspect(item: SkillDiagnosticItem): Para[] {
	const paras: Para[] = [];
	// Names, paths, provenance and model text are untrusted: strip terminal controls before any styling.
	const add: AddPara = (value, tone = "text", extra = {}) => {
		paras.push({ text: line(value), tone, ...extra });
	};
	const gap = (): void => {
		paras.push({ text: "", tone: "text" });
	};

	add(item.name, "accent", { strong: true });
	if (item.issues.length === 0) add("Clean: no conflicting or redundant copies.", "success");
	for (const issue of item.issues) add(`• ${ISSUE_TEXT[issue]}`, "warning");
	if (item.reason) add(`Selection: ${SELECTION_REASONS[item.reason]}`, "muted");
	gap();
	add("AI analysis", "text", { strong: true });
	if (!item.canAnalyze) {
		add(
			`Unavailable: ${item.unavailableReason ?? "No competing variants to compare."} Enter sends nothing to a model for this skill.`,
			"muted",
		);
	} else if (item.analysis?.status !== "running") {
		add(
			"Enter asks for consent, then analyzes these copies with AI. Browsing this list never contacts a model.",
			"muted",
		);
	}
	const current = item.analysis;
	const previous = item.lastAnalysis && item.lastAnalysis.id !== current?.id ? item.lastAnalysis : undefined;
	if (!current && !previous) add("No analysis yet.", "dim");
	if (current) describeRecord(current, "Current", add, true);
	if (current && previous) gap();
	if (previous) describeRecord(previous, current ? "Previous result" : "Result", add, false);

	gap();
	add(`Copies (${item.skills.length + item.duplicates.length})`, "text", { strong: true });
	const bare = item.skills.find(skill => skill.name === item.name);
	if (!bare && item.skills.length > 0) {
		add("No bare default is included; invoke a namespaced variant explicitly.", "muted");
	}
	for (const skill of item.skills) {
		add(skill === bare ? `Default: ${skill.name}` : `Variant: ${skill.name}`, "text", { strong: true });
		describeEntry(skill, add);
		if (skill !== bare && bare?.repository !== undefined && skill.repository === bare.repository) {
			add("Same origin as the default; skills.dedupeSameOrigin would hide this variant.", "muted", { indent: 2 });
		}
	}
	for (const duplicate of item.duplicates) {
		const origin = duplicate.match === "origin";
		add(`${origin ? "Same-origin variant" : "Redundant copy"}: ${duplicate.skill.name}`, "text", { strong: true });
		describeEntry(duplicate.skill, add);
		add(
			`${origin ? "Hidden in favor of" : "Identical to"}: ${duplicate.retained.name} (${shortenPath(duplicate.retained.filePath)})`,
			"muted",
			{ indent: 2 },
		);
	}
	if (item.skills.length + item.duplicates.length > 1) {
		add(
			"Invoke a variant with /skill:<name> or skill://<name>. Same names do not imply the same skill lineage; Origin is the source repository a plugin declares.",
			"dim",
		);
	}
	return paras;
}

function paint(para: Para): string {
	const body = para.strong ? theme.bold(para.text) : para.text;
	return para.tone === "text" ? body : theme.fg(para.tone, body);
}

/** Wrap paragraphs to `width`; wrapped rows keep their paragraph's indent behind a one-column gutter. */
function renderParas(paras: readonly Para[], width: number): string[] {
	const rows: string[] = [];
	for (const para of paras) {
		if (para.text === "") {
			rows.push("");
			continue;
		}
		const indent = (para.indent ?? 0) + 1;
		const pad = " ".repeat(indent);
		for (const wrapped of wrapTextWithAnsi(paint(para), Math.max(1, width - indent))) rows.push(pad + wrapped);
	}
	return rows;
}

function describePara(para: Para): NativeNode {
	if (para.text === "") return text(" ");
	const style = compact([para.tone === "text" ? undefined : para.tone, para.strong ? "strong" : undefined]).join(" ");
	return text([span(" ".repeat(para.indent ?? 0) + para.text, style === "" ? undefined : style)], { wrap: "word" });
}

export class SkillDiagnosticsPanel implements Component {
	readonly #tui: TUI;
	readonly #controller: SkillDiagnosticController;
	readonly #done: (result: SkillDiagnosticsPanelResult) => void;
	readonly #unsubscribe: () => void;
	readonly #detail = new ScrollView([], {
		height: 0,
		scrollbar: "auto",
		ellipsis: Ellipsis.Omit,
		theme: { track: value => theme.fg("dim", value), thumb: value => theme.fg("accent", value) },
	});
	#items: readonly SkillDiagnosticItem[] = [];
	#entries: SidebarEntry<"skill">[] = [];
	#selected: string | undefined;
	#selectedIndex = 0;
	#focus: "list" | "detail" = "list";
	#notice: SkillDiagnosticsPanelNotice | undefined;
	#closed = false;
	/** Bumped on every visible change; the native description is rebuilt when it moves. */
	#version = 0;
	#scroll: NativeScroll | undefined;
	#native: { version: number; scroll: NativeScroll | undefined; node: NativeNode } | undefined;

	#sidebarStyle = (entry: SidebarEntry<"skill">, index: number): SidebarStyle => {
		const item = this.#items[index];
		if (!item) return { icon: " ", annotation: "" };
		const state = rowState(item);
		return {
			icon: theme.fg(state.tone, state.icon),
			annotation: theme.fg(state.tone, entry.annotation ?? ""),
			muted: !item.canAnalyze && !item.analysis && !item.lastAnalysis,
		};
	};

	#renderBody = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines = [...this.#headLines(width), ""];
		const item = this.#current();
		this.#detail.setLines(renderParas(item ? inspect(item) : EMPTY_PARAS, Math.max(1, width - 1)));
		this.#detail.setHeight(Math.max(1, rows - lines.length));
		lines.push(...this.#detail.render(width));
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};

	readonly #frame: HubFrame = new HubFrame(
		"Skill diagnostics",
		SIDEBAR_BOUNDS,
		(width, rows) =>
			this.#frame.renderSidebar(
				this.#entries,
				width,
				rows,
				{ id: this.#selected ?? "", focused: this.#focus === "list", follow: true, clamp: true },
				this.#sidebarStyle,
			),
		this.#renderBody,
		{ bodyMinWidth: BODY_MIN_WIDTH, preserveSidebar: true },
	);

	constructor(tui: TUI, controller: SkillDiagnosticController, options: SkillDiagnosticsPanelOptions) {
		this.#tui = tui;
		this.#controller = controller;
		this.#done = options.done;
		this.#selected = options.initialName;
		this.#notice = options.notice;
		this.#refresh();
		this.#unsubscribe = controller.subscribe(() => {
			if (this.#closed) return;
			this.#refresh();
			this.#touch();
		});
	}

	dispose(): void {
		this.#unsubscribe();
		this.#detail.dispose();
	}

	invalidate(): void {
		this.#version++;
		this.#frame.invalidate();
	}

	render(width: number): readonly string[] {
		const footer = this.#frame.renderFooter(width - 4, this.#hint());
		return this.#frame.render(width, this.#terminalRows(), this.#entries, footer);
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		this.#refresh();
		this.#notice = undefined;
		if (matchesSelectCancel(data)) {
			this.#finish({ action: "close", selected: this.#selected });
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "list" ? "detail" : "list";
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#analyze();
		} else if (isLetter(data, "a")) {
			this.#apply();
		} else if (isLetter(data, "c")) {
			this.#cancelRunning();
		} else if (this.#focus === "detail") {
			this.#scrollDetail(data);
		} else {
			this.#navigate(data);
		}
		this.#touch();
	}

	// ── Native surface ────────────────────────────────────────────────────────────────────────────

	describe(_cx: DescribeContext): NativeNode {
		const cached = this.#native;
		if (cached && cached.version === this.#version && cached.scroll === this.#scroll) return cached.node;
		const item = this.#current();
		const { analyze, apply, cancel } = this.#actions();
		const detail: NativeNode = {
			...col((item ? inspect(item) : [...EMPTY_PARAS]).map(describePara), { gap: "xs" }),
			key: "detail",
			scroll: this.#scroll,
		};
		const hints: NativeHint[] = [
			{ keys: ["up", "down"], label: "select" },
			{ keys: ["tab"], label: this.#focus === "list" ? "scroll details" : "back to list" },
		];
		const described = describeHubFrame(
			"omp.hub.skill-diagnostics",
			"Skill diagnostics",
			describeHubSidebar(this.#entries, this.#selected ?? "", this.#sidebarStyle, "skills"),
			node("col", { gap: "sm", grow: 1 }, [text(this.#headSpans(), { wrap: "word" }), detail], "body"),
			node(
				"col",
				{ gap: "xs" },
				[
					actionBar([
						...compact([
							analyze && actionButton("Analyze with AI", "analyze", { keys: "enter", tone: "accent" }),
							apply && actionButton("Apply recommendation", "apply", { keys: "a" }),
							cancel && actionButton("Cancel analysis", "cancel", { keys: "c", tone: "error" }),
						]),
						null,
						actionButton("Close", "close", { keys: "escape" }),
					]),
					hintsRow(hints),
				],
				"footer",
			),
		);
		this.#native = { version: this.#version, scroll: this.#scroll, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed) return;
		this.#refresh();
		this.#notice = undefined;
		if ((event.type === "select" || event.type === "activate") && leafKey(event.key) === "skills") {
			const index = this.#items.findIndex(item => item.name === event.item);
			if (index < 0) return;
			this.#focus = "list";
			this.#select(index);
			if (event.type === "activate") this.#analyze();
		} else if (event.type === "action") {
			if (event.act === "analyze") this.#analyze();
			else if (event.act === "apply") this.#apply();
			else if (event.act === "cancel") this.#cancelRunning();
			else if (event.act === "close") this.#finish({ action: "close", selected: this.#selected });
		} else {
			return;
		}
		this.#touch();
	}

	// ── State ─────────────────────────────────────────────────────────────────────────────────────

	/** Re-read the controller; keep the selected row by name, else the nearest index. */
	#refresh(): void {
		// Comparable groups first; the sort is stable, so the controller's order holds within each group.
		const items = [...this.#controller.items()].sort((a, b) => Number(b.canAnalyze) - Number(a.canAnalyze));
		const found = items.findIndex(item => item.name === this.#selected);
		const index = found >= 0 ? found : Math.min(this.#selectedIndex, Math.max(0, items.length - 1));
		const name = items[index]?.name;
		if (name !== this.#selected) this.#resetDetailScroll();
		this.#items = items;
		this.#selectedIndex = index;
		this.#selected = name;
		this.#entries = items.map((item): SidebarEntry<"skill"> => {
			const word = rowState(item).word;
			// Pre-cut the label so the annotation always fits the widest sidebar.
			const room = Math.max(4, SIDEBAR_BOUNDS.max - 5 - visibleWidth(word));
			return { id: item.name, kind: "skill", label: truncateToWidth(line(item.name), room), annotation: word };
		});
	}

	#current(): SkillDiagnosticItem | undefined {
		return this.#items[this.#selectedIndex];
	}

	#actions(): { analyze: boolean; apply: boolean; cancel: boolean } {
		const item = this.#current();
		return {
			analyze: item?.canAnalyze === true && item.analysis?.status !== "running",
			apply: item !== undefined && "record" in applicability(item),
			cancel: item?.analysis?.status === "running",
		};
	}

	#touch(): void {
		this.#version++;
		this.#tui.requestRender();
	}

	#say(tone: SkillDiagnosticsPanelNotice["tone"], message: string): void {
		this.#notice = { tone, text: message };
	}

	#finish(result: SkillDiagnosticsPanelResult): void {
		if (this.#closed) return;
		this.#closed = true;
		// The host disposes the component on done, but never keep a finished panel subscribed to the session.
		this.#unsubscribe();
		this.#done(result);
	}

	#terminalRows(): number {
		return Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
	}

	// ── Actions ───────────────────────────────────────────────────────────────────────────────────

	/** Enter: ask the host to prepare and confirm an analysis. Rows with nothing to compare explain why instead. */
	#analyze(): void {
		const item = this.#current();
		if (!item) return;
		if (!item.canAnalyze) {
			this.#say(
				"info",
				`Nothing to analyze: ${item.unavailableReason ?? "No competing variants to compare."} No model is called.`,
			);
			return;
		}
		if (item.analysis?.status === "running") {
			this.#say("info", "An analysis is already running for this skill. Press C to cancel it.");
			return;
		}
		// A plan prepared elsewhere (an RPC client) is consented to and started as is, not prepared again.
		const prepared = item.analysis?.status === "prepared" ? item.analysis : undefined;
		this.#finish({ action: "analyze", selected: item.name, prepared });
	}

	/** A: ask the host to confirm and apply the completed recommendation. */
	#apply(): void {
		const item = this.#current();
		if (!item) return;
		const found = applicability(item);
		if ("reason" in found) {
			this.#say("info", found.reason);
			return;
		}
		this.#finish({ action: "apply", selected: item.name, record: found.record });
	}

	/** C: stop the selected row's running analysis. Needs no consent: it only withdraws work. */
	#cancelRunning(): void {
		const running = this.#current()?.analysis;
		if (running?.status !== "running") {
			this.#say("info", "No analysis is running for this skill.");
			return;
		}
		try {
			this.#controller.cancel(running.id);
			this.#say("info", "Analysis cancelled.");
		} catch (error) {
			this.#say("error", error instanceof Error ? error.message : String(error));
		}
		this.#refresh();
	}

	// ── Navigation ────────────────────────────────────────────────────────────────────────────────

	#navigate(data: string): void {
		const page = Math.max(1, this.#terminalRows() - 8);
		if (matchesSelectUp(data)) this.#select(this.#selectedIndex - 1);
		else if (matchesSelectDown(data)) this.#select(this.#selectedIndex + 1);
		else if (matchesSelectPageUp(data)) this.#select(this.#selectedIndex - page);
		else if (matchesSelectPageDown(data)) this.#select(this.#selectedIndex + page);
		else if (matchesKey(data, "home")) this.#select(0);
		else if (matchesKey(data, "end")) this.#select(this.#items.length - 1);
	}

	#select(index: number): void {
		const next = Math.max(0, Math.min(this.#items.length - 1, index));
		const item = this.#items[next];
		if (!item || next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#selected = item.name;
		this.#resetDetailScroll();
	}

	#resetDetailScroll(): void {
		this.#detail.scrollToTop();
		this.#scroll = { by: "start", n: (this.#scroll?.n ?? 0) + 1 };
	}

	/** Detail focus: the arrow, page, Home and End keys scroll; natively the terminal scrolls the same node. */
	#scrollDetail(data: string): void {
		const by: NativeScroll["by"] | undefined = matchesSelectUp(data)
			? "line-up"
			: matchesSelectDown(data)
				? "line-down"
				: matchesSelectPageUp(data)
					? "page-up"
					: matchesSelectPageDown(data)
						? "page-down"
						: matchesKey(data, "home")
							? "start"
							: matchesKey(data, "end")
								? "end"
								: undefined;
		if (by === undefined) return;
		this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
		this.#detail.handleScrollKey(data);
	}

	// ── Chrome ────────────────────────────────────────────────────────────────────────────────────

	#summary(): string {
		const comparable = this.#items.filter(item => item.canAnalyze).length;
		const running = this.#items.filter(item => item.analysis?.status === "running").length;
		return `${this.#items.length} skill${this.#items.length === 1 ? "" : "s"} · ${comparable} comparable${running > 0 ? ` · ${running} analyzing` : ""}`;
	}

	#headLines(width: number): string[] {
		if (this.#notice) {
			const painted = theme.fg(NOTICE_TONE[this.#notice.tone], ` ${line(this.#notice.text)}`);
			return wrapTextWithAnsi(painted, Math.max(1, width)).slice(0, MAX_NOTICE_LINES);
		}
		return [truncateToWidth(theme.fg("muted", ` ${this.#summary()}`), width)];
	}

	#headSpans() {
		if (this.#notice) return [span(line(this.#notice.text), NOTICE_TONE[this.#notice.tone])];
		return [span(this.#summary(), "muted")];
	}

	#hint(): string {
		const { analyze, apply, cancel } = this.#actions();
		const analysis = this.#current()?.analysis;
		return compact([
			analyze &&
				`${formatKeyHint("enter")} ${analysis && analysis.status !== "prepared" ? "analyze again" : "analyze"}`,
			apply && `${formatKeyHint("a")} apply`,
			cancel && `${formatKeyHint("c")} cancel analysis`,
			`${editorKeys("tui.select.up", "tui.select.down")} select`,
			`${formatKeyHint("tab")} ${this.#focus === "list" ? "scroll details" : "back to list"}`,
			`${editorKey("tui.select.cancel")} close`,
		]).join(" · ");
	}
}
