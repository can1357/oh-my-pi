/**
 * Rich pastes: the HTML a clipboard holds (a web page's selection, a document's, a copy from
 * Tern's composer) as the Markdown the composer takes, the images it carries inline (`data:`
 * URLs) becoming attachments where they stood.
 *
 * Text keeps its characters (no Markdown escaping: the reader is a model, not a renderer).
 * Preformatted HTML keeps its text verbatim: `<pre>` code becomes a fenced block, and an
 * element styled `white-space: pre*` (a code editor's copy, Tern's composer) its exact text.
 * HTML that is all preformatted and carries no image (code copied from an editor, a lone
 * code block) is pasted as that text alone, as its plain text would be.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { parseHtmlFragment, type TurndownNode } from "@oh-my-pi/pi-utils/turndown";
import { createTurndown } from "./turndown";

/** One piece of a rich paste, in order: Markdown text or an image to attach. */
export type HtmlPastePart = string | ImageContent;

/** Stands in for an image while the Markdown is built; split on afterwards. */
const IMAGE_SLOT = "\uE000";
const PREFORMATTED_STYLE = /white-space\s*:\s*(?:pre|pre-wrap|pre-line|break-spaces)\b/i;
const NORMAL_WEIGHT_STYLE = /font-weight\s*:\s*(?:normal|[1-4]00)\b/i;
const DATA_IMAGE_URL = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/i;
/** Elements whose content is never text the user meant to paste. */
const DROPPED = ["head", "title", "meta", "link", "style", "script", "noscript", "template"];
/** Elements that start a line inside preformatted text. */
const LINE_ELEMENTS: Readonly<Record<string, true>> = {
	DIV: true,
	P: true,
	LI: true,
	TR: true,
	PRE: true,
	BLOCKQUOTE: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
};

/**
 * `html` as paste parts: Markdown text with the images it carries between. Undefined when it
 * holds nothing to paste.
 */
export function htmlToPaste(html: string): HtmlPastePart[] | undefined {
	const root = parseHtmlFragment(html);
	const images: ImageContent[] = [];
	const markdown = allPreformatted(root) ? verbatim(root, images).trim() : convert(root, images);
	const parts: HtmlPastePart[] = [];
	markdown.split(IMAGE_SLOT).forEach((text, index) => {
		const image = index > 0 ? images[index - 1] : undefined;
		if (image) parts.push(image);
		if (text) parts.push(text);
	});
	return parts.some(part => typeof part !== "string" || part.trim()) ? parts : undefined;
}

/** Markdown of `root`, its `data:` images replaced by {@link IMAGE_SLOT}s appended to `images`. */
function convert(root: TurndownNode, images: ImageContent[]): string {
	const turndown = createTurndown();
	turndown.escape = text => text;
	turndown.remove(DROPPED);
	turndown.addRule("lineBreak", { filter: "br", replacement: () => "\n" });
	turndown.addRule("pastedImage", {
		filter: node => node.nodeName === "IMG" && (node.getAttribute("src") ?? "").startsWith("data:"),
		replacement: (_content, node) => image(node, images),
	});
	turndown.addRule("preformattedStyle", {
		filter: node => node.nodeName !== "PRE" && PREFORMATTED_STYLE.test(node.getAttribute("style") ?? ""),
		skipContent: true,
		replacement: (_content, node) => {
			const text = verbatim(node, images);
			return LINE_ELEMENTS[node.nodeName] ? `\n\n${text.replace(/\n+$/, "")}\n\n` : text;
		},
	});
	// Google Docs wraps a whole copy in `<b style="font-weight:normal">`.
	turndown.addRule("normalWeight", {
		filter: node =>
			(node.nodeName === "B" || node.nodeName === "STRONG") &&
			NORMAL_WEIGHT_STYLE.test(node.getAttribute("style") ?? ""),
		replacement: content => content,
	});
	return turndown.turndown(root);
}

/** The text of `node` as written, line elements on their own lines and `data:` images as slots. */
function verbatim(node: TurndownNode, images: ImageContent[]): string {
	let out = "";
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 3) {
			out += child.textContent ?? "";
		} else if (child.nodeType !== 1 || DROPPED.includes(child.nodeName.toLowerCase())) {
			continue;
		} else if (child.nodeName === "BR") {
			out += "\n";
		} else if (child.nodeName === "IMG") {
			out += (child.getAttribute("src") ?? "").startsWith("data:")
				? image(child, images)
				: (child.getAttribute("alt") ?? "");
		} else if (LINE_ELEMENTS[child.nodeName]) {
			// A line's closing `<br>` ends it; it adds no line of its own.
			const line = verbatim(child, images).replace(/\n$/, "");
			if (out && !out.endsWith("\n")) out += "\n";
			out += `${line}\n`;
		} else {
			out += verbatim(child, images);
		}
	}
	return out;
}

/** A slot for `img`'s `data:` image, appended to `images`; its `alt` when the URL holds no image. */
function image(img: TurndownNode, images: ImageContent[]): string {
	const match = DATA_IMAGE_URL.exec(img.getAttribute("src") ?? "");
	if (!match?.[1] || !match[2]) return img.getAttribute("alt") ?? "";
	images.push({ type: "image", mimeType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, "") });
	return IMAGE_SLOT;
}

/** Whether every non-blank text of `root` is preformatted and no `data:` image is in it. */
function allPreformatted(root: TurndownNode): boolean {
	let text = false;
	const visit = (node: TurndownNode, pre: boolean): boolean => {
		if (node.nodeType === 3) {
			if (!(node.textContent ?? "").trim()) return true;
			text = true;
			return pre;
		}
		if (node.nodeType === 1) {
			const name = node.nodeName;
			if (DROPPED.includes(name.toLowerCase())) return true;
			if (name === "IMG" && (node.getAttribute("src") ?? "").startsWith("data:")) return false;
			pre ||= name === "PRE" || PREFORMATTED_STYLE.test(node.getAttribute("style") ?? "");
		}
		return Array.from(node.childNodes).every(child => visit(child, pre));
	};
	return visit(root, false) && text;
}
