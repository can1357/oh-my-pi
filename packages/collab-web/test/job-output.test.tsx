import { describe, expect, it } from "bun:test";
import { countElements } from "./test-utils";
import { renderToStaticMarkup } from "react-dom/server";
import type { AsyncJobResult } from "../src/components/transcript/agent-notices";
import { JobOutput } from "../src/components/transcript/JobOutput";

function renderResult(output: string, data?: unknown): string {
	const job: AsyncJobResult = { id: "review", outcome: "completed", output, data };
	return renderToStaticMarkup(<JobOutput job={job} />);
}

describe("Structured job reports", () => {
	it("renders nested JSON as labeled sections and lists without discarding falsy or empty values", () => {
		const output = JSON.stringify({
			changed: ["src/client.ts", "test/client.test.ts"],
			checks: { passed: false, count: 0, detail: null, note: "", warnings: [], metadata: {} },
			orderingEvidence: "First line\nSecond line",
			unsafe: '<img src=x onerror="alert(1)">',
		});
		const html = renderResult(output);
		expect(countElements(html, ".tr-report-content dl")).toBe(2);
		expect(countElements(html, ".tr-report-content li")).toBe(2);
		expect(countElements(html, ".tr-report-scalar")).toBe(4);
		expect(countElements(html, ".tr-report-empty")).toBe(2);
		expect(html).toContain("false");
		expect(html).toContain(">0<");
		expect(html).toContain("null");
		expect(html).toContain("src/client.ts");
		expect(html).toContain('title="orderingEvidence"');
		expect(html).toContain("Ordering Evidence");
		expect(html).toContain("First line\nSecond line");
		expect(countElements(html, "img")).toBe(0);
		expect(html).toContain("&lt;img");
	});

	it("uses schema data over textual output even when the schema payload is false or null", () => {
		const falseReport = renderResult("stale preview", false);
		expect(countElements(falseReport, ".tr-report-scalar")).toBe(1);
		expect(falseReport).toContain(">false<");
		expect(falseReport).not.toContain("stale preview");
		const nullReport = renderResult("stale preview", null);
		expect(countElements(nullReport, ".tr-report-scalar")).toBe(1);
		expect(nullReport).toContain(">null<");
		expect(nullReport).not.toContain("stale preview");
	});

	it("leaves ordinary Markdown and malformed JSON readable instead of replacing them with a report", () => {
		const prose = renderResult("Verified **the reconnect path**.");
		expect(countElements(prose, ".tr-md strong")).toBe(1);
		expect(countElements(prose, ".tr-report")).toBe(0);
		const partial = renderResult('{"verification": "unfinished');
		expect(partial).toContain("unfinished");
		expect(countElements(partial, ".tr-report")).toBe(0);
	});
});
