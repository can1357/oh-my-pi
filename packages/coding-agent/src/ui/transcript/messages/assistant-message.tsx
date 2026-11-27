/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The assistant's turn: a `col` (role `omp.assistant`) of the reply's blocks
 * in order, keyed by content index so streamed deltas reach a native terminal
 * as appends to the same node.
 *
 * - Text is `md`; the block being written carries `stream: true` until the
 *   reply settles. Relative links are handed to native terminals resolved
 *   (once the block closes).
 * - Thinking is a quiet collapsible `section`: "Thinking…" with a starburst,
 *   a ticking timer and tok/s while it streams, then "Thought for 12s"
 *   (folded unless thinking stays expanded). Hidden thinking shows only the
 *   live head.
 * - Images, then tool-result images, then the turn-ending error (an error
 *   card with the status chip and Retry / Copy error / Switch model, the
 *   abort label, or the recovered-retry note).
 * - Markers (served model, cache miss), the `↺ rewound` tag and the turn's
 *   usage line close the turn.
 * - A reply that opens with an emoji reacts on the prompt before it: the
 *   emoji leaves the prose (`onReaction`).
 *
 * Terminal look: `omp.assistant` (`src/ui/styles/messages/assistant.ts`).
 */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
import {
	computed,
	effect,
	For,
	type JSXNode,
	nativeRendering,
	nativeSupports,
	onCleanup,
	type Reactive,
	read,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { markCodeCopied } from "@oh-my-pi/pi-tui/term/painters/md";
import {
	CODE_COPY_ACT_PREFIX,
	extractFencedCodeBlocks,
	holdPartialTableRow,
	speculativeStreamingSource,
} from "@oh-my-pi/pi-tui/text/markdown/index";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { TurnUsageSummary } from "../../../modes/view-model/overlays/usage-row";
import type { CacheInvalidation } from "../../../session/transcript/cache-invalidation-marker";
import { chartFence, hasChartTable, lookupTableChart, splitTableCharts } from "../../../session/transcript/table-chart";
import { splitReaction } from "../../../session/transcript/reaction";
import type { ServedModelMismatch } from "../../../session/transcript/served-model-marker";
import {
	canonicalizeMessage,
	formatThinkingForDisplay,
	hasDisplayableThinking,
} from "../../../session/transcript/thinking-display";
import { resolveAssistantErrorPresentation } from "../../../session/transcript/transcript-render-helpers";
import type { AssistantTextRenderer, AssistantThinkingRenderer } from "../../../extensibility/extensions/render-types";
import { extensionTheme, renderExtension } from "../../extensions/render-output";
import { type EmbedHost, EmbedFigure, parseEmbed } from "../figures/embed";
import { figureSegments, mightHaveFigures, SvgFence } from "../figures/figure-markdown";
import type { FigureCell } from "../figures/svg";
import "../../styles/figures/figure";
import { settledRevision } from "../../shell/transcript";
import { ImageNode, InlineMedia } from "./image";
import { rewriteLinkDestinations } from "./links";
import { CacheMissMarker, ServedModelMarker } from "./markers";
import { turnHoldEntries } from "./turn-actions";

/** Wrapped rows an error keeps while collapsed. */
export const ERROR_PREVIEW_ROWS = 8;

/** Media from one grouped read, whether it returned image bytes, a file path, or both. */
export interface ToolResultMedia {
	readonly images: readonly ImageContent[];
	readonly mediaPath?: string;
}

/** What an assistant block shows. Every field may be a signal the host moves. */
export interface AssistantMessageModel {
	/** The reply as last updated (undefined while nothing arrived). */
	readonly message: Reactive<AssistantMessage | undefined>;
	/** The last update was a streaming delta (the reply is still being written). */
	readonly transient?: Reactive<boolean>;
	/** The block is settled: nothing streams any more. */
	readonly finalized?: Reactive<boolean>;
	/** Thinking hidden (Ctrl+T): only the live head shows. */
	readonly hideThinking?: Reactive<boolean>;
	/** Keep finished thinking expanded. */
	readonly expandThinking?: Reactive<boolean>;
	/** Elide fenced code in thinking. */
	readonly proseOnlyThinking?: boolean;
	/** Assistant and tool-result images (default true). */
	readonly showImages?: Reactive<boolean>;
	/** Lift accepted SVG code fences out of assistant Markdown. */
	readonly renderSvg?: Reactive<boolean>;
	/** Lift standalone HTML image and page embeds out of assistant Markdown. */
	readonly renderEmbeds?: Reactive<boolean>;
	/** Embed paths and the terminal's iframe capture, supplied by the interactive session. */
	readonly embedHost?: EmbedHost;
	/** Terminal cell when it draws pictures; undefined from the accessor means a text-only terminal. */
	readonly figureCell?: Reactive<FigureCell | undefined>;
	/** Rows a figure may take (a share of the terminal's); undefined: as tall as it draws. */
	readonly figureRows?: Reactive<number | undefined>;
	/** Tool-result images (default true). */
	readonly showToolResultImages?: Reactive<boolean>;
	/** Tables get charts (default false; a focused subagent's do not): Tern is sent each chart after its table. */
	readonly tableCharts?: Reactive<boolean>;
	/** Media grouped reads produced, by tool call id. */
	readonly toolResultMedia?: Reactive<ReadonlyMap<string, ToolResultMedia>>;
	/** Session-resolved destinations of relative prose links. */
	readonly linkTargets?: Reactive<ReadonlyMap<string, string>>;
	/** Tone of the reply's prose (`/live`'s spoken reply reads in the accent); undefined keeps the theme's text. */
	readonly tone?: Reactive<TspTone | undefined>;
	/** Show the whole turn-ending error. */
	readonly errorExpanded?: Reactive<boolean>;
	/** The same error is pinned above the composer (the terminal then keeps only the expanded inline copy). */
	readonly errorPinned?: Reactive<boolean>;
	readonly cacheInvalidation?: Reactive<CacheInvalidation | undefined>;
	readonly servedModelMismatch?: Reactive<ServedModelMismatch | undefined>;
	readonly turnUsage?: Reactive<TurnUsageSummary | undefined>;
	/** A TTSR rule rewound this partial answer. */
	readonly rewound?: Reactive<boolean>;
	/** Whether a host handles transcript actions (controls are only shown when one does). */
	readonly actions?: Reactive<boolean>;
	/** Live thinking speed (tok/s); shown from 0.05 up. */
	readonly thinkingRate?: Reactive<number>;
	/** Clock for thinking durations (ms; default `performance.now`). */
	readonly now?: () => number;
	/** The emoji the reply opens with (undefined when it opens with none). */
	readonly onReaction?: (emoji: string | undefined) => void;
	/** The reply's opening emoji is a reaction (default true); false keeps it in the prose (a later reply, nothing to react on). */
	readonly reacts?: boolean;
	/** `retry`, `copy-error`, `switch-model`, `copy-answer` and turn hold-menu actions. */
	readonly onAction?: (act: string, copyText?: string) => void;
	/** Extension text renderers: display-only transforms of each text block's Markdown, in order. */
	readonly textRenderers?: Reactive<readonly AssistantTextRenderer[]>;
	/** Extension thinking renderers: drawn under each shown thinking block, in order. */
	readonly thinkingRenderers?: Reactive<readonly AssistantThinkingRenderer[]>;
	/** Index in the full reply of this segment's first block (a segment drawn after a tool call). */
	readonly contentOffset?: number;
}

/** Renderers that threw once: reported once, then their input is drawn. */
const failedTextRenderers = new WeakSet<AssistantTextRenderer>();

/**
 * `text` through the extension text renderers (`message` is a deep copy: renderers are
 * display-only); a renderer that throws or returns nothing leaves its input.
 */
/** Text part `contentIndex` of `message` as the extensions' text renderers draw it (in order). */
export function renderAssistantText(
	renderers: readonly AssistantTextRenderer[],
	message: AssistantMessage,
	contentIndex: number,
	text: string,
	streaming: boolean,
): string {
	let out = text;
	for (const renderer of renderers) {
		try {
			const rendered = renderer({ message, contentIndex, text: out, streaming });
			if (typeof rendered === "string") out = rendered;
		} catch (error) {
			if (failedTextRenderers.has(renderer)) continue;
			failedTextRenderers.add(renderer);
			logger.warn("Assistant text renderer failed; drawing its input", { error: String(error) });
		}
	}
	return out;
}

/** One rendered part of the reply, by slot (its node key). */
type Part =
	| {
			kind: "text";
			source: string;
			native: string;
			stream: boolean;
			deferFigures?: boolean;
			links?: ReadonlyMap<string, string>;
	  }
	| { kind: "svg"; source: string }
	| { kind: "embed"; html: string }
	| {
			kind: "thinking";
			index: number;
			text: string;
			live: boolean;
			stream: boolean;
			collapsed: boolean;
			tokens: number;
			/** When the thought was first seen streaming and when it stopped (clock ms). */
			start?: number;
			end?: number;
			hidden: boolean;
			spaceAfter: boolean;
	  }
	| {
			kind: "thinkingExtension";
			/** The thinking block's index in the full reply, and among the reply's thinking blocks. */
			contentIndex: number;
			thinkingIndex: number;
			text: string;
	  }
	| { kind: "image"; image: ImageContent; tool: boolean; path?: string }
	| { kind: "media"; path: string }
	| { kind: "error"; error: ErrorPart };

/** The turn-ending error part. */
type ErrorPart =
	| { kind: "abort"; text: string }
	| {
			kind: "failed";
			code?: string;
			text: string;
			preview: string;
			actions: boolean;
			termHidden: boolean;
			/** Rows the message keeps while collapsed. */
			lines?: number;
	  }
	| { kind: "recovered"; attempt: number; body: string; note: string };

interface ThinkingClock {
	start: number;
	end?: number;
	tokens: number;
}

type ThinkingPart = Extract<Part, { kind: "thinking" }>;

function hasVisibleText(content: AssistantMessage["content"][number]): boolean {
	return content.type === "text" && canonicalizeMessage(content.text) !== "";
}

/** Index of the thinking block being produced right now, if the tail of an unsettled reply is thinking. */
export function thinkingTail(message: AssistantMessage): number | undefined {
	let tail: "text" | "thinking" | undefined;
	let index = -1;
	for (let i = 0; i < message.content.length; i++) {
		const content = message.content[i]!;
		if (content.type === "toolCall") return undefined;
		if (hasVisibleText(content)) {
			tail = "text";
			index = i;
		} else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) {
			tail = "thinking";
			index = i;
		}
	}
	return tail === "thinking" ? index : undefined;
}

