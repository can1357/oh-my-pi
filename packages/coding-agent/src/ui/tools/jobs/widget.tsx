/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Background-job widgets and tiles as TSP nodes.
 *
 * A widget (`JobWidgetView`, `src/tools/details/job-widget.ts`) is the rendered state of what a job is
 * doing: a headline figure, a stage line and blocks (a spark series, bars per
 * key, a meter, stats, a grid of states, a text line). It is plain data the
 * job-widgets runtime recomputes; these components only draw it.
 *
 * - {@link JobWidget}: a whole widget (the jobs sheet's detail).
 * - {@link JobTiles}: jobs as one wrapping row of tiles (the wait card):
 *   status dot, name, id, completion ring and clock, then a live widget's
 *   figure, primary block and notes.
 *
 * The terminal draws both from the data the root nodes carry on `term`
 * (`widget`, `tile`); see `src/ui/styles/tools/jobs/widget.ts`.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspChartMark, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type {
	JobTileType,
	JobWidgetBlock,
	JobWidgetMeterBlock,
	JobWidgetSparkBlock,
	JobWidgetStatBlock,
	JobWidgetTrend,
	JobWidgetView,
} from "../../../tools/details/job-widget";
import { truncate } from "@oh-my-pi/pi-tui/text/width";

export type {
	JobWidgetBarsBlock,
	JobWidgetBlock,
	JobWidgetGridBlock,
	JobWidgetMeterBlock,
	JobWidgetSparkBlock,
	JobWidgetStatBlock,
	JobWidgetTrend,
	JobWidgetView,
} from "../../../tools/details/job-widget";

/** What a glance at a widget reads. */
export interface JobWidgetGlance {
	readonly text: string;
	readonly label?: string;
	readonly trend?: JobWidgetTrend;
}

export type JobTileStatus = "running" | "completed" | "failed" | "cancelled";

/** One job as a tile draws it. */
export interface JobTile {
	readonly id: string;
	readonly type: JobTileType;
	readonly status: JobTileStatus;
	/** The job's label (a command): the title of a non-task job before a widget names it. */
	readonly label: string;
	/** How long the job has run; none shows no clock. */
	readonly durationMs?: number;
	/** Live: the dot pulses and the clock runs. */
	readonly live: boolean;
	readonly widget?: JobWidgetView;
	/** A task's own completion estimate (0–100). */
	readonly completionPercent?: number;
	/** What the job is doing now, when its widget names nothing. */
	readonly stage?: string;
	readonly exitCode?: number;
}

/** Keys a tile's bars block lists before it counts the rest. */
const TILE_BARS = 3;
/** Cells of a stage a tile's body shows. */
const TILE_LEAD_CELLS = 120;
const DEFAULT_TONE: TspTone = "accent";
const TILE_GLYPH: Record<JobTileStatus, string> = { running: "●", completed: "✓", failed: "✕", cancelled: "■" };
export const TILE_TONE: Record<JobTileStatus, TspTone> = {
	running: "accent",
	completed: "success",
	failed: "error",
	cancelled: "warning",
};
/** A figure's leading number and its unit: `1.10k req/s`, `7/9 trials`, `68%`. */
const FIGURE_NUMBER = /^([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)[kKMGT]?%?)(?:\s+|(?=\/)|$)(.*)$/;

/** Styled text as one plain line: escapes and controls gone, whitespace runs one space. */
export function plainLine(text: string): string {
	return sanitizeText(text.replace(/\s/g, " ")).replace(/\s+/g, " ").trim();
}

/** The theme color of a tone. */
export function toneColor(tone: TspTone): string {
	switch (tone) {
		case "neutral":
			return "text";
		case "accent":
		case "info":
			return "accent";
		case "warning":
		case "pending":
			return "warning";
		case "user":
			return "customMessageLabel";
		default:
			return tone;
	}
}

/** `value / max` clamped to 0–1 (0 for a broken scale). */
export function fraction(value: number, max: number): number {
	if (!(max > 0) || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / max));
}

/** The headline as a glance. */
function headlineGlance(view: JobWidgetView): JobWidgetGlance | undefined {
	const headline = view.headline;
	const text = headline ? plainLine(headline.text) : "";
	if (!headline || !text) return undefined;
	const label = headline.label ? plainLine(headline.label) : "";
	return { text, ...(label ? { label } : {}), ...(headline.trend ? { trend: headline.trend } : {}) };
}

