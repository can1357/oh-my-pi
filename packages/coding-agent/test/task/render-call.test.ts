import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";

describe("task renderer: streaming call preview", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const resolved = await getThemeByName("dark");
		expect(resolved).toBeDefined();
		theme = resolved!;
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function render(args: TaskParams, expanded = false): string {
		const component = taskToolRenderer.renderCall(args, { expanded, isPartial: true }, theme);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	// The preview must surface the dispatched agent type + name while args
	// stream in: the flat header carries the agent type, and the agent row's
	// secondary text is the FIRST line of the task brief only.
	it("shows the agent type in the header and the first task line on the agent row", () => {
		const args: TaskParams = {
			agent: "reviewer",
			name: "ReviewAuth",
			task: "Review packages/server/src/auth for missing 401 handling.\nReport findings.",
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(lines[0]).toContain("reviewer");
		const row = lines.find(line => line.includes("ReviewAuth"));
		expect(row).toBeDefined();
		expect(row).toContain("Review packages/server/src/auth for missing 401 handling.");
		expect(row).not.toContain("Report findings.");
		// A non-default agent type also badges the row itself.
		expect(row).toContain(`${theme.format.bracketLeft}reviewer${theme.format.bracketRight}`);
	});

	it("caps the agent-row brief to a single preview line", () => {
		const args: TaskParams = {
			agent: "task",
			name: "CapCheck",
			task: `${"x".repeat(80)} TAIL_MARKER\nsecond line`,
		};
		const row = render(args)
			.split("\n")
			.find(line => line.includes("CapCheck"));

		expect(row).toBeDefined();
		expect(row).toContain("…");
		expect(row).not.toContain("TAIL_MARKER");
	});

	it("renders partially-streamed args (name only, no task yet) without crashing", () => {
		const args: TaskParams = { name: "First" };

		const out = render(args);

		expect(out).toContain("First");
	});

	it("always renders the full task markdown, collapsed or expanded", () => {
		const taskLines = Array.from({ length: 6 }, (_, i) => `Step ${i + 1}: do the thing.`);
		const args: TaskParams = {
			agent: "task",
			name: "Worker",
			task: taskLines.join("\n"),
		};

		// The task text is the brief handed to the subagent; it renders as
		// markdown in full regardless of the expanded toggle.
		const collapsed = render(args, false);
		expect(collapsed).toContain("Step 1");
		expect(collapsed).toContain("Step 6");

		const expanded = render(args, true);
		expect(expanded).toContain("Step 1");
		expect(expanded).toContain("Step 6");
	});

	it("surfaces the isolation flag in the header bar", () => {
		const args: TaskParams = {
			agent: "task",
			isolated: true,
			name: "Only",
			task: "...",
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(out).toContain("Only");
		// Isolation is surfaced as header meta in the frame's top bar (first line),
		// not as a trailing child row under the task list.
		expect(lines[0]).toContain("isolated");
	});

	// The batch schema streams `context` before `tasks`, and `renderResult`
	// draws context/assignment above the agent rows. The call preview must use
	// the same order: agent rows above the context would shift the whole brief
	// down on every streamed item, then visibly jump below it once the first
	// progress snapshot replaces the call view.
	it("renders the per-agent list below the context brief, one row per item", () => {
		const args: TaskParams = {
			context: "# Goal\nFix the bench branches.",
			tasks: [
				{ name: "Fix01Foundation", task: "Fix bench/01-foundation-memory" },
				{ name: "Fix02Setup", task: "Fix bench/02-setup" },
			],
		};
		const out = render(args);

		const contextAt = out.indexOf("Fix the bench branches.");
		const firstAgentAt = out.indexOf("Fix01Foundation");
		expect(contextAt).toBeGreaterThanOrEqual(0);
		expect(firstAgentAt).toBeGreaterThan(contextAt);
		expect(out.indexOf("Fix02Setup")).toBeGreaterThan(firstAgentAt);
		// Each item row carries its own first task line as secondary text.
		const row = out.split("\n").find(line => line.includes("Fix01Foundation"));
		expect(row).toContain("Fix bench/01-foundation-memory");
	});

	it("badges non-default agent types on item rows and keeps the generic worker bare", () => {
		const args: TaskParams = {
			context: "ctx",
			tasks: [
				{ name: "Scouty", agent: "scout", task: "map the code" },
				{ name: "Worker", agent: "task", task: "do the work" },
			],
		};
		const out = render(args);

		expect(out).toContain(`${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
		expect(out).not.toContain(`${theme.format.bracketLeft}task${theme.format.bracketRight}`);
		// Agent types live on the item rows; the batch header no longer joins them.
		expect(out.split("\n")[0]).not.toContain("scout");
	});

	// Early in the stream only `context` has parsed; the (empty) agent-list
	// section must not draw a stray trailing divider bar.
	it("omits the agent-list divider while no agent rows exist yet", () => {
		const args: TaskParams = { context: "# Goal\nShared brief." };
		const out = render(args);
		const lines = out.split("\n");

		expect(out).toContain("Shared brief.");
		// Interior divider bars start with the tee glyph; only the header (top)
		// and bottom border may exist.
		const tee = theme.boxRound.teeRight;
		expect(lines.filter(line => line.trimStart().startsWith(tee))).toHaveLength(0);
	});

	// Once the tool produces a result, the container suppresses the call entirely
	// via `mergeCallAndResult` and `renderResult` draws the agent. As a safety
	// net, `renderCall` also drops its preview when a result snapshot is present,
	// so the two never stack.
	it("drops the preview once a result snapshot exists", () => {
		const args: TaskParams = {
			agent: "reviewer",
			name: "ReviewAuth",
			task: "Review the auth module.",
		};
		const component = taskToolRenderer.renderCall(
			args,
			{ expanded: false, isPartial: true, renderContext: { hasResult: true } },
			theme,
		);
		const out = Bun.stripANSI(component.render(160).join("\n"));

		expect(out).not.toContain("Review the auth module.");
		expect(out).not.toContain("ReviewAuth");
	});
});