/** `500 upstream overloaded` → chip `500`; a line the next one repeats with more detail is dropped. */
function errorParts(text: string): { code?: string; detail: string } {
	const lines = text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	const code = /^(\d{3})\s+/.exec(lines[0] ?? "");
	if (code) lines[0] = lines[0]!.slice(code[0].length);
	const detail = lines.filter((line, index) => !lines.slice(index + 1).some(next => next.startsWith(line)));
	return { code: code?.[1], detail: detail.join("\n") || "Unknown error" };
}

/** `12.4s · 20K tok this turn` and its exact title. */
export function formatTurnUsage(summary: TurnUsageSummary): {
	text: string;
	title: string;
} {
	const tokens = summary.input + summary.output;
	const cost = summary.cost > 0 ? (summary.cost < 0.005 ? "<$0.01" : `$${summary.cost.toFixed(2)}`) : undefined;
	const seconds = summary.elapsedMs === undefined ? undefined : formatDuration(summary.elapsedMs);
	const text = [seconds, `${formatNumber(tokens)} tok`, cost].filter(part => part !== undefined).join(" · ");
	const exact = `${tokens.toLocaleString("en-US")} tokens (${summary.input.toLocaleString("en-US")} in · ${summary.output.toLocaleString("en-US")} out)`;
	const title = [seconds, exact, cost].filter(part => part !== undefined).join(" · ");
	return { text: `${text} this turn`, title: `This turn: ${title}` };
}