/** What one glance reads: the headline (its meter's `140/190` when it restates the numerator), else the first spark's or meter's figure. */
export function jobWidgetGlance(view: JobWidgetView): JobWidgetGlance | undefined {
	const headline = headlineGlance(view);
	if (headline) {
		const meter = view.blocks.find((block): block is JobWidgetMeterBlock => block.kind === "meter");
		const whole = meter ? plainLine(meter.text) : "";
		const lead = headline.text.trim();
		return whole.startsWith(lead) && /^\s*\/\s*\S/.test(whole.slice(lead.length))
			? { ...headline, text: whole }
			: headline;
	}
	for (const block of view.blocks) {
		if (block.kind === "spark" && block.values.length > 0 && plainLine(block.last))
			return { text: plainLine(block.last), label: plainLine(block.label) };
		if (block.kind === "meter" && plainLine(block.text))
			return { text: plainLine(block.text), label: plainLine(block.label) };
	}
	return undefined;
}

/** `p50 41 ms ▼ 12% · errors 0`: dim labels, values in their tone, toned trends. */
export function statSpans(block: JobWidgetStatBlock): TspSpan[] {
	const spans: TspSpan[] = [];
	block.items.forEach((item, index) => {
		if (index > 0) spans.push({ s: "dim", t: " · " });
		spans.push({ s: "dim", t: `${plainLine(item.label)} ` });
		spans.push(item.tone ? { s: toneColor(item.tone), t: plainLine(item.text) } : { t: plainLine(item.text) });
		if (item.trend) spans.push({ s: toneColor(item.trend.tone), t: ` ${plainLine(item.trend.text)}` });
	});
	return spans;
}

/** A spark as chart props: columns over its domain, toned reference lines and per-point tooltips. */
function sparkChart(block: JobWidgetSparkBlock) {
	const marks = (block.marks ?? []).map((mark): TspChartMark => {
		const title = plainLine(mark.label);
		return { value: mark.value, ...(mark.tone ? { tone: mark.tone } : {}), ...(title ? { title } : {}) };
	});
	return {
		kind: "bars" as const,
		series: block.values.map((value, index) => {
			const tip = block.tips?.[index];
			return tip ? { value, title: plainLine(tip) } : { value };
		}),
		min: block.min,
		max: block.max,
		...(marks.length > 0 ? { marks } : {}),
		token: toneColor(block.tone ?? DEFAULT_TONE),
		summary: `${plainLine(block.label)} ${plainLine(block.last)}`,
	};
}

// ─── Whole widget ───────────────────────────────────────────────────────────

function Waiting(): JSXNode {
	return <text spans={[{ s: "dim", t: "waiting for data" }]} wrap="none" />;
}

/** A ≈12-cell muted label column before `children`. */
function Labelled(props: {
	readonly label: string;
	readonly role: string;
	readonly nodeKey?: string;
	readonly children: JSXNode;
}): JSXNode {
	return (
		<row key={props.nodeKey} role={props.role} gap="sm" align="center">
			<text
				spans={[{ s: "muted", t: plainLine(props.label) }]}
				wrap="none"
				truncate="end"
				min={{ w: "12ch" }}
				max={{ w: "12ch" }}
			/>
			{props.children}
		</row>
	);
}

function WidgetHead(props: { readonly view: JobWidgetView }): JSXNode {
	const view = props.view;
	const stage = view.stage ? plainLine(view.stage) : "";
	const headline = headlineGlance(view);
	return (
		<row role="omp.job.widget.head" gap="sm" align="baseline">
			<text
				role="omp.job.widget.title"
				spans={[{ s: "strong", t: plainLine(view.title) }]}
				wrap="none"
				truncate="end"
				grow={stage ? undefined : 1}
			/>
			{stage ? (
				<text role="omp.job.widget.stage" spans={[{ s: "muted", t: stage }]} wrap="none" truncate="end" grow={1} />
			) : undefined}
			{headline ? (
				<text
					role="omp.job.widget.headline"
					spans={[
						...(headline.label ? [{ s: "muted", t: `${headline.label} ` }] : []),
						{ s: "num strong", t: headline.text },
						...(headline.trend
							? [{ s: toneColor(headline.trend.tone), t: ` ${plainLine(headline.trend.text)}` }]
							: []),
					]}
					wrap="none"
				/>
			) : undefined}
		</row>
	);
}

