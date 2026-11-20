import { containsWrapperTag } from "../hindsight/content";

/**
 * Cheap deterministic content-risk classification for recalled and retained rows.
 *
 * This is a heuristic that MARKS, never deletes (demote+mark, never delete —
 * the same posture as the conflict ledger): `injection` demotes the row in the
 * render ladder and surfaces a `[suspect]` marker; `wrapper` records that the
 * payload carried envelope wrapper tags (the renderer shears them either way).
 * Strong signatures only: instruction-shaped project knowledge (tool mandates,
 * repo conventions, user demands) is exactly the valuable content and MUST pass
 * clean, and rows quoting attack phrasings in documentation only get demoted —
 * never lost.
 */
export function detectSuspectContent(text: string): "injection" | "wrapper" | undefined {
	if (INJECTION_OVERRIDE_REGEX.test(text) || ROLE_IMPERSONATION_REGEX.test(text)) return "injection";
	if (containsWrapperTag(text)) return "wrapper";
	return undefined;
}

/** Instruction-override phrasings aimed at the assistant ("ignore previous instructions…"). */
const INJECTION_OVERRIDE_REGEX =
	/\b(?:ignore|disregard|forget|overrule|override)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|directives?|context)\b/i;

/** Assistant role impersonation: fake protocol tags or persona reassignment. */
const ROLE_IMPERSONATION_REGEX = /\[(?:system|assistant)\]|<\/?system\b|<\|system\|>|\byou are now (?:a|an|the)\b/i;
