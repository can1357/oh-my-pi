/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The footer: a `status` bar (`omp.footer`) — the working directory (and
 * branch), the usage counters, billing and context on the left, the model
 * and thinking level on the right — and, while extensions report any, their
 * statuses as one line (`omp.footer.extensions`) in an `omp.footer.panel`.
 *
 * Terminal look: `src/ui/styles/status/footer.ts` (path row, then the stats
 * row with the model right-aligned).
 */
import { type Accessor, computed, For, type JSXNode, Show } from "@oh-my-pi/pi-tui";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeStatusText } from "../../modes/view-model/chrome/shared";
import { shortenPath } from "../../utils/render-utils";
import "../styles/status";
import type { StatusUsage } from "./facts";
import { billingSummary, contextColor, contextLevel, contextTone, formatContextUsage } from "./format";

/** What the footer shows. */
export interface FooterFacts {
	readonly model?: { readonly id: string; readonly thinking: boolean; readonly contextWindow?: number };
	readonly thinkingLevel?: string;
	readonly autoThinking?: boolean;
	readonly autoResolvedLevel?: string;
	readonly usage: StatusUsage;
	readonly usingSubscription: boolean;
	/** Context occupancy; undefined while the session has none to report. */
	readonly context?: { readonly tokens: number | null; readonly window: number; readonly percent: number | null };
	readonly autoCompact: boolean;
	readonly cwd: string;
	readonly home?: string;
	/** Branch, bookmark or change id of the working copy. */
	readonly branch?: string | null;
	/** Extension statuses, ordered by key. */
	readonly statuses: readonly string[];
}

/** One `seg` of the footer bar. */
export interface FooterSeg {
	readonly key: string;
	readonly side: "left" | "right";
	readonly priority: number;
	readonly spans: TspSpan[];
	readonly icon?: string;
	readonly tone?: TspTone;
}

const UNICODE = presetSymbols("unicode");

/** The footer bar's segments for `facts`. */
export function footerSegs(facts: FooterFacts): FooterSeg[] {
	const segs: FooterSeg[] = [];
	const path: TspSpan[] = [{ t: shortenPath(facts.cwd, facts.home), s: "path dim" }];
	if (facts.branch) path.push({ t: ` (${facts.branch})`, s: "dim" });
	segs.push({ key: "path", side: "left", priority: 6, icon: "folder", spans: path });
	const { usage } = facts;
	const counters: [string, string, number][] = [
		["input", "↑", usage.input],
		["output", "↓", usage.output],
		["cache-read", "R", usage.cacheRead],
		["cache-write", "W", usage.cacheWrite],
	];
	for (const [key, glyph, amount] of counters) {
		if (amount)
			segs.push({ key, side: "left", priority: 1, spans: [{ t: `${glyph}${formatNumber(amount)}`, s: "dim" }] });
	}
	const billing = billingSummary(
		{
			cost: usage.cost,
			usingSubscription: facts.usingSubscription,
			premiumRequests: usage.premiumRequests,
			digits: 3,
		},
		{ nerd: false, subscription: UNICODE["icon.subscription"] ?? "", advisor: UNICODE["icon.advisor"] ?? "" },
	);
	if (billing) segs.push({ key: "cost", side: "left", priority: 3, spans: [{ t: billing, s: "dim" }] });
	const window = facts.context?.window ?? facts.model?.contextWindow ?? 0;
	const percent = window > 0 ? (facts.context?.percent ?? 0) : null;
	const level = facts.context && percent !== null ? contextLevel(percent, window) : "normal";
	const context: TspSpan[] = [
		{ t: formatContextUsage(percent, window, facts.context?.tokens ?? 0), s: contextColor(level) },
	];
	const auto = UNICODE["icon.auto"];
	if (facts.autoCompact && auto) context.push({ t: ` ${auto}`, s: "dim" });
	const tone = contextTone(level);
	segs.push({ key: "context", side: "left", priority: 4, icon: "context", spans: context, ...(tone ? { tone } : {}) });
	let model = facts.model?.id || "no-model";
	if (facts.model?.thinking) {
		const level = facts.autoThinking
			? (facts.autoResolvedLevel ?? `${UNICODE["thinking.autoPending"] ?? ""} auto`)
			: (facts.thinkingLevel ?? "off");
		model += ` • ${level}`;
	}
	segs.push({ key: "model", side: "right", priority: 5, icon: "model", spans: [{ t: model, s: "dim" }] });
	return segs;
}

export interface FooterProps {
	readonly facts: Accessor<FooterFacts>;
}

export function Footer(props: FooterProps): JSXNode {
	const segs = computed(() => footerSegs(props.facts()));
	const byKey = computed(() => new Map(segs().map(seg => [seg.key, seg])));
	const keys = computed(() => segs().map(seg => seg.key), {
		equals: (a, b) => a.length === b.length && a.every((key, i) => key === b[i]),
	});
	const statuses = computed(() => props.facts().statuses.map(sanitizeStatusText).join(" "));
	const bar = (
		<status key="bar" role="omp.footer">
			<For each={keys}>
				{key => {
					const seg = () => byKey().get(key);
					return (
						<seg
							key={key}
							role={`omp.footer.${key}`}
							side={() => seg()?.side}
							priority={() => seg()?.priority}
							icon={() => seg()?.icon}
							spans={() => seg()?.spans}
							tone={() => seg()?.tone}
						/>
					);
				}}
			</For>
		</status>
	);
	const extensions = <text key="ext" role="omp.footer.extensions" text={statuses} wrap="none" />;
	return (
		<Show when={() => props.facts().statuses.length > 0} fallback={bar}>
			<col role="omp.footer.panel">
				{bar}
				{extensions}
			</col>
		</Show>
	);
}