function WidgetBlock(props: { readonly block: JobWidgetBlock; readonly nodeKey?: string }): JSXNode {
	const { block, nodeKey } = props;
	switch (block.kind) {
		case "spark": {
			if (block.values.length === 0)
				return (
					<Labelled nodeKey={nodeKey} label={block.label} role="omp.job.widget.spark">
						<Waiting />
					</Labelled>
				);
			const label = plainLine(block.label);
			const last = plainLine(block.last);
			return (
				<row key={nodeKey} role="omp.job.widget.spark" gap="sm" align="center">
					<chart key="chart" {...sparkChart(block)} size="md" grow={1} />
					<col key="side" role="omp.job.widget.side" gap="none">
						<text spans={[{ s: "num strong", t: last }]} wrap="none" />
						{label && !last.endsWith(label) ? (
							<text spans={[{ s: "muted", t: label }]} wrap="none" truncate="end" />
						) : undefined}
						{(block.marks ?? []).map(mark => (
							<text
								spans={[
									{ s: toneColor(mark.tone ?? "muted"), t: "┄ " },
									{ s: "dim", t: plainLine(mark.label) },
								]}
								wrap="none"
								truncate="end"
							/>
						))}
					</col>
				</row>
			);
		}
		case "bars":
			return (
				<col key={nodeKey} role="omp.job.widget.bars" gap="xs">
					<text
						role="omp.job.widget.caption"
						spans={[{ s: "dim", t: plainLine(block.label) }]}
						wrap="none"
						truncate="end"
					/>
					{block.items.length > 0 ? (
						block.items.map((item, index) => (
							<Labelled nodeKey={`${index}`} label={item.label} role="omp.job.widget.bar">
								<meter
									value={fraction(item.value, block.max)}
									label={plainLine(item.text)}
									size="sm"
									grow={1}
									tone={item.tone}
								/>
							</Labelled>
						))
					) : (
						<Waiting />
					)}
				</col>
			);
		case "meter":
			return (
				<Labelled nodeKey={nodeKey} label={block.label} role="omp.job.widget.meter">
					<meter
						value={fraction(block.value, 1)}
						label={plainLine(block.text)}
						size="sm"
						grow={1}
						tone={block.tone}
					/>
				</Labelled>
			);
		case "stat":
			return <text key={nodeKey} role="omp.job.widget.stat" spans={statSpans(block)} wrap="none" truncate="end" />;
		case "grid":
			return (
				<col key={nodeKey} role="omp.job.widget.grid" gap="xs">
					<text
						role="omp.job.widget.caption"
						spans={[{ s: "dim", t: plainLine(block.label) }]}
						wrap="none"
						truncate="end"
					/>
					{block.items.length > 0 ? (
						<row role="omp.job.widget.cells" gap="xs" wrap>
							{block.items.map((item, index) => (
								<badge
									key={`${index}`}
									text={plainLine(item.label)}
									tone={item.tone}
									title={plainLine(item.text)}
								/>
							))}
						</row>
					) : (
						<Waiting />
					)}
				</col>
			);
		case "text":
			return (
				<text
					key={nodeKey}
					role="omp.job.widget.text"
					spans={[{ s: "muted", t: plainLine(block.text) }]}
					wrap="none"
					truncate="end"
				/>
			);
	}
}

/**
 * A job's whole widget (role `omp.job.widget`): a head row (title, stage,
 * headline) over every block. The view rides on `term.widget` for the
 * terminal (`jobWidgetRows`).
 */
export function JobWidget(props: { readonly view: JobWidgetView; readonly nodeKey?: string }): JSXNode {
	const view = props.view;
	return (
		<col key={props.nodeKey} role="omp.job.widget" gap="xs" term={{ widget: view }}>
			<WidgetHead view={view} />
			{view.blocks.map((block, index) => (
				<WidgetBlock nodeKey={`${index}-${block.kind}`} block={block} />
			))}
		</col>
	);
}

