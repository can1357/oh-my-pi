/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The status line: a `status` bar (`omp.status`) of the configured segments
 * — preset or custom, each a `seg` keyed by its id with its side and drop
 * priority — and the extension statuses under it (`omp.status.hook`), in an
 * `omp.status.panel` column.
 *
 * Drop order follows the bar's terminal behaviour: the right group yields
 * before the left, each from its outer end; the session title truncates
 * before anything on its side drops and the path before anything on its own
 * (both down to 8 cells), and each of them drops last on its side. Live-work
 * badges (running subagents, background jobs) lead the right group.
 *
 * Terminal look: `src/ui/styles/status/status-line.ts`.
 */
import { type Accessor, computed, For, Index, type JSXNode, Show, type UiNode } from "@oh-my-pi/pi-tui";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { sparkline } from "@oh-my-pi/pi-tui/term/painters/chart";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeHookStatusText, sanitizeStatusText } from "../../modes/view-model/chrome/shared";
import type { StatusLineSettings } from "../../modes/view-model/status-line/types";
import type { ContextLineMode, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../config/status-line-schema";
import type { JobWidgetSparkBlock, JobWidgetView } from "../../tools/details/job-widget";
import type { ComposerShape, ComposerStatusSource, StatusAttachment } from "../styles/composer/shapes";
import { jobWidgetGlance, plainLine, toneColor } from "../tools/jobs/widget";
import "../styles/status";
import type { StatusFacts, StatusPlacement } from "./facts";
import type { LookPiece, SegLook } from "./look";
import { effectiveStatusSettings, type SegMotion, segmentView } from "./segments";

/** One `seg` of the bar. */
export interface StatusSeg {
	readonly key: string;
	readonly side: "left" | "right";
	readonly priority: number;
	/** Narrowest the terminal cuts it to (cells); undefined: it never shrinks. */
	readonly min?: number;
	readonly spans: TspSpan[];
	readonly icon?: string;
	readonly tone?: TspTone;
	readonly title?: string;
	readonly motion?: SegMotion;
	readonly look: SegLook;
}

/** Cells the path and the session title shrink to before they drop. */
const ELASTIC_MIN = 8;

/** Terminal look facts of the panel. */
export type StatusPanelLook = {
	readonly placement: StatusPlacement;
};

/** Terminal look facts of an extension status row. */
export type StatusHookLook = {
	/** The status with its SGR kept. */
	readonly ansi: string;
};

/** The bar's segments, in order, for `settings` over `facts`. */
export function statusSegs(settings: StatusLineSettings, facts: StatusFacts): StatusSeg[] {
	const effective = effectiveStatusSettings(settings);
	const badge = facts.subagents > 0;
	const collect = (ids: readonly StatusLineSegmentId[]) =>
		ids.flatMap(id => {
			if (badge && id === "subagents") return [];
			const segView = segmentView(id, facts, effective);
			return segView ? [{ id, view: segView }] : [];
		});
	const left = collect(effective.leftSegments);
	const right = collect(effective.rightSegments);
	const badges: StatusSeg[] = [];
	if (badge) {
		const count = `${facts.subagents}`;
		badges.push({
			key: "subagent-badge",
			side: "right",
			priority: 0,
			icon: "agents",
			spans: [{ t: count, s: "statusLineSubagents" }],
			look: {
				pieces: [
					{ icon: "agents", s: "statusLineSubagents" },
					{ t: count, s: "statusLineSubagents" },
				],
			},
		});
	}
	if (facts.jobs > 0) {
		const count = `${facts.jobs}`;
		badges.push({
			key: "jobs",
			side: "right",
			priority: 0,
			icon: "job",
			spans: [{ t: count, s: "statusLineSubagents" }],
			look: {
				pieces: [
					{ icon: "job", s: "statusLineSubagents" },
					{ t: count, s: "statusLineSubagents" },
					...(facts.jobGlance ? jobGlancePieces(facts.jobGlance) : []),
				],
			},
		});
	}
	const rightCount = badges.length + right.length;
	const out: StatusSeg[] = [];
	left.forEach(({ id, view }, index) => {
		const elastic = id === "path";
		out.push({
			key: id,
			side: "left",
			priority: elastic ? rightCount + left.length + 2 : rightCount + 1 + (left.length - index),
			...(elastic ? { min: ELASTIC_MIN } : {}),
			...view,
		});
	});
	badges.forEach((seg, index) => {
		out.push({ ...seg, priority: rightCount - index });
	});
	right.forEach(({ id, view }, index) => {
		const elastic = id === "session_name";
		out.push({
			key: id,
			side: "right",
			priority: elastic ? right.length + 0.5 : right.length - index,
			...(elastic ? { min: ELASTIC_MIN } : {}),
			...view,
		});
	});
	return out;
}

/** A segment's terminal-clocked readout as its native child. */
export function SegMotionNode(props: { readonly motion: SegMotion }): JSXNode {
	const { motion } = props;
	if (motion.kind === "rate") return <rate key="rate" value={motion.value} unit={motion.unit} />;
	return <elapsed key="timer" age={motion.age} stopped={motion.stopped} format="short" />;
}

export interface StatusLineProps {
	readonly settings: Accessor<StatusLineSettings>;
	readonly facts: Accessor<StatusFacts>;
	readonly placement: Accessor<StatusPlacement>;
}

/** The status line's terminal chrome around a composer, drawn on demand. */
export interface StatusChrome {
	/** Status for the composer's top chrome (`composer.setStatus`). */
	readonly composerStatus: ComposerStatusSource;
	/** The bottom bar with `groups` at `width` cells ("" when nothing shows). */
	bottomBar(cx: PaintContext, groups: "full" | "left", width: number): string;
}

/** Terminal look facts of a top attachment (`omp.status.top`). */
export type StatusTopLook = {
	readonly attachment: StatusAttachment;
	/** The bar's segments. */
	readonly segs: readonly UiNode[];
	readonly separator: StatusLineSeparatorStyle;
	readonly transparent: boolean;
	/** How the gauge reacts to context usage (`embedded` when unset, but labels move into it only when set so). */
	readonly contextLine?: ContextLineMode;
	/** Seed of the session accent (the gauge's lit color); undefined when off or unnamed. */
	readonly accent?: string;
	readonly context: StatusFacts["context"];
	readonly autoCompact: boolean;
	readonly compaction?: StatusFacts["compaction"];
	/** Dim it all (the view is proxied at a subagent). */
	readonly faint: boolean;
};

/** Terminal look facts of a bar (`omp.status`). */
export type StatusBarLook = {
	readonly groups: "both" | "left";
	/** Segments of another bar to draw (the chrome's bars borrow the panel's). */
	readonly segs?: readonly UiNode[];
};

/** Sparkline cells the jobs badge draws after the freshest widget's headline. */
const JOB_GLANCE_SPARK_CELLS = 8;

/** The jobs badge's glance at a widget: ` headline trend sparkline`, as the terminal draws it. */
function jobGlancePieces(view: JobWidgetView): LookPiece[] {
	const pieces: LookPiece[] = [];
	const glance = jobWidgetGlance(view);
	if (glance) {
		pieces.push({ t: " " }, { t: glance.text, s: "strong" });
		if (glance.trend) pieces.push({ t: ` ${plainLine(glance.trend.text)}`, s: toneColor(glance.trend.tone) });
	}
	const spark = view.blocks.find((block): block is JobWidgetSparkBlock => block.kind === "spark");
	if (spark && spark.values.length > 0) {
		const values = spark.values.slice(-JOB_GLANCE_SPARK_CELLS);
		pieces.push(
			{ t: " " },
			{ t: sparkline(values, { min: spark.min, max: spark.max }), s: toneColor(spark.tone ?? "accent") },
		);
	}
	return pieces;
}

/**
 * The status line (see the module docs) and its chrome for the composer:
 * the top attachment the composer's shape asks for, and the bottom bar.
 */
export function createStatusLine(props: StatusLineProps): {
	readonly panel: JSXNode;
	readonly chrome: StatusChrome;
	/** The bar as a shape shows it: in its top `attachment`, or the full standalone bar without one. */
	preview(attachment: StatusAttachment | undefined): UiNode;
} {
	const segs = computed(() => statusSegs(props.settings(), props.facts()));
	const byKey = computed(() => new Map(segs().map(seg => [seg.key, seg])));
	const keys = computed(() => segs().map(seg => seg.key), {
		equals: (a, b) => a.length === b.length && a.every((key, i) => key === b[i]),
	});
	const hooks = computed(() =>
		(props.settings().showHookStatus ?? true) ? props.facts().hooks.filter(text => sanitizeStatusText(text)) : [],
	);
	let bar: UiNode | undefined;
	const barSegs = () => bar?.children() ?? [];
	const top = (attachment: StatusAttachment): UiNode => {
		const look = (): StatusTopLook => {
			const settings = effectiveStatusSettings(props.settings());
			const facts = props.facts();
			return {
				attachment,
				segs: barSegs(),
				separator: settings.separator ?? "powerline-thin",
				transparent: settings.transparent === true,
				...(settings.contextLine ? { contextLine: settings.contextLine } : {}),
				...(settings.sessionAccent !== false && facts.sessionName ? { accent: facts.sessionName } : {}),
				context: facts.context,
				autoCompact: facts.autoCompact,
				...(facts.compaction ? { compaction: facts.compaction } : {}),
				faint: facts.focusedAgentId !== undefined,
			};
		};
		return (<status role="omp.status.top" term={look} />) as UiNode;
	};
	const tops: Record<StatusAttachment, UiNode> = {
		"top-border": top("top-border"),
		"top-band": top("top-band"),
		"top-rule-chip": top("top-rule-chip"),
	};
	const bottom = (groups: StatusBarLook["groups"]): UiNode =>
		(<status role="omp.status" term={(): StatusBarLook => ({ groups, segs: barSegs() })} />) as UiNode;
	const bottoms = { full: bottom("both"), left: bottom("left") };
	const chrome: StatusChrome = {
		composerStatus(cx, attachment, width) {
			const row = cx.paint(tops[attachment], width).rows[0];
			return row ? { content: row, width: visibleWidth(row) } : undefined;
		},
		bottomBar: (cx, groups, width) => cx.paint(bottoms[groups], width).rows[0] ?? "",
	};
	const panel = (
		<col role="omp.status.panel" term={(): StatusPanelLook => ({ placement: props.placement() })}>
			<status
				key="bar"
				ref={node => {
					bar = node;
				}}
				role="omp.status"
				transparent={() => props.settings().transparent === true}
				term={(): StatusBarLook => ({ groups: props.placement().bar === "left" ? "left" : "both" })}
			>
				<For each={keys}>
					{key => {
						const seg = () => byKey().get(key);
						return (
							<seg
								key={key}
								role={`omp.status.${key}`}
								side={() => seg()?.side}
								priority={() => seg()?.priority}
								min={() => {
									const min = seg()?.min;
									return min === undefined ? undefined : { w: `${min}ch` as const };
								}}
								spans={() => seg()?.spans}
								icon={() => seg()?.icon}
								tone={() => seg()?.tone}
								title={() => seg()?.title}
								term={() => seg()?.look}
							>
								<Show when={() => seg()?.motion}>{motion => <SegMotionNode motion={motion} />}</Show>
							</seg>
						);
					}}
				</For>
			</status>
			<Index each={hooks}>
				{(status, index) => (
					<text
						key={`hook-${index}`}
						role="omp.status.hook"
						text={() => sanitizeStatusText(status())}
						wrap="none"
						term={(): StatusHookLook => ({ ansi: sanitizeHookStatusText(status()) })}
					/>
				)}
			</Index>
		</col>
	);
	return { panel, chrome, preview: attachment => (attachment ? tops[attachment] : bottoms.full) };
}

/** Where the standalone bar goes for a composer `shape` (its top chrome takes the status through `composerStatus`). */
export function shapePlacement(shape: ComposerShape, autocomplete: boolean): StatusPlacement {
	return { bar: shape.bottomBar ?? "none", gap: shape.bottomBarGap === true, autocomplete };
}

export function StatusLine(props: StatusLineProps): JSXNode {
	return createStatusLine(props).panel;
}
