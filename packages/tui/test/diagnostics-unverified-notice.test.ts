import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import type { FileDiagnosticsResult } from "../src/tools/lsp";
import { diagnosticsBadge, diagnosticsSection } from "../src/tools/native-view";
import { formatOutputNotice, type OutputMeta } from "../src/tools/output-meta";

/**
 * Issue #15408: a file whose language server never published a report has no
 * messages, which used to render exactly like a file that came back clean.
 * Every surface that shows diagnostics has to say the file is unverified.
 */

const UNVERIFIED: FileDiagnosticsResult = {
	messages: [],
	summary: "no diagnostics report yet from silent-lsp",
	errored: false,
	unreported: ["silent-lsp"],
};

const CHECKED_CLEAN: FileDiagnosticsResult = { messages: [], summary: "OK", errored: false };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function prop(node: NativeNode, key: string): unknown {
	return node.p && key in node.p ? Reflect.get(node.p, key) : undefined;
}

function spanText(node: NativeNode, key: "spans" | "head"): string {
	const spans = prop(node, key);
	return Array.isArray(spans) ? spans.map(span => String(span.t)).join("") : "";
}

describe("diagnostics notice for an unverified file", () => {
	it("names the servers that sent no report in the tool notice", () => {
		const meta: OutputMeta = { diagnostics: UNVERIFIED };

		const notice = formatOutputNotice(meta);

		expect(notice).toContain("LSP diagnostics unavailable: no diagnostics report yet from silent-lsp");
		expect(notice).not.toContain("no issues");
	});

	it("stays silent for a file that was checked and came back clean", () => {
		const checked: OutputMeta = { diagnostics: CHECKED_CLEAN };

		expect(formatOutputNotice(checked)).toBe("");
	});

	it("renders a row naming the servers when the file has no findings", () => {
		const children = (diagnosticsSection(UNVERIFIED)?.c ?? []).filter(isNode);
		const rows = children.filter(child => prop(child, "role") === "omp.tool.diagnostic");

		expect(rows).toHaveLength(1);
		expect(spanText(rows[0]!, "spans")).toBe("no diagnostics report yet from silent-lsp");
	});

	it("still renders nothing for a file with no findings and no unreported server", () => {
		expect(diagnosticsSection(undefined)).toBeUndefined();
		expect(diagnosticsSection(CHECKED_CLEAN)).toBeUndefined();
	});

	it("keeps the unverified row visible past the five-row cap", () => {
		const messages = Array.from({ length: 6 }, (_, i) => `src/a.ts:${i + 1}:1 [error] failure ${i}`);
		const children = (
			diagnosticsSection({ messages, summary: "6 error(s)", errored: true, unreported: ["silent-lsp"] })?.c ?? []
		).filter(isNode);

		// The cap applies to findings only: the status is news about the file, not a finding.
		expect(spanText(children.at(-1)!, "spans")).toBe("no diagnostics report yet from silent-lsp");
	});

	it("marks the head chip instead of counting an unverified file as clean", () => {
		expect(diagnosticsBadge([UNVERIFIED])).toEqual({ text: "diagnostics unverified", tone: "warning" });
		expect(diagnosticsBadge([CHECKED_CLEAN])).toBeUndefined();
		expect(
			diagnosticsBadge([{ messages: ["src/a.ts:1:1 [error] boom"], summary: "1 error(s)", errored: true }]),
		).toEqual({ text: "1 diagnostic", tone: "error" });
		// A server that reported findings does not make a silent one's silence clean.
		expect(
			diagnosticsBadge([
				{ messages: ["src/a.ts:1:1 [error] boom"], summary: "1 error(s)", errored: true },
				UNVERIFIED,
			]),
		).toEqual({ text: "1 diagnostic · unverified", tone: "error" });
	});
});
