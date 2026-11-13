import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import {
	describeProcRead,
	PROC_EMPTY_TEXT,
	type ProcReadDetails,
	renderProcRead,
} from "@oh-my-pi/pi-tui/tools/proc-render";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { WakeupRecord } from "../../src/async/wakeup-manager";
import { Settings } from "../../src/config/settings";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import type { ToolSession } from "../../src/tools";

const DUE = Date.UTC(2030, 0, 1, 12, 0, 0);
const DEADLINE = Date.UTC(2030, 0, 1, 13, 0, 0);
const PROMPT = "SECRET-PROMPT check the deploy";
const COMMAND = "SECRET-COMMAND curl https://internal.example";

const records: WakeupRecord[] = [
	{
		version: 1,
		id: "wake_1",
		owner: "owner",
		cwd: "/fixture",
		createdAt: DUE - 60_000,
		dueAt: DUE,
		state: "scheduled",
		delaySeconds: 60,
		prompt: PROMPT,
	},
	{
		version: 1,
		id: "wake_2",
		owner: "owner",
		cwd: "/fixture",
		createdAt: DUE - 60_000,
		dueAt: DUE,
		deadline: DEADLINE,
		baseline: "0:abc",
		state: "scheduled",
		delaySeconds: 60,
		prompt: PROMPT,
		check: { command: COMMAND, maxWaitSeconds: 3660 },
	},
];

function session(wakeups: WakeupRecord[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: true,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		wakeupManager: {
			list: (state?: WakeupRecord["state"]) =>
				wakeups
					.filter(record => state === undefined || record.state === state)
					.map(record => structuredClone(record)),
		},
		settings: Settings.isolated({ "launch.enabled": false }),
	} as unknown as ToolSession;
}

async function readRoot(wakeups: WakeupRecord[]) {
	const resource = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://"), { session: session(wakeups) });
	return {
		content: resource.content,
		result: { content: [{ type: "text", text: resource.content }] },
		details: resource.details?.proc,
	};
}

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) if ("k" in child) out.push(child, ...nodes(child.c));
	return out;
}

let theme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected dark theme");
	theme = loaded;
});

function renderTui(result: { content: Array<{ type: string; text?: string }> }, details?: ProcReadDetails): string {
	return Bun.stripANSI(
		renderProcRead("", result, details, { expanded: false, isPartial: false }, theme).render(160).join("\n"),
	);
}

describe("proc:// wakeup timers in structured details", () => {
	it("exposes display-safe timer rows, never prompt or command", async () => {
		const { details } = await readRoot(records);
		expect(details?.wakeups).toEqual([
			{ id: "wake_1", state: "scheduled", dueAt: DUE },
			{ id: "wake_2", state: "scheduled", dueAt: DUE, deadline: DEADLINE },
		]);
		const serialized = JSON.stringify(details);
		expect(serialized).not.toContain("SECRET-PROMPT");
		expect(serialized).not.toContain("SECRET-COMMAND");
		expect(serialized).not.toContain("baseline");
	});

	it("lists only pending timers while retaining explicit ID inspection of terminal history", async () => {
		const history: WakeupRecord[] = Array.from({ length: 100 }, (_, index) => ({
			...records[0]!,
			id: `wake_${(index + 100).toString(16)}`,
			state: index % 2 === 0 ? "cancelled" : "claimed",
		}));
		const all = [...history, ...records];
		const { content, details } = await readRoot(all);
		expect(details?.wakeups?.map(record => record.id)).toEqual(records.map(record => record.id));
		for (const terminal of history) expect(content).not.toContain(terminal.id);
		const proc = new ProcProtocolHandler();
		for (const terminal of history.slice(0, 2)) {
			const inspected = await proc.resolve(parseInternalUrl(`proc://${terminal.id}`), { session: session(all) });
			expect(JSON.parse(inspected.content)).toEqual(terminal);
		}
		expect(all).toHaveLength(102);
	});

	it("renders each timer's id, state, and due time in the TUI table", async () => {
		const { result, details } = await readRoot(records);
		const rendered = renderTui(result, details);
		expect(rendered).toContain("2 timers");
		for (const id of ["wake_1", "wake_2"]) expect(rendered).toContain(id);
		expect(rendered).toContain("scheduled");
		expect(rendered).toContain("due 2030-01-01T12:00:00Z");
		expect(rendered).toContain("deadline 2030-01-01T13:00:00Z");
		expect(rendered).not.toContain(PROC_EMPTY_TEXT);
		expect(rendered).not.toContain("SECRET");
	});

	it("renders each timer in the native process table", async () => {
		const { result, details } = await readRoot(records);
		const view = describeProcRead("", result, details);
		const table = nodes(view.body).find(item => item.k === "list");
		const items = nodes(table?.c).filter(item => item.k === "item");
		expect(items.map(item => item.key)).toEqual(["wakeup:wake_1", "wakeup:wake_2"]);
		const serialized = JSON.stringify(view);
		expect(serialized).toContain("2 timers");
		expect(serialized).toContain("scheduled");
		expect(serialized).toContain("due 2030-01-01T12:00:00Z");
		expect(serialized).toContain("deadline 2030-01-01T13:00:00Z");
		expect(serialized).not.toContain("SECRET");
	});

	it("shows terminal timer states without a relative due time", () => {
		const details: ProcReadDetails = {
			jobs: [],
			daemons: [],
			agents: [],
			wakeups: [{ id: "wake_3", state: "cancelled", dueAt: DUE }],
		};
		const rendered = renderTui({ content: [{ type: "text", text: "wake_3 [wakeup] cancelled" }] }, details);
		expect(rendered).toContain("wake_3");
		expect(rendered).toContain("cancelled");
		expect(rendered).toContain("due 2030-01-01T12:00:00Z");
		expect(rendered).not.toContain("overdue");
	});

	it("keeps the timer-aware empty state when nothing is listed", async () => {
		const { content, result, details } = await readRoot([]);
		expect(content).toBe(PROC_EMPTY_TEXT);
		expect(details?.wakeups).toEqual([]);
		expect(renderTui(result, details)).toContain(PROC_EMPTY_TEXT);
		const table = nodes(describeProcRead("", result, details).body).find(item => item.k === "list");
		expect(table?.p).toMatchObject({ empty: PROC_EMPTY_TEXT });
	});

	it("preserves job and service rows next to timers", () => {
		const details: ProcReadDetails = {
			jobs: [{ id: "bg_1", type: "bash", status: "running", label: "build", durationMs: 1000 }],
			daemons: [
				{
					name: "web",
					id: "web",
					state: "running",
					pid: 100,
					createdAt: 0,
					startedAt: Date.now(),
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
			],
			wakeups: [{ id: "wake_1", state: "scheduled", dueAt: DUE }],
		};
		const result = { content: [{ type: "text", text: "listing" }] };
		const rendered = renderTui(result, details);
		for (const text of ["1 jobs", "1 services", "1 timers", "bg_1", "build", "web", "wake_1"])
			expect(rendered).toContain(text);
		const table = nodes(describeProcRead("", result, details).body).find(item => item.k === "list");
		expect(
			nodes(table?.c)
				.filter(item => item.k === "item")
				.map(item => item.key),
		).toEqual(["bg_1", "service:web", "wakeup:wake_1"]);
	});
});
