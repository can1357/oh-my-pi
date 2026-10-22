import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { formatStatusIcon } from "@oh-my-pi/pi-tui/render/render-utils";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";

describe("display.collapsedToolTitles", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: false });
	});

	function mount(args: Record<string, unknown> = { path: "src/app.ts" }) {
		const tool = {
			name: "probe",
			label: "Probe",
			renderCall: () => new Text("CALL-CARD", 0, 0),
			renderResult: (r: { content: Array<{ text?: string }> }) => new Text(`BODY:${r.content[0]?.text}`, 0, 0),
		};
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		return new ToolExecutionComponent("probe", args, {}, tool as unknown as AgentTool, ui, process.cwd());
	}
	const text = (c: ToolExecutionComponent) => c.render(100).map(l => stripVTControlCharacters(l));

	it("draws one title row for a settled collapsed call, the full card once expanded", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const c = mount();
		c.updateResult({ content: [{ type: "text", text: "secret-output" }] }, false);
		c.seal?.();

		const collapsed = text(c);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("Probe · src/app.ts");
		expect(collapsed.join("\n")).not.toContain("secret-output");

		c.setExpanded(true);
		const expanded = text(c).join("\n");
		expect(expanded).toContain("BODY:secret-output");
	});

	const glyph = (status: Parameters<typeof formatStatusIcon>[0], frame?: number) =>
		stripVTControlCharacters(formatStatusIcon(status, theme, frame));

	it("leads each settled row with its semantic status glyph", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const ok = mount();
		ok.updateResult({ content: [{ type: "text", text: "fine" }] }, false);
		const bad = mount();
		bad.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
		const abandoned = mount();
		abandoned.seal();

		const [okRow] = text(ok);
		const [badRow, ...rest] = text(bad);
		expect(okRow.startsWith(`${glyph("success")} Probe`)).toBe(true);
		expect(badRow.startsWith(`${glyph("error")} Probe`)).toBe(true);
		expect(rest).toHaveLength(0);
		expect(badRow).not.toContain("boom");
		expect(text(abandoned)[0]?.startsWith(`${glyph("warning")} Probe`)).toBe(true);
	});

	it("keeps running calls and streamed partial results to an animated title row", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const c = mount({ command: "make test" });
		c.setExecutionStarted?.();
		expect(text(c)).toHaveLength(1);
		expect(text(c)[0]).toContain("Probe · make test");
		expect(text(c).join("\n")).not.toContain("CALL-CARD");

		c.updateResult({ content: [{ type: "text", text: "streamed-chunk" }] }, true);
		expect(text(c)).toHaveLength(1);
		expect(text(c).join("\n")).not.toContain("streamed-chunk");
		c.tickSpinner(1);
		expect(text(c)[0]?.startsWith(glyph("running", 1))).toBe(true);
		c.tickSpinner(2);
		expect(text(c)[0]?.startsWith(glyph("running", 2))).toBe(true);

		c.setExpanded(true);
		expect(text(c).join("\n")).toContain("BODY:streamed-chunk");
		c.stopAnimation();
	});

	it("strips terminal control sequences from the title target", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const c = mount({ path: "evil\u001b[2Jname.ts" });
		c.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		expect(c.render(100).join("")).not.toContain("\u001b[2J");
	});

	it("titles search-style calls by their query or pattern", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		for (const [key, value] of [
			["query", "omp collapse"],
			["pattern", "fn\\s+main"],
		]) {
			const c = mount({ [key]: value, path: "src" });
			const row = `Probe · ${value}`;
			expect(text(c)).toEqual([expect.stringContaining(row)]);
			c.setExecutionStarted();
			expect(text(c)).toEqual([expect.stringContaining(row)]);
			c.updateResult({ content: [{ type: "text", text: "hits" }] }, false);
			expect(text(c)).toEqual([expect.stringContaining(row)]);
			c.stopAnimation();
		}
	});

	it("hides a streaming built-in write body until expanded", () => {
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const c = new ToolExecutionComponent(
			"write",
			{ path: "src/app.ts", content: "const leaked = 1;\n" },
			{ useBuiltInRenderer: true },
			undefined,
			ui,
			process.cwd(),
		);
		const collapsed = text(c);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("src/app.ts");
		expect(collapsed.join("\n")).not.toContain("leaked");
		c.setExpanded(true);
		expect(text(c).join("\n")).toContain("leaked");
	});

	describe("read groups", () => {
		function readGroup(showContentPreview: boolean, files: string[]) {
			const g = new ReadToolGroupComponent({ showContentPreview });
			files.forEach((path, i) => {
				g.updateArgs({ path }, `r${i}`);
				g.updateResult({ content: [{ type: "text", text: `body-of-${path}` }] }, false, `r${i}`);
			});
			return g;
		}
		const lines = (g: ReadToolGroupComponent) =>
			g
				.render(100)
				.map(l => stripVTControlCharacters(l))
				.join("\n");

		for (const showContentPreview of [true, false]) {
			for (const files of [["a.ts"], ["a.ts", "b.ts"]]) {
				it(`lists paths, hides bodies until expanded (preview=${showContentPreview}, ${files.length} file)`, () => {
					setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
					const g = readGroup(showContentPreview, files);
					const collapsed = lines(g);
					for (const f of files) {
						expect(collapsed).toContain(f);
						expect(collapsed).not.toContain(`body-of-${f}`);
					}
					const head = files.length === 1 ? `Read · ${files[0]}` : `Read · (${files.length})`;
					expect(collapsed.split("\n")[0]?.trimEnd()).toBe(`${glyph("success")} ${head}`);
					g.setExpanded(true);
					const expanded = lines(g);
					for (const f of files) expect(expanded).toContain(`body-of-${f}`);
				});
			}
		}

		it("rebuilds a live group when the setting flips at runtime", () => {
			const g = readGroup(true, ["a.ts"]);
			expect(lines(g)).toContain("body-of-a.ts");
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
			expect(lines(g)).not.toContain("body-of-a.ts");
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: false });
			expect(lines(g)).toContain("body-of-a.ts");
		});
	});

	it("holds grouped read images back until expanded", () => {
		const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "looked at it" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		// Matches both the inline-image escape and the text fallback, whichever the test terminal uses.
		const imageRows = (a: AssistantMessageComponent) =>
			a.render(100).filter(l => l.includes(PNG_1X1.slice(0, 24)) || l.includes("[Image: image/png]")).length;
		const withImage = () => {
			const a = new AssistantMessageComponent(message);
			a.setToolResultImages("r1", [{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
			return a;
		};

		expect(imageRows(withImage())).toBe(1);
		setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
		const a = withImage();
		expect(imageRows(a)).toBe(0);
		a.setExpanded(true);
		expect(imageRows(a)).toBe(1);
	});

	it("leaves the default collapsed preview untouched when off", () => {
		const c = mount();
		c.updateResult({ content: [{ type: "text", text: "visible-output" }] }, false);
		c.seal?.();
		expect(text(c).join("\n")).toContain("BODY:visible-output");
	});

	describe("usage row spacing", () => {
		const usage = {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const frame = { tick: 0, now: 0 };

		/** A settled call and the turn's metrics row as the transcript appends them. */
		function mountTranscript() {
			const c = mount();
			c.updateResult({ content: [{ type: "text", text: "secret-output" }] }, false);
			c.seal?.();
			const transcript = new TranscriptContainer();
			transcript.addChild(c);
			transcript.addChild(createUsageRowBlock(usage, 1000, undefined, 1_700_000_000_000));
			return { c, transcript };
		}
		const rows = (transcript: TranscriptContainer) =>
			transcript.render(100).map(line => stripVTControlCharacters(line).trimEnd());
		const usageRowIndex = (rendered: readonly string[]) => rendered.findIndex(line => line.includes("20.0/s"));

		it("sets the metrics row directly under a collapsed title row", () => {
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
			const { transcript } = mountTranscript();
			const rendered = rows(transcript);
			expect(rendered).toHaveLength(2);
			expect(rendered[0]).toContain("Probe · src/app.ts");
			expect(rendered[1]).toContain("20.0/s");
			// The viewport's own sizing has to count the joined pair the same way.
			expect(transcript.liveRowCount(100)).toBe(rendered.length);
		});

		it("keeps a blank above the metrics row once the card is expanded", () => {
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
			const { c, transcript } = mountTranscript();
			c.setExpanded(true);
			const rendered = rows(transcript);
			const index = usageRowIndex(rendered);
			expect(index).toBeGreaterThan(1);
			expect(rendered[index - 1]).toBe("");
		});

		it("keeps a blank above the metrics row with title mode off", () => {
			const { transcript } = mountTranscript();
			const rendered = rows(transcript);
			const index = usageRowIndex(rendered);
			expect(index).toBeGreaterThan(1);
			expect(rendered[index - 1]).toBe("");
		});

		it("retires the title row without a gap before the metrics row that follows it", () => {
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
			const { transcript } = mountTranscript();
			transcript.addChild(new Text("tail", 0, 0));
			transcript.renderViewport(100, 10, frame);
			// Three rows of room keep only the tail block live, so the title row
			// retires on its own while the metrics row stays live.
			transcript.renderViewport(100, 3, frame);
			const batch = transcript.peekFinalizedBatch(100, 3);
			expect(batch?.rows.map(line => stripVTControlCharacters(line).trimEnd())).toEqual([
				expect.stringContaining("Probe · src/app.ts"),
			]);
			if (!batch) throw new Error("expected a retirement batch");
			transcript.acknowledgeFinalizedBatch(batch.id);
			const viewport = transcript.renderViewport(100, 10, frame).map(line => stripVTControlCharacters(line));
			expect(viewport[0]?.trimEnd()).toContain("20.0/s");
		});

		it("sees the metrics row past a block that draws no rows", () => {
			setChatTranscriptDisplayPreferences({ collapsedToolTitles: true });
			const c = mount();
			c.updateResult({ content: [{ type: "text", text: "secret-output" }] }, false);
			c.seal?.();
			const transcript = new TranscriptContainer();
			transcript.addChild(c);
			// A post-tool assistant segment with nothing to show (hidden thinking)
			// sits between the call and the metrics row it does not own.
			transcript.addChild(new Text("", 0, 0));
			transcript.addChild(createUsageRowBlock(usage, 1000, undefined, 1_700_000_000_000));
			transcript.addChild(new Text("tail", 0, 0));
			expect(transcript.render(100)).toHaveLength(4);
			transcript.renderViewport(100, 10, frame);
			transcript.renderViewport(100, 3, frame);
			const batch = transcript.peekFinalizedBatch(100, 3);
			expect(batch?.rows.map(line => stripVTControlCharacters(line).trimEnd())).toEqual([
				expect.stringContaining("Probe · src/app.ts"),
			]);
			if (!batch) throw new Error("expected a retirement batch");
			transcript.acknowledgeFinalizedBatch(batch.id);
			const viewport = transcript.renderViewport(100, 10, frame).map(line => stripVTControlCharacters(line));
			expect(viewport[0]?.trimEnd()).toContain("20.0/s");
		});
	});
});
