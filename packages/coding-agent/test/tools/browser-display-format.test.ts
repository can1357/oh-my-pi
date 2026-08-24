import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";

describe("browser renderer: display-only streaming formatting", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("expands compact JavaScript without mutating the run source", () => {
		const source = "if (ready) {run();finish();}";
		const args = { action: "run", code: source };
		const rendered = Bun.stripANSI(
			toolRenderers.browser.renderCall(args, { expanded: true, isPartial: true }, theme).render(120).join("\n"),
		);

		expect(rendered).toContain("run();");
		expect(rendered).toContain("finish();");
		expect(rendered).not.toContain("run();finish();");
		expect(args.code).toBe(source);
	});

	/**
	 * `browser.ts` never builds an `OutputMeta` itself, but the browser tool is a
	 * built-in wrapped by `wrapToolWithMetaNotice` (`tools/index.ts`), whose
	 * generic `spillLargeResultToArtifact` sets `details.meta.truncation` and
	 * bakes `formatOutputNotice`'s bracket into the body for any oversized
	 * result. Browser declares neither `modelContentProjection` nor
	 * `presentationFacts`, so that composition is the only one it ever gets —
	 * which is why the renderer must peel the inline notice back off before
	 * printing its own styled truncation warning. Same contract as
	 * `mcp-render-status.test.ts`'s spill case.
	 */
	it("strips the spill notice from the body and surfaces the artifact link once", () => {
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 400,
				totalBytes: 32_000,
				outputLines: 3,
				outputBytes: 66,
				maxBytes: 1024,
				shownRange: { start: 398, end: 400 },
				artifactId: "41",
			},
		};
		const body = ["row-0398 payload AAAA", "row-0399 payload BBBB", "row-0400 payload CCCC"].join("\n");
		const rendered = Bun.stripANSI(
			toolRenderers.browser
				.renderResult(
					{
						content: [{ type: "text", text: body + formatOutputNotice(meta) }],
						details: { action: "run", meta },
					},
					{ expanded: true, isPartial: false },
					theme,
					{ action: "run", code: "await collect()" },
				)
				.render(120)
				.join("\n"),
		);

		expect(rendered).toContain("row-0398 payload AAAA");
		expect(rendered).toContain("row-0400 payload CCCC");
		expect(rendered).toContain("artifact://41");
		// Exactly once — as the styled warning. Two occurrences would mean the
		// LLM-facing bracket was echoed verbatim beside it.
		expect(rendered.split("artifact://41").length - 1).toBe(1);
	});
});
