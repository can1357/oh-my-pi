/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The status line's facts inside the native composer, where no status strip
 * is drawn: the context meter along the field's top edge
 * (`omp.composer.context`), the session cost (`omp.composer.usage`), every
 * other configured segment as a fact (`omp.composer.extras`, the bar's
 * flexible space), and the model chip's label and the effort level for the
 * composer's own chips.
 *
 * Segments shown elsewhere stay out of the extras: the model chip, the
 * context meter and usage (context, cost), Tern's pane header (path), the
 * tab title (session name, PR), the HUD (subagents), the editor (vim) and
 * the brand (pi).
 */
import { type Accessor, computed, For, type JSXNode, Show } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspMeterMark, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { StatusLineSegmentId } from "../../config/status-line-schema";
import { sanitizeStatusText } from "../../modes/view-model/chrome/shared";
import { promptCacheDetails } from "../../modes/view-model/status-line/prompt-cache";
import type { StatusLineSettings } from "../../modes/view-model/status-line/types";
import type { StatusFacts } from "./facts";
import { effectiveStatusSettings, type SegMotion, type SegView, segmentView, thinkingWord } from "./segments";
import { SegMotionNode } from "./status-line";

/** Segments a native terminal shows outside the composer's facts. */
const HOMED: Partial<Record<StatusLineSegmentId, true>> = {
	pi: true,
	model: true,
	context_pct: true,
	context_total: true,
	cost: true,
	path: true,
	pr: true,
	session_name: true,
	subagents: true,
	vim: true,
};

/** Facts that outlast every other as the native bar narrows. */
const PINNED: Partial<Record<StatusLineSegmentId, true>> = {
	model: true,
	context_pct: true,
	context_total: true,
	git: true,
	tree: true,
};
const PINNED_PRIORITY = 1000;

/** Controls on the native composer bar. The effort menu also supplies a level with `thinking.set`. */
export type ComposerBarAction =
	| `status.${"model" | "context" | "git" | "cost" | "usage" | "cache" | "path" | "tree"}`
	| "thinking.cycle"
	| "thinking.set"
	| "dictation.toggle";

/** The live session must supply a destination for every bar control before the frame advertises clicks. */
export type ComposerBarRoutes = Readonly<Record<ComposerBarAction, (value?: string) => void>>;

const FACT_ACTIONS: Partial<Record<StatusLineSegmentId, ComposerBarAction>> = {
	model: "status.model",
	context_pct: "status.context",
	context_total: "status.context",
	git: "status.git",
	cost: "status.cost",
	usage: "status.usage",
	path: "status.path",
	cache: "status.cache",
	tree: "status.tree",
};

/** One fact of the extras. */
interface Fact {
	readonly key: string;
	readonly role: string;
	readonly priority: number;
	readonly side?: "right";
	readonly spans: TspSpan[];
	readonly icon?: string;
	readonly tone?: TspTone;
	readonly title?: string;
	readonly actions?: { readonly click: ComposerBarAction };
	readonly motion?: SegMotion;
}

/** Where a context level starts, as a share of the window: its percent or its token count, whichever comes first. */
function levelShare(window: number, percent: number, tokens: number): number {
	return (window > 0 ? Math.min(percent, (tokens / window) * 100) : percent) / 100;
}

