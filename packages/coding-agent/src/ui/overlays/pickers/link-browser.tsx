/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The extension link browser: the session's replies on the alternate screen,
 * so links an extension owns (registered link schemes) that scrolled into
 * the terminal's history can still be picked.
 *
 * The terminal draws the replies' prose with every extension link label
 * tagged (typing a tag picks its link; a click on a label picks it too),
 * scrolled with ↑/↓, PgUp/PgDn, Home/End and the wheel; Esc closes. It opens
 * at the bottom. A Tern terminal clicks extension links in the transcript
 * itself: natively the browser is a card listing every extension link of the
 * replies, a pick activates it.
 *
 * The terminal look is `omp.overlay.linkBrowser` (`src/ui/styles/pickers/link-browser.ts`).
 */
import { computed, type JSXNode, type KeyEvent, read, type Reactive, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { lexMarkdown, type Token, type Tokens } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import "../../styles/pickers/link-browser";
import { type LinkBrowserTerm, linkBrowserMeasure } from "../../styles/pickers/link-browser";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

/** One reply's prose (its text blocks, as the transcript draws them). */
export interface LinkReply {
	/** Stable across redraws of the same reply (its entry id). */
	readonly id: string;
	readonly text: string;
}

/** An extension link of a reply: its label and URL, in reading order. */
export interface ExtensionLink {
	readonly label: string;
	readonly url: string;
}

export interface LinkBrowserProps {
	/** The replies, oldest first; a host redrawing a reply replaces its text. */
	readonly replies: Reactive<readonly LinkReply[]>;
	/** Registered extension link schemes (lowercase, without `:`). */
	readonly schemes: Reactive<readonly string[]>;
	/** Terminal rows the browser fills. */
	readonly rows: Reactive<number>;
	/** A link was picked: raise `link_activate` for `url`. */
	onActivate(url: string): void;
	onClose(): void;
}

/** The extension links of `text` in reading order (Markdown draws each as its label alone). */
export function extensionLinks(text: string, schemes: readonly string[]): ExtensionLink[] {
	const links: ExtensionLink[] = [];
	if (schemes.length === 0) return links;
	const visit = (tokens: readonly Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "link") {
				const link = token as Tokens.Link;
				const colon = link.href.indexOf(":");
				if (colon > 0 && schemes.includes(link.href.slice(0, colon).toLowerCase()))
					links.push({ label: link.text, url: link.href });
				continue;
			}
			if (token.type === "code" || token.type === "codespan") continue;
			if (token.type === "table") {
				const table = token as Tokens.Table;
				for (const cell of [...table.header, ...table.rows.flat()]) visit(cell.tokens);
				continue;
			}
			if ("tokens" in token && Array.isArray(token.tokens)) visit(token.tokens as Token[]);
			if (token.type === "list") visit((token as Tokens.List).items);
		}
	};
	visit(lexMarkdown(text));
	return links;
}

/** Whether any reply draws an extension link (the host opens the browser only then). */
export function hasExtensionLinks(replies: readonly LinkReply[], schemes: readonly string[]): boolean {
	return replies.some(reply => extensionLinks(reply.text, schemes).length > 0);
}

/** The extension link browser. */
export function LinkBrowser(props: LinkBrowserProps): JSXNode {
	/** First body row shown; Infinity: the bottom. */
	const offset = signal(Number.POSITIVE_INFINITY);
	/** Tag letters typed so far. */
	const typed = signal("");
	let sheet: UiNode | undefined;

	/** Scroll by `delta` rows from where the last paint showed the body. */
	const scroll = (delta: number | "top" | "bottom"): void => {
		const measure = sheet ? linkBrowserMeasure(sheet) : undefined;
		const max = measure?.max ?? 0;
		const from = Math.min(offset(), max);
		const next = delta === "top" ? 0 : delta === "bottom" ? max : Math.max(0, Math.min(max, from + delta));
		offset.set(next);
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const page = Math.max(1, (sheet ? linkBrowserMeasure(sheet)?.visible : undefined) ?? 1) - 1;
		if (matchesSelectCancel(key)) {
			props.onClose();
			return true;
		}
		switch (selectKeyId(key)) {
			case "up":
				scroll(-1);
				return true;
			case "down":
				scroll(1);
				return true;
			case "pageUp":
				scroll(-Math.max(1, page));
				return true;
			case "pageDown":
				scroll(Math.max(1, page));
				return true;
			case "home":
				scroll("top");
				return true;
			case "end":
				scroll("bottom");
				return true;
		}
		if (!/^[a-z]$/.test(key.id)) return true;
		const measure = sheet ? linkBrowserMeasure(sheet) : undefined;
		if (!measure || measure.crowded) return true;
		const next = typed() + key.id;
		const matching = measure.tags.filter(hint => hint.tag.startsWith(next));
		const picked = matching.length === 1 && matching[0]!.tag === next ? matching[0]! : undefined;
		if (matching.length === 0 || picked) {
			typed.set("");
			if (picked) props.onActivate(picked.url);
		} else typed.set(next);
		return true;
	};

	const links = computed(() => {
		const schemes = read(props.schemes);
		return read(props.replies).flatMap(reply => extensionLinks(reply.text, schemes));
	});
	/** Pick link `item` (its index among every reply's extension links). */
	const activate = (item: string): void => {
		const link = links()[Number(item)];
		if (link) props.onActivate(link.url);
	};

	const term = computed((): LinkBrowserTerm => ({
		role: "omp.overlay.linkBrowser",
		replies: read(props.replies).map(reply => reply.text),
		schemes: read(props.schemes),
		offset: offset(),
		typed: typed(),
		height: read(props.rows),
	}));

	return (
		<card
			role="omp.overlay.linkBrowser"
			head="Extension links"
			term={term}
			ref={node => {
				sheet = node;
			}}
			onKey={onKey}
			onAction={(act, event) => {
				if (act === "scroll") scroll(Number(event.value) || 0);
				else if (act === "pick" && event.value) props.onActivate(event.value);
			}}
			onActivate={activate}
			onSelect={activate}
		>
			<text
				key="note"
				spans={[{ s: "muted", t: "Pick an extension link anywhere in the transcript" }]}
				wrap="word"
			/>
			<list key="links" actions={{ click: "activate" }} empty={[{ s: "muted", t: "No extension links" }]}>
				{() =>
					links().map((link, index) => (
						<item key={String(index)} label={link.label} detail={[{ s: "dim", t: link.url }]} />
					))
				}
			</list>
		</card>
	);
}
