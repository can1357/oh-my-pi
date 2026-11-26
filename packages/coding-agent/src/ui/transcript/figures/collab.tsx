/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Collaboration blocks: a guest's prompt as a user bubble headed by its
 * sender, and the join link with its QR code.
 *
 * Terminal looks: `src/ui/styles/figures/collab.ts`.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { computed, type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { encodeQr, qrHalfBlocks } from "./qr";

/** A collab guest's prompt as the session records it (`customType: "collab"`). */
export interface CollabPromptMessage {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly details?: { readonly from?: string };
}

/** Terminal facts of a collab prompt card. */
export type CollabPromptTerm = {
	readonly sender: string;
};

/** A guest's prompt: `«sender» ›` over the prompt's Markdown (text parts only). */
export function CollabPrompt(props: { readonly message: CollabPromptMessage }): JSXNode {
	const message = props.message;
	const sender = sanitizeText(message.details?.from ?? "").trim() || "guest";
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
	const term: CollabPromptTerm = { sender };
	return (
		<card role="omp.user.collab" tone="user" head={[{ t: `«${sender}» ›`, s: "accent strong" }]} term={term}>
			<md text={text} />
		</card>
	);
}

/** Terminal facts of a collab QR block: the symbol drawn dark-on-light. */
export type CollabQrTerm = {
	readonly url: string;
	readonly rows: readonly string[];
};

/** The join link as a QR code (error correction M) under the link. */
export function CollabQrCode(props: {
	readonly url: string;
	/** The terminal's appearance (default: the active theme's): a dark one inks the light modules natively. */
	readonly dark?: Reactive<boolean>;
}): JSXNode {
	const symbol = encodeQr(props.url, "M");
	const term: CollabQrTerm = { url: props.url, rows: qrHalfBlocks(symbol, "dark") };
	const native = computed(() =>
		qrHalfBlocks(symbol, (props.dark === undefined ? currentTheme().dark : read(props.dark)) ? "light" : "dark").join(
			"\n",
		),
	);
	return (
		<col role="omp.collab.qrcode" term={term}>
			<text spans={[{ t: props.url.replace(/^https?:\/\//, ""), s: "accent link", href: props.url }]} wrap="none" />
			<code text={native} lang="text" wrap={false} />
		</col>
	);
}
