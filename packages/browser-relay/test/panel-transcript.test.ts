import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { TabContext } from "../extension/messages";
import { describeStep } from "../extension/panel/describe";
import { parseTime } from "../extension/panel/schedule";
import { composePrompt, parsePrompt, TAB_AUTHORIZATION, tabContextBlock } from "../extension/panel/tab-context";
import { buildCommitted, buildTimeline, isStep, liveVerb, type TimelineItem } from "../extension/panel/timeline";

const TAB: TabContext = {
	tabId: 412,
	windowId: 1,
	url: "https://github.com/can1357/oh-my-pi/pull/42?a=1&b=2",
	title: 'Fix "relay" <reconnect> · PR #42',
	groupId: -1,
	targetId: "PAGEab12cd34.412",
	viewport: { width: 1440, height: 900 },
};

describe("tab context block", () => {
	it("starts the prompt with the tag and the authorization sentence the agent reads", () => {
		const prompt = composePrompt([tabContextBlock(TAB, TAB.viewport)], "Merge this if CI is green");
		expect(prompt).toBe(
			'<chrome-tab target="PAGEab12cd34.412" url="https://github.com/can1357/oh-my-pi/pull/42?a=1&amp;b=2" ' +
				'title="Fix &quot;relay&quot; &lt;reconnect&gt; · PR #42" viewport="1440x900"/>\n' +
				`${TAB_AUTHORIZATION}\n\nMerge this if CI is green`,
		);
	});

	it("reads back as tab chips and the text the user typed", () => {
		const other = { ...TAB, tabId: 7, targetId: "PAGEab12cd34.7", url: "https://omp.sh/", title: "omp" };
		const prompt = composePrompt([tabContextBlock(TAB, TAB.viewport), tabContextBlock(other, null)], "Compare these");
		const parsed = parsePrompt(prompt);
		expect(parsed.text).toBe("Compare these");
		expect(parsed.tabs).toEqual([
			{ target: "PAGEab12cd34.412", url: TAB.url, title: TAB.title, viewport: "1440x900" },
			{ target: "PAGEab12cd34.7", url: "https://omp.sh/", title: "omp", viewport: "" },
		]);
	});

	it("leaves a prompt without tags untouched, even when it quotes the sentence", () => {
		const text = `Why does it say "${TAB_AUTHORIZATION}"?`;
		expect(parsePrompt(text)).toEqual({ tabs: [], text });
	});
});

describe("step labels", () => {
	const js = (code: string, title?: string) => ({ language: "js", code, title });

	it("names what a click, a fill and a key press acted on", () => {
		expect(describeStep("eval", js('await tab.click("text=Merge pull request")'), undefined).done).toBe(
			"Clicked “Merge pull request”",
		);
		expect(describeStep("eval", js("await tab.fill('[placeholder=\"Search\"]', 'relay')"), undefined).live).toBe(
			"Typing in Search",
		);
		expect(describeStep("eval", js('await tab.press("Enter")'), undefined).done).toBe("Pressed Enter");
	});

	it("labels a cell by what changed the page, then by what it waited for, then by what it read", () => {
		const adopt = 'const tab = await browser.open({ app: "relay", target: "PAGEx.1" });\nprint(await tab.observe());';
		expect(describeStep("eval", js(adopt), undefined).done).toBe("Read page");
		const wait = 'await tab.waitFor("text=All checks have passed");\nprint(await tab.screenshot());';
		expect(describeStep("eval", js(wait), undefined).done).toBe("Waited for “All checks have passed”");
		const act = 'print(await tab.observe());\nawait tab.goto("https://omp.sh/docs");\nawait tab.screenshot();';
		expect(describeStep("eval", js(act), undefined).done).toBe("Went to omp.sh/docs");
	});

	it("keeps pointer coordinates for the thumbnail dot and the drag arrow", () => {
		const click = describeStep("eval", js("await tab.clickAt(203, 128)", "Clicked “Checks”"), undefined);
		expect(click).toMatchObject({ done: "Clicked “Checks”", point: { x: 203, y: 128 }, motion: "click" });
		const drag = describeStep("eval", js("await tab.drag({ x: 10, y: 20 }, { x: 300, y: 40 })"), undefined);
		expect(drag.drag).toEqual({ from: { x: 10, y: 20 }, to: { x: 300, y: 40 } });
	});

	it("does not mistake ordinary code for browser actions", () => {
		const step = describeStep("eval", js('const rows = data.select("a");\nconsole.log(rows.text())'), undefined);
		expect(step.icon).toBe("terminal");
		expect(describeStep("bash", { command: "bun test\necho done" }, undefined).done).toBe("Ran `bun test`");
		expect(describeStep("mystery_tool", {}, "Checking the queue").live).toBe("Checking the queue");
		expect(
			describeStep("mystery_tool", { i: "Checking the queue: How many jobs remain?" }, undefined),
		).toMatchObject({
			live: "Checking the queue",
			done: "Checking the queue",
		});
	});
});

