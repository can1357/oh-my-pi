import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDialog } from "../src/components/ApprovalDialog";
import type { RpcBridge } from "../src/rpc/bridge";
import type { ExtensionUiRequestFrame } from "../src/rpc/protocol";

const bridge = { answerUi: () => {} } as unknown as RpcBridge;

function render(request: Partial<ExtensionUiRequestFrame>): string {
	return renderToStaticMarkup(
		<ApprovalDialog
			bridge={bridge}
			request={{ type: "extension_ui_request", id: "1", method: "select", ...request } as ExtensionUiRequestFrame}
		/>,
	);
}

describe("ApprovalDialog", () => {
	test("a plan review renders the plan as markdown, in a document-sized dialog", () => {
		const markup = render({
			title: "Plan Review — readme",
			message: "# Readme\n\n- one\n",
			planFilePath: "local://readme-plan.md",
			options: ["Approve and execute", "Refine plan"],
		});

		expect(markup).toContain("omp-modal--document");
		expect(markup).toContain("omp-modal__plan");
		// The heading became a heading, rather than printing its hash.
		expect(markup).toContain("<h1");
		expect(markup).toContain("<li>one</li>");
	});

	test("an ask keeps its prose intact and never reaches the markdown renderer", () => {
		// Without `planFilePath` the message is prose. Running it through markdown
		// would reinterpret its punctuation — `#` becomes a heading, `*` italics.
		const markup = render({
			title: "Question",
			message: "# not a heading, and *not* italics",
			options: ["Yes", "No"],
		});

		expect(markup).not.toContain("omp-modal__plan");
		expect(markup).not.toContain("<h1");
		expect(markup).toContain("omp-modal__message");
		expect(markup).toContain("# not a heading, and *not* italics");
	});

	test("a plain select is wide, not document-sized", () => {
		const markup = render({ title: "Pick one", options: ["a", "b"] });

		expect(markup).toContain("omp-modal--wide");
		expect(markup).not.toContain("omp-modal--document");
	});

	test("options are rows carrying their number, so the keys and the print agree", () => {
		const markup = render({
			title: "Pick one",
			options: ["Approve and execute", "Refine plan"],
			optionDetails: [{ description: "Leave plan mode and carry it out" }, {}],
		});

		expect(markup).toContain("omp-option__key");
		expect(markup).toContain(">1<");
		expect(markup).toContain(">2<");
		expect(markup).toContain("Leave plan mode and carry it out");
	});

	test("an editor opens on the document it was handed, on the very first paint", () => {
		// `/review`'s custom mode sends this scaffold as `prefill`. Asserted through
		// static markup precisely because that render never runs an effect: it pins
		// the initial state, so a first frame with an empty box cannot come back.
		const markup = render({
			method: "editor",
			title: "Custom review instructions",
			prefill: "Review the following:\n\n",
		});

		expect(markup).toContain(">Review the following:\n\n</textarea>");
	});
});
