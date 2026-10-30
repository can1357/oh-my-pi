import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { assertSelectorString, PLAYWRIGHT_ONLY_SELECTOR_RE, parseAriaRefSelector } from "../aria/aria-snapshot";

/** Semantic selector engines resolved in-page by the exported Chromium query handlers. */
export type TernSemanticEngine = "label" | "placeholder" | "testid" | "alt" | "title" | "role";

/** Parsed selector, JSON-safe, resolved in-page by the Tern page kit. */
export type TernSelector =
	| { engine: "css"; query: string }
	/** Puppeteer text engine: deepest elements whose text content includes the query. */
	| { engine: "text"; query: string }
	/** Puppeteer aria syntax `aria/Name[role="button"]`; a missing name matches any name. */
	| { engine: "aria"; name?: string; role?: string }
	| { engine: "xpath"; query: string }
	/** CSS through open shadow roots. */
	| { engine: "pierce"; query: string }
	| { engine: TernSemanticEngine; query: string }
	/** `eN` from the last `ariaSnapshot` in this document. */
	| { engine: "ariaRef"; ref: string }
	/** Numeric id from the last `observe()` in this document. */
	| { engine: "id"; id: number }
	/** Element marked by the kit's `mark()`. */
	| { engine: "handle"; token: string };

const SEMANTIC_ENGINES: readonly TernSemanticEngine[] = ["label", "placeholder", "testid", "alt", "title", "role"];

const PREFIXED_ENGINES = ["text", "xpath", "pierce", ...SEMANTIC_ENGINES] as const;

const LEGACY_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"] as const;

const ENGINE_PREFIXES = ["aria/", ...PREFIXED_ENGINES.map(engine => `${engine}/`), ...ARIA_REF_PREFIXES, "p-"];

/** Puppeteer's `parseARIASelector` attribute syntax: `[name="…"]` / `[role='…']`. */
const ARIA_ATTRIBUTE_RE = /\[\s*(?<attribute>\w+)\s*=\s*(?<quote>"|')(?<value>\\.|.*?(?=\k<quote>))\k<quote>\s*\]/g;

function parseAriaQuery(query: string): TernSelector {
	if (query.length > 10_000) throw new ToolError(`Selector ${query} is too long`);
	const options: { name?: string; role?: string } = {};
	const defaultName = query.replace(ARIA_ATTRIBUTE_RE, (_match, attribute: string, _quote: string, value: string) => {
		if (attribute !== "name" && attribute !== "role") {
			throw new ToolError(`Unknown aria attribute "${attribute}" in selector`);
		}
		options[attribute] = value;
		return "";
	});
	if (defaultName && !options.name) options.name = defaultName;
	return { engine: "aria", ...options };
}

function legacyToModern(selector: string): string {
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		return `aria/${name ? name.trim() : rest}`;
	}
	return selector.slice("p-".length);
}

/** Parse a browser-tool selector string into a {@link TernSelector}. Throws ToolError on unsupported syntax. */
export function parseTernSelector(selector: string): TernSelector {
	assertSelectorString(selector);
	if (!ENGINE_PREFIXES.some(prefix => selector.startsWith(prefix)) && PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-")) {
		if (!LEGACY_PREFIXES.some(prefix => selector.startsWith(prefix))) {
			throw new ToolError(
				`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
			);
		}
		return parseTernSelector(legacyToModern(selector));
	}
	const ref = parseAriaRefSelector(selector);
	if (ref !== null) return { engine: "ariaRef", ref };
	if (ARIA_REF_PREFIXES.some(prefix => selector.trim().startsWith(prefix))) {
		throw new ToolError(`Invalid ARIA ref selector ${JSON.stringify(selector)}; expected e.g. "aria-ref=e5".`);
	}
	if (selector.startsWith("aria/")) return parseAriaQuery(selector.slice("aria/".length));
	for (const engine of PREFIXED_ENGINES) {
		if (selector.startsWith(`${engine}/`)) return { engine, query: selector.slice(engine.length + 1) };
	}
	return { engine: "css", query: selector };
}