/** The composer facts of `settings` over `facts` (see the module docs). */
export function composerFacts(props: {
	readonly settings: Accessor<StatusLineSettings>;
	readonly facts: Accessor<StatusFacts>;
	readonly click: (action: ComposerBarAction) => { click: ComposerBarAction } | undefined;
}): {
	readonly context: JSXNode;
	readonly extras: JSXNode;
	readonly usage: JSXNode;
	/** The model chip's label. */
	readonly model: Accessor<TspSpan[]>;
	/** The model chip's tone (its segment's). */
	readonly modelTone: Accessor<TspTone | undefined>;
	/** The effort chip's level; undefined without thinking. */
	readonly effort: Accessor<string | undefined>;
} {
	const effective = computed(() => effectiveStatusSettings(props.settings()));
	const dim = (spans: TspSpan[]) =>
		props.facts().focusedAgentId ? spans.map(part => ({ ...part, s: part.s ? `${part.s} dim` : "dim" })) : spans;

	const facts = computed((): Fact[] => {
		const settings = effective();
		const state = props.facts();
		const out: Fact[] = [];
		const nerd = currentTheme().symbols.preset === "nerd";
		const collect = (side: "left" | "right", ids: readonly StatusLineSegmentId[]) => {
			ids.forEach((id, index) => {
				if (HOMED[id]) return;
				const view = segmentView(id, state, settings, nerd);
				if (!view) return;
				const order = side === "left" ? ids.length - index : index + 1;
				const action = FACT_ACTIONS[id];
				const cache = id === "cache" ? state.promptCache : undefined;
				out.push({
					key: id,
					role: cache ? "omp.composer.cache" : "omp.composer.fact",
					priority: (PINNED[id] ? PINNED_PRIORITY : 0) + order,
					spans: dim(view.spans),
					...(cache ? { side: "right" as const } : {}),
					...(view.icon !== undefined ? { icon: view.icon } : {}),
					...(view.tone !== undefined ? { tone: view.tone } : {}),
					...(cache
						? {
								title: promptCacheDetails(cache, state.now)
									.map(row => `${row.label}: ${row.value}`)
									.join("\n"),
							}
						: view.title !== undefined
							? { title: view.title }
							: {}),
					...(action ? { actions: props.click(action) } : {}),
					...(view.motion ? { motion: view.motion } : {}),
				});
			});
		};
		collect("left", settings.leftSegments);
		collect("right", settings.rightSegments);
		const ids = [...settings.leftSegments, ...settings.rightSegments];
		if ((settings.showHookStatus ?? true) && !ids.includes("status")) {
			state.hooks.forEach((status, index) => {
				const text = sanitizeStatusText(status);
				if (text)
					out.push({ key: `hook-${index}`, role: "omp.composer.fact", priority: 0, spans: dim([{ t: text }]) });
			});
		}
		return out;
	});
	const byKey = computed(() => new Map(facts().map(fact => [fact.key, fact])));
	const keys = computed(() => facts().map(fact => fact.key), {
		equals: (a, b) => a.length === b.length && a.every((key, i) => key === b[i]),
	});

	const meter = computed(() => {
		const state = props.facts();
		const { percent, window, tokens } = state.context;
		const boundaries = state.autoCompact ? state.compaction : undefined;
		const lines = [
			percent === null ? "Context usage unknown" : `Context ${Math.round(percent)}% used`,
			window > 0 ? `${formatNumber(tokens)} of ${formatNumber(window)} tokens` : "No context window",
		];
		if (boundaries) lines.push(`Auto-compact at ${Math.round(boundaries.thresholdPercent)}%`);
		if (state.speculation === "running") lines.push("Compaction summary in progress");
		else if (state.speculation === "armed") lines.push("Compaction summary ready");
		const used = percent === null ? null : Math.min(1, percent / 100);
		const speculationAt =
			boundaries?.speculationPercent == null ? null : Math.min(1, boundaries.speculationPercent / 100);
		const marks: TspMeterMark[] = [];
		if (boundaries) {
			if (speculationAt !== null) {
				marks.push({
					at: speculationAt,
					icon: "context.speculation",
					title: `Compaction summary starts at ${Math.round(speculationAt * 100)}%`,
					...(state.speculation && state.speculation !== "idle" ? { tone: "accent" as const } : {}),
				});
			}
			marks.push({
				at: Math.min(1, boundaries.thresholdPercent / 100),
				icon: "context.compaction",
				title: `Auto-compact at ${Math.round(boundaries.thresholdPercent)}%`,
			});
		}
		return {
			value: used,
			thresholds: { warn: levelShare(window, 50, 150_000), bad: levelShare(window, 90, 500_000) },
			parts:
				used !== null && speculationAt !== null && used > speculationAt
					? [{ value: speculationAt }, { value: used - speculationAt, token: "accent" }]
					: undefined,
			marks: marks.length > 0 ? marks : undefined,
			label: percent === null ? undefined : `${Math.round(percent)}%`,
			total: window > 0 ? formatNumber(window) : undefined,
			title: lines.join("\n"),
		};
	});
	// The session's spend (a Nerd Font subscription marker in it travels as an `icon` span).
	const cost = computed((): string => {
		const nerd = currentTheme().symbols.preset === "nerd";
		return (
			segmentView("cost", props.facts(), effective(), nerd)
				?.spans.map(part => part.t)
				.join("") ?? ""
		);
	});

	const modelView = computed(() =>
		segmentView(
			"model",
			props.facts(),
			{ ...effective(), segmentOptions: { ...effective().segmentOptions, model: { showThinkingLevel: false } } },
			currentTheme().symbols.preset === "nerd",
		),
	);

	return {
		context: (
			<meter
				key="context"
				role="omp.composer.context"
				style="bar"
				value={() => meter().value}
				thresholds={() => meter().thresholds}
				parts={() => meter().parts}
				marks={() => meter().marks}
				label={() => meter().label}
				total={() => meter().total}
				title={() => meter().title}
				actions={props.click("status.context")}
			/>
		),
		extras: (
			<status key="extras" role="omp.composer.extras" transparent grow={1}>
				<For each={keys}>
					{key => {
						const fact = () => byKey().get(key);
						return (
							<seg
								key={key}
								role={() => fact()?.role}
								side={() => fact()?.side}
								priority={() => fact()?.priority}
								spans={() => fact()?.spans}
								icon={() => fact()?.icon}
								tone={() => fact()?.tone}
								title={() => fact()?.title}
								actions={() => fact()?.actions}
							>
								<Show when={() => fact()?.motion}>{motion => <SegMotionNode motion={motion} />}</Show>
							</seg>
						);
					}}
				</For>
			</status>
		),
		usage: (
			<text
				key="usage"
				role="omp.composer.usage"
				text={cost}
				wrap="none"
				title={() => (cost() ? `Session cost ${cost()}` : undefined)}
				actions={props.click("status.cost")}
			/>
		),
		model: computed(() => dim(modelView()?.spans ?? [])),
		modelTone: computed(() => modelView()?.tone),
		effort: computed(() => thinkingWord(props.facts())),
	};
}

