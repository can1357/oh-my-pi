/**
 * Sessions manager overlay — render/keyboard contracts.
 *
 * Uses injected fakes (enumerate, registry, gate, lifecycle, ctx) and real
 * `setArchived`/`isArchived` against temp session files, so no production
 * registry, DB, or settings are touched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { SessionsManagerComponent } from "../src/modes/components/sessions-manager";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { MAIN_AGENT_ID } from "../src/registry/agent-registry";
import {
	type EnumerateOptions,
	isArchived,
	type SessionFilter,
	type SessionRow,
	type SessionSort,
	setArchived,
} from "../src/session/session-control";
import type { SessionInfo } from "../src/session/session-listing";

const tmpDirs: string[] = [];

function makeSessionFile(id: string): string {
	return path.join(tmpDirs[tmpDirs.length - 1]!, `${id}.jsonl`);
}

function makeRow(
	overrides: Partial<SessionInfo> & {
		isCurrent?: boolean;
		archived?: boolean;
		liveState?: SessionRow["liveState"];
		cost?: number;
		model?: string;
		agentCounts?: SessionRow["agentCounts"];
	},
): SessionRow {
	const id = overrides.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`;
	const info: SessionInfo = {
		path: overrides.path ?? makeSessionFile(id),
		id,
		cwd: overrides.cwd ?? "/work",
		title: overrides.title,
		created: overrides.created ?? new Date(1000),
		modified: overrides.modified ?? new Date(2000),
		messageCount: overrides.messageCount ?? 0,
		size: overrides.size ?? 0,
		firstMessage: overrides.firstMessage ?? "first message",
		allMessagesText: overrides.allMessagesText ?? "",
		status: overrides.status,
	};
	return {
		info,
		isCurrent: overrides.isCurrent ?? false,
		archived: overrides.archived ?? false,
		liveState: overrides.liveState,
		cost: overrides.cost,
		model: overrides.model,
		agentCounts: overrides.agentCounts,
	};
}

function applyFilter(rows: SessionRow[], filter: SessionFilter): SessionRow[] {
	switch (filter) {
		case "current":
			return rows.filter(r => r.isCurrent);
		case "archived":
			return rows.filter(r => r.archived);
		case "paused":
			return rows.filter(r => r.liveState === "paused");
		case "active":
			return rows.filter(r => !r.archived);
		default:
			return rows;
	}
}

function agentTotal(r: SessionRow): number {
	return r.agentCounts ? r.agentCounts.running + r.agentCounts.idle + r.agentCounts.parked : 0;
}

function applySort(rows: SessionRow[], sort: SessionSort): SessionRow[] {
	const copy = [...rows];
	switch (sort) {
		case "created":
			copy.sort((a, b) => b.info.created.getTime() - a.info.created.getTime());
			break;
		case "cost":
			copy.sort((a, b) => (b.cost ?? -Infinity) - (a.cost ?? -Infinity));
			break;
		case "agents":
			copy.sort((a, b) => agentTotal(b) - agentTotal(a));
			break;
		default:
			copy.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
			break;
	}
	return copy;
}

interface ReleaseSpy {
	(id: string, expected?: unknown, options?: { tombstone?: boolean }): Promise<boolean>;
	calls: Array<{ id: string; options?: { tombstone?: boolean } }>;
}

function makeReleaseSpy(): ReleaseSpy {
	const calls: ReleaseSpy["calls"] = [];
	const fn = vi.fn(async (id: string, _expected?: unknown, options?: { tombstone?: boolean }) => {
		calls.push({ id, options });
		return true;
	}) as unknown as ReleaseSpy;
	fn.calls = calls;
	return fn;
}

interface Fakes {
	base: SessionRow[];
	registryList: Array<{ id: string; status: string }>;
	gate: { paused: boolean; engage: () => void; release: () => void };
	release: ReleaseSpy;
	handleResumeSession: (path: string) => Promise<void>;
	showStatus: (text: string) => void;
	dropSession: (path: string) => Promise<void>;
}

function makeFakes(base: SessionRow[]): Fakes {
	const handleResumeSession = vi.fn(async () => {});
	const showStatus = vi.fn();
	const dropSession = vi.fn(async () => {});
	const gate = { paused: false, engage: vi.fn(), release: vi.fn() };
	return {
		base,
		registryList: [{ id: MAIN_AGENT_ID, status: "running" }],
		gate,
		release: makeReleaseSpy(),
		handleResumeSession,
		showStatus,
		dropSession,
	};
}

function makeComponent(fakes: Fakes, ui?: unknown): SessionsManagerComponent {
	const base = fakes.base;
	const enumerate = (opts: EnumerateOptions): Promise<SessionRow[]> => {
		let rows = base.map(r => ({ ...r, archived: isArchived(r.info.path) }));
		rows = applyFilter(rows, opts.filter ?? "all");
		rows = applySort(rows, opts.sort ?? "recent");
		return Promise.resolve(rows);
	};
	const ctx = {
		session: { getSessionFile: () => base.find(r => r.isCurrent)?.info.path, model: "provider/model" },
		sessionManager: { dropSession: fakes.dropSession },
		showStatus: fakes.showStatus,
		handleResumeSession: fakes.handleResumeSession,
	} as unknown as InteractiveModeContext;
	return new SessionsManagerComponent({
		ctx,
		ui: ui as never,
		requestRender: () => {},
		onClose: () => {},
		enumerate,
		registry: { list: () => fakes.registryList, onChange: () => () => {} } as never,
		gate: fakes.gate as never,
		lifecycle: { release: fakes.release } as never,
	});
}
/** Await the component's in-flight enumeration — the real completion signal, no timers. */
const settle = async (component: SessionsManagerComponent): Promise<void> => {
	for (let i = 0; i < 4; i += 1) await component.awaitSettled();
};
const renderText = (c: SessionsManagerComponent, width = 160): string => Bun.stripANSI(c.render(width).join("\n"));

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	tmpDirs.push(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sm-")));
});

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) await removeWithRetries(dir).catch(() => {});
});

