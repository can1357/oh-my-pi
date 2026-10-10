import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { type Component } from "../tui";
import { Container } from "../tui";
import { Text } from "../components/text";
import { WidthAwareText } from "../render/index";
import { getLanguageFromPath, theme } from "../theme";
import { parseLineRanges, selectorLineRanges } from "../tools/line-ranges";
import {
	type ReadRenderArgs,
	type ReadToolDetails,
	readContentCode,
	readSourceFsPath,
	splitPathAndSel,
} from "../tools/read";
import { PREVIEW_LIMITS, shortenPath } from "../render/render-utils";
import { fileHyperlink, renderCodeCell } from "../render";
import { canonicalizeMessage } from "./thinking-display";
import { internalUrlSchemeSpec, splitUrlScheme } from "../tools/url-scheme-host";
import { describeToolAdditionalContext, renderToolAdditionalContext, type ToolExecutionHandle } from "./tool-execution";
import { formatUsageRow } from "../overlays/usage-row";
import { formatCount } from "@oh-my-pi/pi-utils";
import type { TspCardStatus, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { NativeToolHead } from "../tools/renderer";
import { card, code, col, keyed, node, span, text, withHidden } from "../native/describe";
import {
	type DescribeContext,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	rootToggleExpanded,
} from "../native/node";
import { plainText } from "../native/spans";
import { Memo } from "../native/memo";
import { fileHref, fileRow, inlineErrorView } from "../tools/native-view";

/**
 * Extract the read call's target path. `path` is the canonical arg; `file_path`
 * is the legacy alias still tolerated by the read tool schema.
 */
function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

/**
 * Whether a read collapses into the compact {@link ReadToolGroupComponent}
 * rather than a full tool execution. Filesystem/external targets always
 * collapse; registered internal-URL schemes render full so their resolved
 * content is visible, unless their spec declares `compactTranscript`
 * (device listings/docs read better in the compact grouped view).
 */
export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (target === undefined) return false;
	const url = splitUrlScheme(target);
	const spec = url && internalUrlSchemeSpec(url.scheme);
	return spec === undefined || spec.compactTranscript === true;
}

/**
 * Return the collapsed read calls that can own a turn's usage row. Mixed-tool
 * turns and visible content after a read keep the standalone row so request
 * metrics retain their transcript ordering.
 */
export function groupedReadUsageCallIds(message: AssistantMessage): string[] | undefined {
	const toolCallIds: string[] = [];
	let sawToolCall = false;
	for (const content of message.content) {
		if (content.type === "toolCall") {
			if (content.name !== "read" || !readArgsCollapseIntoGroup(content.arguments)) return undefined;
			sawToolCall = true;
			toolCallIds.push(content.id);
			continue;
		}
		if (
			sawToolCall &&
			(content.type === "image" ||
				(content.type === "text" && canonicalizeMessage(content.text)) ||
				(content.type === "thinking" && canonicalizeMessage(content.thinking)))
		) {
			return undefined;
		}
	}
	return toolCallIds.length > 0 ? toolCallIds : undefined;
}

type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

type ReadToolGroupOptions = {
	showContentPreview?: boolean;
};