describe("timeline", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
	const assistant = (id: string, content: AssistantMessage["content"]): SessionEntry => ({
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		type: "message",
		message: { role: "assistant", content, model: "m", usage, stopReason: "toolUse", timestamp: 0 },
	});
	const result = (id: string, toolCallId: string, isError = false): SessionEntry => ({
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "bash", content: [], isError, timestamp: 0 },
	});
	const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: id } });
	const user: SessionEntry = {
		id: "u",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		type: "message",
		message: { role: "user", content: "go", timestamp: 0 },
	};
	const kinds = (items: TimelineItem[]) => items.map(item => item.kind);
	const build = (entries: SessionEntry[], extra: Partial<Parameters<typeof buildTimeline>[1]> = {}) => {
		const snapshot = { entries, activeTools: new Map(), stream: null, streamDone: false, ...extra };
		return buildTimeline(buildCommitted(snapshot), snapshot);
	};

	it("groups tool calls between prose into one chapter, across messages and thoughts", () => {
		const items = build([
			user,
			assistant("a1", [{ type: "text", text: "Checking." }, call("c1"), call("c2")]),
			result("r1", "c1"),
			result("r2", "c2", true),
			assistant("a2", [{ type: "thinking", thinking: "one more" }, call("c3")]),
			result("r3", "c3"),
			assistant("a3", [{ type: "text", text: "Done." }, call("c4")]),
		]);
		expect(kinds(items)).toEqual(["user", "reply", "steps", "reply", "steps"]);
		const first = items[2];
		if (first.kind !== "steps") throw new Error("expected a step group");
		expect(first.stepCount).toBe(3);
		expect(first.rows.map(row => (isStep(row) ? row.id : "thought"))).toEqual(["c1", "c2", "thought", "c3"]);
		expect(first.running).toBe(false);
	});

	it("shows a streamed call once, running until its result lands", () => {
		const entries = [user, assistant("a1", [call("c1")]), result("r1", "c1")];
		const stream: AssistantMessage = {
			role: "assistant",
			content: [call("c2")],
			model: "m",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
		};
		const active = new Map([
			["c2", { toolCallId: "c2", toolName: "bash", args: { command: "bun test" }, startedAt: 1 }],
		]);
		const live = build(entries, { stream, streamDone: false, activeTools: active });
		expect(kinds(live)).toEqual(["user", "steps"]);
		const group = live[1];
		if (group.kind !== "steps") throw new Error("expected a step group");
		expect(group.rows.map(row => (isStep(row) ? [row.id, row.running] : null))).toEqual([
			["c1", false],
			["c2", true],
		]);
		expect(liveVerb({ activeTools: active, stream, streamDone: false, uiRequest: null })).toBe("Running `bun test`");

		// The entry landed but the ghost is still held: the call must not appear twice.
		const landed = build([...entries, assistant("a2", [call("c2")])], {
			stream,
			streamDone: true,
			activeTools: active,
		});
		const merged = landed[1];
		if (merged.kind !== "steps") throw new Error("expected a step group");
		expect(merged.stepCount).toBe(2);
	});
});

describe("time entry", () => {
	it("takes 12h and 24h forms and rejects non-times", () => {
		expect(parseTime("9")).toBe("09:00");
		expect(parseTime("9:30 pm")).toBe("21:30");
		expect(parseTime("12am")).toBe("00:00");
		expect(parseTime("0930")).toBe("09:30");
		expect(parseTime("21:15")).toBe("21:15");
		expect(parseTime("25:00")).toBeNull();
		expect(parseTime("13pm")).toBeNull();
		expect(parseTime("soon")).toBeNull();
	});
});