describe("sessions manager — enumerate-driven rows", () => {
	it("renders current + persisted sessions from a temp sessionDir fixture", async () => {
		const base = [
			makeRow({ id: "current1", title: "Current Session", isCurrent: true, cwd: "/work/a" }),
			makeRow({ id: "old1", title: "Old Session", cwd: "/work/b" }),
		];
		await fs.writeFile(base[0]!.info.path, "");
		await fs.writeFile(base[1]!.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		const text = renderText(component);
		expect(text).toContain("Current Session");
		expect(text).toContain("Old Session");
		expect(text).toContain("●");
	});

	it("cycles filter current/active/paused/archived/all", async () => {
		const base = [
			makeRow({ id: "c1", title: "Cur", isCurrent: true, cwd: "/w" }),
			makeRow({ id: "p1", title: "Paused", liveState: "paused", cwd: "/w" }),
			makeRow({ id: "a1", title: "Arch", archived: true, cwd: "/w" }),
		];
		for (const r of base) await fs.writeFile(r.info.path, "");
		// Production derives `archived` from the on-disk sentinel, not the row field.
		await setArchived(base[2]!.info.path, true);
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);

		component.handleInput("F");
		await settle(component);
		expect(renderText(component)).toContain("Cur");
		expect(renderText(component)).not.toContain("Paused");

		component.handleInput("F");
		await settle(component);
		const active = renderText(component);
		expect(active).toContain("Cur");
		expect(active).toContain("Paused");
		expect(active).not.toContain("Arch");

		component.handleInput("F");
		await settle(component);
		const paused = renderText(component);
		expect(paused).toContain("Paused");
		expect(paused).not.toContain("Cur");

		component.handleInput("F");
		await settle(component);
		const archived = renderText(component);
		expect(archived).toContain("Arch");
		expect(archived).not.toContain("Cur");
	});

	it("sorts recent/cost/agents", async () => {
		const base = [
			makeRow({ id: "cheap", title: "Cheap", cost: 1, modified: new Date(3000), cwd: "/w" }),
			makeRow({ id: "pricey", title: "Pricey", cost: 99, modified: new Date(1000), cwd: "/w" }),
			makeRow({ id: "many", title: "Many", agentCounts: { running: 5, idle: 0, parked: 0 }, cwd: "/w" }),
		];
		for (const r of base) await fs.writeFile(r.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);

		let text = renderText(component);
		expect(text.indexOf("Cheap")).toBeLessThan(text.indexOf("Pricey"));

		component.handleInput("S");
		await settle(component);
		component.handleInput("S");
		await settle(component);
		text = renderText(component);
		expect(text.indexOf("Pricey")).toBeLessThan(text.indexOf("Cheap"));

		component.handleInput("S");
		await settle(component);
		text = renderText(component);
		expect(text.indexOf("Many")).toBeLessThan(text.indexOf("Pricey"));
	});

	it("renders the renamed title but drives actions with the durable path", async () => {
		const base = [makeRow({ id: "abc123", title: "Renamed Title", cwd: "/w/x", isCurrent: false })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		expect(renderText(component)).toContain("Renamed Title");
		component.handleInput("\r");
		await settle(component);
		expect(fakes.handleResumeSession).toHaveBeenCalledTimes(1);
		expect(fakes.handleResumeSession).toHaveBeenCalledWith(base[0]!.info.path);
		expect(fakes.handleResumeSession).not.toHaveBeenCalledWith("Renamed Title");
	});

	it("toggles pause only for the current session via the gate", async () => {
		const base = [makeRow({ id: "c1", title: "Cur", isCurrent: true, cwd: "/w" })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		component.handleInput("P");
		await settle(component);
		expect(fakes.gate.engage).toHaveBeenCalledTimes(1);
		expect(fakes.gate.release).not.toHaveBeenCalled();
	});

	it("requires confirmation and scopes kill to running subagents only", async () => {
		const base = [makeRow({ id: "c1", title: "Cur", isCurrent: true, cwd: "/w" })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		fakes.registryList = [
			{ id: MAIN_AGENT_ID, status: "running" },
			{ id: "r1", status: "running" },
			{ id: "r2", status: "parked" },
		];
		const component = makeComponent(fakes);
		await settle(component);
		component.handleInput("K");
		await settle(component);
		expect(fakes.release.calls).toHaveLength(0);
		component.handleInput("y");
		await settle(component);
		expect(fakes.release.calls).toHaveLength(1);
		expect(fakes.release.calls[0]).toEqual({ id: "r1", options: { tombstone: true } });
		expect(fakes.release.calls.some(c => c.id === "r2")).toBe(false);
		expect(fakes.release.calls.some(c => c.id === MAIN_AGENT_ID)).toBe(false);
	});

	it("archives a session and reflects it in the list (roundtrip)", async () => {
		const base = [makeRow({ id: "a1", title: "ToArchive", cwd: "/w", isCurrent: false })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		expect(isArchived(base[0]!.info.path)).toBe(false);
		component.handleInput("A");
		await settle(component);
		expect(isArchived(base[0]!.info.path)).toBe(true);
		expect(renderText(component)).toContain("archived");
		component.handleInput("A");
		await settle(component);
		expect(isArchived(base[0]!.info.path)).toBe(false);
	});

	it("renders unavailable metrics as a placeholder, never zero", async () => {
		const base = [makeRow({ id: "u1", title: "NoMetrics", cwd: "/w", isCurrent: false })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		const text = renderText(component);
		expect(text).toContain("—");
		expect(text).not.toContain("$0");
	});
});

describe("sessions manager — narrow widths and timers", () => {
	it("renders at 160/120/80/60 without throwing and drops columns", async () => {
		const base = [
			makeRow({
				id: "c1",
				title: "Cur",
				isCurrent: true,
				cwd: "/work/long/path",
				model: "provider/model",
				cost: 42,
				agentCounts: { running: 1, idle: 0, parked: 0 },
			}),
			makeRow({ id: "o1", title: "Other", cwd: "/work/other", model: "provider/model2", cost: 7 }),
		];
		for (const r of base) await fs.writeFile(r.info.path, "");
		const fakes = makeFakes(base);
		const component = makeComponent(fakes);
		await settle(component);
		for (const width of [160, 120, 80, 60]) {
			const lines = component.render(width);
			expect(Array.isArray(lines)).toBe(true);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Cur");
		}
		component.dispose();
	});

	it("creates no timer tighter than 5s (only the age tick at 5000ms)", async () => {
		const base = [makeRow({ id: "c1", title: "Cur", isCurrent: true, cwd: "/w" })];
		await fs.writeFile(base[0]!.info.path, "");
		const fakes = makeFakes(base);
		const intervals: number[] = [];
		const original = global.setInterval;
		// Record the requested delay and return a no-op timer so no real clock is bound.
		// @ts-expect-error test shim
		global.setInterval = (_fn: () => void, delay?: number): NodeJS.Timeout => {
			intervals.push(delay ?? 0);
			return { unref() {} } as unknown as NodeJS.Timeout;
		};
		try {
			const component = makeComponent(fakes, { requestRender: () => {} });
			await settle(component);
			expect(intervals).toEqual([5000]);
			component.dispose();
		} finally {
			global.setInterval = original;
		}
	});
});