/** "Thought for 12s" once a thought was seen streaming, else "Thought". */
function thoughtLabel(part: ThinkingPart | undefined): string {
	if (part?.end === undefined || part.start === undefined) return "Thought";
	const ms = part.end - part.start;
	return `Thought for ${ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : formatDuration(ms)}`;
}

/** An assistant reply. */
export function AssistantMessageBlock(props: { model: AssistantMessageModel }): JSXNode {
	const { model } = props;
	const now = model.now ?? (() => performance.now());
	const clocks = new Map<number, ThinkingClock>();
	/** Thinking sections a native terminal folded or opened, by content index. */
	const toggled = signal<ReadonlyMap<number, boolean>>(new Map());
	const flag = (value: Reactive<boolean> | undefined, fallback: boolean): boolean =>
		value === undefined ? fallback : read(value);

	/** The reply as written (narration shown as answer) and as displayed (reaction lifted). */
	const reply = computed(() => {
		const raw = read(model.message);
		if (!raw) return undefined;
		const answer = presentNarrationAsAnswer(raw);
		const transient = flag(model.transient, false);
		let reaction: string | undefined;
		let reacted = false;
		const reacts = model.reacts !== false;
		const content = answer.content.map(block => {
			if (!reacts || reacted || block.type !== "text") return block;
			reacted = true;
			const split = splitReaction(block.text);
			if (split.emoji) {
				reaction = split.emoji;
				return { ...block, text: split.body };
			}
			// While the opening run could still become an emoji, it is withheld.
			return split.pending && transient ? { ...block, text: "" } : block;
		});
		return { raw, answer, displayed: { ...answer, content }, reaction };
	});
	if (model.onReaction) {
		const onReaction = model.onReaction;
		effect(() => {
			const emoji = reply()?.reaction;
			untrack(() => onReaction(emoji));
		});
	}

	/** Bumped when a model's pick of a table's chart lands: the parts are built again with it. */
	const chartPicks = signal(0);
	const waiting = new Set<Promise<void>>();
	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});
	const awaitChart = (pick: Promise<void>): void => {
		if (waiting.has(pick)) return;
		waiting.add(pick);
		void pick.then(() => {
			waiting.delete(pick);
			if (mounted) chartPicks.set(chartPicks.peek() + 1);
		});
	};

	const showFigureImages = computed(
		() =>
			flag(model.showImages, true) &&
			(nativeRendering() || model.figureCell === undefined || read(model.figureCell) !== undefined),
	);
	const parts = computed((): ReadonlyMap<string, Part> => {
		const out = new Map<string, Part>();
		chartPicks();
		const current = reply();
		if (!current) return out;
		const { answer, displayed } = current;
		const finalized = flag(model.finalized, false);
		const live = !finalized && flag(model.transient, false);
		const hide = flag(model.hideThinking, false);
		const expand = flag(model.expandThinking, false);
		const showImages = flag(model.showImages, true);
		const renderSvg = flag(model.renderSvg, false) && showFigureImages();
		const renderEmbeds = flag(model.renderEmbeds, false);
		const charts = showImages && flag(model.tableCharts, false) && nativeRendering();
		const tail = finalized ? undefined : thinkingTail(answer);
		const links = read(model.linkTargets);
		const proseOnly = model.proseOnlyThinking ?? true;
		let tailIndex = -1;
		for (let i = 0; i < answer.content.length; i++) {
			const content = answer.content[i]!;
			if (hasVisibleText(content) || (content.type === "thinking" && canonicalizeMessage(content.thinking))) {
				tailIndex = i;
			}
		}
		const visibleAfter = (from: number): boolean =>
			displayed.content
				.slice(from + 1)
				.some(
					c =>
						hasVisibleText(c) ||
						(c.type === "image" && !!c.data && !!c.mimeType) ||
						(c.type === "thinking" &&
							hasDisplayableThinking(c.thinking, formatThinkingForDisplay(c.thinking, proseOnly))),
				);
		const toggles = toggled();
		const tokens = answer.usage.reasoningTokens ?? answer.usage.output;
		const textRenderers = read(model.textRenderers) ?? [];
		const thinkingRenderers = read(model.thinkingRenderers) ?? [];
		const offset = model.contentOffset ?? 0;
		let view: AssistantMessage | undefined;
		let thinkingIndex = 0;
		for (let i = 0; i < displayed.content.length; i++) {
			const content = displayed.content[i]!;
			const streaming = live && i === tailIndex;
			if (content.type === "thinking") thinkingIndex++;
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				const rendered =
					textRenderers.length > 0
						? renderAssistantText(
								textRenderers,
								(view ??= structuredClone(current.raw)),
								offset + i,
								content.text,
								streaming,
							)
						: content.text;
				let count = 0;
				const slot = (): string => (count++ === 0 ? `t${i}` : `t${i}.${count - 1}`);
				const linked = (text: string): string =>
					links?.size ? rewriteLinkDestinations(text, href => links.get(href)) : text;
				const markdown = (text: string, stream: boolean, deferFigures = false): void => {
					const source = (stream ? holdPartialTableRow(text) : text).trim();
					if (!charts || !hasChartTable(source)) {
						out.set(slot(), {
							kind: "text",
							// Terminal streaming and link rewriting use the original Markdown.
							source: text.trim(),
							native: stream ? speculativeStreamingSource(source) : linked(source),
							stream,
							deferFigures,
							links,
						});
						return;
					}
					const segments = splitTableCharts(source, stream);
					for (const [at, segment] of segments.entries()) {
						if (segment.kind === "chart") {
							const key = slot();
							const chart = lookupTableChart(segment.table);
							if (chart instanceof Promise) awaitChart(chart);
							else if (chart)
								out.set(key, { kind: "text", source: "", native: chartFence(chart), stream: false });
						} else {
							const tail = stream && at === segments.length - 1;
							const prose = segment.text.trim();
							out.set(slot(), {
								kind: "text",
								source: prose,
								native: tail ? speculativeStreamingSource(prose) : linked(prose),
								stream: tail,
								links,
							});
						}
					}
				};
				const candidate = mightHaveFigures(rendered, renderSvg, renderEmbeds);
				if (!candidate || live) {
					markdown(rendered, streaming, candidate);
					continue;
				}
				const figures = figureSegments(rendered, { charts: false, showImages, renderSvg, renderEmbeds });
				if (figures.every(figure => figure.kind === "md")) {
					markdown(rendered, false);
					continue;
				}
				for (const figure of figures) {
					if (figure.kind === "md") markdown(figure.text, false);
					else if (figure.kind !== "chart") out.set(`${figure.kind}:${slot()}`, figure);
				}
			} else if (content.type === "thinking") {
				// A display message's thinking (`rawThinking` set) is already formatted: formatting it again
				// would strip its fences a second time.
				const raw = (content as { rawThinking?: string }).rawThinking;
				const text = raw !== undefined ? content.thinking : formatThinkingForDisplay(content.thinking, proseOnly);
				if (!hasDisplayableThinking(raw ?? content.thinking, text)) continue;
				const thinkingLive = streaming && tail === i;
				let clock = clocks.get(i);
				if (thinkingLive) {
					if (clock) clock.tokens = tokens || clock.tokens;
					else clocks.set(i, (clock = { start: untrack(now), tokens }));
				} else if (clock && clock.end === undefined) {
					clock.end = untrack(now);
				}
				if (hide && !thinkingLive) continue;
				out.set(`k${i}`, {
					kind: "thinking",
					index: i,
					text: text.trim(),
					live: thinkingLive,
					stream: streaming,
					collapsed: toggles.get(i) ?? (hide || (!thinkingLive && !expand)),
					tokens: thinkingLive ? tokens : (clock?.tokens ?? 0),
					start: clock?.start,
					end: clock?.end,
					hidden: hide,
					spaceAfter: visibleAfter(i),
				});
				if (!hide && thinkingRenderers.length > 0) {
					out.set(`x${i}`, {
						kind: "thinkingExtension",
						contentIndex: offset + i,
						thinkingIndex: thinkingIndex - 1,
						text: content.thinking,
					});
				}
			} else if (content.type === "image" && content.data && content.mimeType && showImages) {
				out.set(`i${i}`, { kind: "image", image: content, tool: false });
			}
		}
		const toolMedia = read(model.toolResultMedia);
		if (toolMedia?.size && showImages && flag(model.showToolResultImages, true)) {
			const showByPath = nativeSupports("media");
			const shown = showByPath ? new Set<string>() : undefined;
			if (shown) {
				for (const [id, { mediaPath }] of toolMedia) {
					if (!mediaPath || shown.has(mediaPath)) continue;
					shown.add(mediaPath);
					out.set(`r${id}`, { kind: "media", path: mediaPath });
				}
			}
			for (const [id, { images, mediaPath }] of toolMedia) {
				if (mediaPath && showByPath) continue;
				images.forEach((image, n) => {
					if (image.data && image.mimeType)
						out.set(`r${id}:${n}`, { kind: "image", image, tool: true, path: mediaPath });
				});
			}
		}
		const error = errorPart(displayed, model);
		if (error) out.set("error", { kind: "error", error });
		return out;
	});

	// Grouped reads may finish after the assistant's block has settled in the native host.
	const revise = settledRevision();
	effect(() => {
		if (read(model.toolResultMedia)?.size) untrack(revise);
	});

	const answered = (): boolean => reply()?.answer.content.some(hasVisibleText) ?? false;
	const rewound = (): boolean => flag(model.rewound, false);
	const actions = (): boolean => flag(model.actions, false);
	const usage = (): TurnUsageSummary | undefined => read(model.turnUsage);
	const slots = computed(() => [...parts().keys()], { equals: sameSlots });
	const thinkingDots = (): { tokens: number; rate: number } | undefined => {
		const current = reply();
		if (!current || !flag(model.hideThinking, false) || flag(model.finalized, false)) return undefined;
		if (!flag(model.transient, false) || thinkingTail(current.answer) === undefined) return undefined;
		return {
			tokens: current.answer.usage.reasoningTokens ?? current.answer.usage.output,
			rate: read(model.thinkingRate) ?? 0,
		};
	};

	return (
		<col
			role={() => (rewound() ? "omp.assistant.rewound" : "omp.assistant")}
			actions={() => {
				const at = reply()?.answer.timestamp;
				return usage() && answered() && at !== undefined && !rewound() && actions()
					? {
							hold: turnHoldEntries("assistant", {
								id: "copy-answer",
								label: "Copy reply",
								icon: "copy",
							}),
						}
					: undefined;
			}}
			term={() => ({ thinkingDots: thinkingDots() })}
			onAction={act => {
				if (act.startsWith(CODE_COPY_ACT_PREFIX)) {
					if (!model.onAction) return;
					const hash = act.slice(CODE_COPY_ACT_PREFIX.length);
					const sources: string[] = [];
					for (const part of parts().values()) {
						if (part.kind === "text") sources.push(part.source);
					}
					for (const block of reply()?.answer.content ?? []) {
						if (block.type === "text") sources.push(block.text);
					}
					for (const source of sources) {
						const match = extractFencedCodeBlocks(source, { includeQuotes: true }).find(
							candidate => candidate.hash === hash,
						);
						if (match) {
							model.onAction("copy-code", match.code);
							markCodeCopied(hash);
							return;
						}
					}
					return;
				}
				if (act === "copy-error") {
					const part = parts().get("error");
					if (part?.kind === "error" && part.error.kind === "failed") model.onAction?.(act, part.error.text);
				} else if (act === "copy-answer") {
					const blocks = reply()?.answer.content.flatMap(block =>
						block.type === "text" && hasVisibleText(block) ? [block.text.trim()] : [],
					);
					if (blocks?.length) model.onAction?.(act, blocks.join("\n\n"));
				} else model.onAction?.(act);
			}}
			onToggle={(collapsed, event) => {
				if (!event.key.startsWith("k")) return;
				const index = Number(event.key.slice(1));
				if (!Number.isInteger(index)) return;
				const next = new Map(toggled());
				next.set(index, collapsed);
				toggled.set(next);
			}}
		>
			<For each={slots}>
				{slot => (
					<ReplyPart
						slot={slot}
						part={() => parts().get(slot)}
						now={now}
						figureCell={model.figureCell}
						figureRows={model.figureRows}
						embedHost={model.embedHost}
						showFigureImages={showFigureImages}
						rate={() => read(model.thinkingRate) ?? 0}
						tone={() => read(model.tone)}
						thinkingRenderers={() => read(model.thinkingRenderers) ?? []}
						codeCopy={Boolean(model.onAction)}
					/>
				)}
			</For>
			{() => {
				const info = read(model.servedModelMismatch);
				return info && <ServedModelMarker info={info} />;
			}}
			{() => {
				const info = read(model.cacheInvalidation);
				return info && <CacheMissMarker info={info} />;
			}}
			{() => rewound() && <badge key="rewound" text="↺ rewound" tone="muted" role="omp.assistant.rewound-tag" />}
			{() => {
				const summary = usage();
				if (!summary) return undefined;
				const line = formatTurnUsage(summary);
				return (
					<row key="turn-usage" role="omp.turn.usage" gap="xs" align="center" title={line.title}>
						{answered() &&
							actions() && [
								<icon
									key="copy"
									name="copy"
									role="omp.turn.copy"
									title="Copy answer"
									aria="Copy answer"
									actions={{ click: "copy-answer" }}
								/>,
								<text key="dot" text="·" />,
							]}
						<text key="text" text={line.text} />
					</row>
				);
			}}
		</col>
	);
}

