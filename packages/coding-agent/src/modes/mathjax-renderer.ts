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
import type { MathImageRenderRequest, MathImageSvg } from "@oh-my-pi/pi-tui";
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

export function renderMathImageSvg(request: MathImageRenderRequest): MathImageSvg {
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
