import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type DOMWindow, parseHTML } from "../src/dom";

const fixtureDirectory = new URL("./fixtures/dom/", import.meta.url);
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let reactRoot: Root | null = null;

async function fixture(name: string): Promise<string> {
	return Bun.file(new URL(name, fixtureDirectory)).text();
}

function text(element: { textContent: string | null } | null): string | null {
	return element?.textContent ?? null;
}

function installWindow(window: DOMWindow): void {
	const globals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		Node: window.Node,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		HTMLIFrameElement: window.HTMLIFrameElement,
		SVGElement: window.SVGElement,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [name, value] of Object.entries(globals)) {
		originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
	}
}

afterEach(async () => {
	if (reactRoot) {
		await act(async () => reactRoot?.unmount());
		reactRoot = null;
	}
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("DOM scraper compatibility", () => {
	test("matches linkedom golden extraction across real scraper pipelines", async () => {
		const golden = await Bun.file(new URL("golden.json", fixtureDirectory)).json();
		const searchDoc = parseHTML(await fixture("search-results.html")).document;
		const search = {
			ecosia: searchDoc.querySelectorAll('article[data-test-id="organic-result"]').map(article => ({
				title: text(article.querySelector('[data-test-id="result-title"]')),
				href: article.querySelector('[data-test-id="result-title"]')?.closest("a")?.getAttribute("href"),
				snippet: text(article.querySelector('[data-test-id="web-result-description"]')),
			})),
			google: searchDoc.querySelectorAll("h3").map(heading => ({
				title: text(heading),
				href: heading.closest("a")?.getAttribute("href"),
				snippet: text(
					heading.closest(".tF2Cxc, .MjjYud, .Gx5Zad")?.querySelector("[data-sncf='1'] .VwiC3b") ?? null,
				),
			})),
			mojeek: searchDoc.querySelectorAll("ul.results-standard > li").map(item => ({
				title: text(item.querySelector("h2 a.title")),
				href: item.querySelector("a.title")?.getAttribute("href"),
				snippet: text(item.querySelector("p.s")),
			})),
			startpage: searchDoc.querySelectorAll("div.result").map(block => ({
				title: text(block.querySelector("a.result-link h2, a.result-link h3")),
				href: block.querySelector("a.result-link")?.getAttribute("href"),
				snippet: text(block.querySelector("p.description")),
			})),
			hidden: searchDoc
				.querySelectorAll('form[action="/sp/search"] input[type="hidden"]')
				.map(input => [input.getAttribute("name"), input.getAttribute("value")]),
		};

		const nitterDoc = parseHTML(await fixture("nitter.html")).document;
		const nitter = {
			primary: [".tweet-content", ".fullname", ".username", ".tweet-date a", ".tweet-stats"].map(selector =>
				text(nitterDoc.querySelector(selector)),
			),
			replies: nitterDoc.querySelectorAll(".timeline-item .tweet-content").map(reply => ({
				text: text(reply),
				username: text(reply.parentElement?.querySelector(".username") ?? null),
			})),
		};

		const atomDoc = parseHTML(await fixture("atom.xml")).document;
		const atom = {
			title: text(atomDoc.querySelector("feed > title")),
			entries: atomDoc.querySelectorAll("entry").map(entry => ({
				title: text(entry.querySelector("title")),
				authors: entry.querySelectorAll("author name").map(text),
				categories: entry.querySelectorAll("category").map(category => category.getAttribute("term")),
				pdf: entry.querySelector('link[title="pdf"]')?.getAttribute("href") ?? null,
				summary: text(entry.querySelector("summary, content")),
			})),
		};

		const wikipediaDoc = parseHTML(await fixture("wikipedia.html")).document;
		const wikipedia = wikipediaDoc.querySelectorAll("section").map(section => ({
			heading: text(section.querySelector("h2, h3, h4")),
			tag: section.querySelector("h2, h3, h4")?.tagName ?? null,
			paragraphs: section.querySelectorAll("p").map(text),
		}));

		expect({ search, nitter, atom, wikipedia }).toEqual(golden);
	});

	test("parses tag soup, raw text, entities, and reparses innerHTML", () => {
		const { document } = parseHTML(
			'<DIV id=x><p>one<p>two &copy; &eacute; &Aacute; &#x1f642;</DIV><script>if (a < b) x = "<i>";</script>',
		);
		const div = document.getElementById("x");
		expect(div?.children.map(child => child.tagName)).toEqual(["P", "P"]);
		expect(div?.textContent).toBe("onetwo © é Á 🙂");
		expect(document.querySelector("script")?.textContent).toBe('if (a < b) x = "<i>";');
		if (!div) throw new Error("Expected fixture div");
		div.innerHTML = '<span data-value="a&amp;b">A &lt; B</span><!--note-->tail';
		expect(div.querySelector("span")?.getAttribute("data-value")).toBe("a&b");
		expect(div.innerHTML).toBe('<span data-value="a&b">A &lt; B</span><!--note-->tail');
		expect(div.cloneNode(true).outerHTML).toBe(div.outerHTML);
	});

	test("supports every selector family used by consumers", () => {
		const { document } = parseHTML(
			'<main id="root"><article id="a" class="card featured" data-kind="news-item" title="alpha beta"><h2>A</h2><p class="body">One</p></article><article id="b" class="card" data-kind="blog"><h2>B</h2><p class="body muted">Two</p></article><aside id="c"></aside></main>',
		);
		const ids = (selector: string) =>
			document.querySelectorAll(selector).map(element => element.id || element.tagName);
		expect(ids("article")).toEqual(["a", "b"]);
		expect(ids("#a.featured")).toEqual(["a"]);
		expect(ids("[data-kind]")).toEqual(["a", "b"]);
		expect(ids('[data-kind="blog"]')).toEqual(["b"]);
		expect(ids('[data-kind^="news"]')).toEqual(["a"]);
		expect(ids('[data-kind$="item"]')).toEqual(["a"]);
		expect(ids('[data-kind*="ws-i"]')).toEqual(["a"]);
		expect(ids('[title~="beta"]')).toEqual(["a"]);
		expect(ids('[data-kind|="news"]')).toEqual(["a"]);
		expect(ids("main > article .body")).toEqual(["P", "P"]);
		expect(ids("#a + article")).toEqual(["b"]);
		expect(ids("#a ~ aside")).toEqual(["c"]);
		expect(ids("aside, article.featured")).toEqual(["a", "c"]);
		expect(document.getElementById("b")?.matches("main > .card:not(.featured)")).toBe(true);
		expect(document.getElementById("b")?.closest("main")?.id).toBe("root");
	});

	test("supports tree mutation and sibling traversal", () => {
		const { document } = parseHTML("<div><b>one</b><i>two</i></div>");
		const div = document.querySelector("div");
		const italic = document.querySelector("i");
		if (!div || !italic) throw new Error("Expected fixture elements");
		const span = document.createElement("span");
		span.textContent = "middle";
		div.insertBefore(span, italic);
		expect(span.previousElementSibling?.tagName).toBe("B");
		expect(span.nextElementSibling).toBe(italic);
		const replacement = document.createElement("em");
		replacement.textContent = "last";
		div.replaceChild(replacement, italic);
		expect(div.children.map(child => child.tagName)).toEqual(["B", "SPAN", "EM"]);
		span.remove();
		expect(div.textContent).toBe("onelast");
	});

	test("renders and unmounts a React root", async () => {
		const window = parseHTML('<html><body><div id="root"></div></body></html>');
		installWindow(window);
		const container = window.document.getElementById("root");
		if (!container) throw new Error("Expected React root");
		reactRoot = createRoot(container as unknown as globalThis.Element);
		await act(async () => {
			reactRoot?.render(
				createElement(
					"section",
					{ className: "ready", "data-state": "ok" },
					createElement("strong", null, "Rendered"),
				),
			);
		});
		expect(container.innerHTML).toBe('<section data-state="ok" class="ready"><strong>Rendered</strong></section>');
	});
});
