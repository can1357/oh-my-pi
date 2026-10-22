import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { asGlobalFetch } from "../helpers/fetch-mock";

const AMAZON_URL = "https://www.amazon.in/dp/B0TESTASIN";
const AMAZON_TITLE = "Acme 1.5L Electric Kettle";
// Underscore-free: turndown escapes bare `_` in the rendered markdown.
const REVIEW_MARKER = "REVIEW-MARKER-FULL";
const EXAMPLE_URL = "https://example.com/page";
const EXAMPLE_FILLER =
	"Example page body copy long enough that a reader keeps it instead of swapping in a site-wide alternate. ".repeat(6);

/** Full product page: title, price, one spec row, one review. Amazon only serves this to the browser UA. */
const AMAZON_FULL_PAGE = `<!doctype html><html><head><title>${AMAZON_TITLE}</title></head><body>
<span id="productTitle">${AMAZON_TITLE}</span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price-whole">1,299</span></div>
<div id="productDetails_feature_div"><table><tr><th>Brand</th><td>Acme</td></tr></table></div>
<div id="reviewsMedley"><div id="cm-cr-dp-review-list" data-hook="cr-widget-DesktopReviews">
<div data-hook="review" class="a-section review">
<div class="a-profile-name">Asha R</div>
<i data-hook="review-star-rating" class="a-icon a-icon-star"><span class="a-icon-alt">5.0 out of 5 stars</span></i>
<a data-hook="reviewTitle" class="a-link-normal"><span class="a-size-base">Keeps water hot</span></a>
<span data-hook="review-date" class="a-size-base">Reviewed in India on 12 March 2025</span>
<span data-hook="avp-badge" class="a-size-mini">Verified Purchase</span>
<span data-hook="review-body" class="a-size-base review-text">${REVIEW_MARKER}</span>
</div></div></div>
</body></html>`;

/** What curl and TextBot get: the same product with the reviews trimmed away. */
const AMAZON_TRIMMED_PAGE = `<!doctype html><html><head><title>${AMAZON_TITLE}</title></head><body><span id="productTitle">${AMAZON_TITLE}</span></body></html>`;

const examplePage = (marker: string): string =>
	`<!doctype html><html><head><title>Example</title></head><body><main><h1>${marker}</h1><p>${EXAMPLE_FILLER}</p></main></body></html>`;

function makeSession(): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-amazon-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

/** Read a URL the way the model does and return the text it would receive. */
async function readUrl(url: string): Promise<string> {
	const result = await new ReadTool(makeSession()).execute("call", { path: url });
	return result.content.find(block => block.type === "text")?.text ?? "";
}

function htmlResponse(body: string, url: string, status = 200): Response {
	const response = new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
	// `loadPage` takes the final URL off the response; a constructed Response reports "".
	Object.defineProperty(response, "url", { value: url });
	return response;
}

/** Amazon (and every other host) answers per User-Agent and Accept-Encoding, never by real network. */
function stubFetch(options: { chromeBlocked?: boolean } = {}): void {
	const handler = (input: string | URL | Request, init?: RequestInit): Response => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(init?.headers);
		const userAgent = headers.get("user-agent") ?? "";
		const compressed = (headers.get("accept-encoding") ?? "") !== "identity";
		const chrome = userAgent.includes("Chrome/");
		if (new URL(url).hostname.endsWith("amazon.in")) {
			if (options.chromeBlocked && chrome) return htmlResponse("captcha", url, 503);
			const fullPage = options.chromeBlocked || (chrome && compressed);
			return htmlResponse(fullPage ? AMAZON_FULL_PAGE : AMAZON_TRIMMED_PAGE, url);
		}
		const curl = userAgent === "curl/8.0" && !compressed;
		return htmlResponse(curl ? examplePage("CURL_MARKER") : examplePage("CHROME_MARKER"), url);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(handler));
}

describe("read Amazon product pages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads the full product page, reviews included, for an Amazon product URL", async () => {
		stubFetch();
		const text = await readUrl(AMAZON_URL);

		expect(text).toContain(AMAZON_TITLE);
		expect(text).toContain("1,299");
		expect(text).toContain(REVIEW_MARKER);
	});

	it("still returns the review text when Amazon bot-blocks the browser User-Agent", async () => {
		stubFetch({ chromeBlocked: true });
		const text = await readUrl(AMAZON_URL);

		expect(text).toContain(REVIEW_MARKER);
	});

	it("sends curl first to non-Amazon hosts", async () => {
		stubFetch();
		const text = await readUrl(EXAMPLE_URL);

		expect(text).toContain("CURL_MARKER");
		expect(text).not.toContain("CHROME_MARKER");
	});
});