function sameSlots(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((slot, i) => slot === b[i]);
}

function errorPart(message: AssistantMessage, model: AssistantMessageModel): ErrorPart | undefined {
	const presentation = resolveAssistantErrorPresentation(message);
	if (presentation.kind === "compact-recovered") {
		const attempt = message.retryRecovery?.attempt ?? 1;
		const body = [message.errorMessage?.trim(), presentation.text].filter(
			(line, index, all): line is string => !!line && all.indexOf(line) === index,
		);
		return {
			kind: "recovered",
			attempt,
			body: body.join("\n"),
			note: presentation.text,
		};
	}
	if (presentation.kind !== "full" || message.content.some(content => content.type === "toolCall")) return undefined;
	if (message.stopReason === "aborted") return { kind: "abort", text: presentation.text };
	const { code, detail } = errorParts(presentation.text);
	const expanded = model.errorExpanded === undefined ? false : read(model.errorExpanded);
	const pinned = model.errorPinned === undefined ? false : read(model.errorPinned);
	return {
		kind: "failed",
		code,
		text: detail,
		preview: presentation.text,
		actions: message.stopReason === "error" && (model.actions === undefined ? false : read(model.actions)),
		termHidden: message.stopReason === "error" && pinned && !expanded,
		...(expanded ? {} : { lines: ERROR_PREVIEW_ROWS }),
	};
}

