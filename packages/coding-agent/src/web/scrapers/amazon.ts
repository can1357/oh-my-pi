/**
 * Amazon product pages. Keeps only the product's own data (title, byline, price,
 * variants, spec tables, A+ copy, ratings, reviews) and drops navigation, ads,
 * sponsored carousels, and page chrome.
 * Returns null for pages without `#productTitle` (captcha, search, error) so the
 * generic reader takes over.
 */
import type { Document as AmazonDocument, Element, Node } from "@oh-my-pi/pi-utils/dom";
import {
	AMAZON_HOST,
	AMAZON_PAGE_OPTIONS,
	buildResult,
	htmlToBasicMarkdown,
	loadPage,
	type SpecialHandler,
} from "./types";
import { ToolAbortError } from "../../tools/tool-errors";

interface AmazonPage {
	doc: AmazonDocument;
	/** Hostname product links are rewritten against, e.g. `www.amazon.in`. */
	host: string;
	html: string;
	pageAsin: string | null;
}

interface Section {
	heading: string;
	/** Candidate containers: the first non-empty one is used, or all of them when `firstOnly` is unset. */
	ids?: string[];
	firstOnly?: boolean;
	/** Keep preloaded popover panels; for some sections they hold the only copy of a fact. */
	preload?: boolean;
	render?: (ctx: AmazonPage) => Promise<string | null> | string | null;
}

interface DetailRow {
	panel: string;
	label: string;
	value: string;
}

const PRODUCT_PATH = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?#]|$)/i;
const PRODUCT_IMAGE = /\/images\/I\//;
const DROP_ELEMENTS =
	"script,style,link,meta,noscript,iframe,svg,button,form,input,select,textarea,video,audio,source,track,canvas,hr,legend";

/** Sections in output order; custom ones carry a `render` instead of container ids. */
const SECTIONS: Section[] = [
	{
		heading: "Price",
		firstOnly: true,
		ids: [
			"corePriceDisplay_desktop_feature_div",
			"corePrice_feature_div",
			"price_inside_buybox",
			"corePrice_desktop",
			"unifiedPrice_feature_div",
			"fodcx_feature_div",
			"apex_desktop",
		],
	},
	{ heading: "Availability", firstOnly: true, ids: ["availability"] },
	{
		heading: "Newer model",
		firstOnly: true,
		ids: ["generationsWidgetBelowPriceBlock_feature_div", "generationsWidgetBelowTwister_feature_div"],
	},
	{ heading: "Recent purchases", firstOnly: true, ids: ["socialProofingAsinFaceout_feature_div"] },
	{ heading: "Offers", ids: ["soppATF_feature_div", "inemi_feature_div", "promoPriceBlockMessage_feature_div"] },
	{ heading: "Protection plans", firstOnly: true, ids: ["mbb_feature_div"], preload: true },
	{ heading: "Delivery and returns", firstOnly: true, ids: ["iconfarmv2_feature_div"] },
	{ heading: "Variants", render: renderVariants },
	{ heading: "Images", render: renderImages },
	{ heading: "About this item", firstOnly: true, ids: ["feature-bullets"] },
	{
		heading: "Top Brand",
		firstOnly: true,
		ids: [
			"brandInsights_feature_div_1",
			"brandInsights_feature_div_2",
			"brandInsights_feature_div_3",
			"brandInsights_feature_div_4",
		],
	},
	{ heading: "Product overview", firstOnly: true, ids: ["productOverview_feature_div"] },
	{ heading: "Product details", render: renderDetails },
	{
		heading: "Important information",
		firstOnly: true,
		ids: ["importantInformation_feature_div", "important-information"],
	},
	{
		heading: "Description",
		ids: [
			"productDescription",
			"bookDescription_feature_div",
			"editorialReviews_feature_div",
			"btfContent3_feature_div",
		],
	},
	{ heading: "From the manufacturer", firstOnly: true, ids: ["aplus_feature_div"] },
	{ heading: "Technical details", render: ctx => renderDetails(ctx, ["tech"]) },
	{ heading: "Product documents", firstOnly: true, ids: ["productDocuments_feature_div", "productDocuments"] },
	{ heading: "Ratings", render: renderRatings },
	{ heading: "Reviews", render: renderReviews },
];

