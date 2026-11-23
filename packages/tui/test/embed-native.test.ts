import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setEmbedHost } from "@oh-my-pi/pi-tui/chat/embed-host";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	type AssistantMessageHost,
	createAssistantMessageComponent,
} from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspKind } from "@oh-my-pi/pi-wire";

const REPLY = [
	"The chart and the running app:",
	"",
	'<img src="out/chart.png" alt="Latency" width="50%">',
	"",
	'<iframe src="localhost:3000/app" title="Dev server" height="400"></iframe>',
	"",
	"Done.",
].join("\n");

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const HOST: AssistantMessageHost = {
	viewSession: { extensionRunner: { getAssistantThinkingRenderers: () => [] } },
	effectiveHideThinkingBlock: false,
	proseOnlyThinking: false,
	expandThinkingBlocks: false,
	assistantImagesVisible: true,
	tableChartsVisible: true,
	hideToolActivity: false,
	toolOutputExpanded: false,
	ui: { requestRender: () => {}, imageBudget: new ImageBudget(8, () => {}) },
	resolveAssistantMessageLinkHrefs: async () => new Map(),
};

/** The described nodes of `reply` on a terminal with the given kinds, flattened in document order. */
function described(reply: string, kinds: (kind: TspKind) => boolean): NativeNode[] {
	const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: kinds, feature: () => true };
	const flat: NativeNode[] = [];
	const walk = (child: NativeChild): void => {
		if (!("k" in child)) return;
		flat.push(child);
		child.c?.forEach(walk);
	};
	walk(createAssistantMessageComponent(HOST, assistant(reply)).describe(cx));
	return flat;
}

describe("reply embeds on a native terminal", () => {
	const cwd = path.join(path.parse(process.cwd()).root, "work", "project");
	let captures: string[];

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		// As on a native terminal: the reply is described, never drawn as rows.
		setNativeRendering(true);
		captures = [];
		setEmbedHost({
			cwd: () => cwd,
			capturePage: async url => {
				captures.push(url);
				throw new Error("no Chromium installed");
			},
		});
	});

	afterEach(() => {
		setNativeRendering(false);
		setEmbedHost(undefined);
	});

	it("hands the terminal a loadable img source and a live page for an iframe", () => {
		const nodes = described(REPLY, () => true);
		const prose = nodes.filter(node => node.k === "md").map(node => node.p?.text);
		expect(prose).toEqual([
			`The chart and the running app:\n\n<img src="${path.join(cwd, "out", "chart.png")}" alt="Latency" width="50%">`,
			"Done.",
		]);
		expect(nodes.find(node => node.k === "web")?.p).toEqual({
			url: "http://localhost:3000/app",
			title: "Dev server",
			w: undefined,
			h: "400px",
		});
		// The terminal runs the page itself: nothing is captured for it.
		expect(captures).toEqual([]);
	});

	it("falls back to a screenshot and a link where the terminal has no live pages", async () => {
		const nodes = described(REPLY, kind => kind !== "web");
		expect(nodes.some(node => node.k === "web")).toBe(false);
		const visit = nodes.find(node => node.k === "text" && node.key?.endsWith(".visit"));
		expect(visit?.k === "text" && visit.p?.spans).toEqual([
			{ t: "▣ Dev server — capturing…", s: "muted" },
			{ t: " " },
			{ t: "Visit", s: "link", href: "http://localhost:3000/app" },
		]);
		// Captures queue behind one another, so this one starts a tick later.
		await Bun.sleep(0);
		expect(captures).toEqual(["http://localhost:3000/app"]);
	});
});
