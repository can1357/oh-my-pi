/** Bounded inline Mermaid previews with the existing Markdown/ASCII fallback. */
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import * as pele from "pele";
import { fencedCode, type Markdown } from "../components/markdown";
import type { Component } from "../tui";
import { SvgFigure, type SvgFigureOptions } from "./svg-figure";
import { mermaidFigurePalette } from "./mermaid-theme";
import mermaidStyles from "./mermaid.css" with { type: "text" };
import { fencedSourceContent } from "./svg-source";

export interface MermaidDiagram {
	readonly id: string;
	readonly source: string;
	/** Full natural drawing, with theme tokens still unresolved; never a fitted preview or PNG. */
	readonly svg: string;
	readonly width: number;
	readonly height: number;
}

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_EDGES = 512;
const MAX_NATURAL_EDGE = 1_000_000;
const CACHE_ENTRIES = 64;
const CACHE_BYTES = 4 * 1024 * 1024;

interface CachedDiagram {
	readonly sourceLength: number;
	readonly diagram: MermaidDiagram | null;
}

// Successful and failed source resolutions share one byte-bounded store.
const diagrams = new LRUCache<string, CachedDiagram>({
	max: CACHE_ENTRIES,
	maxSize: CACHE_BYTES,
	sizeCalculation: (entry, id) => 256 + 2 * (id.length + entry.sourceLength + (entry.diagram?.svg.length ?? 0)),
});

/** Pele's public colors expressed through the same late-bound tokens as authored SVG figures. */
const THEME_TOKENS: Readonly<Record<string, string>> = {
	"pele-fg": "fg",
	"pele-muted": "mermaid-muted",
	"pele-line": "mermaid-line",
	"pele-bg": "mermaid-background",
	"pele-surface": "mermaid-node",
	"pele-surface-alt": "mermaid-group",
	"pele-border": "mermaid-border",
	"pele-accent": "accent",
	"pele-critical": "error",
	"pele-error": "error",
	"pele-series-1": "c1",
	"pele-series-2": "c2",
	"pele-series-3": "c3",
	"pele-series-4": "c4",
	"pele-series-5": "c5",
	"pele-series-6": "c6",
	"pele-series-7": "c1",
	"pele-series-8": "c2",
};

/** The same simple CSS var grammar accepted by the figure raster preparation. */
const VARIABLE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
const STYLED_ATTRIBUTE = /\b(style|fill|stroke|color|font-family|font-size|font-weight|rx|ry)="([^"]*)"/g;

/**
 * resvg does not evaluate CSS variables or Pele's font shorthand. Expand only
 * generated SVG attributes, preserving literal label text and authored node styles.
 * Color values stay as OMP tokens, so theme changes need a raster, not another layout.
 */
function normalizeSvg(svg: string): string {
	const root = /^<svg\b[^>]*>/.exec(svg)?.[0];
	if (!root) throw new Error("Mermaid did not produce an SVG root");
	const rootStyle = /\bstyle="([^"]*)"/.exec(root)?.[1] ?? "";
	const aliases = new Map<string, string>();
	for (const declaration of rootStyle.split(";")) {
		const match = /^\s*--([\w-]+)\s*:(.*)$/.exec(declaration);
		if (match) aliases.set(match[1]!, match[2]!.trim());
	}
	const resolve = (value: string, seen: ReadonlySet<string>): string =>
		value.replace(VARIABLE, (reference, name: string, fallback: string | undefined) => {
			const token = THEME_TOKENS[name];
			if (token) return `var(--${token})`;
			const alias = aliases.get(name);
			if (alias !== undefined && !seen.has(name)) return resolve(alias, new Set([...seen, name]));
			// Radius, font and weight tokens retain Pele's measured defaults rather
			// than becoming a foreground color in the generic SVG var resolver.
			if (name.startsWith("pele-")) return fallback?.trim() || "var(--fg)";
			return reference;
		});
	const normalized = svg.replace(STYLED_ATTRIBUTE, (_attribute, name: string, value: string) => {
		const resolved = resolve(value, new Set());
		if (name !== "style") return `${name}="${resolved}"`;
		return `style="${resolved
			.replace(/(?:^|;)\s*--[\w-]+\s*:[^;]*(?=;|$)/g, "")
			.replace(/\bfont\s*:\s*([\d.]+)px\s+sans-serif\s*(?=;|$)/g, "font-size:$1px;font-family:sans-serif")}"`;
	});
	const fontSize = /(?:^|;)font:([\d.]+)px sans-serif(?:;|$)/.exec(rootStyle)?.[1];
	const themed = fontSize ? normalized.replace(/^<svg\b/, `<svg font-size="${fontSize}"`) : normalized;
	return themed.replace(/^<svg\b[^>]*>/, root => `${root}<style>${mermaidStyles}</style>`);
}

