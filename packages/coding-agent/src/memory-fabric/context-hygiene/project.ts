/**
 * Adaptive Context Hygiene — Graphify code projection (ACF CH4).
 *
 * Realizes the "code-context-projection" concept from the plan (§6) as the
 * pipeline's F2 `projectItem` seam (plan §5 gate step "project evidence & code
 * compactly"). F2 items — Graphify code, Memvid evidence, large logs/diffs —
 * are rendered as a COMPACT set of signatures plus a RETAINED POINTER to the
 * full evidence, so the packet carries the structure the model needs to reason
 * while the bulk stays one expand-on-demand hop away (plan §3, F2 row).
 *
 * Safety posture (plan §3/§4, rule #10 "no new parser — reuse Graphify"):
 *   - NO NEW PARSER. This module never reads or tokenizes source itself. The
 *     signatures come exclusively from an injectable {@link GraphifyProjectionPort}
 *     backed by Graphify's already-computed graph. With no port (the default) or
 *     no signatures for an item, projection is a pass-through identity.
 *   - Only F2 is ever projected. F0/F1 (preserved) and no-compression items are
 *     returned untouched — a projection can never downgrade authoritative truth.
 *   - Never-worse (rule #5): if the projected view is not strictly smaller than
 *     the original, the original is kept. Projection can never enlarge a packet.
 *   - A pointer to the full evidence is always retained (rule #1 provenance);
 *     the projection is reversible via that pointer (CH5 hot-cold expansion).
 *   - Fail-open (rule #4): any error — including a throwing port — returns the
 *     original item unchanged, flagged `failedOpen` in the batch report.
 *   - Non-mutating: inputs are cloned; the caller's items are never touched.
 *
 * Additive, injectable, disabled by default. NOT wired as the pipeline's default
 * `projectItem` (that stays identity); a caller opts in via
 * `runContextHygieneGate(items, needs, { projectItem: makeGraphifyProjector({ port }) })`.
 */

import { countTokens, heuristicTokenCounter, type TokenCounter } from "../token-accounting/token-accounting";
import type { ClassifiedContextItem, TransformKind } from "./types";

export const PROJECTOR_NAME = "acf-graphify-projector";
export const PROJECTOR_VERSION = "ch4-1";

/** Transforms that permit a compact projection (must be F2-allowed). */
const PROJECTABLE_TRANSFORMS: ReadonlySet<TransformKind> = new Set<TransformKind>([
	"project",
	"reference",
	"excerpt",
	"expand-on-demand",
]);

/**
 * A single Graphify-derived signature. Mirrors the host GraphNode shape
 * (adapters/graphify.ts) so the real adapter can feed it with no glue.
 */
export interface GraphifySymbol {
	/** Signature text as Graphify recorded it (e.g. `runContextHygieneGate(items, opts)`). */
	label: string;
	/** Structural kind from the code graph. */
	kind?: "class" | "function" | "interface" | "type" | "module" | "file" | "symbol";
	/** Source file the symbol lives in (for the pointer/audit). */
	file?: string;
	/** 1-based line, when known. */
	line?: number;
}

/**
 * Minimal SYNCHRONOUS structural contract CH4 needs from Graphify. Deliberately
 * a strict subset of the host graph surface: "given this F2 item, hand me the
 * signatures Graphify already computed for it, or null if it has none." Returning
 * null (the default) means "no graph data" → the item is passed through as-is.
 * This is the whole "no new parser" guarantee: signatures come only from here.
 */
export interface GraphifyProjectionPort {
	getSignatures(item: ClassifiedContextItem): GraphifySymbol[] | null;
}

/** Default port: knows nothing, projects nothing (identity pass-through). */
export const nullGraphifyPort: GraphifyProjectionPort = {
	getSignatures: () => null,
};

export interface ProjectionOptions {
	/** Graphify signature source. Default: {@link nullGraphifyPort} (identity). */
	port?: GraphifyProjectionPort;
	/** Cap the number of signatures rendered. Default 40. */
	maxSignatures?: number;
	/** Build the retained full-evidence pointer for an item. Default derives it. */
	pointerFor?: (item: ClassifiedContextItem) => string;
	/** Token counter for the never-worse size check (default heuristic; CH0). */
	counter?: TokenCounter;
	/** Injectable clock for deterministic telemetry timestamps. */
	now?: () => Date;
}

/** Metadata describing a successful projection (retained on the item). */
export interface ProjectionInfo {
	projector: string;
	projectorVersion: string;
	projectedAt: string;
	/** Pointer to the full evidence — the expand-on-demand handle (CH5). */
	pointer: string;
	/** Total signatures Graphify supplied. */
	symbolCount: number;
	/** How many were rendered (<= symbolCount when capped). */
	renderedCount: number;
	originalTokens: number;
	projectedTokens: number;
	/** originalTokens - projectedTokens (always > 0 when projected). */
	savedTokens: number;
}

