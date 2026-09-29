import type { ImageContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import MathJax from "mathjax";

const MAX_EDGE_PX = 2048;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const SVG_COLOR = "#ffffff";

const runtime = MathJax;
let ready: Promise<void> | undefined;
const cache = new LRUCache<string, ImageContent>({
	max: 128,
	maxSize: MAX_CACHE_BYTES,
	sizeCalculation: image => image.data.length,
});
const pending = new Map<string, Promise<ImageContent>>();

function initialize(): Promise<void> {
	return (ready ??= runtime.init({
		loader: { load: ["input/tex", "output/svg"] },
		svg: { fontCache: "local" },
	}));
}

function svgElement(markup: string): string {
	const start = markup.indexOf("<svg");
	const end = markup.lastIndexOf("</svg>");
	if (start === -1 || end === -1) throw new Error("MathJax did not produce an SVG element");
	return markup.slice(start, end + 6).replace("<svg ", `<svg color="${SVG_COLOR}" `);
}

async function renderLatexImage(tex: string, display: boolean): Promise<ImageContent> {
	await initialize();
	const node = await runtime.tex2svgPromise(tex, { display });
	const svg = svgElement(runtime.startup.adaptor.serializeXML(node));
	const png = await rasterizeSvg(Buffer.from(svg), MAX_EDGE_PX, MAX_EDGE_PX);
	return { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" };
}

/** Render one LaTeX expression through MathJax SVG and the native image pipeline. */
export function latexImage(tex: string, display: boolean): Promise<ImageContent> {
	const key = `${display ? "display" : "inline"}\0${tex}`;
	const cached = cache.get(key);
	if (cached) return Promise.resolve(cached);
	const existing = pending.get(key);
	if (existing) return existing;
	const promise = renderLatexImage(tex, display)
		.then(image => {
			cache.set(key, image);
			return image;
		})
		.finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}
