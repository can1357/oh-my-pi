import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
/**
 * Regression: the fullscreen transcript viewer must align the header, body, and
 * footer on a single shared gutter. The transcript components carry their own
 * 1-column left pad, so the viewer must NOT add a second outer gutter to body
 * rows — doing so shifted the content one column right of the "Agent Hub" title
 * (the reported "first char off / title shift"). Scrolling must also move the
 * visible window.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	getKittyGraphics,
	ImageBudget,
	ImageProtocol,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";

const TS = new Date().toISOString();

function buildJsonl(): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	lines.push(
		JSON.stringify({
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: TS,
			message: { role: "user", synthetic: true, attribution: "agent", content: "### PROMPTMARKER", timestamp: 0 },
		}),
	);
	for (let i = 0; i < 40; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Reviewing step ${i}.` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "gpt-5.5",
					usage,
					stopReason: "stop",
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

function buildImageJsonl(): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const entries = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "a0",
			parentId: null,
			timestamp: TS,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "image-call", name: "eval", arguments: { language: "py", code: "display" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "gpt-5.5",
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		}),
		JSON.stringify({
			type: "message",
			id: "t0",
			parentId: "a0",
			timestamp: TS,
			message: {
				role: "toolResult",
				toolCallId: "image-call",
				toolName: "eval",
				content: [
					{ type: "text", text: "displayed image" },
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				],
				isError: false,
				timestamp: 2,
			},
		}),
	];
	return `${entries.join("\n")}\n`;
}

function messageLine(id: string, content: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", synthetic: true, attribution: "agent", content: `### ${content}`, timestamp: 0 },
	});
}

function makeViewer(file: string, remote?: AgentHubRemote, ui?: TUI) {
	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: remote ? undefined : file,
		status: "parked",
	});
	return new AgentTranscriptViewer({
		transcript: agentTranscriptSource,
		agentId: "Main/advisor",
		registry: agents,
		ui: ui ?? ({ requestRender: () => {}, requestComponentRender: () => {} } as never),
		cwd: "/tmp",
		remote,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender: () => {},
		onClose: () => {},
		onHubClose: () => {},
	});
}

/** Leading-space count of a stripped line (its content gutter). */
function gutter(line: string): number {
	const stripped = Bun.stripANSI(line);
	return stripped.length - stripped.trimStart().length;
}

/**
 * Await every transcript read `reads` (a spy on `agentTranscriptSource.readFrom`)
 * has started, including reads a landed read chains (a rewrite's rebuild). A
 * read's own continuation registered first, so it has run when the await resumes.
 */
async function settleReads(reads: { mock: { results: { value: unknown }[] } }): Promise<void> {
	for (let index = 0; index < reads.mock.results.length; index++) {
		await Promise.resolve(reads.mock.results[index]!.value).catch(() => {});
	}
}

async function withViewer(fn: (viewer: AgentTranscriptViewer) => void): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());
	const reads = vi.spyOn(agentTranscriptSource, "readFrom");
	const viewer = makeViewer(file);
	try {
		await settleReads(reads);
		fn(viewer);
	} finally {
		viewer.dispose();
		removeSyncWithRetries(dir);
	}
}