// ─── Tiles ──────────────────────────────────────────────────────────────────

/** A task's name; any other job's widget title, else its label's first line, else its id. */
export function tileTitle(tile: JobTile): string {
	if (tile.type === "task") return plainLine(tile.id);
	return plainLine(tile.widget?.title ?? "") || plainLine(tile.label.split(/\r?\n/, 1)[0] ?? "") || plainLine(tile.id);
}

/** `p50 41 ms ▲ 8%`: the number between its quiet label and unit, then the toned trend; a label the unit states is dropped. */
function figureSpans(glance: JobWidgetGlance): TspSpan[] {
	const match = FIGURE_NUMBER.exec(glance.text);
	const value = match?.[1] ?? glance.text;
	const unit = (match?.[2] ?? "").replace(/^\/\s*/, "/ ");
	const label = glance.label && !unit.toLowerCase().includes(glance.label.toLowerCase()) ? glance.label : "";
	const spans: TspSpan[] = [];
	if (label) spans.push({ s: "dim", t: `${label} ` });
	spans.push({ t: value });
	if (unit) spans.push({ s: "dim", t: ` ${unit}` });
	if (glance.trend) spans.push({ s: toneColor(glance.trend.tone), t: ` ${plainLine(glance.trend.text)}` });
	return spans;
}

function TileMeter(props: { readonly value: number; readonly tone?: TspTone }): JSXNode {
	return (
		<meter
			role="omp.job.tile.meter"
			value={fraction(props.value, 1)}
			size="sm"
			tone={props.tone ?? DEFAULT_TONE}
			grow={1}
		/>
	);
}

/** A tile's picture of its primary block; stats and text read as notes instead. */
function tileVisual(block: JobWidgetBlock | undefined): JSXNode {
	switch (block?.kind) {
		case "spark":
			return block.values.length > 0 ? (
				<chart key="visual" {...sparkChart(block)} role="omp.job.tile.chart" size="sm" />
			) : undefined;
		case "meter":
			return (
				<meter
					key="visual"
					role="omp.job.tile.meter"
					value={fraction(block.value, 1)}
					size="sm"
					tone={block.tone ?? DEFAULT_TONE}
					grow={1}
				/>
			);
		case "bars": {
			const shown = block.items.slice(0, TILE_BARS);
			if (shown.length === 0) return undefined;
			const rest = block.items.length - shown.length;
			return (
				<col key="visual" role="omp.job.tile.bars" gap="xs">
					{shown.map((item, index) => (
						<row key={`${index}`} role="omp.job.tile.bar" gap="sm" align="center">
							<text
								role="omp.job.tile.key"
								spans={[{ s: "dim", t: plainLine(item.label) }]}
								wrap="none"
								truncate="end"
							/>
							<TileMeter value={fraction(item.value, block.max)} tone={item.tone} />
							<text role="omp.job.tile.num" spans={[{ t: plainLine(item.text) }]} wrap="none" />
						</row>
					))}
					{rest > 0 ? (
						<text role="omp.job.tile.more" spans={[{ s: "dim", t: `+${rest} more` }]} wrap="none" />
					) : undefined}
				</col>
			);
		}
		case "grid": {
			if (block.items.length === 0) return undefined;
			// No-break spaces inside a cell: lines wrap between cells only.
			const spans: TspSpan[] = [];
			for (const item of block.items) {
				if (spans.length > 0) spans.push({ t: "   " });
				spans.push(
					{ s: toneColor(item.tone), t: "●\u00a0" },
					{ s: "dim", t: plainLine(item.label).replaceAll(" ", "\u00a0") },
				);
			}
			return <text key="visual" role="omp.job.tile.grid" spans={spans} wrap="word" />;
		}
		default:
			return undefined;
	}
}

