/**
 * Model-mention chips: a `^provider/id[:level]` mention of a model the session
 * can tag shows in the draft as one chip (`⬢ Name`, the symbol preset's model
 * icon) sent as the canonical `^selector`. Prose punctuation right after a
 * mention stays text; a selector whose chip label already stands for another
 * model in the draft stays literal. In restored text, the submitted
 * `<model agent="mN" …/>` tags of known pseudonyms come back as chips. Never
 * in a local-execution draft (`!cmd`, `$ code`).
 */
import { isLocalExecutionDraft } from "../../extensibility/skill-tokens";
import type { ResolvedModelMention } from "../../session/model-mentions";
import {
	MODEL_MENTION_RE,
	MODEL_MENTION_TAG_RE,
	modelMentionToken,
	resolveModelMentionToken,
} from "../../session/model-mention-syntax";
import type { DraftToken, TokenAtomizer } from "./composer";

/** The chip style: the status line's model color, bold. */
const MODEL_CHIP_STYLE = "statusLineModel strong";

export interface ModelMentionSource {
	/** The mentionable model a selector names (canonical selector and display name), if any. */
	resolve(selector: string): Pick<ResolvedModelMention, "selector" | "name"> | undefined;
	/** The selector a submitted pseudonym (`m1`) stands for on this session, if any. */
	selectorOf(agent: string): string | undefined;
	/** The chip glyph. */
	icon(): string;
}

/** An atomizer for model-mention chips over `source`. */
export function modelMentionAtomizer(source: ModelMentionSource): TokenAtomizer {
	return (text, taken) => {
		if ((!text.includes("^") && !text.includes("<model ")) || isLocalExecutionDraft(text)) return [];
		const tokens: DraftToken[] = [];
		// Labels this pass already gave out (a chip registers only after the pass).
		const given = new Map<string, string>();
		const chipFor = (selector: string) => {
			const resolved = source.resolve(selector);
			if (!resolved) return undefined;
			const label = `${source.icon()} ${resolved.name}`;
			const expansion = modelMentionToken(resolved.selector);
			const other = given.get(label);
			if ((other !== undefined && other !== expansion) || taken(label, expansion)) return undefined;
			return { label, selector: resolved.selector };
		};
		const give = (token: DraftToken): void => {
			given.set(token.label, token.expansion);
			tokens.push(token);
		};
		for (const match of text.matchAll(MODEL_MENTION_RE)) {
			const mention = resolveModelMentionToken(
				match[2]!,
				chipFor,
				selector => source.resolve(selector) !== undefined,
			);
			if (!mention) continue;
			const from = match.index + match[1]!.length;
			const matchEnd = match.index + match[0].length;
			give({
				from,
				to: matchEnd - mention.suffix.length,
				matchEnd,
				label: mention.value.label,
				expansion: modelMentionToken(mention.value.selector),
				s: MODEL_CHIP_STYLE,
			});
		}
		for (const match of text.matchAll(MODEL_MENTION_TAG_RE)) {
			const selector = source.selectorOf(match[1]!);
			if (selector === undefined) continue;
			// A known pseudonym comes back as its mention: a chip, or the plain `^selector` when none can show.
			const chip = chipFor(selector);
			const token = modelMentionToken(chip?.selector ?? selector);
			give({
				from: match.index,
				to: match.index + match[0].length,
				label: chip?.label ?? token,
				expansion: token,
				s: MODEL_CHIP_STYLE,
			});
		}
		return tokens.sort((a, b) => a.from - b.from);
	};
}
