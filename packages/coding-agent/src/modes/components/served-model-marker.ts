import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";

/** A turn whose response provably came from a different model than was requested. */
export interface ServedModelMismatch {
	/** Model id the request asked for. */
	requested: string;
	/** Model id recovered from the response (signed thinking block or router report). */
	served: string;
	/** Configured provider the request went to. */
	provider: string;
	/** Upstream host the provider routed to, when it reported one (OpenRouter's `provider`). */
	upstreamProvider?: string;
}

/**
 * Decide whether `message` was served by a model other than the one requested.
 *
 * Compares the requested and served ids through `classifyModel` rather than
 * textually: a snapshot suffix (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`)
 * or a gateway prefix (`anthropic/claude-opus-5`) is the same model, while a
 * different family or revision (`claude-opus-5` → `claude-haiku-4-5`) is a
 * substitution. Ids either side cannot classify — Anthropic's internal A/B
 * codenames (`numbat-v6-…`) show up as served ids on first-party traffic —
 * are unverifiable, not mismatches, so they yield `undefined`.
 */
export function detectServedModelMismatch(message: AssistantMessage): ServedModelMismatch | undefined {
	const served = message.upstreamModel;
	if (!served || served === message.model) return undefined;
	const requested = classifyModel(message.provider, message.model, { lenient: true });
	const actual = classifyModel(message.provider, served, { lenient: true });
	if (requested.class === "unknown" || actual.class === "unknown") return undefined;
	if (
		requested.class === actual.class &&
		requested.family === actual.family &&
		(requested.revision === undefined || actual.revision === undefined || requested.revision === actual.revision)
	) {
		return undefined;
	}
	return {
		requested: message.model,
		served,
		provider: message.provider,
		...(message.upstreamProvider ? { upstreamProvider: message.upstreamProvider } : {}),
	};
}

/**
 * Per-transcript memory that surfaces each distinct (requested → served)
 * substitution once. A gateway that swaps models does so for every turn, so
 * repeating the marker would only add noise; a new pair after a model switch
 * still gets its own marker. Replaced wholesale on rebuild so replaying history
 * re-derives the same first occurrence.
 */
export class ServedModelTracker {
	readonly #announced = new Set<string>();

	/** The mismatch to render for `message`, or undefined when there is none or it was already shown. */
	check(message: AssistantMessage): ServedModelMismatch | undefined {
		const mismatch = detectServedModelMismatch(message);
		if (!mismatch) return undefined;
		const key = `${mismatch.provider}\0${mismatch.requested}\0${mismatch.served}`;
		if (this.#announced.has(key)) return undefined;
		this.#announced.add(key);
		return mismatch;
	}
}

const SERVED_MODEL_RULE_WIDTH = 10;

/**
 * Slim left-aligned divider rendered after the first assistant turn whose
 * response came from a different model than requested. Same shape as the
 * cache-miss divider, in the warning color:
 *
 *   ────────── ⚠ served claude-haiku-4-5-20251001 · requested claude-opus-5 · via openrouter/Amazon Bedrock
 */
export class ServedModelMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: ServedModelMismatch) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const dot = theme.sep.dot.trim();
		const via = this.info.upstreamProvider
			? `${this.info.provider}/${this.info.upstreamProvider}`
			: this.info.provider;
		const label = `${theme.status.warning} served ${this.info.served} ${dot} requested ${this.info.requested} ${dot} via ${via}`;
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(SERVED_MODEL_RULE_WIDTH, width - labelWidth - 1);
		if (ruleWidth < 1) {
			return truncateToWidth(theme.fg("warning", label), width);
		}
		return `${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${theme.fg("warning", label)}`;
	}
}
