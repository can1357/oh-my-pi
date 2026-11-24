/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A user-invoked skill: a user-toned card headed by the skill chip (linked to
 * its SKILL.md) and the prompt's size, the user's draft always visible, and
 * the loaded skill prompt behind a disclosure.
 *
 * The terminal draws one of two layouts, chosen by where `/skill:<name>` sat
 * in the draft: a callout with a skill-colored rail when it led the draft
 * (the chip and size head it, the rest of the draft under them), or the
 * draft as a plain user bubble with the chip inline when it sat mid-prompt
 * (the callout then only holds the expanded prompt).
 *
 * Terminal look: `omp.skill` (`src/ui/styles/messages/skill.ts`).
 */
import type { JSXNode, Reactive } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { SkillPromptDetails } from "../../../session/transcript/messages";
import { cardExpansion } from "../expansion";
import { chipText, termChips } from "./chips";
import { openableImage } from "./image";

/** The skill chip glyph (the unicode symbol preset's `icon.extensionSkill`). */
const SKILL_GLYPH = "✦";

/** What a skill row shows. */
export interface SkillMessageProps {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly details?: Partial<SkillPromptDetails>;
	/** Files of attached images by chip number − 1. */
	readonly imageLinks?: readonly (string | undefined)[];
	readonly expanded: Reactive<boolean>;
	readonly onToggle?: (expanded: boolean) => void;
}

function promptText(content: SkillMessageProps["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap(part => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
}

/** A skill invocation. */
export function SkillMessage(props: SkillMessageProps): JSXNode {
	const details = props.details;
	const name = details?.name?.trim() || "unknown";
	const token = `/skill:${name}`;
	const prompt = details?.prompt ?? (details?.args ? `${token} ${details.args}` : token);
	const label = `${SKILL_GLYPH} ${name}`;
	// Only the invoked skill becomes a chip: another `/skill:` token the dispatcher ignored stays literal.
	const display = prompt.replace(new RegExp(`${RegExp.escape(token)}(?![\\w./-])`, "g"), label);
	const leading = display.startsWith(label) && /^\s*$/.test(display.charAt(label.length));
	const draft = leading ? display.slice(label.length).trim() : display;
	const href = details?.path ? openableImage(details.path).href : undefined;
	const head: TspSpan[] = [
		href ? { t: label, s: "customMessageLabel strong", href } : { t: label, s: "customMessageLabel strong" },
	];
	const lines =
		typeof details?.lineCount === "number"
			? `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`
			: undefined;
	if (lines) head.push({ t: `  ${lines}`, s: "muted" });
	const text = promptText(props.content);
	const chips = chipText(draft, {
		imageLinks: props.imageLinks,
		skillPath: candidate => (candidate === name ? details?.path : undefined),
	});
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	return (
		<card
			role="omp.skill"
			tone="user"
			head={head}
			term={() => ({
				label,
				...(details?.path ? { path: details.path } : {}),
				lines,
				leading,
				draft: chips.text,
				chips: termChips(chips.chips),
				prompt: text,
				expanded: expanded(),
			})}
		>
			{draft && <md text={draft} />}
			<section
				key="prompt"
				head={[{ t: "prompt", s: "muted" }]}
				role="omp.skill.prompt"
				collapsible
				collapsed={() => !expanded()}
				onToggle={toggle}
			>
				{() => expanded() && text && <md text={text} />}
			</section>
		</card>
	);
}
