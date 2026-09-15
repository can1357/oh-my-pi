import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatStatusIcon } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, requestComponentRender() {}, clearInlineImages() {} } as unknown as TUI;

function bashCard(command: string, output: string): ToolExecutionComponent {
	const card = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	card.updateResult({ content: [{ type: "text", text: output }], details: { exitCode: 0 } }, false);
	return card;
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

describe("tool output details", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("folds a settled card into its one-line call summary and back", () => {
		const card = bashCard("ls -la", "total 0\nfile-a\nfile-b\n");
		try {
			const full = plain(card.render(120));
			expect(full).toContain("ls -la");
			expect(full).toContain("file-a");

			card.setToolOutputDetailsHidden(true);
			const folded = card.render(120);
			expect(folded).toHaveLength(1);
			expect(plain(folded)).toContain("ls -la");
			expect(plain(folded)).not.toContain("file-a");

			card.setToolOutputDetailsHidden(false);
			const restored = plain(card.render(120));
			expect(restored).toContain("file-a");
		} finally {
			card.stopAnimation();
		}
	});

	it("folds cards that enter a container after the setting", () => {
		const container = new TranscriptContainer();
		container.setToolOutputDetailsHidden(true);
		const card = bashCard("ls -la", "file-a\n");
		try {
			container.addChild(card);
			expect(card.render(120)).toHaveLength(1);
		} finally {
			card.stopAnimation();
		}
	});

	it("folds cards already in the transcript", () => {
		const container = new TranscriptContainer();
		const card = bashCard("ls -la", "file-a\n");
		try {
			container.addChild(card);
			expect(card.render(120).length).toBeGreaterThan(1);

			container.setToolOutputDetailsHidden(true);
			expect(card.render(120)).toHaveLength(1);
		} finally {
			card.stopAnimation();
		}
	});

	it("drops read content previews but keeps the read rows", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "/tmp/example.ts" }, "read-0");
		group.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }] }, false, "read-0");

		const withPreview = plain(group.render(120));
		expect(withPreview).toContain("line 1");
		expect(withPreview).toContain("example.ts");

		group.setToolOutputDetailsHidden(true);
		const folded = plain(group.render(120));
		expect(folded).toContain("example.ts");
		expect(folded).not.toContain("line 1");
	});

	it("shortens a home-directory path in the folded summary", () => {
		const home = os.homedir();
		// No built-in renderer for this name, so the generic summary supplies the row.
		const card = new ToolExecutionComponent(
			"custom-thing",
			{ path: `${home}/projects/notes.md` },
			{},
			undefined,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const folded = plain(card.render(120));

			expect(folded).toContain("~/projects/notes.md");
			expect(folded).not.toContain(home);
		} finally {
			card.stopAnimation();
		}
	});

	it("strips terminal control bytes out of a folded summary", () => {
		const card = new ToolExecutionComponent(
			"custom-thing",
			{ command: "echo \u0007banner\u001b[2J" },
			{},
			undefined,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const row = card.render(120).join("");

			expect(row).not.toContain("\u0007");
			expect(row).not.toContain("\u001b[2J");
			expect(Bun.stripANSI(row)).toContain("echo banner");
		} finally {
			card.stopAnimation();
		}
	});

	it("strips terminal control bytes out of a renderer-provided summary", () => {
		// `hub` is a renderer-backed tool whose summary detail is a model-supplied
		// target, so this exercises the path that never reaches the generic branch.
		const card = new ToolExecutionComponent(
			"hub",
			{ op: "send", to: "agent\u0007\u001b[2J", message: "hi" },
			{},
			undefined,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const row = card.render(120).join("");

			expect(row).not.toContain("\u0007");
			expect(row).not.toContain("\u001b[2J");
			expect(Bun.stripANSI(row)).toContain("send → agent");
		} finally {
			card.stopAnimation();
		}
	});

	it("shortens a home-directory argument inside a device summary", () => {
		const home = os.homedir();
		// `write` targeting a device delegates its summary to the xdev helper, which
		// echoes inner arguments such as `path` verbatim.
		const card = new ToolExecutionComponent(
			"write",
			{ path: "xd://grep", content: JSON.stringify({ pattern: "needle", path: `${home}/project` }) },
			{},
			undefined,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const row = plain(card.render(120));

			expect(row).toContain("~/project");
			expect(row).not.toContain(home);
		} finally {
			card.stopAnimation();
		}
	});

	it("collapses whitespace in a multi-line tool label", () => {
		// Extension and MCP tools supply their own label, and `sanitizeText` keeps
		// tabs and newlines, so a folded row would otherwise carry extra lines.
		const card = new ToolExecutionComponent(
			"custom-thing",
			{ command: "ls" },
			{},
			{ label: "Grep\tFiles\nNow" } as never,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const rows = card.render(120);

			expect(rows).toHaveLength(1);
			expect(plain(rows)).toContain("Grep Files Now");
		} finally {
			card.stopAnimation();
		}
	});

	it("shortens a home path embedded in a folded command", () => {
		const home = os.homedir();
		const card = new ToolExecutionComponent(
			"custom-thing",
			{ command: `cat ${home}/notes.md` },
			{},
			undefined,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const row = plain(card.render(120));

			expect(row).toContain("cat ~/notes.md");
			expect(row).not.toContain(home);
		} finally {
			card.stopAnimation();
		}
	});

	it("keeps a folded read group to one row per call", () => {
		const longPath = `/${"segment-".repeat(12)}file.ts`;
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: longPath }, "read-0");
		group.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }] }, false, "read-0");

		group.setToolOutputDetailsHidden(true);

		const rows = group.render(40);

		expect(rows).toHaveLength(1);
		expect(Bun.stringWidth(plain(rows))).toBeLessThanOrEqual(40);
	});

	it("shortens a home path inside a folded label", () => {
		const home = os.homedir();
		const card = new ToolExecutionComponent(
			"custom-thing",
			{ command: "ls" },
			{},
			{ label: `Inspect ${home}/repo` } as never,
			uiStub,
		);
		try {
			card.setToolOutputDetailsHidden(true);

			const row = plain(card.render(120));

			expect(row).toContain("Inspect ~/repo");
			expect(row).not.toContain(home);
		} finally {
			card.stopAnimation();
		}
	});

	it("keeps a folded read group to one row while usage is shown", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: false });
		group.updateArgs({ path: "/tmp/usage.ts" }, "read-0");
		group.updateResult({ content: [{ type: "text", text: "line 1" }] }, false, "read-0");
		group.attachUsage(
			["read-0"],
			{
				input: 1111,
				output: 11,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1122,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			1000,
			500,
		);

		group.setToolOutputDetailsHidden(true);

		const rows = group.render(120);

		expect(rows).toHaveLength(1);
		expect(plain(rows)).toContain("usage.ts");
		expect(plain(rows)).toContain("1.1K");
	});

	it("keeps an interrupted call neutral while folded", () => {
		// Steering interrupts a pending call and reports `isError`; the full card
		// renders the placeholder neutrally, so the folded row must not claim failure.
		const skipped = new ToolExecutionComponent("custom-thing", { command: "sleep 30" }, {}, undefined, uiStub);
		skipped.updateResult(
			{
				content: [{ type: "text", text: "skipped" }],
				isError: true,
				details: { source: "interrupt_skipped", __synthetic: true },
			},
			false,
		);
		try {
			skipped.setToolOutputDetailsHidden(true);

			const row = plain(skipped.render(120));

			expect(row.startsWith(Bun.stripANSI(formatStatusIcon("error", theme)))).toBe(false);
		} finally {
			skipped.stopAnimation();
		}
	});

	it("keeps a failed call distinguishable from a successful one while folded", () => {
		const failed = new ToolExecutionComponent("custom-thing", { command: "exit 1" }, {}, undefined, uiStub);
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
		const succeeded = new ToolExecutionComponent("custom-thing", { command: "exit 1" }, {}, undefined, uiStub);
		succeeded.updateResult({ content: [{ type: "text", text: "fine" }], isError: false }, false);
		try {
			failed.setToolOutputDetailsHidden(true);
			succeeded.setToolOutputDetailsHidden(true);

			const failedRow = plain(failed.render(120));
			const succeededRow = plain(succeeded.render(120));
			const errorGlyph = Bun.stripANSI(formatStatusIcon("error", theme));

			expect(failedRow.startsWith(errorGlyph)).toBe(true);
			expect(succeededRow.startsWith(errorGlyph)).toBe(false);
		} finally {
			failed.stopAnimation();
			succeeded.stopAnimation();
		}
	});
});