/** One part of the reply, kept by slot. */
function ReplyPart(props: {
	slot: string;
	part: () => Part | undefined;
	now: () => number;
	figureCell?: Reactive<FigureCell | undefined>;
	figureRows?: Reactive<number | undefined>;
	embedHost?: EmbedHost;
	showFigureImages: () => boolean;
	rate: () => number;
	tone: () => TspTone | undefined;
	thinkingRenderers: () => readonly AssistantThinkingRenderer[];
	codeCopy: boolean;
}): JSXNode {
	const initial = untrack(props.part);
	const kind = initial?.kind;
	const slot = props.slot;
	if (kind === "text") {
		const text = (): Extract<Part, { kind: "text" }> | undefined => {
			const part = props.part();
			return part?.kind === "text" ? part : undefined;
		};
		return (
			<md
				key={slot}
				text={() => text()?.native ?? ""}
				stream={() => (text()?.stream ? true : undefined)}
				// Held before it was trimmed: a second hold would take the finished row for a partial one.
				prepared={() => (text()?.stream ? true : undefined)}
				codeCopy={props.codeCopy ? true : undefined}
				tone={props.tone}
				term={() => ({ source: text()?.source, links: text()?.links, deferFigures: text()?.deferFigures })}
			/>
		);
	}
	if (kind === "svg") {
		const source = computed(() => {
			const part = props.part();
			return part?.kind === "svg" ? part.source : "";
		});
		return (
			<SvgFence
				source={source}
				nodeKey={slot}
				cell={props.figureCell}
				maxRows={props.figureRows}
				theme={currentTheme}
			/>
		);
	}
	if (kind === "embed") {
		const html = computed(() => {
			const part = props.part();
			return part?.kind === "embed" ? part.html : "";
		});
		const embed = computed(() => parseEmbed(html()));
		return (
			<EmbedFigure
				embed={embed}
				nodeKey={slot}
				showImages={props.showFigureImages}
				host={props.embedHost}
				cell={props.figureCell}
				maxRows={props.figureRows}
				theme={currentTheme}
			/>
		);
	}
	if (kind === "thinking") {
		const thinking = (): ThinkingPart | undefined => {
			const part = props.part();
			return part?.kind === "thinking" ? part : undefined;
		};
		const live = (): boolean => thinking()?.live === true;
		const title = (): string | undefined => {
			const tokens = thinking()?.tokens ?? 0;
			return tokens > 0 ? `${formatNumber(tokens)} tokens` : undefined;
		};
		return (
			<section
				key={slot}
				role={() => (live() ? "omp.thinking.live" : "omp.thinking")}
				collapsible
				collapsed={() => thinking()?.collapsed ?? true}
				took={() => {
					const part = thinking();
					return part?.end === undefined || part.start === undefined
						? undefined
						: Math.max(0, Math.round(part.end - part.start));
				}}
				term={() => ({
					hidden: thinking()?.hidden,
					spaceAfter: thinking()?.spaceAfter,
				})}
			>
				{() =>
					live() ? (
						<row key="head" gap="sm" title={title}>
							<spinner style="starburst" role="omp.thinking.spin" />
							<text spans={[{ t: "Thinking…", s: "muted" }]} />
							<elapsed
								age={() => {
									const start = thinking()?.start;
									return start === undefined ? 0 : Math.max(0, untrack(props.now) - start);
								}}
								format="short"
							/>
							{() => {
								const rate = Math.round(props.rate() * 10) / 10;
								return rate >= 0.05 && <rate value={rate} unit="tok/s" />;
							}}
						</row>
					) : (
						<text key="head" spans={() => [{ t: thoughtLabel(thinking()), s: "muted" }]} title={title} />
					)
				}
				<md
					key="body"
					text={() => {
						const part = thinking();
						return part?.stream ? speculativeStreamingSource(part.text) : (part?.text ?? "");
					}}
					stream={() => (thinking()?.stream ? true : undefined)}
					term={() => ({ source: thinking()?.text })}
				/>
			</section>
		);
	}
	if (kind === "thinkingExtension") {
		// A renderer's `requestRender` draws it again.
		const revision = signal(0);
		const requestRender = (): void => revision.set(untrack(revision) + 1);
		return (
			<col key={slot} role="omp.thinking.extension">
				{() => {
					revision();
					const part = props.part();
					if (part?.kind !== "thinkingExtension") return undefined;
					const theme = extensionTheme(currentTheme());
					const context = {
						contentIndex: part.contentIndex,
						thinkingIndex: part.thinkingIndex,
						text: part.text,
						requestRender,
					};
					return props.thinkingRenderers().map(renderer => renderExtension(() => renderer(context, theme)));
				}}
			</col>
		);
	}
	if (initial?.kind === "media") {
		return (
			<InlineMedia
				nodeKey={slot}
				path={() => {
					const part = props.part();
					return part?.kind === "media" ? part.path : initial.path;
				}}
			/>
		);
	}
	if (initial?.kind === "image") {
		return (
			<ImageNode
				image={initial.image}
				nodeKey={slot}
				alt={initial.image.mimeType}
				path={() => {
					const current = props.part();
					return current?.kind === "image" ? current.path : undefined;
				}}
				term={{ tool: initial.tool, mime: initial.image.mimeType }}
			/>
		);
	}
	if (kind === "error") return <ErrorPartNode part={props.part} />;
	return undefined;
}

