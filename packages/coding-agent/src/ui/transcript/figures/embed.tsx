/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Embeds of a reply's HTML: `<img src alt width height>` and `<iframe src>`.
 *
 * Natively an image is an `image` node (its bytes as a blob) and a frame a
 * `web` node. For the terminal the image's file is loaded (a path from the
 * session's working directory, a `data:` URL or an `http(s)` URL; SVG drawn
 * as a figure) and a frame's page captured as a still through the host;
 * until then, or when that fails, the embed is a one-row note naming it
 * (with why it is not shown where the terminal draws images). With images
 * off nothing is loaded.
 *
 * Terminal look: `src/ui/styles/figures/figure.ts` (`omp.embed`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	computed,
	effect,
	type JSXNode,
	nativeRendering,
	nativeSupports,
	onCleanup,
	type Reactive,
	read,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { errorMessage } from "@oh-my-pi/pi-utils";
import { readImageHeaderDimensions } from "../../../utils/image-resize";
import { holdSettle } from "../../shell/transcript";
import { closePartialSvg, type FigureRaster, PX_PER_ROW, trackFigureWork } from "./svg";
import { type FigureOptions, SvgRaster } from "./svg-figure";

/** An embed of a reply. */
export interface Embed {
	readonly kind: "img" | "iframe";
	readonly src: string;
	/** `alt` of an image, `title` of a frame; may be empty. */
	readonly label: string;
	/** Stated size in CSS px. */
	readonly size?: { readonly w?: number; readonly h?: number };
}

/** Where embeds load from. */
export interface EmbedHost {
	/** Directory relative image paths resolve against. */
	cwd(): string;
	/** A still of the page at `url` (PNG bytes); rejects when no browser can capture it. */
	capturePage?(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

function decodeEntities(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_match, name: string) => ENTITIES[name] ?? _match);
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function pixels(value: string | undefined): number | undefined {
	const match = value === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(value);
	return match ? Number(match[1]) : undefined;
}

/** The embed an HTML block is (one `<img>` or `<iframe>` with a `src`), else undefined. */
export function parseEmbed(html: string): Embed | undefined {
	const source = html.trim();
	const img = /^<img\b[^>]*\/?>$/i.exec(source);
	const frame = /^<iframe\b[^>]*>\s*(?:<\/iframe>)?$/i.exec(source);
	const tag = img?.[0] ?? (frame ? source.slice(0, source.indexOf(">") + 1) : undefined);
	if (!tag) return undefined;
	const src = attribute(tag, "src");
	if (!src) return undefined;
	const w = pixels(attribute(tag, "width"));
	const h = pixels(attribute(tag, "height"));
	return {
		kind: img ? "img" : "iframe",
		src,
		label: attribute(tag, img ? "alt" : "title") ?? "",
		...(w !== undefined || h !== undefined ? { size: { ...(w ? { w } : {}), ...(h ? { h } : {}) } } : {}),
	};
}

/** What an embed is called in its note: its label, else its URL (a nameless `data:` image is `image`). */
export function embedLabel(embed: Embed): string {
	if (embed.label.trim()) return embed.label.trim();
	return embed.kind === "img" && embed.src.startsWith("data:") ? "image" : embed.src;
}

/** Terminal facts of an embed. */
export type EmbedTerm = {
	/** The terminal draws a visit link for a page, even without a live native web node. */
	readonly page?: boolean;
	readonly label: string;
	/** Why it is not shown (`couldn't load: …`). */
	readonly error?: string;
	/** A frame's captured still. */
	readonly still?: FigureRaster;
	/** Where the embed's `src` points: a local file or a web page (none for `data:`). */
	readonly link?: EmbedLink;
};

/** An embed's link target. */
export type EmbedLink = { readonly file: string } | { readonly url: string };

/** Where `src` points, read as {@link fetchSource} loads it: a web URL, a `file:` URL, else a path under `cwd`. */
export function embedLink(src: string, cwd: string): EmbedLink | undefined {
	if (/^data:/i.test(src)) return undefined;
	if (/^https?:\/\//i.test(src)) {
		const url = URL.parse(src);
		return url ? { url: url.href } : undefined;
	}
	try {
		if (/^file:\/\//i.test(src)) return { file: Bun.fileURLToPath(src) };
		if (/^[a-z][\w+.-]*:/i.test(src) && !/^[a-z]:[/\\]/i.test(src)) return undefined;
		return { file: path.resolve(cwd, src) };
	} catch {
		return undefined;
	}
}

type Loaded =
	| { readonly status: "idle" }
	| { readonly status: "pending" }
	| { readonly status: "image"; readonly raster: FigureRaster }
	| { readonly status: "svg" }
	| { readonly status: "failed"; readonly error: string };

/** The bytes and type `src` names. */
async function fetchSource(
	src: string,
	link: EmbedLink | undefined,
	signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime?: string }> {
	const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
	if (data) {
		const body = data[2] ? Buffer.from(data[3]!, "base64") : Buffer.from(decodeURIComponent(data[3]!));
		return { bytes: body, mime: data[1] || undefined };
	}
	if (!link) throw new Error("not a web address or file");
	if ("url" in link) {
		const response = await fetch(link.url, { signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			mime: response.headers.get("content-type") ?? undefined,
		};
	}
	return { bytes: await fs.readFile(link.file, { signal }) };
}

/** See the module docs. */
export function EmbedFigure(
	props: {
		readonly embed: Reactive<Embed | undefined>;
		/** Load and draw the picture (the images setting). */
		readonly showImages: Reactive<boolean>;
		readonly nodeKey?: string;
		readonly host?: EmbedHost;
	} & FigureOptions,
): JSXNode {
	const loaded = signal<Loaded>({ status: "idle" });
	const svg = new SvgRaster(props);
	const link = computed(() => {
		const embed = read(props.embed);
		return embed && embedLink(embed.src, props.host?.cwd() ?? process.cwd());
	});
	const url = computed(() => {
		const target = link();
		return target && ("file" in target ? Bun.pathToFileURL(target.file).href : target.url);
	});
	holdSettle(() => loaded().status === "pending");
	effect(() => {
		const embed = read(props.embed);
		const show = read(props.showImages);
		if (!embed || !show || (embed.kind === "iframe" && nativeRendering())) {
			loaded.set({ status: "idle" });
			return;
		}
		const from = link();
		const page = embed.kind === "iframe" ? url() : undefined;
		const controller = new AbortController();
		onCleanup(() => controller.abort());
		const timeout = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
		untrack(() => {
			loaded.set({ status: "pending" });
			const load = async (): Promise<Loaded> => {
				if (embed.kind === "iframe") {
					if (!page || !props.host?.capturePage) throw new Error("no browser or page address");
					const bytes = await props.host.capturePage(page, timeout);
					controller.signal.throwIfAborted();
					return picture(bytes, "image/png") ?? { status: "failed", error: "couldn't capture: no image" };
				}
				const { bytes, mime } = await fetchSource(embed.src, from, timeout);
				controller.signal.throwIfAborted();
				if (mime?.includes("svg") || /^\s*(?:<\?xml|<svg)/.test(Buffer.from(bytes.subarray(0, 256)).toString())) {
					const source = Buffer.from(bytes).toString("utf8");
					if (closePartialSvg(source) === null) return { status: "failed", error: "couldn't draw the SVG" };
					svg.update(source, true);
					return { status: "svg" };
				}
				return picture(bytes, mime) ?? { status: "failed", error: "couldn't decode the image" };
			};
			void trackFigureWork(
				load().then(
					next => {
						if (!controller.signal.aborted) loaded.set(next);
					},
					error => {
						if (controller.signal.aborted) return;
						const action = embed.kind === "iframe" ? "capture" : "load";
						loaded.set({ status: "failed", error: `couldn't ${action}: ${errorMessage(error)}` });
					},
				),
			);
		});
	});
	return () => {
		const embed = read(props.embed);
		if (!embed) return undefined;
		const state = loaded();
		const label = embedLabel(embed);
		const target = link();
		const page = embed.kind === "iframe" ? url() : undefined;
		const web = page !== undefined && read(props.showImages) && nativeSupports("web");
		const vector = state.status === "svg" ? svg.state() : undefined;
		const raster = state.status === "image" ? state.raster : vector?.status === "ready" ? vector.raster : undefined;
		const error =
			state.status === "failed" ? state.error : vector?.status === "failed" ? "couldn't draw the SVG" : undefined;
		const max =
			embed.size?.w !== undefined || embed.size?.h !== undefined
				? {
						...(embed.size.w
							? { w: `${Math.max(1, Math.round(embed.size.w / (PX_PER_ROW / 2)))}ch` as const }
							: {}),
						...(embed.size.h ? { h: `${Math.max(1, Math.round(embed.size.h / PX_PER_ROW))}lines` as const } : {}),
					}
				: undefined;
		return untrack(() => {
			if (embed.kind === "iframe") {
				const term: EmbedTerm = {
					label,
					page: true,
					...(error ? { error } : {}),
					...(raster ? { still: raster } : {}),
					...(target ? { link: target } : {}),
				};
				return web ? (
					<web
						key={props.nodeKey}
						role="omp.embed"
						url={page}
						title={embed.label.trim() || undefined}
						term={term}
					/>
				) : (
					<text key={props.nodeKey} role="omp.embed" text={label} term={term} />
				);
			}
			const term: EmbedTerm = { label, ...(error ? { error } : {}), ...(target ? { link: target } : {}) };
			return (
				<image
					key={props.nodeKey}
					role="omp.embed"
					blob={raster?.blob}
					w={raster?.w}
					h={raster?.h}
					alt={label}
					max={max}
					term={term}
				/>
			);
		});
	};
}

/** A loaded picture registered as a blob, or undefined when its size cannot be read. */
function picture(bytes: Uint8Array, mime: string | undefined): Loaded | undefined {
	const size = readImageHeaderDimensions(bytes);
	if (!size) return undefined;
	const type = mime?.startsWith("image/") ? mime.split(";")[0]! : size.mimeType;
	return { status: "image", raster: { blob: registerBlob(bytes, type), w: size.width, h: size.height } };
}