/** A live widget's stats and text lines, and the stage (with a failed exit ahead of it): a quiet last line, or the body when nothing charts. */
function tileNotes(tile: JobTile, view: JobWidgetView | undefined, lead: boolean): JSXNode[] {
	const stage = plainLine(tile.widget?.stage ?? tile.stage ?? "");
	const failed = tile.exitCode !== undefined && tile.exitCode !== 0 ? `exit ${tile.exitCode}` : "";
	const notes: { role: string; spans: TspSpan[]; wrap: "none" | "word" }[] = [];
	for (const block of view?.blocks ?? []) {
		if (block.kind === "stat" && block.items.length > 0)
			notes.push({ role: "omp.job.tile.stats", spans: statSpans(block), wrap: "none" });
		else if (block.kind === "text" && plainLine(block.text) && plainLine(block.text) !== stage)
			notes.push({ role: "omp.job.tile.note", spans: [{ s: "dim", t: plainLine(block.text) }], wrap: "none" });
	}
	if (stage || failed) {
		const spans: TspSpan[] = [];
		if (failed) spans.push({ s: "error", t: failed });
		if (failed && stage) spans.push({ s: "dim", t: " · " });
		if (stage) spans.push(lead ? { t: truncate(stage, TILE_LEAD_CELLS) } : { s: "dim", t: stage });
		if (lead) notes.unshift({ role: "omp.job.tile.lead", spans, wrap: "word" });
		else notes.push({ role: "omp.job.tile.stage", spans, wrap: "none" });
	}
	return notes.map((note, index) =>
		note.wrap === "word" ? (
			<text key={`note-${index}`} role={note.role} spans={note.spans} wrap="word" />
		) : (
			<text key={`note-${index}`} role={note.role} spans={note.spans} wrap="none" truncate="end" />
		),
	);
}

/**
 * One job as a tile (role `omp.job.tile`): a head line (status dot, name,
 * id, completion ring, clock), then what a live widget shows (its figure,
 * primary block and notes) and the stage.
 */
export function JobTileNode(props: { readonly tile: JobTile; readonly nodeKey?: string }): JSXNode {
	const tile = props.tile;
	const view = tile.widget?.state === "live" ? tile.widget : undefined;
	const glance = view ? jobWidgetGlance(view) : undefined;
	const title = tileTitle(tile);
	const id = plainLine(tile.id);
	const pulse = tile.live && tile.status === "running";
	const percent = tile.completionPercent === undefined ? undefined : Math.round(tile.completionPercent);
	const visual = tileVisual(view?.blocks[0]);
	const clock = tile.durationMs === undefined ? undefined : Math.max(0, Math.round(tile.durationMs));
	return (
		<col key={props.nodeKey} role="omp.job.tile" tone={TILE_TONE[tile.status]} gap="xs" term={{ tile }}>
			<row key="head" role="omp.job.tile.head" gap="xs" align="center">
				<text
					role="omp.job.tile.dot"
					spans={[
						{
							s: toneColor(TILE_TONE[tile.status]),
							t: TILE_GLYPH[tile.status],
							...(pulse ? { fx: "pulse" as const } : {}),
						},
					]}
					wrap="none"
				/>
				<text role="omp.job.tile.title" spans={[{ t: title }]} wrap="none" truncate="end" grow={1} />
				{id === title ? undefined : <text role="omp.job.tile.id" spans={[{ s: "dim", t: id }]} wrap="none" />}
				{percent === undefined ? undefined : (
					<meter
						key="ring"
						role="omp.job.tile.ring"
						style="ring"
						size="sm"
						value={fraction(percent, 100)}
						label={`${percent}%`}
						title={`The agent's own completion estimate: ${percent}%`}
					/>
				)}
				{clock === undefined ? undefined : tile.live ? (
					<elapsed key="clock" age={clock} format="short" />
				) : (
					<elapsed key="clock" age={clock} stopped={clock} format="short" />
				)}
			</row>
			{glance ? (
				<text key="figure" role="omp.job.tile.figure" spans={figureSpans(glance)} wrap="none" truncate="end" />
			) : undefined}
			{visual}
			{tileNotes(tile, view, !glance && visual === undefined)}
		</col>
	);
}

/** Jobs as one wrapping row of equal tiles (role `omp.job.tiles`), keyed by job id. */
export function JobTiles(props: { readonly tiles: readonly JobTile[]; readonly nodeKey?: string }): JSXNode {
	return (
		<row key={props.nodeKey} role="omp.job.tiles" gap="none" wrap>
			{props.tiles.map(tile => (
				<JobTileNode nodeKey={Bun.hash(tile.id).toString(36)} tile={tile} />
			))}
		</row>
	);
}
