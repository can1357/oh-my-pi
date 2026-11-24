/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Dividers and turn markers: a short rule and a label set off by blank rows
 * in the terminal.
 *
 * - A plain divider is a `rule` natively (its label in the label color).
 * - A marker with a native presentation is an icon and a one-line label
 *   (`row`): the cache-miss marker (a prompt-cache miss reprocessed N tokens)
 *   and the served-model marker (the provider served another model than the
 *   one requested).
 *
 * Terminal look: `omp.divider` / `omp.marker.*` (`src/ui/styles/messages/divider.ts`).
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatNumber } from "@oh-my-pi/pi-utils";

/** What a divider shows and how the terminal draws it. */
export interface DividerProps {
	/** The terminal label (may carry SGR attributes such as bold). */
	readonly label: Reactive<string>;
	/** Symbol key of a glyph the terminal draws before the label (`icon.cacheMiss`). */
	readonly glyph?: string;
	/** Theme color of the label (also its native span style). */
	readonly labelColor: string;
	/** Theme color of the rule (default `dim`). */
	readonly ruleColor?: string;
	/** Rule cells before the label (default 10). */
	readonly ruleWidth?: number;
	/** Role of the native node (default `omp.divider`). */
	readonly role?: string;
	/** Native presentation: an icon and a label instead of a rule. */
	readonly native?: { readonly icon: string; readonly label: Reactive<string> };
	/** When the label leaves no room for the rule: truncate it (default) or let it run (false). */
	readonly truncateWhenNarrow?: boolean;
}

/** A labeled divider. */
export function MessageDivider(props: DividerProps): JSXNode {
	const term = () => ({
		label: read(props.label),
		glyph: props.glyph,
		labelColor: props.labelColor,
		ruleColor: props.ruleColor,
		ruleWidth: props.ruleWidth,
		truncateWhenNarrow: props.truncateWhenNarrow,
	});
	const native = props.native;
	if (native) {
		return (
			<row gap="sm" role={props.role} term={term}>
				<icon name={native.icon} />
				<text spans={() => [{ t: read(native.label), s: props.labelColor }]} truncate="end" />
			</row>
		);
	}
	return (
		<rule
			role={props.role ?? "omp.divider"}
			label={() => {
				// The label reads as the terminal draws it, glyph included (in the active symbol preset).
				const glyph = props.glyph ? currentTheme().symbols.icon(props.glyph) : "";
				const label = stripEscapes(read(props.label));
				return [{ t: glyph ? `${glyph} ${label}` : label, s: props.labelColor }];
			}}
			term={term}
		/>
	);
}

/** A prompt-cache miss: the provider reprocessed `reprocessedTokens` input tokens. */
export interface CacheInvalidation {
	readonly reprocessedTokens: number;
}

/** The cache-miss marker. */
export function CacheMissMarker(props: { info: CacheInvalidation }): JSXNode {
	const tokens = formatNumber(props.info.reprocessedTokens);
	return (
		<MessageDivider
			glyph="icon.cacheMiss"
			label={`cache miss · ${tokens} tokens`}
			labelColor="muted"
			ruleColor="dim"
			ruleWidth={10}
			role="omp.marker.cache-miss"
			native={{ icon: "database", label: `Cache miss · ${tokens} tokens` }}
			truncateWhenNarrow={false}
		/>
	);
}

/** The provider served `served` where `requested` was asked for. */
export interface ServedModelMismatch {
	readonly requested: string;
	readonly served: string;
	readonly provider: string;
}

/** The served-model marker. */
export function ServedModelMarker(props: { info: ServedModelMismatch }): JSXNode {
	const { requested, served, provider } = props.info;
	return (
		<MessageDivider
			glyph="status.warning"
			label={`served ${served} · requested ${requested} · via ${provider}`}
			labelColor="warning"
			ruleColor="dim"
			ruleWidth={10}
			role="omp.marker.served-model"
			native={{
				icon: "warn",
				label: `Served ${served} · requested ${requested} · via ${provider}`,
			}}
		/>
	);
}