function getSuffixResolution(details: ReadToolDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

/** One display path recovered from a delimited read, paired with the resolved fs link target for its row. */
type ReadDisplayPathSpec = { path: string; linkPath?: string };

type ReadEntry = {
	toolCallId: string;
	path: string;
	displayPaths?: ReadDisplayPathSpec[];
	linkPath?: string;
	status: "pending" | "success" | "warning" | "error";
	correctedFrom?: string;
	contentText?: string;
	conflictCount?: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
};

type ReadUsageRow = {
	toolCallIds: readonly string[];
	usage: Usage;
	durationMs?: number;
	ttftMs?: number;
	timestamp?: number;
	turnElapsedMs?: number;
};

/** Number of code lines to show in collapsed preview mode */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

/**
 * Collapsed clamp for a data-first group whose previews are already trimmed
 * to {@link COLLAPSED_PREVIEW_LINES}: large enough never to cut the trimmed
 * body, so collapsed shows every file and the head of each preview.
 */
const TRIMMED_BODY_PREVIEW = { lines: 1000 } as const;

/** Native item tone per read status; successful reads stay neutral. */
const READ_STATUS_TONE: Record<ReadEntry["status"], "pending" | "warning" | "error" | undefined> = {
	success: undefined,
	pending: "pending",
	warning: "warning",
	error: "error",
};

type ReadDisplayTarget = {
	entry: ReadEntry;
	targetPath: string;
	basePath: string;
	linkPath?: string;
	selector?: string;
};

type ReadSummaryRow = {
	targetPath: string;
	basePath: string;
	targets: ReadDisplayTarget[];
};

const READ_STATUS_RANK: Record<ReadEntry["status"], number> = {
	success: 0,
	pending: 1,
	warning: 2,
	error: 3,
};

function getDisplayReadTargets(details: ReadToolDetails | undefined): ReadDisplayPathSpec[] | undefined {
	if (!Array.isArray(details?.displayReadTargets)) return undefined;
	const links = Array.isArray(details.displayReadTargetLinks) ? details.displayReadTargetLinks : undefined;
	const targets: ReadDisplayPathSpec[] = [];
	details.displayReadTargets.forEach((raw, index) => {
		if (typeof raw !== "string") return;
		const path = raw.trim();
		if (!path) return;
		const link = links?.[index];
		targets.push({ path, linkPath: typeof link === "string" && link.length > 0 ? link : undefined });
	});
	return targets.length > 0 ? targets : undefined;
}

function displayPathWithSuffixResolution(currentPath: string, suffixResolution: ReadToolSuffixResolution): string {
	const currentSelector = splitPathAndSel(currentPath).sel;
	if (!currentSelector || splitPathAndSel(suffixResolution.to).sel) return suffixResolution.to;
	return `${suffixResolution.to}:${currentSelector}`;
}

function readResultLinkPath(details: ReadToolDetails | undefined): string | undefined {
	return (
		details?.displayTarget ??
		(typeof details?.resolvedPath === "string" ? details.resolvedPath : readSourceFsPath(details))
	);
}

function readTargetLinkPath(basePath: string, entryLinkPath: string | undefined): string | undefined {
	if (entryLinkPath) return entryLinkPath;
	return path.isAbsolute(basePath) ? basePath : undefined;
}

function firstSelectorLine(selector: string | undefined): number | undefined {
	try {
		return selectorLineRanges(selector)?.[0].startLine;
	} catch {
		return undefined;
	}
}

function firstSelectorLineForTargets(targets: ReadDisplayTarget[]): number | undefined {
	let line: number | undefined;
	for (const target of targets) {
		const targetLine = firstSelectorLine(target.selector);
		if (targetLine === undefined) continue;
		if (line === undefined || targetLine < line) line = targetLine;
	}
	return line;
}

function linkPathForTargets(targets: ReadDisplayTarget[]): string | undefined {
	for (const target of targets) {
		if (target.linkPath) return target.linkPath;
	}
	return undefined;
}

function selectorChunkIsLineRangeList(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) return false;
	try {
		return parseLineRanges(trimmed) !== null;
	} catch {
		return false;
	}
}

function nextTopLevelToken(input: string, start: number): string {
	let braceDepth = 0;
	for (let i = start; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";")) {
			return input.slice(start, i);
		}
	}
	return input.slice(start);
}

function commaContinuesLineRangeSelector(input: string, partStart: number, commaIndex: number): boolean {
	const currentPart = input.slice(partStart, commaIndex).trim();
	if (!splitPathAndSel(currentPart).sel) return false;
	return selectorChunkIsLineRangeList(nextTopLevelToken(input, commaIndex + 1));
}

function splitReadDisplayPathSpecs(rawPath: string): string[] {
	const normalized = rawPath.trim();
	if (!normalized || splitUrlScheme(normalized)) return [rawPath];

	const parts: string[] = [];
	let braceDepth = 0;
	let partStart = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "\\" && i + 1 < normalized.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (ch !== "," && ch !== ";")) continue;
		if (ch === "," && commaContinuesLineRangeSelector(normalized, partStart, i)) continue;
		parts.push(normalized.slice(partStart, i).trim());
		partStart = i + 1;
	}
	parts.push(normalized.slice(partStart).trim());

	const cleanParts = parts.filter(part => part.length > 0);
	if (cleanParts.length <= 1) return [rawPath];
	return cleanParts.every(part => splitPathAndSel(part).sel !== undefined) ? cleanParts : [rawPath];
}

function splitSelectorDisplayParts(sel: string | undefined): Array<string | undefined> {
	if (!sel) return [undefined];
	const chunks = sel.split(":");
	if (chunks.length === 1) {
		if (!selectorChunkIsLineRangeList(sel) || !sel.includes(",")) return [sel];
		return sel
			.split(",")
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0);
	}
	if (chunks.length === 2) {
		const [left, right] = chunks as [string, string];
		const leftIsRange = selectorChunkIsLineRangeList(left);
		const rightIsRange = selectorChunkIsLineRangeList(right);
		if (leftIsRange && left.includes(",")) {
			return left
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${chunk}:${right}`);
		}
		if (rightIsRange && right.includes(",")) {
			return right
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${left}:${chunk}`);
		}
	}
	return [sel];
}