/**
 * The status bar as Tern is sent it (the settings screen's live preview): every configured segment
 * with its drop priority and its click, the live-work badges, and the hook rows under it.
 */
export function StatusBarPreview(props: {
	readonly settings: Accessor<StatusLineSettings>;
	readonly facts: Accessor<StatusFacts>;
}): JSXNode {
	return () => {
		const settings = effectiveStatusSettings(props.settings());
		const state = props.facts();
		const nerd = currentTheme().symbols.preset === "nerd";
		const faint = state.focusedAgentId !== undefined;
		const badge = state.subagents > 0;
		const segs: JSXNode[] = [];
		const push = (
			key: string,
			side: "left" | "right",
			order: number,
			view: Pick<SegView, "spans" | "icon" | "tone" | "title" | "motion">,
		): void => {
			const action = FACT_ACTIONS[key as StatusLineSegmentId];
			segs.push(
				<seg
					key={key}
					role={`omp.status.${key}`}
					side={side}
					priority={(PINNED[key as StatusLineSegmentId] ? PINNED_PRIORITY : 0) + order}
					// The path truncates before anything drops.
					min={key === "path" ? { w: "12ch" } : undefined}
					actions={action ? { click: action } : undefined}
					spans={faint ? view.spans.map(part => ({ ...part, s: part.s ? `${part.s} dim` : "dim" })) : view.spans}
					icon={view.icon}
					tone={view.tone}
					title={view.title}
				>
					{view.motion && <SegMotionNode motion={view.motion} />}
				</seg>,
			);
		};
		const collect = (side: "left" | "right", ids: readonly StatusLineSegmentId[]): void => {
			ids.forEach((id, index) => {
				if (badge && id === "subagents") return;
				const view = segmentView(id, state, settings, nerd);
				if (view) push(id, side, side === "left" ? ids.length - index : index + 1, view);
			});
		};
		collect("left", settings.leftSegments);
		// Live-work badges lead the right group: on its inner edge, they drop before any configured segment.
		if (badge)
			push("subagent-badge", "right", 0, {
				spans: [{ t: `${state.subagents}`, s: "statusLineSubagents" }],
				icon: "agents",
			});
		if (state.jobs > 0)
			push("jobs", "right", 0, { spans: [{ t: `${state.jobs}`, s: "statusLineSubagents" }], icon: "job" });
		collect("right", settings.rightSegments);
		const bar = (
			<status key="bar" role="omp.status" transparent={settings.transparent === true}>
				{segs}
			</status>
		);
		if (!(props.settings().showHookStatus ?? true) || state.hooks.length === 0) return bar;
		return (
			<col role="omp.status.panel">
				{bar}
				{state.hooks.map((status, index) => (
					<text key={`hook-${index}`} role="omp.status.hook" text={sanitizeStatusText(status)} wrap="none" />
				))}
			</col>
		);
	};
}
