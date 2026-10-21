import { describe, expect, it } from "bun:test";
import { type OutputMeta, formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";

/**
 * The model-facing notice for a file no language server judged (#15408). When
 * one result covers several files — a batched write merges them — each
 * unchecked file has to be named: a flat server list cannot say which file the
 * silence belongs to, so a warning about an earlier file reads as if it
 * applied to the last write of the batch.
 */
describe("the diagnostics notice", () => {
	it("names every unchecked file when the result covers several files", () => {
		const meta: OutputMeta = {
			diagnostics: {
				summary: "diagnostics unavailable from test-lsp",
				messages: [],
				unjudgedServers: ["test-lsp"],
				unjudgedFiles: [
					{ path: "src/a.ts", servers: ["test-lsp"] },
					{ path: "src/b.ts", servers: ["test-lsp"] },
				],
			},
		};

		const lines = formatOutputNotice(meta)
			.split("\n")
			.filter(line => line.startsWith("LSP diagnostics unavailable"));

		expect(lines).toEqual([
			"LSP diagnostics unavailable from test-lsp for src/a.ts",
			"LSP diagnostics unavailable from test-lsp for src/b.ts",
		]);
	});

	it("names the servers when the result covers a single file", () => {
		const meta: OutputMeta = {
			diagnostics: {
				summary: "diagnostics unavailable from test-lsp",
				messages: [],
				unjudgedServers: ["test-lsp"],
			},
		};

		const notice = formatOutputNotice(meta);

		expect(notice).toContain("LSP diagnostics unavailable from test-lsp");
		// A single-file result names no file, so the notice must not invent one.
		expect(notice).not.toContain(" for ");
	});
});