/** Collapse whitespace and strip the bidi marks Amazon sprinkles into spec labels
 * (both as characters and as the double-escaped `&rlm;`/`&lrm;` text seen on some pages). */
function singleLine(el: Element): string {
	const text = (el.textContent ?? "").replace(/[\u200e\u200f]|&(?:rlm|lrm);/gi, "");
	return text.replace(/\s+/g, " ").trim();
}

function stripCommentNodes(node: Node): void {
	let child = node.firstChild;
	while (child) {
		const next = child.nextSibling;
		if (child.nodeType === 8) child.remove();
		else stripCommentNodes(child);
		child = next;
	}
}

/** Enforce the output link policy on a cloned subtree: product links keep a /dp/<ASIN> target,
 * every other link keeps only its text; only /images/I/ images survive. */
function cleanFragment(root: Element, host: string, preload = false): void {
	for (const el of root.querySelectorAll(
		`${DROP_ELEMENTS},.a-hidden,.a-offscreen,.aok-offscreen,.a-carousel-goto-prevpage,.a-carousel-goto-nextpage${preload ? "" : ",.a-popover-preload"}`,
	))
		el.remove();
	stripCommentNodes(root);
	// Layout tables (one row, one cell) hold prose, not rows; turndown would make them one-column tables.
	for (const table of root.querySelectorAll("table")) {
		const row = table.querySelector("tr");
		const parent = table.parentNode;
		if (!row || !parent || row.children.length !== 1 || table.querySelectorAll("tr").length !== 1) continue;
		const cell = row.children[0];
		while (cell.firstChild) parent.insertBefore(cell.firstChild, table);
		table.remove();
	}
	for (const img of root.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? img.getAttribute("data-src") ?? "";
		if (!PRODUCT_IMAGE.test(src) || /\.gif(\?|$)/i.test(src)) {
			img.remove();
			continue;
		}
		img.setAttribute("src", src);
		img.removeAttribute("srcset");
		img.removeAttribute("data-src");
	}
	for (const link of root.querySelectorAll("a")) {
		const asin = PRODUCT_PATH.exec(link.getAttribute("href") ?? "")?.[1];
		if (asin) {
			link.setAttribute("href", `https://${host}/dp/${asin}`);
			continue;
		}
		const parent = link.parentNode;
		if (!parent) continue;
		while (link.firstChild) parent.insertBefore(link.firstChild, link);
		link.remove();
	}
}

async function fragmentMarkdown(el: Element, host: string, preload = false): Promise<string> {
	const clone = el.cloneNode(true) as Element;
	cleanFragment(clone, host, preload);
	// Lazy, like the parser: the turndown stack stays off the CLI startup graph.
	const { normalizeTablesHtml } = await import("../../utils/turndown");
	return htmlToBasicMarkdown(normalizeTablesHtml(clone.innerHTML));
}

