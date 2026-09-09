import { describe, expect, it } from "bun:test";
import type { FileDiagnosticsResult } from "@oh-my-pi/pi-coding-agent/lsp";
import { DiagnosticsLedger, diagnosticIdentity } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics-ledger";

const FILE_A = "/repo/src/a.ts";
const FILE_B = "/repo/src/b.ts";

const TYPE_ERROR =
	'src/a.ts:12:5 [error] pyright: Type "str" is not assignable to declared type "int" (reportAssignmentType)';
const TYPE_ERROR_SHIFTED =
	'src/a.ts:48:19 [error] pyright: Type "str" is not assignable to declared type "int" (reportAssignmentType)';
const PRIVATE_IMPORT =
	'src/a.ts:20:7 [warning] pyright: "device" is not exported from module "torch" (reportPrivateImportUsage)';
const PRIVATE_IMPORT_SHIFTED =
	'src/a.ts:58:11 [warning] pyright: "device" is not exported from module "torch" (reportPrivateImportUsage)';
const NEW_ERROR =
	'src/a.ts:60:3 [error] pyright: Cannot access attribute "missing" for class "Widget" (reportAttributeAccessIssue)';

function makeDiagnostics(
	messages: string[],
	options: { summary?: string; errored?: boolean; server?: string } = {},
): FileDiagnosticsResult {
	return {
		server: options.server ?? "pyright",
		messages,
		summary: options.summary ?? (messages.length === 0 ? "OK" : `${messages.length} diagnostic(s)`),
		errored: options.errored ?? messages.some(message => message.includes("[error]")),
	};
}

describe("DiagnosticsLedger", () => {
	it("returns all messages unchanged the first time a file is reduced", () => {
		const ledger = new DiagnosticsLedger();
		const first = makeDiagnostics([TYPE_ERROR, PRIVATE_IMPORT], { summary: "1 error(s), 1 warning(s)" });

		const reduced = ledger.reduce(FILE_A, first);

		expect(reduced).toBe(first);
		expect(reduced.messages).toEqual([TYPE_ERROR, PRIVATE_IMPORT]);
	});

	it("fully suppresses an identical second reduce", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR, PRIVATE_IMPORT]));

		const reduced = ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR, PRIVATE_IMPORT]));

		expect(reduced.messages).toEqual([]);
		expect(reduced.summary).toBe("no issues");
		expect(reduced.errored).toBe(false);
	});

	it("suppresses diagnostics whose line and column shifted", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR, PRIVATE_IMPORT]));

		const reduced = ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR_SHIFTED, PRIVATE_IMPORT_SHIFTED]));

		expect(reduced.messages).toEqual([]);
	});

	it("returns only genuinely new messages and recomputes summary state", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR, PRIVATE_IMPORT]));

		const reduced = ledger.reduce(
			FILE_A,
			makeDiagnostics([TYPE_ERROR_SHIFTED, PRIVATE_IMPORT_SHIFTED, NEW_ERROR], {
				summary: "2 error(s), 1 warning(s)",
			}),
		);

		expect(reduced.messages).toEqual([NEW_ERROR]);
		expect(reduced.summary).toBe("1 error(s)");
		expect(reduced.errored).toBe(true);
		expect(reduced.server).toBe("pyright");
	});

	it("re-surfaces a diagnostic after it was removed", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR]));
		ledger.reduce(FILE_A, makeDiagnostics([]));

		const reduced = ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR]));

		expect(reduced.messages).toEqual([TYPE_ERROR]);
	});

	it("tracks files independently", () => {
		const ledger = new DiagnosticsLedger();
		ledger.reduce(FILE_A, makeDiagnostics([TYPE_ERROR]));

		const reduced = ledger.reduce(FILE_B, makeDiagnostics([TYPE_ERROR]));

		expect(reduced.messages).toEqual([TYPE_ERROR]);
	});
});

describe("diagnosticIdentity", () => {
	it("strips path, line, and column while preserving diagnostic identity", () => {
		const first = "fixtures/pkg:2/example.ts:12:5 [error] pyright: Broken import (E1)";
		const shifted = "fixtures/pkg:2/example.ts:99:27 [error] pyright: Broken import (E1)";

		expect(diagnosticIdentity(first)).toBe("[error] pyright: Broken import (E1)");
		expect(diagnosticIdentity(shifted)).toBe(diagnosticIdentity(first));
	});

	it("distinguishes severity and code changes", () => {
		const base = diagnosticIdentity("src/a.ts:1:1 [error] pyright: Broken import (E1)");

		expect(diagnosticIdentity("src/a.ts:1:1 [warning] pyright: Broken import (E1)")).not.toBe(base);
		expect(diagnosticIdentity("src/a.ts:1:1 [error] pyright: Broken import (E2)")).not.toBe(base);
	});

	it("falls back to the full message when the prefix is unparseable", () => {
		const message = "pyright: Broken import (E1)";

		expect(diagnosticIdentity(message)).toBe(message);
	});
});
