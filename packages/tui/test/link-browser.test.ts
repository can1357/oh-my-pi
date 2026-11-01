import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AssistantTextRenderer } from "../src/chat/extension-types";
import type { SessionMessageEntryLike } from "../src/chat/transcript-entry";
import type { TUI } from "../src/index";
import { LinkBrowserComponent } from "../src/overlays/link-browser";
import { setExtensionLinks } from "../src/render/extension-links";
import { initTheme } from "../src/theme";

const WIDTH = 60;
// Three border rows, a header and a footer leave seven transcript rows in view.
const HEIGHT = 12;
const HOME = "\x1b[H";
const END = "\x1b[F";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAG_PATTERN = /\x1b\[1;7m(.*?)\x1b\[22;27m/g;

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(() => {
	setExtensionLinks(["demo"]);
});
afterEach(() => {
	setExtensionLinks([]);
});

function reply(text: string, timestamp: number): SessionMessageEntryLike {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
	return {
		type: "message",
		id: `r${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

/** `[gamma](demo:g)` in the first reply and `[omega](demo:z)` in the last (timestamp 2), far apart. */
function transcript(): SessionMessageEntryLike[] {
	const filler = Array.from({ length: 6 }, (_, index) => reply(`Filler paragraph number ${index}.`, 10 + index));
	return [reply("First [gamma](demo:g) here.", 1), ...filler, reply("Last [omega](demo:z) here.", 2)];
}

function browse(
	entries: SessionMessageEntryLike[],
	textRenderers: readonly AssistantTextRenderer[] = [],
	width = WIDTH,
): { browser: LinkBrowserComponent; activated: string[]; view: () => string[]; tags: () => string[] } {
	const activated: string[] = [];
	const ui = {
		terminal: { rows: HEIGHT },
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	const browser = new LinkBrowserComponent(entries, {
		ui,
		cwd: "/tmp",
		textRenderers,
		requestRender: () => {},
		onActivate: url => activated.push(url),
		onClose: () => {},
	});
	return {
		browser,
		activated,
		view: () => browser.render(width).map(row => Bun.stripANSI(row).trimEnd()),
		// Hint tags are drawn bold and inverse over the start of their labels.
		tags: () =>
			browser.render(width).flatMap(row => [...row.matchAll(TAG_PATTERN)].map(match => Bun.stripANSI(match[1]!))),
	};
}

/** Replies with the given link labels (`[label](demo:label)`), one per reply, each between `filler` replies. */
function linkReplies(labels: readonly string[], filler: number): SessionMessageEntryLike[] {
	const entries: SessionMessageEntryLike[] = [];
	for (const [index, label] of labels.entries()) {
		if (index > 0) {
			for (let line = 0; line < filler; line++) entries.push(reply(`Filler ${index}.${line}.`, 100 * index + line));
		}
		entries.push(reply(`See [${label}](demo:${label}) here.`, index + 1));
	}
	return entries;
}

/**
 * A branch longer than the browser replays at first: `[ancient](demo:ancient)` in its first reply,
 * then hundreds of user turns, and `last` as the final reply.
 */
function longBranch(last: string): SessionMessageEntryLike[] {
	const user = (index: number): SessionMessageEntryLike => ({
		type: "message",
		id: `u${index}`,
		parentId: null,
		timestamp: new Date(index).toISOString(),
		message: { role: "user", content: `Question ${index}.`, timestamp: index },
	});
	const entries = [user(0), reply("Old [ancient](demo:ancient) here.", 1)];
	for (let index = 1; index <= 350; index++) entries.push(user(index), reply(`Answer ${index}.`, 1000 + index));
	entries.push(reply(last, 5000));
	return entries;
}

describe("extension link browser", () => {
	it("opens at the bottom, tagging each label in view with the letter it starts with", () => {
		const { browser, activated, view, tags } = browse(transcript());
		expect(view().some(row => row.includes("Last omega here."))).toBe(true);
		expect(view().some(row => row.includes("First"))).toBe(false);
		expect(tags()).toEqual(["o"]);
		browser.handleInput("o");
		expect(activated).toEqual(["demo:z"]);
		browser.dispose();
	});

	it("gives a label wrapped across rows one tag, beside the scrollbar", () => {
		const label = "a label long enough that it has to wrap onto the next row of the browser";
		const { browser, activated, view, tags } = browse([
			...transcript(),
			reply(`Long [${label}](demo:long) link.`, 3),
		]);
		// The transcript is taller than the screen, so the last column holds the scrollbar.
		expect(view().filter(row => /\w/.test(row) && row.length >= WIDTH).length).toBeGreaterThan(0);
		// `omega` in the reply above keeps its tag; the long label's second row gets none.
		expect(tags()).toEqual(["o", "a"]);
		browser.handleInput("a");
		expect(activated).toEqual(["demo:long"]);
		browser.dispose();
	});

	it("keeps a wrapped label's tag while its first row scrolls out and the next stays in view", () => {
		const label = "a label long enough that it has to wrap onto the next row of the browser";
		const { browser, activated, view, tags } = browse([
			reply(`Long [${label}](demo:long) link.`, 1),
			...Array.from({ length: 12 }, (_, index) => reply(`More filler ${index}.`, 500 + index)),
		]);
		view();
		browser.handleInput(HOME);
		expect(tags()).toEqual(["a"]);
		const second = view().findIndex(row => row.includes("Long")) + 1;
		// Without the scrollbar column, whose cell changes as the view scrolls.
		const rest = view()
			[second]!.slice(0, WIDTH - 1)
			.trim();
		// The second row starts with another letter, which a fresh tag would prefer.
		expect(rest[0]).not.toBe("a");
		while (view().some(row => row.includes("Long"))) browser.handleInput(DOWN);
		expect(view().some(row => row.includes(rest.slice(1)))).toBe(true);
		expect(tags()).toEqual(["a"]);
		browser.handleInput("a");
		expect(activated).toEqual(["demo:long"]);
		browser.dispose();
	});

	it("keeps a label's tag while it stays in view, as the labels around it scroll out", () => {
		const { browser, activated, view, tags } = browse([
			...linkReplies(["apple", "avocado"], 0),
			...Array.from({ length: 10 }, (_, index) => reply(`More filler ${index}.`, 500 + index)),
		]);
		view();
		browser.handleInput(HOME);
		// Both start with `a`: the second falls back to its own next letter.
		expect(tags()).toEqual(["a", "v"]);
		// Scroll until `apple` leaves the top; `avocado` keeps `v` rather than taking the freed `a`.
		while (view().some(row => row.includes("apple"))) browser.handleInput(DOWN);
		// `v` is drawn over the `a` it replaces.
		expect(view().some(row => row.includes("See vvocado here."))).toBe(true);
		expect(tags()).toEqual(["v"]);
		browser.handleInput("v");
		expect(activated).toEqual(["demo:avocado"]);
		browser.dispose();
	});

	it("keeps a label's tag when a reply above it is rerendered taller, pushing it down", () => {
		let expanded = false;
		const longer: AssistantTextRenderer = ({ text, message }) =>
			expanded && message.timestamp === 100 ? `${text}\n\nExtra one.\n\nExtra two.` : undefined;
		const { browser, activated, view, tags } = browse(
			[
				...linkReplies(["apple", "avocado"], 1),
				...Array.from({ length: 10 }, (_, index) => reply(`More filler ${index}.`, 500 + index)),
			],
			[longer],
		);
		view();
		browser.handleInput(HOME);
		expect(tags()).toEqual(["a", "v"]);
		// With `apple` scrolled out, `a` is free: a label tagged afresh would take it.
		while (view().some(row => row.includes("apple"))) browser.handleInput(DOWN);
		const before = view().findIndex(row => row.includes("vocado"));
		expanded = true;
		expect(browser.rerenderMessage(100)).toBe(true);
		expect(view().findIndex(row => row.includes("vocado"))).toBeGreaterThan(before);
		expect(tags()).toEqual(["v"]);
		browser.handleInput("v");
		expect(activated).toEqual(["demo:avocado"]);
		browser.dispose();
	});

	it("tags a label scrolling into view without taking or changing the tags already drawn", () => {
		// Opened at the bottom, `sun` is in view and `sky` one row above it.
		const { browser, activated, view, tags } = browse([
			...linkReplies(["sky", "sun"], 4),
			...Array.from({ length: 2 }, (_, index) => reply(`More filler ${index}.`, 500 + index)),
		]);
		expect(view().some(row => row.includes("sky"))).toBe(false);
		expect(tags()).toEqual(["s"]);
		browser.handleInput(UP);
		expect(view().some(row => row.includes("See kky here."))).toBe(true);
		expect(view().some(row => row.includes("sun"))).toBe(true);
		// `sky` comes in above `sun` and would be first to `s`; it takes its next letter instead.
		expect(tags()).toEqual(["k", "s"]);
		browser.handleInput("s");
		browser.handleInput("k");
		expect(activated).toEqual(["demo:sun", "demo:sky"]);
		browser.dispose();
	});

	it("activates a label's link on a left click, and nothing on other cells", () => {
		const { browser, activated, view } = browse(transcript());
		const rows = view();
		const row = rows.findIndex(line => line.includes("Last"));
		const click = (col: number) => browser.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
		click(rows[row]!.indexOf("Last"));
		expect(activated).toEqual([]);
		click(rows[row]!.indexOf("omega") + 2);
		expect(activated).toEqual(["demo:z"]);
		browser.dispose();
	});

	it("redraws a reply the extension rerenders in place, keeping the rows above it where they were", () => {
		let expanded = false;
		const details: AssistantTextRenderer = ({ text }) =>
			expanded ? text.replace("here.", "here.\n\nDetails one.\n\nDetails two.") : undefined;
		const { browser, view } = browse(transcript(), [details]);
		const before = view();
		const omega = before.findIndex(row => row.includes("Last"));
		expanded = true;
		expect(browser.rerenderMessage(2)).toBe(true);
		const after = view();
		// The reply grows downward: everything down to its first row stays put, nothing jumps up (only
		// the scrollbar in the last column shrinks its thumb).
		const text = (rows: string[]) => rows.slice(0, omega + 1).map(row => row.slice(0, WIDTH - 1).trimEnd());
		expect(text(after)).toEqual(text(before));
		browser.handleInput(END);
		expect(view().some(row => row.includes("Details two."))).toBe(true);
		browser.dispose();
	});

	it("keeps the rows above a reply where they were when the extension rerenders it shorter", () => {
		let expanded = true;
		const details: AssistantTextRenderer = ({ text }) =>
			expanded ? text.replace("here.", "here.\n\nDetails one.\n\nDetails two.") : undefined;
		const { browser, view } = browse(transcript(), [details]);
		// Opened at the bottom, the expanded last reply ends the view.
		const before = view();
		expect(before.some(row => row.includes("Details two."))).toBe(true);
		const omega = before.findIndex(row => row.includes("Last"));
		expanded = false;
		expect(browser.rerenderMessage(2)).toBe(true);
		const after = view();
		// The reply collapses upward into blank rows: nothing above it moves down to fill them.
		const text = (rows: string[]) => rows.slice(0, omega + 1).map(row => row.slice(0, WIDTH - 1).trimEnd());
		expect(text(after)).toEqual(text(before));
		expect(after.some(row => row.includes("Details"))).toBe(false);
		// A scroll lets the blank rows go: End shows the bottom as a browser opened on the short reply does
		// (the scrollbar column aside, whose thumb a first render sizes differently).
		browser.handleInput(END);
		const fresh = browse(transcript(), [details]);
		const content = (rows: string[]) => rows.map(row => row.slice(0, WIDTH - 1).trimEnd());
		expect(content(view())).toEqual(content(fresh.view()));
		fresh.browser.dispose();
		browser.dispose();
	});

	it("draws no tags, and says why, when a row in view has more links than its tags could fit", () => {
		// 27 one-cell labels on a row need 54 cells of two-letter tags; 40 columns leave 39.
		const labels = Array.from({ length: 27 }, (_, index) => `[x](demo:open/${index})`).join("");
		const { browser, activated, view } = browse([reply(labels, 1)], [], 40);
		const rows = view();
		expect(rows.some(row => row.includes("x".repeat(27)))).toBe(true);
		expect(rows.some(row => row.includes("Too many links on one row"))).toBe(true);
		browser.handleInput("a");
		browser.handleInput("a");
		expect(activated).toEqual([]);
		browser.dispose();
	});

	it("reaches a link older than the replayed recent history by scrolling to the top", () => {
		const { browser, activated, view, tags } = browse(longBranch("See [recent](demo:recent) here."));
		expect(tags()).toEqual(["r"]);
		// The first Home reaches the top of the recent part and replays the rest above it; the
		// second goes to the very top, where the old link is.
		browser.handleInput(HOME);
		expect(view().some(row => row.includes("ancient"))).toBe(false);
		browser.handleInput(HOME);
		expect(view().some(row => row.includes("ancient"))).toBe(true);
		expect(tags()).toEqual(["a"]);
		browser.handleInput("a");
		expect(activated).toEqual(["demo:ancient"]);
		browser.dispose();
	});

	it("finds a link only older history draws", () => {
		const { browser } = browse(longBranch("Nothing to pick here."));
		expect(browser.hasLinks(WIDTH)).toBe(true);
		browser.dispose();
	});

	it("keeps a label's tag across a resize that rewraps only the older history loaded above it", () => {
		const branch = longBranch("Nothing to pick here.");
		// The old reply wraps onto fewer rows once the terminal widens; the recent rows do not.
		branch[1] = reply(`Old ${"wrapping words ".repeat(20)}here.`, 1);
		branch.push(
			...linkReplies(["apple", "avocado"], 1).map((entry, index) => ({ ...entry, id: `link${index}` })),
			...Array.from({ length: 10 }, (_, index) => reply(`More filler ${index}.`, 9000 + index)),
		);
		const { browser, activated, view, tags } = browse(branch);
		const scrollUntil = (key: string, done: () => boolean) => {
			for (let step = 0; step < 100 && !done(); step++) browser.handleInput(key);
			expect(done()).toBe(true);
		};
		view();
		// Replay the older history, then scroll up from the bottom to the links.
		browser.handleInput(HOME);
		browser.handleInput(END);
		// A tag is drawn over the letter it is, so match the rest of each label.
		scrollUntil(UP, () => view().some(row => row.includes("pple here.")));
		// `avocado` came into view first and took `a`; `apple` fell back to its next letter.
		expect(tags()).toEqual(["p", "a"]);
		// With `avocado` scrolled out, `a` is free: a label tagged afresh would take it.
		scrollUntil(UP, () => !view().some(row => row.includes("vocado here.")));
		expect(tags()).toEqual(["p"]);
		const wider = browser.render(WIDTH + 20).map(row => Bun.stripANSI(row));
		expect(wider.some(row => row.includes("See ppple here."))).toBe(true);
		browser.handleInput("p");
		expect(activated).toEqual(["demo:apple"]);
		browser.dispose();
	});
});