/**
 * Count parsed relationships, not arrow-looking source text. Pele 1.9's maxEdges
 * protects flowchart expansion, but most other parsers do not enforce it.
 * Keep this exhaustive over its public model union so new families need review.
 */
function relationshipCount(model: pele.DiagramModel): number {
	switch (model.type) {
		case "flowchart": // Swimlane also parses to FlowchartModel.
		case "agentflow":
		case "architecture":
		case "block":
			return model.edges.length;
		case "class": {
			let count = model.relations.length;
			// Lollipop interfaces are already relations; attached notes add routes.
			for (const note of model.notes.values()) {
				if (note.class !== undefined && model.classes.has(note.class) && ++count > MAX_EDGES) break;
			}
			return count;
		}
		case "er":
			return model.relationships.length;
		case "usecase":
			return model.relationships.length + model.notes.size;
		case "requirement":
		case "eventmodeling":
			return model.relations.length;
		case "c4":
			return model.rels.length;
		case "sankey":
		case "wardley":
			return model.links.length;
		case "cynefin":
			return model.transitions.length;
		case "state": {
			let count = 0;
			// StateModel.relations contains only root-level transitions. Its authored
			// statement tree also contains transitions inside composite states.
			const pending = [model.rootDoc];
			for (let statements = pending.pop(); statements !== undefined; statements = pending.pop()) {
				for (const statement of statements) {
					if (typeof statement === "string") continue;
					if (statement.stmt === "relation") {
						count +=
							1 + Number(statement.state1.note !== undefined) + Number(statement.state2.note !== undefined);
					} else if (statement.stmt === "state") {
						count += Number(statement.note !== undefined);
						if (statement.doc) pending.push(statement.doc);
					}
					if (count > MAX_EDGES) return count;
				}
			}
			return count;
		}
		case "sequence": {
			let count = 0;
			for (const message of model.messages) {
				// LINETYPE.NOTE (2) shares the message list and actor endpoints, but
				// notes, activation and control frames are not signal relationships.
				if (message.type !== 2 && message.from !== undefined && message.to !== undefined && ++count > MAX_EDGES) {
					break;
				}
			}
			return count;
		}
		case "gitGraph": {
			let count = 0;
			for (const commit of model.commits.values()) {
				count += commit.parents.length;
				if (count > MAX_EDGES) break;
			}
			return count;
		}
		case "journey":
			return Math.max(0, model.tasks.length - 1);
		case "timeline": {
			let count = 0;
			for (const period of model.periods) {
				count += period.events.length;
				if (count > MAX_EDGES) break;
			}
			return count;
		}
		case "mindmap":
			// The public node list is flat and includes its one connected root.
			return Math.max(0, model.nodes.length - 1);
		case "treeView":
			// count includes an invisible root; its top-level children have no guides.
			return model.count - 1 - model.root.children.length;
		case "ishikawa": {
			let count = 0;
			const pending = model.root ? [model.root] : [];
			for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
				count += node.children.length;
				if (count > MAX_EDGES) return count;
				for (const child of node.children) pending.push(child);
			}
			return count;
		}
		case "railroad":
			return railroadRelationshipCount(model);
		case "pie":
		case "gantt":
		case "xychart":
		case "quadrantChart":
		case "packet":
		case "kanban":
		case "radar":
		case "treemap":
		case "info":
		case "venn":
			// Chart samples, schedule dates, axes and containment are not graph
			// relationships. Their source/output bounds still apply.
			return 0;
		default:
			model satisfies never;
			throw new Error("Unknown Mermaid diagram model");
	}
}

/** Logical track connections, including branch/bypass/loop expansion, not label characters. */
function railroadRelationshipCount(model: pele.RailroadModel): number {
	let count = 0;
	const pending: pele.RailroadModel["rules"][number]["definition"][] = [];
	for (const rule of model.rules) {
		count += 2; // Each rule connects its start and end to the expression.
		if (count > MAX_EDGES) return count;
		pending.push(rule.definition);
	}
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		switch (node.type) {
			case "sequence":
				count += Math.max(0, node.elements.length - 1);
				if (count > MAX_EDGES) return count;
				for (const element of node.elements) pending.push(element);
				break;
			case "choice":
				count += 2 * node.alternatives.length; // Split and join each alternative.
				if (count > MAX_EDGES) return count;
				for (const alternative of node.alternatives) pending.push(alternative);
				break;
			case "optional":
				count += 3; // Entry, exit and bypass.
				pending.push(node.element);
				break;
			case "repetition":
				if (node.min !== 1 || node.max !== 1) count += node.min === 0 ? 4 : 1;
				pending.push(node.element);
				break;
			case "terminal":
			case "nonterminal":
			case "special":
				break;
			default:
				node satisfies never;
		}
		if (count > MAX_EDGES) return count;
	}
	return count;
}

