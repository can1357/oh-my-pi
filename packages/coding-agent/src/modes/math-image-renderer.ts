import { inflateSync } from "node:zlib";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/mjs/svg.js";
import { liteAdaptor, type LiteAdaptor } from "@mathjax/src/mjs/adaptors/liteAdaptor.js";
import type { LiteDocument } from "@mathjax/src/mjs/adaptors/lite/Document.js";
import { LiteElement } from "@mathjax/src/mjs/adaptors/lite/Element.js";
import type { LiteText } from "@mathjax/src/mjs/adaptors/lite/Text.js";
import type { MathDocument } from "@mathjax/src/mjs/core/MathDocument.js";
import { RegisterHTMLHandler } from "@mathjax/src/mjs/handlers/html.js";
import { TeX } from "@mathjax/src/mjs/input/tex.js";
import { mathjax } from "@mathjax/src/mjs/mathjax.js";
import { SVG } from "@mathjax/src/mjs/output/svg.js";
import "@mathjax/src/mjs/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/mjs/input/tex/configmacros/ConfigMacrosConfiguration.js";
import "@mathjax/src/mjs/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/mjs/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/mjs/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/mjs/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/mjs/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/mjs/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/mjs/input/tex/empheq/EmpheqConfiguration.js";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import {
	type MathImageRenderer,
	type MathImageRenderRequest,
	type MathImageSvg,
	setMathImageRenderer,
} from "@oh-my-pi/pi-tui";

const PACKAGES = [
	"base",
	"ams",
	"newcommand",
	"configmacros",
	"mathtools",
	"boldsymbol",
	"braket",
	"cancel",
	"color",
	"cases",
	"empheq",
];
let adaptor: LiteAdaptor | undefined;
let output: SVG<LiteElement, LiteText, LiteDocument> | undefined;

