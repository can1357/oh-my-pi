/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * IRC message cards: live agent-to-agent traffic in the transcript —
 * incoming DMs (`IRC ⟵ Anna`), auto-replies sent on this session's behalf
 * (`IRC ➤ Ben auto`), relayed traffic between other agents and workpool
 * fan-outs — with the message's age and its Markdown body.
 *
 * Terminal look: `omp.irc.*` cards (`src/ui/styles/tools/irc.ts`); the
 * transcript's expand state reaches it as `term.expanded`.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { cleanText } from "./agent-common";

export interface IrcMessage {
	readonly kind: "incoming" | "autoreply" | "relay" | "workpool";
	readonly from?: string;
	readonly to?: string;
	readonly body?: string;
	readonly replyTo?: string;
	/** When the message was sent (ms since epoch). */
	readonly timestamp?: number;
	readonly pool?: string;
	readonly mode?: string;
}

/** An IRC heading with the given preset's directional glyph. */
export function ircTitle(card: IrcMessage, theme: Theme): string {
	const from = cleanText(card.from?.trim() || "?");
	const to = cleanText(card.to?.trim() || "?");
	switch (card.kind) {
		case "incoming":
			return `IRC ${theme.symbols.symbol("nav.back")} ${from}`;
		case "autoreply":
			return `IRC ${theme.symbols.symbol("nav.selected")} ${to}`;
		case "workpool":
			return `Pool ${cleanText(card.pool?.trim() || "?")} ${theme.symbols.symbol("nav.selected")} ${to}`;
		case "relay":
			return `IRC ${from} ${theme.symbols.symbol("nav.selected")} ${to}`;
	}
}

/** One IRC message as a card. `expanded` is the transcript's expand state. */
export function IrcMessageCard(props: { readonly message: IrcMessage; readonly expanded?: () => boolean }): JSXNode {
	const card = props.message;
	const body = card.body ?? "";
	const tail: TspSpan[] = [];
	if (card.kind === "autoreply") tail.push({ s: "muted", t: " auto" });
	if (card.kind === "workpool" && card.mode) tail.push({ s: "muted", t: ` ${cleanText(card.mode)}` });
	if (card.replyTo) tail.push({ s: "muted", t: " reply" });
	const expanded = props.expanded;
	return (
		<card
			role={`omp.irc.${card.kind}`}
			tone="info"
			head={() => [{ s: "toolTitle strong", t: ircTitle(card, currentTheme()) }, ...tail]}
			collapsible={body.trim().length > 0}
			preview={{ lines: 3 }}
			term={() => ({ message: card, expanded: expanded?.() === true })}
		>
			{card.timestamp ? (
				<row gap="xs">
					<elapsed age={Date.now() - card.timestamp} format="short" />
					<text spans={[{ s: "dim", t: "ago" }]} />
				</row>
			) : undefined}
			{body.trim() ? <md text={body} /> : undefined}
		</card>
	);
}
