import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/mjs/svg.js";
import { liteAdaptor } from "@mathjax/src/mjs/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/mjs/handlers/html.js";
import { TeX } from "@mathjax/src/mjs/input/tex.js";
import { mathjax } from "@mathjax/src/mjs/mathjax.js";
import { SVG } from "@mathjax/src/mjs/output/svg.js";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";

const MAX_EDGE_PX = 2048;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const input = new TeX();
const output = new SVG({ font: new MathJaxNewcmFont(), fontCache: "local" });
const document = mathjax.document("", { InputJax: input, OutputJax: output });
const cache = new LRUCache<string, ImageContent>({
	max: 128,
	maxSize: MAX_CACHE_BYTES,
	sizeCalculation: image => image.data.length,
});
const pending = new Map<string, Promise<ImageContent>>();

function svgElement(markup: string, color: string): string {
	const start = markup.indexOf("<svg");
	const end = markup.indexOf("</svg>", start);
	if (start === -1 || end === -1) throw new Error("MathJax did not produce an SVG element");
	return markup.slice(start, end + 6).replace("<svg ", `<svg color="${color}" `);
}

async function renderLatexImage(tex: string, color: string): Promise<ImageContent> {
	const node = document.convert(tex, { display: true });
	const svg = svgElement(adaptor.outerHTML(node), color);
	const png = await rasterizeSvg(Buffer.from(svg), MAX_EDGE_PX, MAX_EDGE_PX);
	return { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" };
}

/** Render one display LaTeX expression through static MathJax SVG and the native image pipeline. */
export function latexImage(tex: string, color: string): Promise<ImageContent> {
	const key = `${color}\0${tex}`;
	const cached = cache.get(key);
	if (cached) return Promise.resolve(cached);
	const existing = pending.get(key);
	if (existing) return existing;
	const promise = renderLatexImage(tex, color)
		.then(image => {
			cache.set(key, image);
			return image;
		})
		.finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}