function stripHeadingEcho(markdown: string, heading: string): string {
	const normalize = (text: string): string =>
		text
			.replace(/^#+\s*/, "")
			.replace(/[*_:]/g, "")
			.trim()
			.toLowerCase();
	const target = normalize(heading);
	const lines = markdown.split("\n").filter(line => {
		const text = normalize(line);
		return !text || (text !== target && !(/^#+\s/.test(line) && text.startsWith(`${target} `)));
	});
	return lines.join("\n").trim();
}

async function textSection(ctx: AmazonPage, section: Section): Promise<string | null> {
	const parts: string[] = [];
	for (const id of section.ids ?? []) {
		for (const el of ctx.doc.querySelectorAll(`#${id}`)) {
			const markdown = stripHeadingEcho(await fragmentMarkdown(el, ctx.host, section.preload), section.heading);
			if (!markdown) continue;
			parts.push(markdown);
			if (section.firstOnly) break;
		}
		if (section.firstOnly && parts.length > 0) break;
	}
	const joined = parts.join("\n\n").trim();
	return joined || null;
}

/** Name of the collapsed panel a spec table sits in, e.g. `Item details`. */
function panelName(el: Element): string {
	const content = el.closest("div[data-expanded]");
	const prompt = content?.previousElementSibling?.querySelector(".a-expander-prompt");
	if (prompt) return singleLine(prompt);
	const heading = el.closest(".content-grid-row-wrapper")?.previousElementSibling?.querySelector("h3");
	return heading ? singleLine(heading) : "";
}

function detailRows(container: Element, host: string): DetailRow[] {
	const clone = container.cloneNode(true) as Element;
	cleanFragment(clone, host);
	const rows: DetailRow[] = [];
	for (const tr of clone.querySelectorAll("tr")) {
		const cells = tr.children.filter(child => child.tagName === "TH" || child.tagName === "TD");
		if (cells.length < 2) continue;
		const label = singleLine(cells[0]);
		const value = cells
			.slice(1)
			.map(cell => singleLine(cell))
			.filter(Boolean)
			.join(" ");
		if (label && value) rows.push({ panel: panelName(tr), label, value });
	}
	for (const li of clone.querySelectorAll("li")) {
		const labelEl = li.querySelector("span.a-text-bold");
		if (!labelEl) continue;
		const label = singleLine(labelEl).replace(/\s*:\s*$/, "");
		const rest = li.cloneNode(true) as Element;
		for (const bold of rest.querySelectorAll("span.a-text-bold")) bold.remove();
		const value = singleLine(rest);
		if (label && value) rows.push({ panel: panelName(li), label, value });
	}
	return rows;
}

async function renderDetails(
	ctx: AmazonPage,
	ids: string[] = [
		"productDetails_feature_div",
		"prodDetails",
		"detailBullets_feature_div",
		"item_details",
		"measurements",
	],
): Promise<string | null> {
	const containers: Element[] = [];
	for (const id of ids) {
		for (const el of ctx.doc.querySelectorAll(`#${id}`)) {
			if (containers.some(container => container.contains(el))) continue;
			containers.push(el);
		}
	}
	const rows: DetailRow[] = [];
	const seen = new Set<string>();
	for (const container of containers) {
		for (const row of detailRows(container, ctx.host)) {
			const key = `${row.panel}\u0000${row.label}\u0000${row.value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rows.push(row);
		}
	}
	if (rows.length === 0) return null;
	const out: string[] = [];
	let panel = "\u0000";
	for (const row of rows) {
		if (row.panel !== panel) {
			panel = row.panel;
			if (panel) out.push("", `### ${panel}`, "");
		}
		out.push(`| ${row.label.replace(/\|/g, "\\|")} | ${row.value.replace(/\|/g, "\\|")} |`);
	}
	return out.join("\n");
}

function dimensionName(row: Element): string {
	const dimension = /^inline-twister-row-(.+)$/.exec(row.id)?.[1] ?? "";
	const label = row.querySelector(`#inline-twister-dim-title-${dimension}`)?.querySelector(".a-color-secondary");
	if (label) return singleLine(label).replace(/\s*:\s*$/, "");
	const aria = /Selected\s+(.+?)\s+is\b/i.exec(
		row.querySelector(".dimension-heading")?.getAttribute("aria-label") ?? "",
	);
	return aria?.[1] ?? dimension.replace(/_/g, " ");
}

function optionLabel(option: Element): string {
	const text = option.querySelector(".swatch-title-text-display");
	const image = option.querySelector("img.swatch-image");
	if (text) return singleLine(text);
	if (image) return (image.getAttribute("alt") ?? "").trim();
	return singleLine(option)
		.replace(/see available options/gi, "")
		.trim();
}

function renderVariants(ctx: AmazonPage): string | null {
	const roots: Element[] = [];
	for (const id of ["twister_feature_div", "twister-plus-inline-twister-container", "tmmSwatches"]) {
		for (const el of ctx.doc.querySelectorAll(`#${id}`)) {
			if (roots.some(root => root.contains(el))) continue;
			roots.push(el);
		}
	}
	const lines: string[] = [];
	const seen = new Set<string>();
	const add = (dimension: string, option: string, asin: string): void => {
		if (!option) return;
		const line = `- ${dimension}: ${option}${asin ? ` (${asin})` : ""}`;
		if (seen.has(line)) return;
		seen.add(line);
		lines.push(line);
	};
	for (const root of roots) {
		for (const row of root.querySelectorAll(".inline-twister-row")) {
			const dimension = dimensionName(row);
			for (const option of row.querySelectorAll("li[data-asin], li[data-defaultasin]")) {
				const asin =
					option.getAttribute("data-asin") ??
					option.getAttribute("data-defaultasin") ??
					option.getAttribute("data-csa-c-item-id") ??
					ctx.pageAsin ??
					"";
				add(dimension, optionLabel(option), asin);
			}
		}
		for (const singleton of root.querySelectorAll(".inline-twister-singleton-header")) {
			const dimension = singleLine(singleton.querySelector(".inline-twister-dim-title") ?? singleton).replace(
				/\s*:\s*$/,
				"",
			);
			const value =
				singleton.querySelector('[id^="inline-twister-expanded-dimension-text"]') ??
				singleton.querySelector(".inline-twister-dim-title-value");
			add(dimension, value ? singleLine(value) : "", ctx.pageAsin ?? "");
		}
		// Book formats live outside the twister, in the tmm swatch list.
		for (const swatch of root.querySelectorAll(".swatchElement")) {
			const href = swatch.querySelector("a[href]")?.getAttribute("href") ?? "";
			add("Format", singleLine(swatch.querySelector(".slot-title") ?? swatch), PRODUCT_PATH.exec(href)?.[1] ?? "");
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

function renderImages(ctx: AmazonPage): string | null {
	const images: string[] = [];
	const add = (url: string | undefined): void => {
		if (url && PRODUCT_IMAGE.test(url) && !images.includes(url)) images.push(url);
	};
	for (const match of ctx.html.matchAll(/"hiRes":"(https:\/\/[^"]+\/images\/I\/[^"]+)"/g)) add(match[1]);
	if (images.length === 0) {
		for (const match of ctx.html.matchAll(/"large":"(https:\/\/[^"]+\/images\/I\/[^"]+)"/g)) add(match[1]);
	}
	if (images.length === 0) {
		for (const img of ctx.doc.querySelectorAll("img[data-old-hires]"))
			add(img.getAttribute("data-old-hires") ?? undefined);
	}
	return images.length > 0 ? images.map(url => `- ![](${url})`).join("\n") : null;
}

function renderRatings(ctx: AmazonPage): string | null {
	const stars = (ctx.doc.querySelector("#acrPopover")?.getAttribute("title") ?? "").trim();
	const countEl = ctx.doc.querySelector("#acrCustomerReviewText");
	const count = countEl ? (countEl.getAttribute("aria-label") ?? singleLine(countEl).replace(/[()]/g, "")).trim() : "";
	const lines: string[] = [];
	const head = [stars, count ? `(${count})` : ""].filter(Boolean).join(" ");
	if (head) lines.push(head);
	const histogram: string[] = [];
	for (const bar of ctx.doc.querySelectorAll("#histogramTable a[aria-label]")) {
		const match = /^(\d+) percent of reviews have (\d+) star/.exec(bar.getAttribute("aria-label") ?? "");
		if (match) histogram.push(`- ${match[2]} star: ${match[1]}%`);
	}
	if (histogram.length > 0) lines.push("", ...histogram);
	const insights = ctx.doc.querySelector('[data-csa-c-item-id="cr-product-insights-detail-page"]');
	if (insights) {
		const clone = insights.cloneNode(true) as Element;
		cleanFragment(clone, ctx.host);
		const summary = clone.querySelector('[data-testid="overall-summary"]');
		if (summary) {
			const text = singleLine(summary);
			if (text) lines.push("", "### Customers say", "", text);
		}
		// The aspect chips sit inside buttons, which the cleaner drops; read them off the raw tree.
		const aspects: string[] = [];
		for (const label of insights.querySelectorAll('[data-testid="aspect-label"]')) {
			const aspect = label.cloneNode(true) as Element;
			stripCommentNodes(aspect);
			const text = singleLine(aspect).replace(/\((\d+)\)$/, " ($1)");
			if (text && !aspects.includes(text)) aspects.push(text);
		}
		if (aspects.length > 0) lines.push("", ...aspects.map(text => `- ${text}`));
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

function reviewField(review: Element, selector: string): string {
	const el = review.querySelector(selector);
	return el ? singleLine(el) : "";
}

async function renderReviews(ctx: AmazonPage): Promise<string | null> {
	const scope = ctx.doc.querySelector("#reviewsMedley") ?? ctx.doc;
	const blocks: string[] = [];
	for (const review of scope.querySelectorAll('[data-hook="review"]')) {
		const title = reviewField(review, '[data-hook="reviewTitle"]');
		const stars = reviewField(review, '[data-hook="review-star-rating"] .a-icon-alt');
		const author = reviewField(review, ".a-profile-name");
		const date = reviewField(review, '[data-hook="review-date"]');
		const variations: string[] = [];
		for (const span of review.querySelectorAll('[data-hook="format-strip"] span')) {
			const text = singleLine(span);
			if (text && !variations.includes(text)) variations.push(text);
		}
		let variation = variations.join(", ");
		if (!variation) {
			const strip = review.querySelector('[data-hook="product-variation-attributes"]');
			variation = strip
				? singleLine(strip)
						.replace(/verified purchase/i, "")
						.trim()
				: "";
		}
		const verified = review.querySelector('[data-hook="avp-badge"]') ? "Verified Purchase" : "";
		const helpful = reviewField(review, '[data-hook="helpful-vote-statement"]');
		const clone = review.cloneNode(true) as Element;
		cleanFragment(clone, ctx.host);
		const bodyEl =
			clone.querySelector('[data-hook="reviewRichContentContainer"]') ??
			clone.querySelector('[data-hook="review-body"]') ??
			clone.querySelector('[data-hook="reviewText"]');
		const body = bodyEl ? stripHeadingEcho(await htmlToBasicMarkdown(bodyEl.innerHTML), "") : "";
		if (!title && !author && !body) continue;
		const block: string[] = [`### ${[title, stars].filter(Boolean).join(" - ") || "Review"}`, ""];
		const byline = [author, date].filter(Boolean).join(" · ");
		if (byline) block.push(byline);
		if (variation) block.push(variation);
		if (verified) block.push(verified);
		if (body) block.push("", body);
		if (helpful) block.push("", helpful);
		blocks.push(block.join("\n"));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** Render Amazon product HTML as compact markdown, or null when the page has no `#productTitle`. */
export async function renderAmazonProduct(html: string, pageUrl: string): Promise<string | null> {
	// Kept dynamic: the DOM parser stays off the CLI startup graph (same as wikipedia.ts).
	const { parseHTML } = await import("@oh-my-pi/pi-utils/dom");
	// A `<br>` or its malformed `</br>` twin inside a heading would split or glue the heading's words.
	const headingBr = html.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, chunk => chunk.replace(/<\/?br\s*\/?>/gi, " "));
	const doc = parseHTML(headingBr).document;
	// Raw text reads (variants, option labels) would otherwise pick up inline scripts and CSS.
	for (const el of doc.querySelectorAll("script,style")) el.remove();
	const titleEl = doc.querySelector("#productTitle");
	const title = titleEl ? singleLine(titleEl) : "";
	if (!title) return null;
	const requested = new URL(pageUrl);
	const ctx: AmazonPage = {
		doc,
		host: requested.hostname,
		html,
		pageAsin: PRODUCT_PATH.exec(requested.pathname)?.[1] ?? null,
	};
	const out: string[] = [`# ${title}`];
	const byline = doc.querySelector("#bylineInfo_feature_div");
	if (byline) {
		const bylineMarkdown = await fragmentMarkdown(byline, ctx.host);
		if (bylineMarkdown) out.push("", bylineMarkdown);
	}
	for (const section of SECTIONS) {
		const content = section.render ? await section.render(ctx) : await textSection(ctx, section);
		if (content) out.push("", `## ${section.heading}`, "", content);
	}
	return out
		.join("\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** `read` handler for Amazon `/dp/<ASIN>` and `/gp/product/<ASIN>` pages; null hands the URL to the generic reader. */
export const handleAmazon: SpecialHandler = async (url, timeout, signal) => {
	try {
		const parsed = new URL(url);
		if (!AMAZON_HOST.test(parsed.hostname) || !PRODUCT_PATH.test(parsed.pathname)) return null;
		const fetchedAt = new Date().toISOString();
		const result = await loadPage(url, { ...AMAZON_PAGE_OPTIONS, timeout, signal });
		if (!result.ok) return null;
		const markdown = await renderAmazonProduct(result.content, result.finalUrl ?? url);
		if (!markdown) return null;
		return buildResult(markdown, {
			url,
			finalUrl: result.finalUrl,
			method: "amazon",
			fetchedAt,
			truncated: result.truncated,
		});
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		return null;
	}
};