/** An F2 item rendered to its compact projected form. */
export interface ProjectedContextItem extends ClassifiedContextItem {
	/** True when this item's content is the compact projection. */
	projected: boolean;
	/** Present only when `projected` is true. */
	projection?: ProjectionInfo;
}

export interface ProjectionReport {
	projector: string;
	projectorVersion: string;
	items: ClassifiedContextItem[];
	/** How many items were actually projected. */
	projectedCount: number;
	/** Per-item skip reasons (id → why it was not projected). */
	skipped: Array<{ id: string; reason: string }>;
	tokensBefore: number;
	tokensAfter: number;
	/** tokensBefore - tokensAfter (>= 0). */
	saved: number;
	failedOpen: boolean;
	generatedAt: string;
}

const KIND_TAG: Record<NonNullable<GraphifySymbol["kind"]>, string> = {
	class: "class",
	function: "fn",
	interface: "interface",
	type: "type",
	module: "module",
	file: "file",
	symbol: "sym",
};

function tokensOf(text: string, counter: TokenCounter): number {
	return countTokens(text, counter).tokens;
}

/** Default pointer: stable, human-readable, resolvable back to the evidence. */
function defaultPointer(item: ClassifiedContextItem): string {
	const src = item.provenance?.source ?? item.source;
	return src ? `graphify://${src}#${item.id}` : `graphify://item/${item.id}`;
}

function renderProjection(symbols: GraphifySymbol[], pointer: string, maxSignatures: number): string {
	const total = symbols.length;
	const shown = symbols.slice(0, Math.max(0, maxSignatures));
	const header = `⟪F2 projected via Graphify · ${shown.length}/${total} symbols · full evidence → ${pointer}⟫`;
	const lines = shown.map(s => {
		const tag = s.kind ? (KIND_TAG[s.kind] ?? "sym") : "sym";
		const at = typeof s.line === "number" ? ` :${s.line}` : "";
		return `${tag} ${s.label}${at}`;
	});
	const footer =
		total > shown.length
			? `… (+${total - shown.length} more symbols) — expand-on-demand → ${pointer}`
			: `↳ expand-on-demand → ${pointer}`;
	return [header, ...lines, footer].join("\n");
}

/**
 * Project one classified item. Only F2 items with Graphify signatures are ever
 * projected; everything else is returned as an untouched clone. Pure,
 * deterministic, non-mutating, never-worse, fail-open.
 *
 * @returns the projected item, or a clone of the original when not projected,
 *          plus a machine-readable skip reason.
 */
export function projectItem(
	item: ClassifiedContextItem,
	options: ProjectionOptions = {},
): { item: ProjectedContextItem; skipped?: string } {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const clone = (): ProjectedContextItem => ({ ...item, projected: false });

	try {
		// Only F2 is projectable (plan §3). Guard even though the pipeline pre-filters.
		if (item.fidelity !== "F2") return { item: clone(), skipped: "not-F2" };
		// Never touch protected or no-compression content.
		if (item.preserved || item.noCompression) return { item: clone(), skipped: "protected" };
		// The class must actually permit a projection transform.
		if (!item.allowedTransforms.some(t => PROJECTABLE_TRANSFORMS.has(t))) {
			return { item: clone(), skipped: "no-project-transform" };
		}

		// Signatures come ONLY from Graphify (rule #10: no new parser).
		const port = options.port ?? nullGraphifyPort;
		const symbols = port.getSignatures(item);
		if (!symbols || symbols.length === 0) return { item: clone(), skipped: "no-graph-signatures" };

		const maxSignatures = options.maxSignatures ?? 40;
		const pointer = (options.pointerFor ?? defaultPointer)(item);
		const projectedContent = renderProjection(symbols, pointer, maxSignatures);

		const originalTokens = tokensOf(item.content, counter);
		const projectedTokens = tokensOf(projectedContent, counter);
		// Never-worse (rule #5): keep the original if projection didn't shrink it.
		if (projectedTokens >= originalTokens) return { item: clone(), skipped: "never-worse" };

		const projectedAt = now().toISOString();
		const renderedCount = Math.min(symbols.length, Math.max(0, maxSignatures));
		const projection: ProjectionInfo = {
			projector: PROJECTOR_NAME,
			projectorVersion: PROJECTOR_VERSION,
			projectedAt,
			pointer,
			symbolCount: symbols.length,
			renderedCount,
			originalTokens,
			projectedTokens,
			savedTokens: originalTokens - projectedTokens,
		};

		return {
			item: {
				...item,
				content: projectedContent,
				projected: true,
				projection,
				provenance: {
					...item.provenance,
					projector: PROJECTOR_NAME,
					projectorVersion: PROJECTOR_VERSION,
					projectedAt,
					projectionPointer: pointer,
					projectionSymbolCount: symbols.length,
					projectionOriginalTokens: originalTokens,
				},
			},
		};
	} catch {
		// Fail open (rule #4): never alter content on error.
		return { item: clone(), skipped: "failed-open" };
	}
}

