import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerChips } from "../src/components/composer/ComposerChips";
import type { ComposerDraft } from "../src/components/composer/useComposerDraft";

/**
 * The complaint these answer: a referenced file showed up in the editor as
 * `@"/Users/gtrave/Library/Mobile Documents/com~apple~CloudDocs/17_06_2026.pdf"`.
 * Two of those filled the box before a word had been typed.
 *
 * The path now lives in state and is appended at send time, so what the user
 * sees is a tag carrying the file's name — and these check that the long path
 * really is gone from the visible text rather than merely styled smaller.
 */
function draft(overrides: Partial<ComposerDraft>): ComposerDraft {
	return {
		attachments: [],
		references: [],
		notice: null,
		removeAttachment: () => {},
		removeReference: () => {},
		dismissNotice: () => {},
		...overrides,
	} as unknown as ComposerDraft;
}

const LONG = "/Users/gtrave/Library/Mobile Documents/com~apple~CloudDocs/17_06_2026.pdf";

/** The text a chip actually shows, ignoring tooltips and aria labels. */
function visibleNames(markup: string): string[] {
	return [...markup.matchAll(/<span class="omp-chip__name">([^<]*)<\/span>/g)].map(match => match[1]);
}

describe("file reference tags", () => {
	const markup = renderToStaticMarkup(<ComposerChips composer={draft({ references: [LONG] })} />);

	test("show the file name, not the path", () => {
		// The assertion has to be about the *visible* text: the full path is
		// deliberately still in the title attribute, so searching the whole markup
		// would pass for the wrong reason.
		expect(visibleNames(markup)).toEqual(["17_06_2026.pdf"]);
	});

	test("keep the full path reachable as a tooltip", () => {
		expect(markup).toContain(LONG);
		expect(markup).toContain("Read by the agent, not uploaded");
	});

	test("carry the file modifier that paints the blue border", () => {
		expect(markup).toContain("omp-chip--file");
	});

	test("can be removed", () => {
		expect(markup).toContain('aria-label="Remove 17_06_2026.pdf"');
	});
});

describe("image chips", () => {
	const markup = renderToStaticMarkup(
		<ComposerChips
			composer={draft({
				attachments: [
					{ id: "a1", name: "IMG_0002.jpeg", mimeType: "image/jpeg", data: "AA==", previewUrl: "data:image/jpeg;base64,AA==" },
				],
			})}
		/>,
	);

	test("render a thumbnail and stay visually distinct from references", () => {
		expect(markup).toContain("omp-chip--image");
		expect(markup).toContain("omp-chip__thumb");
		expect(markup).not.toContain("omp-chip--file");
	});
});

describe("nothing attached", () => {
	test("renders nothing at all rather than an empty strip", () => {
		expect(renderToStaticMarkup(<ComposerChips composer={draft({})} />)).toBe("");
	});
});

describe("the non-image notice", () => {
	const markup = renderToStaticMarkup(<ComposerChips composer={draft({ notice: "Only images can be attached." })} />);

	test("is announced, because silence was the original bug", () => {
		expect(markup).toContain('role="status"');
		expect(markup).toContain('aria-live="polite"');
		expect(markup).toContain("Only images can be attached.");
	});
});
