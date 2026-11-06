import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { toggleToolRun } from "@oh-my-pi/pi-tui/chat/tool-run";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const frame = { tick: 0, now: 0 };
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

function call(label: string, target: string, running = false) {
	const tool = {
		name: label.toLowerCase(),
		label,
		renderCall: () => new Text(`CALL:${label}`, 0, 0),
		renderResult: (r: { content: Array<{ text?: string }> }) => new Text(`BODY:${r.content[0]?.text}`, 0, 0),
	};
	const c = new ToolExecutionComponent(
		label.toLowerCase(),
		{ path: target },
		{},
		tool as unknown as AgentTool,
		ui,
		process.cwd(),
	);
	if (running) c.setExecutionStarted();
	else c.updateResult({ content: [{ type: "text", text: `${label}-body` }] }, false);
	return c;
}

function reads(...files: string[]) {
	const g = new ReadToolGroupComponent();
	files.forEach((path, i) => {
		g.updateArgs({ path }, `r${i}`);
		g.updateResult({ content: [{ type: "text", text: "file-body" }] }, false, `r${i}`);
	});
	g.finalize();
	return g;
}

const usageRow = () => createUsageRowBlock(usage, 1000, undefined, 1_700_000_000_000);
const rows = (t: TranscriptContainer) => t.render(100).map(line => stripVTControlCharacters(line).trimEnd());
const viewport = (t: TranscriptContainer, height: number) =>
	t.renderViewport(100, height, frame).map(line => stripVTControlCharacters(line).trimEnd());

function transcript(...blocks: Parameters<TranscriptContainer["addChild"]>[0][]) {
	const t = new TranscriptContainer();
	for (const block of blocks) t.addChild(block);
	return t;
}

describe("display.groupToolCalls", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: false, collapsedToolTitles: false });
	});

	it("folds back-to-back calls, their usage rows and empty blocks into one summary row", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const t = transcript(
			reads("a.ts", "b.ts"),
			usageRow(),
			new Text("", 0, 0),
			call("Bash", "make test"),
			usageRow(),
			call("Bash", "make lint"),
			call("Edit", "src/app.ts"),
			usageRow(),
		);
		const rendered = rows(t);
		expect(rendered).toEqual([expect.stringContaining("5 tool calls")]);
		expect(rendered[0]).toContain("Read ×2 · Bash ×2 · Edit");
		expect(rendered[0]).not.toContain("BODY");
		expect(t.liveRowCount(100)).toBe(1);
	});

	it("starts a new run after visible content and leaves a lone call as its own block", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const t = transcript(
			call("Bash", "one"),
			call("Bash", "two"),
			new Text("thinking out loud", 0, 0),
			call("Edit", "x.ts"),
		);
		const rendered = rows(t).filter(line => line.length > 0);
		expect(rendered[0]).toContain("2 tool calls");
		expect(rendered[1]).toBe("thinking out loud");
		expect(rendered.slice(2).join("\n")).toContain("BODY:Edit-body");
		expect(rendered.join("\n")).not.toContain("1 tool calls");
	});

	it("shows every call once expanded with Ctrl+O, and folds again on collapse", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const blocks = [call("Bash", "one"), usageRow(), call("Edit", "x.ts")];
		const t = transcript(...blocks);
		for (const block of blocks) if (block instanceof ToolExecutionComponent) block.setExpanded(true);
		const expanded = rows(t).join("\n");
		expect(expanded).toContain("BODY:Bash-body");
		expect(expanded).toContain("BODY:Edit-body");
		expect(expanded).toContain("20.0/s");
		for (const block of blocks) if (block instanceof ToolExecutionComponent) block.setExpanded(false);
		expect(rows(t)).toEqual([expect.stringContaining("2 tool calls")]);
	});

	it("opens one run on a click on its row, and closes it on a click on any of its rows", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true, collapsedToolTitles: true });
		const first = call("Bash", "one");
		const second = call("Edit", "x.ts");
		const t = transcript(first, second);
		viewport(t, 10);
		const [clickId] = first.getClickFocusAgentIds();
		expect(clickId).toBeDefined();
		expect(second.getClickFocusAgentIds()).toEqual([clickId!]);

		expect(toggleToolRun(clickId!)).toBe(true);
		const open = viewport(t, 10).filter(line => line.length > 0);
		expect(open).toEqual([expect.stringContaining("Bash · one"), expect.stringContaining("Edit · x.ts")]);
		expect(second.getClickFocusAgentIds()).toEqual([clickId!]);

		toggleToolRun(clickId!);
		expect(viewport(t, 10)).toEqual([expect.stringContaining("2 tool calls")]);
	});

	it("names the live call under the summary while it runs", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const live = call("Bash", "make test", true);
		const t = transcript(call("Read", "a.ts"), live);
		const rendered = rows(t);
		expect(rendered).toHaveLength(2);
		expect(rendered[1]).toContain("Bash · make test");
		live.updateResult({ content: [{ type: "text", text: "done" }] }, false);
		expect(rows(t)).toHaveLength(1);
		live.stopAnimation();
	});

	it("keeps the summary live until every call settles, then retires it with the final count", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const live = call("Bash", "slow", true);
		const t = transcript(call("Read", "a.ts"), live);
		t.addChild(new Text("tail one", 0, 0));
		t.addChild(new Text("tail two", 0, 0));
		viewport(t, 10);
		// One row of room puts the summary under pressure; a running call holds it live.
		viewport(t, 1);
		expect(t.peekFinalizedBatch(100, 1)).toBeUndefined();

		live.updateResult({ content: [{ type: "text", text: "done" }] }, false);
		live.stopAnimation();
		viewport(t, 1);
		const batch = t.peekFinalizedBatch(100, 1);
		const retired = batch?.rows.map(line => stripVTControlCharacters(line).trimEnd()) ?? [];
		expect(retired[0]).toContain("2 tool calls");
		expect(retired.join("\n")).not.toContain("slow");
	});

	it("starts a fresh run for a call that lands after the summary retired", () => {
		setChatTranscriptDisplayPreferences({ groupToolCalls: true });
		const t = transcript(call("Read", "a.ts"), call("Read", "b.ts"));
		t.addChild(new Text("", 0, 0));
		viewport(t, 10);
		const batch = t.peekFlushBatch(100);
		if (!batch) throw new Error("expected a flush batch");
		expect(stripVTControlCharacters(batch.rows[0] ?? "")).toContain("2 tool calls");
		t.acknowledgeFinalizedBatch(batch.id);

		t.addChild(call("Bash", "late"));
		const live = viewport(t, 10).join("\n");
		expect(live).toContain("BODY:Bash-body");
	});

	it("leaves the transcript untouched when off", () => {
		const t = transcript(call("Bash", "one"), usageRow(), call("Edit", "x.ts"));
		const rendered = rows(t).join("\n");
		expect(rendered).toContain("BODY:Bash-body");
		expect(rendered).toContain("20.0/s");
		expect(rendered).not.toContain("tool calls");
	});
});