/** The turn-ending error, abort label or recovered-retry note. */
function ErrorPartNode(props: { part: () => Part | undefined }): JSXNode {
	const error = (): ErrorPart | undefined => {
		const part = props.part();
		return part?.kind === "error" ? part.error : undefined;
	};
	const kind = computed(() => error()?.kind);
	return () => {
		switch (kind()) {
			case "abort":
				return untrack(() => (
					<text
						propKey="error"
						role="omp.assistant.abort"
						spans={() => {
							const e = error();
							return e?.kind === "abort" ? [{ t: e.text, s: "error" }] : [];
						}}
						wrap="word"
					/>
				));
			case "recovered":
				return untrack(() => {
					const recovered = (): Extract<ErrorPart, { kind: "recovered" }> | undefined => {
						const e = error();
						return e?.kind === "recovered" ? e : undefined;
					};
					return (
						<section
							propKey="error"
							role="omp.assistant.recovered"
							head={() => {
								const attempt = recovered()?.attempt ?? 1;
								return [
									{
										t: `↻ Recovered after ${attempt} ${attempt === 1 ? "retry" : "retries"}`,
										s: "muted",
									},
								];
							}}
							collapsible
							collapsed
							term={() => ({ note: recovered()?.note })}
						>
							<text spans={() => [{ t: recovered()?.body ?? "", s: "mono" }]} wrap="word" />
						</section>
					);
				});
			case "failed":
				return untrack(() => <FailedTurn error={error} />);
			default:
				return undefined;
		}
	};
}