function render(request: MathImageRenderRequest): MathImageSvg {
	if (!request.tex.trim() || request.tex.length > 20_000) throw new Error("Math source exceeds input limits");
	if (!/^#[\da-f]{6}$/i.test(request.inkHex)) throw new Error("Invalid math ink color");
	for (const value of [request.cellWidthPx, request.cellHeightPx, request.pixelsPerEx, request.maxWidthPx]) {
		if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid math geometry");
	}
	if (!adaptor) {
		adaptor = liteAdaptor();
		RegisterHTMLHandler(adaptor);
		output = new SVG<LiteElement, LiteText, LiteDocument>({
			fontData: new MathJaxTexFont(),
			fontCache: "local",
			linebreaks: { inline: false },
			displayOverflow: "overflow",
		});
	}
	const input = new TeX<LiteElement, LiteText, LiteDocument>({
		packages: PACKAGES,
		tags: "none",
		maxBuffer: 20_000,
		maxMacros: 1_000,
		maxTemplateSubtitutions: 1_000,
		formatError: (_jax: unknown, error: unknown) => {
			throw error;
		},
	});
	const document: MathDocument<LiteElement, LiteText, LiteDocument> = mathjax.document("", {
		InputJax: input,
		OutputJax: output,
		compileError: (_document: unknown, _math: unknown, error: unknown) => {
			throw error;
		},
		typesetError: (_document: unknown, _math: unknown, error: unknown) => {
			throw error;
		},
	});
	try {
		const node = document.convert(request.tex, {
			display: request.display,
			ex: request.pixelsPerEx,
			em: request.pixelsPerEx / 0.442,
			containerWidth: request.maxWidthPx,
		});
		if (!(node instanceof LiteElement)) throw new Error("Math conversion returned a non-DOM result");
		const svgs = adaptor
			.childNodes(node)
			.filter((child): child is LiteElement => child instanceof LiteElement && adaptor!.kind(child) === "svg");
		if (svgs.length !== 1 || adaptor.tags(node, "mjx-break").length)
			throw new Error("Math conversion did not produce one complete SVG");
		const svg = svgs[0];
		const dimension = (name: string): number => {
			const attribute: unknown = adaptor!.getAttribute(svg, name);
			if (typeof attribute !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)ex$/.test(attribute))
				throw new Error("Invalid math SVG dimension");
			const value = Number.parseFloat(attribute);
			if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid math SVG dimension");
			return value;
		};
		const widthEx = dimension("width");
		const heightEx = dimension("height");
		const viewBox: unknown = adaptor.getAttribute(svg, "viewBox");
		if (
			typeof viewBox !== "string" ||
			viewBox.trim().split(/\s+/).length !== 4 ||
			viewBox
				.trim()
				.split(/\s+/)
				.some(value => !Number.isFinite(Number(value)))
		)
			throw new Error("Invalid math SVG viewBox");
		const elements = [node];
		for (let index = 0; index < elements.length; index++) {
			const element = elements[index];
			if (
				adaptor.hasAttribute(element, "data-mjx-error") ||
				adaptor.getAttribute(element, "data-mml-node") === "merror"
			)
				throw new Error("Math conversion returned an error node");
			if (["image", "script", "foreignObject", "text"].includes(adaptor.kind(element)))
				throw new Error("External math SVG resource or unavailable static glyph");
			for (const attribute of adaptor.allAttributes(element)) {
				if ((attribute.name === "href" || attribute.name === "xlink:href") && !attribute.value.startsWith("#"))
					throw new Error("External math SVG reference");
				if (/url\(\s*[^#]/i.test(attribute.value) || attribute.name.startsWith("on"))
					throw new Error("External math SVG resource");
			}
			for (const child of adaptor.childNodes(element)) {
				if (child instanceof LiteElement) elements.push(child);
			}
		}
		adaptor.setAttribute(svg, "color", request.inkHex);
		adaptor.setAttribute(svg, "xmlns", "http://www.w3.org/2000/svg");
		return { svg: adaptor.serializeXML(svg), widthEx, heightEx };
	} finally {
		document.clear();
		input.parseOptions.clear();
		input.reset();
	}
}

export const codingAgentMathImageRenderer: MathImageRenderer = { id: "mathjax-4.1.3-tex-scientific-1", render };

export function registerCodingAgentMathImageRenderer(): void {
	setMathImageRenderer(codingAgentMathImageRenderer);
}

const SMOKE_FORMULAS = [
	"x+y=1",
	String.raw`\frac{a}{b}`,
	String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
	String.raw`f(x)=\begin{cases}x&x>0\\0&x\le0\end{cases}`,
	String.raw`\begin{numcases}{f(x)=}x&$x>0$\\0&$x\le0$\end{numcases}`,
	String.raw`\begin{empheq}[left=\empheqlbrace]{align}a&=b\\c&=d\end{empheq}`,
	String.raw`\coloneqq\boldsymbol{\alpha}\Braket{x|y}\cancel{x}\color{red}{y}\mathcal{F}\mathbf{A}\Gamma`,
	String.raw`\newcommand{\localmath}[1]{#1^2}\localmath{x}`,
];

/** Exercise production conversion and native rasterization independently of terminal preferences. */
export async function smokeTestMathImageRenderer(): Promise<void> {
	for (const tex of SMOKE_FORMULAS) {
		const result = render({
			tex,
			display: tex !== "x+y=1",
			inkHex: "#ffffff",
			cellWidthPx: 9,
			cellHeightPx: 18,
			pixelsPerEx: 9,
			maxWidthPx: 720,
		});
		const svg = result.svg
			.replace(/width="[^"]+"/, `width="${result.widthEx * 9}"`)
			.replace(/height="[^"]+"/, `height="${result.heightEx * 9}"`);
		const png = await rasterizeSvg(new TextEncoder().encode(svg), 720, 4096, 1);
		if (!Buffer.from(png.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
			throw new Error("Math smoke produced invalid PNG");
		const image = new Bun.Image(png);
		const metadata = await image.metadata();
		if (metadata.width <= 0 || metadata.height <= 0 || metadata.width > 720 || metadata.height > 4096)
			throw new Error("Math smoke produced invalid dimensions");
		// Decode and reduce to one pixel. Its alpha proves visible ink, not just a valid PNG header.
		const pixel = Buffer.from(await image.resize(1, 1).png().bytes());
		const chunks: Buffer[] = [];
		for (let offset = 8; offset + 12 <= pixel.length;) {
			const length = pixel.readUInt32BE(offset);
			if (pixel.toString("ascii", offset + 4, offset + 8) === "IDAT")
				chunks.push(pixel.subarray(offset + 8, offset + 8 + length));
			offset += 12 + length;
		}
		const decoded = inflateSync(Buffer.concat(chunks));
		if (pixel[25] !== 6 || decoded.length !== 5 || decoded[4] === 0)
			throw new Error("Math smoke produced transparent output");
	}
}
