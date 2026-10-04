/**
 * A remote transport's delivery receipts are bridge-controlled input: the
 * agent-write renderer must strip terminal escapes, Unicode line breaks, and
 * lone surrogates from receipt ids/errors before they reach the terminal
 * (#7401 review; ported from the retired hub renderer's regression).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { renderAgentWrite } from "@oh-my-pi/pi-tui/tools/proc-render";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";

describe("renderAgentWrite receipt sanitization", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("sanitizes a remote transport's failed-receipt id and error before rendering (#7401)", () => {
		const component = renderAgentWrite(
			"all",
			"heads up",
			{ content: [{ type: "text", text: "" }] },
			{
				op: "send",
				from: "Main",
				to: "all",
				receipts: [
					{ to: "AuthLoader", outcome: "woken" },
					{
						to: "@cluster/e\tvil\u2028name",
						outcome: "failed",
						error: "\x1b[2Jboom\nINJECTED\u2029tail\ud800",
					},
				],
			} satisfies CoordinationDetails,
			{ expanded: false, isPartial: false },
			theme,
		);
		const rendered = (component.render(200) as readonly string[]).join("\n");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toMatch(/[\u2028\u2029\ud800]/u);
		const raw = Bun.stripANSI(rendered);
		expect(raw).toContain("boom INJECTED tail");
		expect(raw).toContain("@cluster/e vil name");
		expect(raw).not.toContain("boom\n");
		expect(raw).not.toContain("e\tvil");
	});
});