/** A failed request: "Request failed" with its status chip, the message once, and its actions. */
function FailedTurn(props: { error: () => ErrorPart | undefined }): JSXNode {
	const failed = (): Extract<ErrorPart, { kind: "failed" }> | undefined => {
		const e = props.error();
		return e?.kind === "failed" ? e : undefined;
	};
	const button = (act: string, label: string, keys: readonly string[], title: string): JSXNode => (
		<row key={act} gap="xs" role="omp.error.action" actions={{ click: act }} title={title}>
			<text text={label} />
			{keys.length > 0 && <kbd keys={keys} />}
		</row>
	);
	return (
		<card
			propKey="error"
			role="omp.error"
			tone="error"
			term={() => ({
				preview: failed()?.preview,
				hidden: failed()?.termHidden,
			})}
		>
			<row key="head" gap="sm">
				<text spans={[{ t: "Request failed", s: "error strong" }]} />
				{() => {
					const code = failed()?.code;
					return code && <badge text={code} tone="error" role="omp.error.code" />;
				}}
			</row>
			<text
				propKey="message"
				role="omp.error.message"
				spans={(): TspSpan[] => [{ t: failed()?.text ?? "", s: "mono" }]}
				wrap="word"
				lines={() => failed()?.lines}
			/>
			{() =>
				failed()?.actions && (
					<row key="actions" gap="sm" role="omp.error.actions">
						{button("retry", "Retry", ["F5"], "Retry the failed turn")}
						{button("copy-error", "Copy error", [], "Copy the error message")}
						{button("switch-model", "Switch model", ["⌥P"], "Pick another model for this session")}
					</row>
				)
			}
		</card>
	);
}