/**
 * Project a batch of classified items, preserving order. Returns a full report;
 * use {@link makeGraphifyProjector} for a drop-in pipeline `projectItem` seam.
 */
export function planProjection(items: ClassifiedContextItem[], options: ProjectionOptions = {}): ProjectionReport {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const generatedAt = now().toISOString();

	try {
		const out: ClassifiedContextItem[] = [];
		const skipped: Array<{ id: string; reason: string }> = [];
		let projectedCount = 0;
		let tokensBefore = 0;
		let tokensAfter = 0;

		for (const item of items) {
			tokensBefore += tokensOf(item.content, counter);
			const result = projectItem(item, options);
			out.push(result.item);
			tokensAfter += tokensOf(result.item.content, counter);
			if (result.item.projected) projectedCount++;
			else if (result.skipped) skipped.push({ id: item.id, reason: result.skipped });
		}

		return {
			projector: PROJECTOR_NAME,
			projectorVersion: PROJECTOR_VERSION,
			items: out,
			projectedCount,
			skipped,
			tokensBefore,
			tokensAfter,
			saved: tokensBefore - tokensAfter,
			failedOpen: false,
			generatedAt,
		};
	} catch {
		// Fail open: return the originals untouched.
		return {
			projector: PROJECTOR_NAME,
			projectorVersion: PROJECTOR_VERSION,
			items: items.map(i => ({ ...i })),
			projectedCount: 0,
			skipped: [],
			tokensBefore: 0,
			tokensAfter: 0,
			saved: 0,
			failedOpen: true,
			generatedAt,
		};
	}
}

/**
 * Build a drop-in `projectItem` hook for the Adaptive Context Hygiene Gate.
 * ProjectedContextItem extends ClassifiedContextItem, so the result is
 * assignable to the pipeline's `projectItem` seam with no widening.
 */
export function makeGraphifyProjector(
	options: ProjectionOptions = {},
): (item: ClassifiedContextItem) => ClassifiedContextItem {
	return item => projectItem(item, options).item;
}

// --- Graphify graph.json bridge -------------------------------------------

/** A node as it appears in Graphify's `graph.json` (tolerant/partial). */
export interface GraphifyGraphNode {
	id?: string;
	label?: string;
	kind?: string;
	file_type?: string;
	source_file?: string;
	file?: string;
	source_location?: { line?: number; column?: number };
	line?: number;
}

export interface GraphifyPortOptions {
	/** Resolve an item's source file. Default: provenance.source ?? item.source. */
	fileOf?: (item: ClassifiedContextItem) => string | undefined;
	/** Cap symbols indexed per file. Default 200. */
	maxPerFile?: number;
}

/** Map a raw graph kind/label to a {@link GraphifySymbol} kind (like the adapter). */
function inferKind(label: string, kind?: string, fileType?: string): GraphifySymbol["kind"] {
	const k = (kind ?? "").toLowerCase();
	if (k === "class" || k === "function" || k === "interface" || k === "type" || k === "module" || k === "file") {
		return k as GraphifySymbol["kind"];
	}
	if (fileType === "test") return "function";
	if (label.includes("class ")) return "class";
	if (label.includes("interface ")) return "interface";
	if (label.includes("type ") || label.includes("Type")) return "type";
	if (label.includes("(") || label.includes("=>") || label.includes("function")) return "function";
	return "symbol";
}

function nodeFile(node: GraphifyGraphNode): string | undefined {
	return node.source_file ?? node.file ?? undefined;
}

/**
 * Build a {@link GraphifyProjectionPort} directly from Graphify's `graph.json`
 * node array (reuse, not reparse — rule #10). Indexes symbols by source file and
 * resolves each item's file to its signatures. Returns null for unknown files.
 */
export function graphifyPortFromGraphNodes(
	nodes: GraphifyGraphNode[],
	options: GraphifyPortOptions = {},
): GraphifyProjectionPort {
	const maxPerFile = options.maxPerFile ?? 200;
	const fileOf = options.fileOf ?? ((item: ClassifiedContextItem) => item.provenance?.source ?? item.source);

	const byFile = new Map<string, GraphifySymbol[]>();
	for (const node of nodes) {
		const file = nodeFile(node);
		const label = node.label;
		if (!file || !label) continue;
		const bucket = byFile.get(file) ?? [];
		if (bucket.length >= maxPerFile) continue;
		bucket.push({
			label,
			kind: inferKind(label, node.kind, node.file_type),
			file,
			line: node.source_location?.line ?? node.line,
		});
		byFile.set(file, bucket);
	}

	const resolve = (target: string): GraphifySymbol[] | null => {
		const exact = byFile.get(target);
		if (exact) return exact;
		// Tolerant suffix match (paths may be relative on one side).
		for (const [file, syms] of byFile) {
			if (file.endsWith(target) || target.endsWith(file)) return syms;
		}
		return null;
	};

	return {
		getSignatures(item: ClassifiedContextItem): GraphifySymbol[] | null {
			const file = fileOf(item);
			if (!file) return null;
			return resolve(file);
		},
	};
}
