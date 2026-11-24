/**
 * Skill chips: a `/skill:<name>` invocation of a known skill shows in the
 * draft as one chip (`✦ name`, the symbol preset's skill icon) that is sent
 * as the token again. The chip links to the skill's SKILL.md (line 1) where
 * the terminal draws links. Unknown skills and tokens that are another
 * command's text (`/plan … /skill:x`, `!cmd`) stay literal.
 */
import { allowsSkillTokens, SKILL_TOKEN_RE } from "../../extensibility/skill-tokens";
import type { DraftToken, TokenAtomizer } from "./composer";

/** The chip style: the custom-message label color, bold. */
const SKILL_CHIP_STYLE = "customMessageLabel strong";

/**
 * An atomizer for skill chips: `skillFile(name)` is the SKILL.md of a known skill (undefined for
 * an unknown one), `icon()` the chip glyph.
 */
export function skillAtomizer(skillFile: (name: string) => string | undefined, icon: () => string): TokenAtomizer {
	return text => {
		if (!text.includes("/skill:") || !allowsSkillTokens(text)) return [];
		const tokens: DraftToken[] = [];
		for (const match of text.matchAll(SKILL_TOKEN_RE)) {
			const name = match[2]!;
			const path = skillFile(name);
			if (path === undefined) continue;
			const from = match.index + match[1]!.length;
			tokens.push({
				from,
				to: match.index + match[0].length,
				label: `${icon()} ${name}`,
				expansion: `/skill:${name}`,
				s: SKILL_CHIP_STYLE,
				link: { path, line: 1 },
			});
		}
		return tokens;
	};
}
