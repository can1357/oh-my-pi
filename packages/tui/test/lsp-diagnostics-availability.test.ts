import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "../src/theme";
import { lspToolRenderer, renderResult, type LspParams, type LspToolDetails } from "../src/tools/lsp";
import type { ToolRenderResult } from "../src/tools/renderer";

let theme: Theme;
const request: LspParams = { action: "diagnostics", file: "src/a.rs" };
const options = { expanded: false, isPartial: false };
const unavailable = "src/a.rs: Rust diagnostics unavailable (crate membership could not be verified)";

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
});

describe("LSP diagnostics availability rendering", () => {
	it("renders an unavailable native result as a failure rather than clean", () => {
		const result: ToolRenderResult<LspToolDetails> = {
			content: [{ type: "text", text: `${theme.status.error} ${unavailable}` }],
			details: { action: "diagnostics", success: false },
		};
		const view = lspToolRenderer.describeResult(result, options, request)!;
		expect(view.tone).toBe("error");
		expect(view.inline).not.toBe(true);
		expect(JSON.stringify(view.tool?.meta)).not.toContain("No issues");
		expect(JSON.stringify(view.body)).toContain("Rust diagnostics unavailable");
	});

	it("keeps native findings and the failed verdict visible together", () => {
		const result: ToolRenderResult<LspToolDetails> = {
			content: [
				{
					type: "text",
					text: `1 warning(s):\n# src/\n## a.rs\n  1:1 [warning] useful finding\n${theme.status.error} ${unavailable}`,
				},
			],
			details: { action: "diagnostics", success: false },
		};
		const view = lspToolRenderer.describeResult(result, options, request)!;
		expect(view.tone).toBe("error");
		expect(JSON.stringify(view.body)).toContain("useful finding");
		expect(JSON.stringify(view.body)).toContain("Rust diagnostics unavailable");
	});

	it("does not mistake an unavailable phrase inside a finding for a status row", () => {
		const result: ToolRenderResult<LspToolDetails> = {
			content: [
				{
					type: "text",
					text: "1 warning(s):\n# src/\n## a.rs\n  1:1 [warning] note: Rust diagnostics unavailable in this expression",
				},
			],
			details: { action: "diagnostics", success: true },
		};
		const view = lspToolRenderer.describeResult(result, options, request)!;
		expect(view.tone).toBe("warning");
		expect(JSON.stringify(view.body)).toContain("in this expression");
	});

	it.each([false, true])("keeps ANSI findings and unavailable status visible (expanded: %s)", expanded => {
		const result: ToolRenderResult<LspToolDetails> = {
			content: [
				{
					type: "text",
					text: `1 warning(s):\nsrc/a.rs:1:1 [warning] useful finding\n${theme.status.error} ${unavailable}`,
				},
			],
			details: { action: "diagnostics", success: false },
		};
		const text = renderResult(result, { ...options, expanded }, theme, request)
			.render(120)
			.join("\n");
		expect(text).toContain("useful finding");
		expect(text).toContain("Rust diagnostics unavailable");
	});

	it("does not label an ANSI unavailable-only result clean", () => {
		const result: ToolRenderResult<LspToolDetails> = {
			content: [{ type: "text", text: `${theme.status.error} ${unavailable}` }],
			details: { action: "diagnostics", success: false },
		};
		const text = renderResult(result, options, theme, request).render(120).join("\n");
		expect(text).not.toContain("No issues");
		expect(text).toContain("Rust diagnostics unavailable");
	});
});