/**
 * Resolve once at natural size after checking source and relationship limits.
 * First layout is synchronous; ordinary paints and theme changes reuse it.
 */
export function resolveMermaidDiagram(source: string): MermaidDiagram | null {
	// Reject oversized input before hashing, retaining or asking Pele to parse it.
	if (source.length > MAX_SOURCE_BYTES || Buffer.byteLength(source) > MAX_SOURCE_BYTES) return null;
	const id = `mermaid:${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`;
	const cached = diagrams.get(id);
	if (cached !== undefined) return cached.diagram;
	let diagram: MermaidDiagram | null = null;
	try {
		const model = pele.parse(source, { limit: MAX_SOURCE_BYTES, maxEdges: MAX_EDGES });
		if (relationshipCount(model) > MAX_EDGES) throw new Error("Mermaid relationship limit exceeded");
		const rendered = pele.render(model, {
			fontSize: 14,
			fontFamily: "sans-serif",
			fontFamilyMono: "monospace",
			idPrefix: `omp-${id.slice("mermaid:".length)}`,
			responsive: false,
			autoDirection: false,
			links: false,
			images: false,
			limit: MAX_SOURCE_BYTES,
			outputLimit: MAX_SVG_BYTES,
			maxEdges: MAX_EDGES,
		});
		if (
			Number.isFinite(rendered.width) &&
			Number.isFinite(rendered.height) &&
			rendered.width > 0 &&
			rendered.height > 0 &&
			rendered.width <= MAX_NATURAL_EDGE &&
			rendered.height <= MAX_NATURAL_EDGE &&
			Buffer.byteLength(rendered.svg) <= MAX_SVG_BYTES
		) {
			const svg = normalizeSvg(rendered.svg);
			if (Buffer.byteLength(svg) <= MAX_SVG_BYTES) {
				diagram = Object.freeze({ id, source, svg, width: rendered.width, height: rendered.height });
			}
		}
	} catch {
		// Unsupported, invalid or over-limit source remains original Mermaid Markdown.
		// Do not surface parser messages: they may embed arbitrary authored source.
	}
	diagrams.set(id, { sourceLength: source.length, diagram });
	return diagram;
}

type MermaidFigureOptions = Pick<SvgFigureOptions, "markdown" | "budget" | "onChange">;

/** A completed Mermaid fence with a bounded, themed image and its original ASCII fallback. */
export class MermaidFigure implements Component {
	readonly #options: MermaidFigureOptions;
	#source = "";
	#closed = false;
	#resolvedSource: string | undefined;
	#svg: SvgFigure | undefined;
	#fallback: Markdown | undefined;
	#queued = false;
	#disposed = false;

	constructor(options: MermaidFigureOptions) {
		this.#options = options;
	}

	update(source: string, closed: boolean): void {
		if (this.#disposed || (source === this.#source && closed === this.#closed)) return;
		this.#svg?.dispose(true);
		this.#svg = undefined;
		this.#resolvedSource = undefined;
		this.#fallback = undefined;
		this.#source = source;
		this.#closed = closed;
		if (!closed || this.#queued) return;
		this.#queued = true;
		queueMicrotask(() => {
			this.#queued = false;
			if (this.#disposed || !this.#closed) return;
			const diagram = resolveMermaidDiagram(fencedSourceContent(this.#source, 0, this.#source.length));
			this.#resolvedSource = this.#source;
			if (diagram) {
				this.#svg = new SvgFigure({
					...this.#options,
					palette: mermaidFigurePalette,
					label: "Mermaid",
					fallback: width => this.#fallbackRows(width),
				});
				this.#svg.update(diagram.svg, true);
			}
			this.#options.onChange();
		});
	}

	get pending(): boolean {
		return !this.#disposed && this.#closed && (this.#resolvedSource !== this.#source || this.#svg?.pending === true);
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		return this.#svg?.render(width) ?? this.#fallbackRows(width);
	}

	#fallbackRows(width: number): readonly string[] {
		if (!this.#options.markdown) return [];
		this.#fallback ??= this.#options.markdown(fencedCode("mermaid", this.#source));
		return this.#fallback.render(width);
	}

	invalidate(): void {
		this.#svg?.invalidate();
		this.#fallback = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#svg?.dispose();
		this.#svg = undefined;
		this.#fallback = undefined;
		this.#source = "";
		this.#resolvedSource = undefined;
	}
}