function formatMergedSelectorParts(selectors: string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	const first = selectors[0]!;
	const second = selectors[1]!;
	const last = selectors[selectors.length - 1]!;
	return `${first},${second},…,${last}`;
}

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#usageRows = new Map<string, ReadUsageRow>();
	#usageBatchByToolCallId = new Map<string, string>();
	#text: Text;
	#expanded = false;
	#toolActivityVisible = true;
	#additionalContext: string | undefined;
	#showContentPreview: boolean;
	// A read group accretes entries across multiple assistant completions for as
	// long as the run of reads is uninterrupted. It remains active while its
	// header can change from `Read <path>` to `Read (N)` plus a tree. The
	// controller calls `finalize()` once the run breaks; TranscriptContainer
	// retires the finalized block as an immutable history batch.
	#finalized = false;
	// Forced terminal even with a still-pending entry: the turn ended (abort or
	// completion) so no late result is coming. Set via `seal()`.
	#sealed = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a finalized group can still change — a late read result landing after the
	// run broke, seal(), or an expansion toggle — and the transcript's
	// width-epoch resolution and committed-render bypass must observe it.
	#blockVersion = 0;
	#displayVersion = 0;
	readonly #native = new Memo();
	/** Content previews toggled in the terminal, by tool call id. */
	#previewCollapsed = new Map<string, boolean>();

	constructor(options: ReadToolGroupOptions = {}) {
		super();
		this.#showContentPreview = options.showContentPreview ?? false;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}
	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (!this.#finalized) return false;
		// Closed to new entries, but a still-pending entry means its result is in
		// flight — parallel reads can finalize the group (a sibling tool starts and
		// breaks the run) before a read's `tool_execution_end` lands. Keep the block
		// active so the late result updates the pending preview.
		return !this.#hasPendingEntries();
	}

	#hasPendingEntries(): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.status === "pending") return true;
		}
		return false;
	}

	finalize(): void {
		this.#finalized = true;
	}

	/**
	 * Force the group terminal even if an entry never received its result (the
	 * turn aborted or ended), allowing the container to retire it as history.
	 */
	seal(): void {
		if (!this.#sealed) this.#blockVersion++;
		this.#sealed = true;
	}

	/** Reads never park as background tasks; the handle method is a no-op. */
	parkAsBackground(): void {}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			status: "pending",
		};
		entry.path = rawPath;
		this.#entries.set(toolCallId, entry);
		this.#updateDisplay();
	}

	/**
	 * Re-key an entry whose streamed tool-call id changed mid-stream (a provider
	 * rewriting the id across deltas; see EventController's
	 * `#streamedToolCallIdByIndex`). Preserves row order so a sibling read run is
	 * not visibly reshuffled, and no-ops when the rename would collide.
	 */
	renameEntry(oldId: string, newId: string): void {
		if (oldId === newId || !newId) return;
		const entry = this.#entries.get(oldId);
		if (!entry || this.#entries.has(newId)) return;
		entry.toolCallId = newId;
		const reordered = [...this.#entries].map(([key, value]): [string, ReadEntry] => [
			key === oldId ? newId : key,
			value,
		]);
		this.#entries.clear();
		for (const [key, value] of reordered) this.#entries.set(key, value);
		this.#updateDisplay();
	}
	/** Remove one call without discarding successful siblings in the shared group. */
	removeEntry(toolCallId: string): boolean {
		if (!this.#entries.delete(toolCallId)) return this.#entries.size === 0;
		this.#updateDisplay();
		return this.#entries.size === 0;
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		this.#blockVersion++;
		const details = result.details as ReadToolDetails | undefined;
		const suffixResolution = getSuffixResolution(details);
		const displayPaths = getDisplayReadTargets(details);
		entry.linkPath = readResultLinkPath(details);
		if (suffixResolution) {
			entry.path = displayPathWithSuffixResolution(entry.path, suffixResolution);
			entry.correctedFrom = suffixResolution.from;
			entry.displayPaths = undefined;
		} else {
			entry.correctedFrom = undefined;
			entry.displayPaths = displayPaths;
		}
		const conflictCount =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		entry.conflictCount = conflictCount;
		entry.status = result.isError ? "error" : suffixResolution ? "warning" : "success";
		// Store clean display content for preview/expanded display when the read
		// tool provides it; fall back to model-facing text for legacy results.
		const displayContent = details?.displayContent;
		const textContent = result.content?.find(c => c.type === "text")?.text;
		if (displayContent !== undefined || textContent !== undefined) {
			entry.contentText = displayContent?.text ?? textContent;
			entry.codeStartLine = displayContent?.startLine;
			entry.codeLineNumbers = displayContent?.lineNumbers;
		}
		this.#updateDisplay();
	}

	/**
	 * Nest one request's usage beneath the last visible read call from that
	 * request. Parallel reads share one row rather than duplicating request totals.
	 */
	attachUsage(
		toolCallIds: readonly string[],
		usage: Usage,
		durationMs?: number,
		ttftMs?: number,
		timestamp?: number,
		turnElapsedMs?: number,
	): boolean {
		const attachedToolCallIds: string[] = [];
		let anchorId: string | undefined;
		for (const toolCallId of toolCallIds) {
			if (!this.#entries.has(toolCallId)) continue;
			attachedToolCallIds.push(toolCallId);
			anchorId = toolCallId;
		}
		if (!anchorId) return false;
		for (const toolCallId of attachedToolCallIds) {
			this.#usageBatchByToolCallId.set(toolCallId, anchorId);
		}
		this.#usageRows.set(anchorId, {
			toolCallIds: attachedToolCallIds,
			usage,
			durationMs,
			ttftMs,
			timestamp,
			turnElapsedMs,
		});
		this.#updateDisplay();
		return true;
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExecutionStarted(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#previewCollapsed.clear();
		this.#updateDisplay();
	}

	setAdditionalContext(context: string): void {
		if (context === this.#additionalContext) return;
		this.#additionalContext = context;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	getComponent(): Component {
		return this;
	}

	/**
	 * Mirrors the terminal's toggles: the `tool` head (the group's root) is
	 * `Ctrl+O`'s expansion; a fallback preview card collapses on its own
	 * (`setExpanded` resets those).
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) {
			this.setExpanded(expanded);
			return;
		}
		if (event.type !== "toggle" || !event.key.startsWith("p")) return;
		const toolCallId = event.key.slice(1);
		if (!this.#entries.has(toolCallId)) return;
		this.#previewCollapsed.set(toolCallId, event.collapsed);
		this.#displayVersion++;
	}

	/**
	 * The read run as one inline `tool` on terminals that list the kind, else
	 * the fallback: a bare `card` (role `omp.tool.read`) with `Read <path>` or
	 * `Read (N)` in the head, a `list` of path items (status tone, link,
	 * correction and conflict detail, nested usage) and, with content previews
	 * on, a `code` block per read clamped by the card's preview while collapsed.
	 */
	override describe(cx?: DescribeContext): NativeNode {
		const dataFirst = cx?.supports("tool") === true;
		const key = [dataFirst, this.#displayVersion, this.#toolActivityVisible, this.#sealed];
		return this.#native.get(key, () => {
			const described = dataFirst ? this.#describeTool() : this.#describeGroup();
			// Passive context sits below the card, outside its preview clamp, as on ordinary tool cards.
			const context = describeToolAdditionalContext(this.#additionalContext, this.#expanded);
			return withHidden(context.length > 0 ? col([described, ...context]) : described, !this.#toolActivityVisible);
		});
	}

	/**
	 * The data-first read (§7.3 read, read group, read error): one inline
	 * `tool` (role `omp.tool.read`). One file: `Read path:13-36`, a failure's
	 * message in the head. Several: `Read 3 files` over one 22px row per file
	 * (glyph, dim dir, strong name, range). Content previews are numbered
	 * `code` (a section per file in a group), trimmed while collapsed.
	 */
	#describeTool(): NativeNode {
		const entries = [...this.#entries.values()];
		const rows = this.#buildSummaryRows(this.#displayTargetsForEntries(entries));
		const status = this.#groupStatus(entries);
		const previews = entries.filter(entry => entry.status !== "error" && this.#shouldRenderPreview(entry));
		const body: NativeChild[] = [];
		let head: NativeToolHead;
		// Previews (and a long error message) are what a collapse hides; plain rows always show.
		let collapsible = previews.length > 0;
		if (rows.length <= 1) {
			const row = rows[0];
			const error = row && this.#statusForTargets(row.targets) === "error" ? this.#errorFor(row) : undefined;
			const rowHead: NativeToolHead = row ? this.#nativeRowHead(row) : { target: "…", targetKind: "path" };
			if (error !== undefined) {
				const view = inlineErrorView(rowHead, error);
				head = view.tool ?? rowHead;
				if (view.body) {
					body.push(...view.body);
					collapsible = true;
				}
			} else {
				head = rowHead;
			}
			for (const entry of previews) body.push(...this.#nativePreview(entry));
			for (const [i, usage] of (this.#usageRowsBySummaryRow(rows).get(0) ?? []).entries()) {
				body.push(this.#nativeUsage(usage, `u${i}`));
			}
		} else {
			head = { target: formatCount("file", rows.length), targetKind: "text" };
			const summaryRows = this.#buildSummaryRows(
				this.#displayTargetsForEntries(entries.filter(entry => !previews.includes(entry))),
			);
			const usageByRow = this.#usageRowsBySummaryRow(summaryRows);
			for (const [index, row] of summaryRows.entries()) {
				body.push(this.#nativeFileRow(row));
				for (const [i, usage] of (usageByRow.get(index) ?? []).entries()) {
					body.push(this.#nativeUsage(usage, `u${index}.${i}`));
				}
			}
			for (const entry of previews) {
				const split = splitPathAndSel(entry.path);
				const name = shortenPath(split.path);
				const sectionHead: TspSpan[] = [span(name || "…", "path")];
				if (split.sel) sectionHead.push(span(`:${split.sel}`, "muted"));
				body.push(node("section", { head: sectionHead }, this.#nativePreview(entry), `p${entry.toolCallId}`));
				const usage = this.#usageRows.get(entry.toolCallId);
				if (usage) body.push(this.#nativeUsage(usage, `u${entry.toolCallId}`));
			}
		}
		return node(
			"tool",
			{
				...head,
				role: "omp.tool.read",
				name: "read",
				title: "Read",
				status,
				tone: status === "error" ? "error" : undefined,
				frame: "inline",
				collapsible,
				collapsed: collapsible ? !this.#expanded : undefined,
				preview: collapsible ? TRIMMED_BODY_PREVIEW : undefined,
			},
			body,
		);
	}

	/** Head data for one summary row: the path (+ selector) target, its link, correction and conflicts. */
	#nativeRowHead(row: ReadSummaryRow): NativeToolHead {
		const split = splitPathAndSel(row.targetPath);
		const filePath = shortenPath(split.sel ? split.path : row.targetPath);
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		const conflicts = this.#conflictCountForTargets(row.targets);
		return {
			target: filePath ? `${filePath}${split.sel ? `:${split.sel}` : ""}` : "…",
			targetKind: "path",
			href: fileHref(linkPathForTargets(row.targets)),
			meta: correctedFrom ? [`corrected from ${shortenPath(correctedFrom)}`] : undefined,
			badges: conflicts
				? [{ text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`, tone: "warning" }]
				: undefined,
		};
	}

	/** One 22px group row: status glyph, path and range, conflicts chip, then the correction or error message. */
	#nativeFileRow(row: ReadSummaryRow): NativeNode {
		const split = splitPathAndSel(row.targetPath);
		const status = this.#statusForTargets(row.targets);
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		const conflicts = this.#conflictCountForTargets(row.targets);
		const error = status === "error" ? this.#errorFor(row) : undefined;
		const detail: TspText | undefined =
			error !== undefined
				? [span(`— ${error.split("\n", 1)[0]}`, "error")]
				: correctedFrom
					? `corrected from ${shortenPath(correctedFrom)}`
					: undefined;
		return fileRow(shortenPath(split.sel ? split.path : row.targetPath), {
			range: split.sel ? `:${split.sel}` : undefined,
			href: fileHref(linkPathForTargets(row.targets)),
			icon: status === "error" ? "x-circle" : undefined,
			tone: READ_STATUS_TONE[status],
			chip: conflicts ? { text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}` } : undefined,
			detail,
			title: error,
			key: row.targetPath,
		});
	}

	/** The failure message of a row's failed read (its result text, `Error:` prefix dropped). */
	#errorFor(row: ReadSummaryRow): string {
		const failed = row.targets.find(target => target.entry.status === "error")?.entry;
		return (
			plainText(failed?.contentText ?? "")
				.replace(/^Error:\s*/, "")
				.trim() || "Read failed"
		);
	}

	/** One read's content as numbered `code`, trimmed to its first lines (plus a count) while collapsed. */
	#nativePreview(entry: ReadEntry): NativeChild[] {
		const split = splitPathAndSel(entry.path);
		const lines = (entry.contentText ?? "").split("\n");
		const shown = this.#expanded ? lines.length : Math.min(lines.length, COLLAPSED_PREVIEW_LINES);
		const blocks: NativeChild[] = readContentCode(
			lines.slice(0, shown).join("\n"),
			entry.codeStartLine ?? firstSelectorLine(split.sel) ?? 1,
			entry.codeLineNumbers?.slice(0, shown),
			getLanguageFromPath(split.path),
		);
		const hidden = lines.length - shown;
		if (hidden > 0) {
			blocks.push(
				keyed(text([span(formatCount("more line", hidden), "muted")], { role: "omp.tool.stats" }), "more"),
			);
		}
		return blocks;
	}

	#describeGroup(): NativeNode {
		const entries = [...this.#entries.values()];
		const rows = this.#buildSummaryRows(this.#displayTargetsForEntries(entries));
		const usageByRow = this.#usageRowsBySummaryRow(rows);
		const previews = entries.filter(entry => this.#shouldRenderPreview(entry));
		const status = this.#groupStatus(entries);
		const title = span("Read", "toolTitle");
		const children: NativeChild[] = [];
		let head: TspSpan[] = [title];
		if (rows.length === 1) {
			head = [title, span(" "), ...this.#nativePathSpans(rows[0]!)];
			if (previews.length === 0) {
				for (const usage of usageByRow.get(0) ?? []) children.push(this.#nativeUsage(usage, "u0"));
			}
		} else if (rows.length > 1) {
			head = [title, span(` (${rows.length})`, "dim")];
			const summaryTargets = this.#displayTargetsForEntries(
				entries.filter(entry => !this.#shouldRenderPreview(entry)),
			);
			const summaryRows = this.#buildSummaryRows(summaryTargets);
			const summaryUsage = this.#usageRowsBySummaryRow(summaryRows);
			const items = summaryRows.map((row, index) => {
				const usage = (summaryUsage.get(index) ?? []).map(usageRow =>
					plainText(
						formatUsageRow(
							usageRow.usage,
							usageRow.durationMs,
							usageRow.ttftMs,
							usageRow.timestamp,
							usageRow.turnElapsedMs,
						),
					),
				);
				return node(
					"item",
					{
						label: this.#nativePathSpans(row),
						tone: READ_STATUS_TONE[this.#statusForTargets(row.targets)],
						detail: usage.length > 0 ? [span(usage.join(" · "), "dim")] : undefined,
					},
					[],
					row.targetPath,
				);
			});
			if (items.length > 0) children.push(node("list", {}, items));
		}
		for (const entry of previews) {
			const split = splitPathAndSel(entry.path);
			const pathValue = shortenPath(entry.path);
			children.push(
				node(
					"card",
					{
						role: "omp.tool.read.preview",
						tone: READ_STATUS_TONE[entry.status],
						head: pathValue ? [title, span(" "), span(pathValue, "path")] : [title],
						collapsible: true,
						collapsed: this.#previewCollapsed.get(entry.toolCallId) ?? !this.#expanded,
						preview: { lines: COLLAPSED_PREVIEW_LINES },
					},
					[
						code(entry.contentText ?? "", {
							lang: getLanguageFromPath(split.path),
							start: entry.codeStartLine,
							numbers: true,
						}),
					],
					`p${entry.toolCallId}`,
				),
			);
			const usage = this.#usageRows.get(entry.toolCallId);
			if (usage) children.push(this.#nativeUsage(usage, `u${entry.toolCallId}`));
		}
		return card(
			{
				role: "omp.tool.read",
				// A group is plain rows: the per-file previews are the only frames.
				variant: "bare",
				status,
				tone: status === "error" ? "error" : status === "running" ? "pending" : undefined,
				head,
			},
			children,
		);
	}

	#groupStatus(entries: readonly ReadEntry[]): TspCardStatus {
		let rank = 0;
		for (const entry of entries) rank = Math.max(rank, READ_STATUS_RANK[entry.status]);
		if (rank === READ_STATUS_RANK.error) return "error";
		if (rank === READ_STATUS_RANK.pending) return this.#sealed ? "cancelled" : "running";
		return "done";
	}

	/** Path spans for a summary row: linked path, selector, correction note and conflict badge. */
	#nativePathSpans(row: ReadSummaryRow): TspSpan[] {
		const split = splitPathAndSel(row.targetPath);
		const filePath = shortenPath(split.sel ? split.path : row.targetPath);
		const linkPath = linkPathForTargets(row.targets);
		const spans: TspSpan[] = [];
		if (filePath) {
			const href = linkPath && path.isAbsolute(linkPath) ? pathToFileURL(linkPath).href : undefined;
			spans.push(span(filePath, "path", href ? { href } : undefined));
		} else {
			spans.push(span("…", "toolOutput"));
		}
		if (split.sel) spans.push(span(`:${split.sel}`, "accent"));
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		if (correctedFrom) spans.push(span(` (corrected from ${shortenPath(correctedFrom)})`, "dim"));
		const conflicts = this.#conflictCountForTargets(row.targets);
		if (conflicts) spans.push(span(` (⚠ ${conflicts} conflict${conflicts === 1 ? "" : "s"})`, "warning"));
		return spans;
	}

	#nativeUsage(usage: ReadUsageRow, key: string): NativeNode {
		const line = formatUsageRow(usage.usage, usage.durationMs, usage.ttftMs, usage.timestamp, usage.turnElapsedMs);
		return text([span(plainText(line), "dim")], { wrap: "word", key, role: "omp.usage" });
	}

	#updateDisplay(): void {
		this.#displayVersion++;
		const entries = [...this.#entries.values()];
		const displayTargets = this.#displayTargetsForEntries(entries);
		const displayRows = this.#buildSummaryRows(displayTargets);

		// Clear previous children and rebuild the summary and preview blocks.
		this.clear();
		this.#text = new Text("", 0, 0);

		if (displayRows.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			this.#appendAdditionalContext();
			return;
		}

		if (displayRows.length === 1) {
			const row = displayRows[0]!;
			if (!this.#shouldRenderPreviewRow(row)) {
				const statusSymbol = this.#formatStatus(this.#statusForTargets(row.targets));
				const pathDisplay = this.#formatRowPath(row);
				const lines = [` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd()];
				const usageRows = this.#usageRowsBySummaryRow(displayRows).get(0) ?? [];
				this.#appendUsageRows(lines, usageRows, "   ");
				this.#text.setText(lines.join("\n"));
				this.addChild(this.#text);
			}
			for (const entry of this.#previewEntriesForRow(row)) {
				this.#addContentPreview(entry);
				this.#addPreviewUsage(entry);
			}
			this.#appendAdditionalContext();
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${displayRows.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const entriesWithoutPreview = entries.filter(entry => !this.#shouldRenderPreview(entry));
		const summaryTargets = this.#displayTargetsForEntries(entriesWithoutPreview);
		const rows = this.#buildSummaryRows(summaryTargets);
		const usageRowsBySummaryRow = this.#usageRowsBySummaryRow(rows);
		for (const [index, row] of rows.entries()) {
			this.#appendSummaryRow(lines, row, index, rows.length, usageRowsBySummaryRow.get(index) ?? []);
		}

		this.#text.setText(lines.join("\n"));
		this.addChild(this.#text);

		for (const entry of entries) {
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
				this.#addPreviewUsage(entry);
			}
		}
		this.#appendAdditionalContext();
	}

	#appendAdditionalContext(): void {
		if (this.#additionalContext === undefined) return;
		this.addChild(
			new WidthAwareText(
				width => renderToolAdditionalContext(this.#additionalContext ?? "", width, this.#expanded),
				1,
				0,
			),
		);
	}
	#displayTargetsForEntries(entries: ReadEntry[]): ReadDisplayTarget[] {
		const targets: ReadDisplayTarget[] = [];
		for (const entry of entries) {
			const pathSpecs: ReadDisplayPathSpec[] =
				entry.displayPaths ?? splitReadDisplayPathSpecs(entry.path).map(path => ({ path }));
			const useEntryLinkPath = pathSpecs.length === 1;
			for (const pathSpec of pathSpecs) {
				const split = splitPathAndSel(pathSpec.path);
				const entryLinkPath = pathSpec.linkPath ?? (useEntryLinkPath ? entry.linkPath : undefined);
				const linkPath = readTargetLinkPath(split.path, entryLinkPath);
				for (const selector of splitSelectorDisplayParts(split.sel)) {
					targets.push({
						entry,
						targetPath: selector ? `${split.path}:${selector}` : pathSpec.path,
						basePath: split.path,
						linkPath,
						selector,
					});
				}
			}
		}
		return targets;
	}

	#buildSummaryRows(targets: ReadDisplayTarget[]): ReadSummaryRow[] {
		const selectorTargetsByBasePathAndBatch = new Map<string, Map<string | undefined, ReadDisplayTarget[]>>();
		for (const target of targets) {
			if (!target.selector) continue;
			let targetsByBatch = selectorTargetsByBasePathAndBatch.get(target.basePath);
			if (!targetsByBatch) {
				targetsByBatch = new Map<string | undefined, ReadDisplayTarget[]>();
				selectorTargetsByBasePathAndBatch.set(target.basePath, targetsByBatch);
			}
			const batchId = this.#usageBatchByToolCallId.get(target.entry.toolCallId);
			const existing = targetsByBatch.get(batchId);
			if (existing) existing.push(target);
			else targetsByBatch.set(batchId, [target]);
		}

		const mergedTargetsByTarget = new Map<ReadDisplayTarget, ReadDisplayTarget[]>();
		for (const [basePath, targetsByBatch] of selectorTargetsByBasePathAndBatch) {
			if (!basePath) continue;
			for (const groupedTargets of targetsByBatch.values()) {
				if (groupedTargets.length <= 1) continue;
				for (const target of groupedTargets) {
					mergedTargetsByTarget.set(target, groupedTargets);
				}
			}
		}

		const emittedMergedTargets = new Set<ReadDisplayTarget[]>();
		const rows: ReadSummaryRow[] = [];
		for (const target of targets) {
			const mergedTargets = mergedTargetsByTarget.get(target);
			if (mergedTargets) {
				if (!emittedMergedTargets.has(mergedTargets)) {
					rows.push({
						targetPath: `${target.basePath}:${formatMergedSelectorParts(
							mergedTargets
								.map(mergedTarget => mergedTarget.selector)
								.filter(selector => selector !== undefined),
						)}`,
						basePath: target.basePath,
						targets: mergedTargets,
					});
					emittedMergedTargets.add(mergedTargets);
				}
				continue;
			}
			rows.push({ targetPath: target.targetPath, basePath: target.basePath, targets: [target] });
		}
		return rows;
	}

	#appendSummaryRow(
		lines: string[],
		row: ReadSummaryRow,
		index: number,
		total: number,
		usageRows: ReadUsageRow[],
	): void {
		const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
		lines.push(`   ${theme.fg("dim", connector)} ${this.#formatRow(row)}`.trimEnd());

		const connectorWidth = Bun.stringWidth(connector);
		const continuation =
			index === total - 1
				? " ".repeat(connectorWidth)
				: `${theme.tree.vertical}${" ".repeat(Math.max(0, connectorWidth - Bun.stringWidth(theme.tree.vertical)))}`;
		this.#appendUsageRows(lines, usageRows, `   ${continuation} `);
	}

	#usageRowsBySummaryRow(rows: ReadSummaryRow[]): Map<number, ReadUsageRow[]> {
		const lastRowIndexByToolCallId = new Map<string, number>();
		for (const [index, row] of rows.entries()) {
			for (const target of row.targets) {
				lastRowIndexByToolCallId.set(target.entry.toolCallId, index);
			}
		}

		const usageRowsByIndex = new Map<number, ReadUsageRow[]>();
		for (const usageRow of this.#usageRows.values()) {
			let lastRowIndex: number | undefined;
			for (const toolCallId of usageRow.toolCallIds) {
				const index = lastRowIndexByToolCallId.get(toolCallId);
				if (index !== undefined && (lastRowIndex === undefined || index > lastRowIndex)) {
					lastRowIndex = index;
				}
			}
			if (lastRowIndex === undefined) continue;
			const usageRows = usageRowsByIndex.get(lastRowIndex);
			if (usageRows) usageRows.push(usageRow);
			else usageRowsByIndex.set(lastRowIndex, [usageRow]);
		}
		return usageRowsByIndex;
	}

	#appendUsageRows(lines: string[], usageRows: ReadUsageRow[], prefix: string): void {
		for (const usageRow of usageRows) {
			lines.push(
				theme.fg(
					"dim",
					`${prefix}${formatUsageRow(usageRow.usage, usageRow.durationMs, usageRow.ttftMs, usageRow.timestamp, usageRow.turnElapsedMs)}`,
				),
			);
		}
	}

	#formatRow(row: ReadSummaryRow): string {
		const status = this.#statusForTargets(row.targets);
		const statusPrefix = status === "success" ? "" : `${this.#formatStatus(status)} `;
		return `${statusPrefix}${this.#formatRowPath(row)}`;
	}

	#formatRowPath(row: ReadSummaryRow): string {
		return this.#formatPathValue(row.targetPath, {
			correctedFrom: this.#correctedFromForTargets(row.targets),
			conflictCount: this.#conflictCountForTargets(row.targets),
			line: firstSelectorLineForTargets(row.targets),
			linkPath: linkPathForTargets(row.targets),
		});
	}

	#statusForTargets(targets: ReadDisplayTarget[]): ReadEntry["status"] {
		let status: ReadEntry["status"] = "success";
		for (const target of targets) {
			if (READ_STATUS_RANK[target.entry.status] > READ_STATUS_RANK[status]) {
				status = target.entry.status;
			}
		}
		return status;
	}

	#correctedFromForTargets(targets: ReadDisplayTarget[]): string | undefined {
		for (const target of targets) {
			if (target.entry.correctedFrom) return target.entry.correctedFrom;
		}
		return undefined;
	}

	#conflictCountForTargets(targets: ReadDisplayTarget[]): number | undefined {
		let conflictCount = 0;
		for (const target of targets) {
			if (target.entry.conflictCount && target.entry.conflictCount > conflictCount) {
				conflictCount = target.entry.conflictCount;
			}
		}
		return conflictCount > 0 ? conflictCount : undefined;
	}

	#previewEntriesForRow(row: ReadSummaryRow): ReadEntry[] {
		const entries: ReadEntry[] = [];
		const seen = new Set<string>();
		for (const target of row.targets) {
			if (seen.has(target.entry.toolCallId) || !this.#shouldRenderPreview(target.entry)) continue;
			entries.push(target.entry);
			seen.add(target.entry.toolCallId);
		}
		return entries;
	}

	#shouldRenderPreviewRow(row: ReadSummaryRow): boolean {
		return this.#previewEntriesForRow(row).length > 0;
	}

	#formatPathValue(
		value: string,
		options: { correctedFrom?: string; conflictCount?: number; line?: number; linkPath?: string } = {},
	): string {
		const split = splitPathAndSel(value);
		const selectorSuffix = split.sel ? `:${split.sel}` : "";
		const baseValue = split.sel ? split.path : value;
		const filePath = shortenPath(baseValue);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (filePath && options.linkPath) {
			const linkOptions = options.line !== undefined ? { line: options.line } : undefined;
			pathDisplay = fileHyperlink(options.linkPath, pathDisplay, linkOptions);
		}
		if (selectorSuffix) {
			pathDisplay += theme.fg("accent", selectorSuffix);
		}
		if (options.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(options.correctedFrom)})`);
		}
		pathDisplay += this.#formatConflictBadge(options.conflictCount);
		return pathDisplay;
	}

	#formatConflictBadge(conflictCount: number | undefined): string {
		if (!conflictCount || conflictCount <= 0) return "";
		const n = conflictCount;
		return ` ${theme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
	}

	/**
	 * Add a code-cell content preview below the entry summary.
	 * When collapsed: shows first COLLAPSED_PREVIEW_LINES lines with a "… N more lines ⟨<key>: Expand⟩" hint.
	 * When expanded: shows full content.
	 */
	#addContentPreview(entry: ReadEntry): void {
		const split = splitPathAndSel(entry.path);
		const lang = getLanguageFromPath(split.path);
		const pathValue = shortenPath(entry.path);
		const pathDisplay = pathValue
			? this.#formatPathValue(entry.path, {
					correctedFrom: entry.correctedFrom,
					conflictCount: entry.conflictCount,
					line: firstSelectorLine(split.sel),
					linkPath: readTargetLinkPath(split.path, entry.linkPath),
				})
			: "";
		const title = pathDisplay ? `Read ${pathDisplay}` : "Read";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		const dropCache = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		const expanded = this.#expanded;
		const component: Component = {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: entry.contentText ?? "",
						language: lang,
						title,
						status: entry.status === "success" ? "complete" : entry.status,
						expanded,
						codeMaxLines: expanded ? undefined : COLLAPSED_PREVIEW_LINES,
						codeStartLine: entry.codeStartLine,
						codeLineNumbers: entry.codeLineNumbers,
						width,
					},
					theme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: dropCache,
			releaseRenderCaches: dropCache,
		};
		this.addChild(component);
	}

	#addPreviewUsage(entry: ReadEntry): void {
		const usageRow = this.#usageRows.get(entry.toolCallId);
		if (!usageRow) return;
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					formatUsageRow(
						usageRow.usage,
						usageRow.durationMs,
						usageRow.ttftMs,
						usageRow.timestamp,
						usageRow.turnElapsedMs,
					),
				),
				3,
				0,
			),
		);
	}

	#shouldRenderPreview(entry: ReadEntry): boolean {
		return this.#showContentPreview && entry.contentText !== undefined;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("text", theme.status.enabled);
		}
		if (status === "warning") {
			return theme.fg("warning", theme.status.warning);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}