async function renderSyntheticAssistant(usage?: { input: number; output: number }): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-usage-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: dir }),
			JSON.stringify({
				type: "message",
				id: "a0",
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "SYNTHETICREPLY" }],
					model: "qq",
					provider: "qq",
					usage,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}),
		].join("\n") + "\n",
	);
	try {
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			viewer.render(80);
			viewer.handleInput("g");
			return viewer
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
		} finally {
			viewer.dispose();
		}
	} finally {
		removeSyncWithRetries(dir);
	}
}
async function settleRemoteRefresh(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("AgentTranscriptViewer", () => {
	let rowsDesc: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 24, set: () => {} });
	});

	afterEach(() => {
		// A leaked transcript-source spy would feed the next test's reads stale stubs.
		vi.restoreAllMocks();
		vi.useRealTimers();
		if (rowsDesc) {
			Object.defineProperty(process.stdout, "rows", rowsDesc);
		} else {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("aligns the title and body content on the same gutter", async () => {
		await withViewer(viewer => {
			viewer.render(80); // populate the scroll view before navigating
			viewer.handleInput("g"); // scroll to top so the first message is visible
			const lines = viewer.render(80).map(l => Bun.stripANSI(l));
			const titleLine = lines.find(l => l.includes("Agent Hub"));
			const bodyLine = lines.find(l => l.includes("PROMPTMARKER"));
			expect(titleLine).toBeDefined();
			expect(bodyLine).toBeDefined();
			// The body must not sit one column right of the title.
			expect(gutter(bodyLine!)).toBe(gutter(titleLine!));
		});
	});

	it("shows a synthetic assistant reply without usage", async () => {
		expect(await renderSyntheticAssistant()).toContain("SYNTHETICREPLY");
	});

	it("shows a synthetic assistant reply with tokens but no cost", async () => {
		expect(await renderSyntheticAssistant({ input: 1, output: 2 })).toContain("SYNTHETICREPLY");
	});

	it("collapses synthetic advisor inputs on cold open and expands their body on ctrl+o", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-collapse-"));
		const file = path.join(dir, "__advisor.jsonl");
		// A synthetic `Session update` whose body carries a distinctive marker
		// far larger than the viewport. Cold open must NOT lay it out; the reader
		// only sees a compact summary until ctrl+o.
		const bodyLines = ["### Session update", ""];
		for (let i = 0; i < 500; i++) bodyLines.push(`- SYNTHBODYMARKER line ${i}`);
		const body = bodyLines.join("\n");
		const jsonl = [
			JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
			JSON.stringify({
				type: "message",
				id: "u0",
				parentId: null,
				timestamp: TS,
				message: { role: "user", synthetic: true, attribution: "agent", content: body, timestamp: 0 },
			}),
			JSON.stringify({
				type: "message",
				id: "a0",
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Advice." }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "gpt-5.5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			}),
		].join("\n");
		fs.writeFileSync(file, `${jsonl}\n`);
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			viewer.render(80);
			viewer.handleInput("g"); // scroll to top
			const collapsed = viewer.render(80).map(l => Bun.stripANSI(l));
			const collapsedBody = collapsed.join("\n");
			// The synthetic body is not laid out; only the summary row shows.
			expect(collapsedBody).not.toContain("SYNTHBODYMARKER");
			expect(collapsed.some(l => /Session update .* line/.test(l))).toBe(true);

			// ctrl+o reveals the full body; scroll back to the top to see it.
			viewer.handleInput("\x0f");
			viewer.render(80);
			viewer.handleInput("g");
			const expandedBody = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(expandedBody).toContain("SYNTHBODYMARKER");
		} finally {
			viewer.dispose();
			removeSyncWithRetries(dir);
		}
	});

	it("scrolls the visible window with j/k and g/G", async () => {
		await withViewer(viewer => {
			const atBottom = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			viewer.handleInput("g");
			const atTop = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(atTop).not.toEqual(atBottom);
			expect(atTop).toContain("PROMPTMARKER");
			expect(atBottom).not.toContain("PROMPTMARKER");
		});
	});

	it("renders tool-result images through the shared Kitty placeholder budget", async () => {
		cfgTerminalShowImages.override(Settings.instance, true);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-image-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildImageJsonl());
		const previousProtocol = TERMINAL.imageProtocol;
		const previousGraphics = getKittyGraphics();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: true });
		const imageBudget = new ImageBudget(8, () => {});
		const ui = {
			imageBudget,
			requestRender: () => {},
			requestComponentRender: () => {},
		} as unknown as TUI;
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file, undefined, ui);
		try {
			await settleReads(reads);
			imageBudget.beginPass();
			const rendered = viewer.render(80).join("\n");
			imageBudget.endPass();
			expect(rendered).toContain("a=p,U=1");
			expect(rendered).toContain("\u{10eeee}");
			expect(imageBudget.takeTransmits().join("")).toContain("a=t");
		} finally {
			viewer.dispose();
			cfgTerminalShowImages.clearOverride(Settings.instance);
			setKittyGraphics(previousGraphics);
			setTerminalImageProtocol(previousProtocol);
			removeSyncWithRetries(dir);
		}
	});

	it("clears stale content when the transcript file is deleted while open", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		const body = () =>
			viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
		try {
			await settleReads(reads);
			viewer.render(80);
			viewer.handleInput("g");
			expect(body()).toContain("PROMPTMARKER");

			removeSyncWithRetries(file);
			// Drive the viewer's own 250ms polling interval without paying wall-clock time.
			vi.advanceTimersByTime(250);
			expect(body()).not.toContain("PROMPTMARKER");
		} finally {
			viewer.dispose();
			removeSyncWithRetries(dir);
		}
	});

	it("tails appended local transcript bytes without rereading the whole file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, `${buildJsonl()}${messageLine("tail-before", "BEFORETAIL")}\n`);
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			viewer.render(80);
			fs.appendFileSync(file, `${messageLine("tail-after", "TAILMARKER")}\n`);
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			vi.advanceTimersByTime(250);
			await settleReads(reads);
			expect(body()).toContain("TAILMARKER");
			// The first read took the whole transcript; the tail read starts near its end.
			expect(reads.mock.calls.map(([, offset]) => offset > 0)).toEqual([false, true]);
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("anchors the tail cursor to bytes actually read so a stat/read growth race never duplicates rows", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		const baseline = `${[
			JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
			messageLine("base", "BASEMARK"),
		].join("\n")}\n`;
		fs.writeFileSync(file, baseline);
		// A stale stat plus a read that appends a fresh entry first reproduces the
		// race the reviewer called out: the rebuild sees the appended bytes, so the
		// tail cursor must count the bytes read (not the pre-race stat size) or the
		// next poll replays them.
		const baselineStat = agentTranscriptSource.stat(file);
		const realStat = agentTranscriptSource.stat;
		const realReadFrom = agentTranscriptSource.readFrom;
		let raceArmed = true;
		const statSpy = vi
			.spyOn(agentTranscriptSource, "stat")
			.mockImplementation(p => (raceArmed && p === file ? baselineStat : realStat(p)));
		const reads = vi.spyOn(agentTranscriptSource, "readFrom").mockImplementation((p, offset) => {
			if (raceArmed && p === file) {
				fs.appendFileSync(file, `${messageLine("race", "RACEMARK")}\n`);
				raceArmed = false;
			}
			return realReadFrom(p, offset);
		});

		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			viewer.render(80);
			statSpy.mockRestore();

			fs.appendFileSync(file, `${messageLine("tail", "TAILMARK")}\n`);

			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			vi.advanceTimersByTime(250);
			await settleReads(reads);
			expect(body()).toContain("BASEMARK");
			expect(body()).toContain("TAILMARK");
			// The race-window entry must be rendered exactly once, not duplicated
			// by the poll's tail read re-reading bytes already in the rebuild.
			expect(body().match(/RACEMARK/g)?.length ?? 0).toBe(1);
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reloads a rewrite that keeps the file size and mtime within a few idle polls", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, `${buildJsonl()}${messageLine("same", "OLDMARKER")}\n`);
		const original = fs.statSync(file);
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			await settleReads(reads);
			expect(body()).toContain("OLDMARKER");
			reads.mockClear();
			fs.writeFileSync(file, `${buildJsonl()}${messageLine("same", "NEWMARKER")}\n`);
			fs.utimesSync(file, original.atime, original.mtime);
			vi.advanceTimersByTime(250 * 5);
			await settleReads(reads);
			// The changed bytes before the rendered end force exactly one rebuild from the start.
			expect(reads.mock.calls.filter(([, offset]) => offset === 0)).toHaveLength(1);
			expect(body()).toContain("NEWMARKER");
			expect(body()).not.toContain("OLDMARKER");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears the remote loading placeholder after a header-only first fetch", async () => {
		const header = `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "adv",
			timestamp: TS,
			cwd: "/tmp",
		})}\n`;
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => ({ text: header, newSize: Buffer.byteLength(header, "utf-8") }),
		};
		const viewer = makeViewer("", remote);
		try {
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			await settleRemoteRefresh();
			expect(body()).toContain("No messages yet.");
		} finally {
			viewer.dispose();
		}
	});

	it("preserves a partial trailing line through the full rebuild so the completion lands on the next poll", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		const header = `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "adv",
			timestamp: TS,
			cwd: "/tmp",
		})}\n`;
		const completeLine = `${messageLine("a0", "FIRSTMARK")}\n`;
		const partialLine = messageLine("a1", "PARTIALMARK");
		fs.writeFileSync(file, header + completeLine + partialLine);

		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			// First entry renders; the headless trailing line stays buffered.
			expect(body()).toContain("FIRSTMARK");
			expect(body()).not.toContain("PARTIALMARK");

			// Completing the dangling line via a single newline must surface the
			// buffered entry; it must NOT be dropped as a malformed fragment.
			fs.appendFileSync(file, "\n");
			vi.advanceTimersByTime(250);
			await settleReads(reads);
			expect(body()).toContain("PARTIALMARK");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stops polling after the host reports an oversized remote JSONL entry", async () => {
		const calls: number[] = [];
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async (_id: string, fromByte: number) => {
				calls.push(fromByte);
				return {
					text: "",
					newSize: fromByte,
					error: "transcript entry exceeds transcript fetch cap (4194304 bytes)",
				};
			},
		};
		const viewer = makeViewer("", remote);
		try {
			await settleRemoteRefresh();
			vi.advanceTimersByTime(650);
			await settleRemoteRefresh();
			const body = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(calls.filter(offset => offset === 0).length).toBe(1);
			expect(body).toContain("entry exceeds transcript fetch cap");
		} finally {
			viewer.dispose();
		}
	});

	it("surfaces an oversized remote transcript error after existing rows", async () => {
		const header = `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "adv",
			timestamp: TS,
			cwd: "/tmp",
		})}\n`;
		const before = `${header}${messageLine("a0", "BEFORE_OVERSIZED")}\n`;
		const beforeSize = Buffer.byteLength(before, "utf-8");
		const error = "transcript entry exceeds transcript fetch cap (4194304 bytes)";
		const calls: number[] = [];
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async (_id: string, fromByte: number) => {
				calls.push(fromByte);
				if (fromByte === 0) return { text: before, newSize: beforeSize };
				return { text: "", newSize: fromByte, error };
			},
		};
		const viewer = makeViewer("", remote);
		try {
			await settleRemoteRefresh();
			vi.advanceTimersByTime(250);
			await settleRemoteRefresh();
			vi.advanceTimersByTime(400);
			const body = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(body).toContain("BEFORE_OVERSIZED");
			expect(body).toContain(error);
			expect(calls.filter(offset => offset === beforeSize).length).toBe(1);
		} finally {
			viewer.dispose();
		}
	});

	it("drops stale rendered rows when the host transcript rotates", async () => {
		const header = `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "adv",
			timestamp: TS,
			cwd: "/tmp",
		})}\n`;
		const before = `${header}${messageLine("a0", "BEFORE_ROTATE")}\n`;
		const beforeSize = Buffer.byteLength(before, "utf-8");
		const after = `${header}${messageLine("a1", "AFTER_ROTATE")}\n`;
		const afterSize = Buffer.byteLength(after, "utf-8");

		let phase: "initial" | "rotated" | "post" = "initial";
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async (_id: string, fromByte: number) => {
				if (phase === "initial") {
					phase = "rotated";
					return { text: before, newSize: beforeSize };
				}
				if (phase === "rotated") {
					phase = "post";
					// Host has rotated: newSize is smaller than the byte cursor we sent.
					return { text: "", newSize: 0 };
				}
				// Post-rotation refetch from byte 0.
				expect(fromByte).toBe(0);
				return { text: after, newSize: afterSize };
			},
		};
		const viewer = makeViewer("", remote);
		try {
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			await settleRemoteRefresh();
			vi.advanceTimersByTime(250);
			await settleRemoteRefresh();
			expect(body()).toContain("AFTER_ROTATE");
			// Pre-rotation rows must not stack underneath the refetched transcript.
			expect(body()).not.toContain("BEFORE_ROTATE");
		} finally {
			viewer.dispose();
		}
	});

	it("keeps the rendered transcript and retries when a read fails after the stat", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const realStat = agentTranscriptSource.stat(file);
		const reads = vi.spyOn(agentTranscriptSource, "readFrom");
		const viewer = makeViewer(file);
		try {
			await settleReads(reads);
			// The stat reports growth, but the read fails as if the transcript was
			// removed between the two. The poll must not throw, the rendered rows
			// must stay, and the next poll must read again.
			vi.spyOn(agentTranscriptSource, "stat").mockReturnValue({
				size: realStat.size + 200,
				mtimeMs: realStat.mtimeMs + 10,
			});
			reads.mockImplementation(() =>
				Promise.reject(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })),
			);
			reads.mockClear();
			expect(() => vi.advanceTimersByTime(250)).not.toThrow();
			await settleReads(reads);
			expect(
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n"),
			).toContain("Reviewing step 39.");
			vi.advanceTimersByTime(250);
			expect(reads).toHaveBeenCalledTimes(2);
			await settleReads(reads);
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
