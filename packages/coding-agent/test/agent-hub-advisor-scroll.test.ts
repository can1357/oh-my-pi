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
import type { AgentHubRemote } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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

function withViewer(fn: (viewer: AgentTranscriptViewer) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());
	const viewer = makeViewer(file);
	try {
		fn(viewer);
	} finally {
		viewer.dispose();
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
		vi.useRealTimers();
		if (rowsDesc) {
			Object.defineProperty(process.stdout, "rows", rowsDesc);
		} else {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("aligns the title and body content on the same gutter", () => {
		withViewer(viewer => {
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

	it("collapses synthetic advisor inputs on cold open and expands their body on ctrl+o", () => {
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
		const viewer = makeViewer(file);
		try {
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

	it("scrolls the visible window with j/k and g/G", () => {
		withViewer(viewer => {
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

	it("renders tool-result images through the shared Kitty placeholder budget", () => {
		Settings.instance.override("terminal.showImages", true);
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
		const viewer = makeViewer(file, undefined, ui);
		try {
			imageBudget.beginPass();
			const rendered = viewer.render(80).join("\n");
			imageBudget.endPass();
			expect(rendered).toContain("a=p,U=1");
			expect(rendered).toContain("\u{10eeee}");
			expect(imageBudget.takeTransmits().join("")).toContain("a=t");
		} finally {
			viewer.dispose();
			Settings.instance.clearOverride("terminal.showImages");
			setKittyGraphics(previousGraphics);
			setTerminalImageProtocol(previousProtocol);
			removeSyncWithRetries(dir);
		}
	});

	it("clears stale content when the transcript file is deleted while open", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const viewer = makeViewer(file);
		const body = () =>
			viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
		try {
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
		const viewer = makeViewer(file);
		try {
			viewer.render(80);
			const readFileSpy = vi.spyOn(fs, "readFileSync");
			fs.appendFileSync(file, `${messageLine("tail-after", "TAILMARKER")}\n`);
			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			vi.advanceTimersByTime(250);
			expect(body()).toContain("TAILMARKER");
			expect(readFileSpy).not.toHaveBeenCalled();
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
		// Stale stat plus a readFileSync that appends a fresh entry in between
		// reproduces the race the reviewer called out: the rebuild sees the
		// appended bytes, the tail cursor must record `data.byteLength` (not the
		// pre-race `stat.size`) so the next poll doesn't replay them.
		const baselineStat = fs.statSync(file);
		const realStatSync = fs.statSync.bind(fs);
		const realReadFileSync = fs.readFileSync.bind(fs);
		let raceArmed = true;
		const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: fs.StatOptions) => {
			if (raceArmed && String(p) === file && !opts) return baselineStat as fs.Stats;
			return realStatSync(p as string, opts as fs.StatSyncOptions);
		}) as typeof fs.statSync);
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, opts?: unknown) => {
			if (raceArmed && String(p) === file) {
				fs.appendFileSync(file, `${messageLine("race", "RACEMARK")}\n`);
				raceArmed = false;
			}
			return realReadFileSync(p as fs.PathOrFileDescriptor, opts as Parameters<typeof fs.readFileSync>[1]);
		}) as typeof fs.readFileSync);

		const viewer = makeViewer(file);
		try {
			viewer.render(80);
			statSpy.mockRestore();
			readSpy.mockRestore();

			fs.appendFileSync(file, `${messageLine("tail", "TAILMARK")}\n`);

			const body = () =>
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
			vi.advanceTimersByTime(250);
			expect(body()).toContain("BASEMARK");
			expect(body()).toContain("TAILMARK");
			// The race-window entry must be rendered exactly once, not duplicated
			// by the poll fast-path re-reading bytes already in the rebuild.
			expect(body().match(/RACEMARK/g)?.length ?? 0).toBe(1);
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

		const viewer = makeViewer(file);
		try {
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

	it("does not let a poll throw when the file is unlinked between stat and the sentinel read", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const realStat = fs.statSync(file);
		vi.useFakeTimers();
		// First #refresh runs in the constructor with real fs and populates state.
		const viewer = makeViewer(file);
		try {
			// Stat reports growth (same identity), but every subsequent open of the
			// session file fails as if it was unlinked in the window between the
			// statSync and the sentinel read. The 250ms poll must not throw.
			vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike) => {
				if (String(p) === file)
					return { ...realStat, size: realStat.size + 200, mtimeMs: realStat.mtimeMs + 10 } as fs.Stats;
				throw new Error("unexpected stat");
			}) as typeof fs.statSync);
			vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike) => {
				if (String(p) === file) {
					const e = new Error("ENOENT: no such file or directory, open") as NodeJS.ErrnoException;
					e.code = "ENOENT";
					throw e;
				}
				throw new Error("unexpected open");
			}) as typeof fs.openSync);
			expect(() => vi.advanceTimersByTime(250)).not.toThrow();
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
