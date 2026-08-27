import * as path from "node:path";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { InternalUrlRouter, XD_URL_PREFIX } from "../../internal-urls";
import { getLanguageFromPath, theme } from "../../modes/theme/theme";
import { parseLineRanges, selectorLineRanges, splitPathAndSel } from "../../tools/path-utils";
import { PREVIEW_LIMITS, shortenPath } from "../../tools/render-utils";
import { fileHyperlink, renderCodeCell, tryResolveInternalUrlSync } from "../../tui";
import { canonicalizeMessage } from "../../utils/thinking-display";
import type { ToolExecutionHandle } from "./tool-execution";
import { formatUsageRow } from "./usage-row";

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
 * collapse; other internal URLs (`skill://`, `agent://`, …) render full so
 * their resolved content is visible. `xd://` device reads are the exception —
 * they list devices/docs and read better in the compact grouped view.
 */
export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (target === undefined) return false;
	return target.startsWith(XD_URL_PREFIX) || !InternalUrlRouter.instance().canHandle(target);
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

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
};

type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

type ReadToolResultDetails = {
	resolvedPath?: string;
	suffixResolution?: {
		from?: string;
		to?: string;
	};
	conflictCount?: number;
	displayReadTargets?: unknown;
	displayContent?: {
		text?: string;
		startLine?: number;
		lineNumbers?: Array<number | null>;
	};
	meta?: {
		source?: {
			type?: string;
			value?: string;
		};
	};
};

type ReadToolGroupOptions = {
	showContentPreview?: boolean;
};

function getSuffixResolution(details: ReadToolResultDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

type ReadEntry = {
	toolCallId: string;
	path: string;
	displayPaths?: string[];
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
};

/** Number of code lines to show in collapsed preview mode */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

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

const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function getDisplayReadTargets(details: ReadToolResultDetails | undefined): string[] | undefined {
	if (!Array.isArray(details?.displayReadTargets)) return undefined;
	const targets = details.displayReadTargets
		.filter((target): target is string => typeof target === "string")
		.map(target => target.trim())
		.filter(target => target.length > 0);
	return targets.length > 0 ? targets : undefined;
}

function displayPathWithSuffixResolution(currentPath: string, suffixResolution: ReadToolSuffixResolution): string {
	const currentSelector = splitPathAndSel(currentPath).sel;
	if (!currentSelector || splitPathAndSel(suffixResolution.to).sel) return suffixResolution.to;
	return `${suffixResolution.to}:${currentSelector}`;
}

function readSourceFsPath(details: ReadToolResultDetails | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

function readResultLinkPath(details: ReadToolResultDetails | undefined): string | undefined {
	return typeof details?.resolvedPath === "string" ? details.resolvedPath : readSourceFsPath(details);
}

function readTargetLinkPath(basePath: string, entryLinkPath: string | undefined): string | undefined {
	if (entryLinkPath) return entryLinkPath;
	const resolvedInternalPath = tryResolveInternalUrlSync(basePath);
	if (resolvedInternalPath) return resolvedInternalPath;
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
	if (!normalized || URL_LIKE_RE.test(normalized)) return [rawPath];

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
		const rawPath = args.file_path || args.path || "";
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
		const details = result.details as ReadToolResultDetails | undefined;
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
		this.#usageRows.set(anchorId, { toolCallIds: attachedToolCallIds, usage, durationMs, ttftMs, timestamp });
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
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	getComponent(): Component {
		return this;
	}

	#updateDisplay(): void {
		const entries = [...this.#entries.values()];
		const displayTargets = this.#displayTargetsForEntries(entries);
		const displayRows = this.#buildSummaryRows(displayTargets);

		// Clear previous children and rebuild the summary and preview blocks.
		this.clear();
		this.#text = new Text("", 0, 0);

		if (displayRows.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
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
	}

	#displayTargetsForEntries(entries: ReadEntry[]): ReadDisplayTarget[] {
		const targets: ReadDisplayTarget[] = [];
		for (const entry of entries) {
			const pathSpecs = entry.displayPaths ?? splitReadDisplayPathSpecs(entry.path);
			const useEntryLinkPath = pathSpecs.length === 1;
			for (const pathSpec of pathSpecs) {
				const split = splitPathAndSel(pathSpec);
				const linkPath = readTargetLinkPath(split.path, useEntryLinkPath ? entry.linkPath : undefined);
				for (const selector of splitSelectorDisplayParts(split.sel)) {
					targets.push({
						entry,
						targetPath: selector ? `${split.path}:${selector}` : pathSpec,
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
					`${prefix}${formatUsageRow(usageRow.usage, usageRow.durationMs, usageRow.ttftMs, usageRow.timestamp)}`,
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
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
		this.addChild(component);
	}

	#addPreviewUsage(entry: ReadEntry): void {
		const usageRow = this.#usageRows.get(entry.toolCallId);
		if (!usageRow) return;
		this.addChild(
			new Text(
				theme.fg("dim", formatUsageRow(usageRow.usage, usageRow.durationMs, usageRow.ttftMs, usageRow.timestamp)),
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
