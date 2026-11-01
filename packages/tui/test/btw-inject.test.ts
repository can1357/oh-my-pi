import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	type BtwHistoryRecord,
	getBtwInject,
	getBtwRecordInject,
	splitBtwInject,
} from "@oh-my-pi/pi-tui/overlays/btw-history";
import { BTW_INJECT_LABEL, BTW_INJECTED_LABEL } from "@oh-my-pi/pi-tui/overlays/btw-inject";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

describe("btw <inject> blocks", () => {
	it("takes the complete block even when the answer mentions the tag in prose around it", () => {
		expect(getBtwInject("I'll wrap it in <inject> tags:\n<inject>\n  Stop retrying the build.\n</inject>")).toBe(
			"Stop retrying the build.",
		);
		expect(getBtwInject("<inject>Stop retrying.</inject>\nThe <inject> block above is ready.")).toBe(
			"Stop retrying.",
		);
		// A later stray closing tag must not pull the prose between into the prompt.
		expect(getBtwInject("<inject>Stop.</inject> The delimiter is </inject>.")).toBe("Stop.");
	});

	it("sends nothing until the block closes, and nothing for a blank block", () => {
		expect(splitBtwInject("Status ok.\n<inject>Stop ret")).toEqual({
			before: "Status ok.\n",
			inject: "Stop ret",
			after: "",
			closed: false,
		});
		expect(getBtwInject("Status ok.\n<inject>Stop ret")).toBeUndefined();
		expect(getBtwInject("<inject> \n </inject>")).toBeUndefined();
		expect(getBtwInject("No steering needed.")).toBeUndefined();
	});

	it("sends exactly what the block shows: control sequences never ride along hidden", () => {
		expect(getBtwInject("<inject>Stop \x1b[31mnow\x1b[0m.</inject>")).toBe("Stop now.");
		// Only control content: nothing visible, so nothing to send.
		expect(getBtwInject("<inject>\x1b[31m\x1b[0m</inject>")).toBeUndefined();
	});

	it("offers a topic's block only from its completed latest turn", () => {
		const record: BtwHistoryRecord = {
			id: "r1",
			leafId: null,
			question: "Status?",
			answer: "<inject>Old prompt</inject>",
			status: "complete",
			createdAt: 1,
			updatedAt: 1,
			followUps: [
				{
					question: "Again?",
					answer: "<inject>New prompt</inject>",
					status: "running",
					createdAt: 2,
					updatedAt: 2,
				},
			],
		};
		expect(getBtwRecordInject(record)).toBeUndefined();
		expect(getBtwRecordInject({ ...record, followUps: [{ ...record.followUps![0]!, status: "complete" }] })).toBe(
			"New prompt",
		);
	});

	it("sends without moving the block: same rows and text column, arrow and label change in place", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Stuck?", tui: ui, canInject: () => true });
		const prompt = "Stop the audit now, cancel every running agent, delete the clone, and report what you removed.";
		panel.setAnswer(`It is looping.\n<inject>${prompt}</inject>\nThat should do it.`);
		panel.markComplete();
		// Panel rows inside the `│ … │` frame.
		const rows = () =>
			Bun.stripANSI(panel.render(52).join("\n"))
				.split("\n")
				.map(line => line.slice(2, -2).trimEnd());
		const rail = theme.symbol("btw.rail");
		const arrow = theme.nav.selected;
		const blockRows = (lines: string[]) => lines.flatMap((line, index) => (line.startsWith(rail) ? [index] : []));
		const column = `${rail} ${arrow} `.length;

		const pending = rows();
		panel.setInjected(true);
		const sent = rows();
		const block = blockRows(pending);
		expect(blockRows(sent)).toEqual(block);
		expect(block.length).toBeGreaterThan(2);
		for (const index of block) {
			expect(pending[index]!.startsWith(`${rail} ${" ".repeat(arrow.length)} `)).toBe(true);
			expect(sent[index]!.startsWith(`${rail} ${arrow} `)).toBe(true);
		}
		const text = (lines: string[]) =>
			block
				.slice(0, -1)
				.map(index => lines[index]!.slice(column))
				.join(" ");
		expect(text(pending)).toBe(prompt);
		expect(text(sent)).toBe(prompt);
		expect(pending[block.at(-1)!]!.slice(column)).toBe(BTW_INJECT_LABEL);
		expect(sent[block.at(-1)!]!.slice(column)).toBe(BTW_INJECTED_LABEL);
		expect(pending.join("\n")).not.toContain("<inject>");
		expect(panel.title).not.toContain("Injected");
		expect(sent).toContain("It is looping.");
		expect(sent).toContain("That should do it.");
	});

	it("splits an unclosed block out only while it streams; a finished answer keeps it as plain text", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Stuck?", tui: ui, canInject: () => true });
		const rail = theme.symbol("btw.rail");
		const railRows = () =>
			Bun.stripANSI(panel.render(60).join("\n"))
				.split("\n")
				.filter(line => line.slice(2).startsWith(rail)).length;

		panel.appendText("Status ok.\n<inject>Stop the build");
		expect(railRows()).toBeGreaterThan(0);
		panel.markComplete();
		expect(railRows()).toBe(0);
	});
});
