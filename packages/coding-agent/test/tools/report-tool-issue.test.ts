import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as reportIssue from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import {
	__awaitAutoQaRecordPipelineForTests,
	__resetAutoQaConsentForTests,
	__resetAutoQaFlushStateForTests,
	dispatchReportIssueDevice,
	flushGrievances,
	isAutoQaEnabled,
	reportIssueDeviceUsage,
} from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import * as piUtils from "@oh-my-pi/pi-utils";
import { mockFetch } from "../helpers/fetch-mock";

function openTempDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE IF NOT EXISTS grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			pushed INTEGER NOT NULL DEFAULT 0
		);
	`);
	return db;
}

function insertGrievance(db: Database, tool: string, report: string): number {
	const info = db
		.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)")
		.run("test-model", "test-version", tool, report);
	return Number(info.lastInsertRowid);
}

/** All rows, regardless of pushed state. */
function selectIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances ORDER BY id ASC").all() as Array<{ id: number }>).map(r => r.id);
}

/** Just unpushed rows — what the next flush would pick up. */
function selectUnpushedIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances WHERE pushed = 0 ORDER BY id ASC").all() as Array<{ id: number }>).map(
		r => r.id,
	);
}

/** Just pushed rows — what's already been shipped. */
function selectPushedIds(db: Database): number[] {
	return (db.prepare("SELECT id FROM grievances WHERE pushed = 1 ORDER BY id ASC").all() as Array<{ id: number }>).map(
		r => r.id,
	);
}

function pushSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"dev.autoqa": true,
		// Consent is the push opt-in; `granted` is what `resolvePushConfig`
		// gates on (or `PI_AUTO_QA_PUSH=1` for headless overrides).
		"dev.autoqaConsent": "granted",
		"dev.autoqaPush.endpoint": "https://qa.example.com/grievances",
		...overrides,
	});
}

let originalPiAutoQa: string | undefined;

function restoreAutoQaEnv(): void {
	if (originalPiAutoQa === undefined) {
		delete Bun.env.PI_AUTO_QA;
		return;
	}
	Bun.env.PI_AUTO_QA = originalPiAutoQa;
}

describe("flushGrievances", () => {
	let db: Database;

	beforeEach(() => {
		__resetAutoQaFlushStateForTests();
		originalPiAutoQa = Bun.env.PI_AUTO_QA;
		delete Bun.env.PI_AUTO_QA;
		db = openTempDb();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		__resetAutoQaFlushStateForTests();
		restoreAutoQaEnv();
		db.close();
	});

	it("lets PI_AUTO_QA=false disable auto QA when the setting is enabled", () => {
		Bun.env.PI_AUTO_QA = "0";

		expect(isAutoQaEnabled(Settings.isolated({ "dev.autoqa": true }))).toBe(false);
	});

	it("lets PI_AUTO_QA=true enable auto QA when the setting is disabled", () => {
		Bun.env.PI_AUTO_QA = "1";

		expect(isAutoQaEnabled(Settings.isolated({ "dev.autoqa": false }))).toBe(true);
	});

	it("enables auto QA by default with consent still unset", () => {
		expect(isAutoQaEnabled(Settings.isolated())).toBe(true);
	});

	it("vetoes default-on auto QA once the user denied consent", () => {
		expect(isAutoQaEnabled(Settings.isolated({ "dev.autoqaConsent": "denied" }))).toBe(false);
	});

	it("keeps explicitly enabled auto QA on despite denied consent", () => {
		expect(isAutoQaEnabled(Settings.isolated({ "dev.autoqa": true, "dev.autoqaConsent": "denied" }))).toBe(true);
	});

	it("stays off when explicitly disabled", () => {
		expect(isAutoQaEnabled(Settings.isolated({ "dev.autoqa": false }))).toBe(false);
	});

	it("skips network when consent is missing and leaves rows intact", async () => {
		insertGrievance(db, "glob", "weird ordering");
		const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 200 }));

		// `denied` is the user-facing kill switch for push.
		const result = await flushGrievances(db, pushSettings({ "dev.autoqaConsent": "denied" }), {
			fetch: mockFetch(fetchSpy),
		});

		expect(result).toEqual({ pushed: 0, ok: false, skipped: true });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(selectIds(db)).toEqual([1]);
	});

	it("skips network when endpoint is missing", async () => {
		insertGrievance(db, "glob", "weird ordering");
		const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 200 }));

		const result = await flushGrievances(db, pushSettings({ "dev.autoqaPush.endpoint": "" }), {
			fetch: mockFetch(fetchSpy),
		});

		expect(result).toEqual({ pushed: 0, ok: false, skipped: true });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(selectIds(db)).toEqual([1]);
	});

	it("returns ok without fetching when there is nothing to push", async () => {
		const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 200 }));

		const result = await flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });

		expect(result).toEqual({ pushed: 0, ok: true });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts pending rows with bearer header and marks them pushed=1 on 200", async () => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("11111111-2222-3333-4444-555555555555");
		insertGrievance(db, "glob", "weird ordering");
		insertGrievance(db, "read", "selector ignored");

		let capturedInput: string | URL | Request | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchSpy = vi.fn(async (input: string | URL | Request, init: RequestInit | undefined) => {
			capturedInput = input;
			capturedInit = init;
			return new Response("", { status: 200 });
		});

		const result = await flushGrievances(db, pushSettings({ "dev.autoqaPush.token": "secret-token" }), {
			fetch: mockFetch(fetchSpy),
		});

		expect(result).toEqual({ pushed: 2, ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(capturedInput)).toBe("https://qa.example.com/grievances");
		expect(capturedInit?.method).toBe("POST");

		const headers = capturedInit?.headers as Record<string, string> | undefined;
		expect(headers?.["content-type"]).toBe("application/json");
		expect(headers?.authorization).toBe("Bearer secret-token");

		const body = JSON.parse(String(capturedInit?.body));
		expect(body.agent?.name).toBe("omp");
		expect(typeof body.agent?.version).toBe("string");
		expect(body.host).toBeUndefined();
		expect(typeof body.platform).toBe("string");
		expect(typeof body.arch).toBe("string");
		expect(body.installId).toBe("11111111-2222-3333-4444-555555555555");
		expect(body.entries).toEqual([
			{ id: 1, model: "test-model", version: "test-version", tool: "glob", report: "weird ordering" },
			{ id: 2, model: "test-model", version: "test-version", tool: "read", report: "selector ignored" },
		]);

		// Rows are retained for inspection — `pushed=1` flips, but the data
		// stays so users can browse what they've shipped via `omp grievances`.
		expect(selectIds(db)).toEqual([1, 2]);
		expect(selectPushedIds(db)).toEqual([1, 2]);
		expect(selectUnpushedIds(db)).toEqual([]);
	});

	it("omits the Authorization header when no token is configured", async () => {
		insertGrievance(db, "glob", "no token here");
		let capturedInit: RequestInit | undefined;
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init: RequestInit | undefined) => {
			capturedInit = init;
			return new Response("", { status: 204 });
		});

		const result = await flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });

		expect(result).toEqual({ pushed: 1, ok: true });
		const headers = capturedInit?.headers as Record<string, string> | undefined;
		expect(headers?.authorization).toBeUndefined();
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1]);
	});

	it("leaves rows unpushed on 5xx and reports failure", async () => {
		insertGrievance(db, "glob", "boom");
		const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));

		const result = await flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });

		expect(result).toEqual({ pushed: 0, ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(selectUnpushedIds(db)).toEqual([1]);
		expect(selectPushedIds(db)).toEqual([]);
	});

	it("drains mid-flight inserts in a follow-up batch within the same loop", async () => {
		insertGrievance(db, "glob", "first");

		const fetchEntered = Promise.withResolvers<void>();
		const releaseFirstFetch = Promise.withResolvers<Response>();
		let fetchCount = 0;
		const fetchSpy = vi.fn(() => {
			fetchCount += 1;
			if (fetchCount === 1) {
				fetchEntered.resolve();
				return releaseFirstFetch.promise;
			}
			// Subsequent loop iterations resolve immediately so the worker
			// finishes draining without manual coordination per batch.
			return Promise.resolve(new Response("", { status: 200 }));
		});

		const flushPromise = flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });
		await fetchEntered.promise;

		// New grievance written by a concurrent tool call while the push is in flight.
		insertGrievance(db, "read", "second");

		releaseFirstFetch.resolve(new Response("", { status: 200 }));
		const result = await flushPromise;

		// Both rows shipped — the worker looped, the second batch picked up
		// the row that landed mid-flight.
		expect(result).toEqual({ pushed: 2, ok: true });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1, 2]);
	});

	it("collapses concurrent callers onto a single in-flight push", async () => {
		insertGrievance(db, "glob", "single-flight");

		const releaseFetch = Promise.withResolvers<Response>();
		const fetchSpy = vi.fn(() => releaseFetch.promise);

		const settings = pushSettings();
		const first = flushGrievances(db, settings, { fetch: mockFetch(fetchSpy) });
		const second = flushGrievances(db, settings, { fetch: mockFetch(fetchSpy) });

		releaseFetch.resolve(new Response("", { status: 200 }));
		const [a, b] = await Promise.all([first, second]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(a).toEqual({ pushed: 1, ok: true });
		expect(b).toBe(a);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db)).toEqual([1]);
	});

	it("skips the next push within the failure cooldown window", async () => {
		insertGrievance(db, "glob", "first");
		const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));

		const settings = pushSettings();
		const firstResult = await flushGrievances(db, settings, { fetch: mockFetch(fetchSpy) });
		const secondResult = await flushGrievances(db, settings, { fetch: mockFetch(fetchSpy) });

		expect(firstResult).toEqual({ pushed: 0, ok: false });
		expect(secondResult).toEqual({ pushed: 0, ok: false, skipped: true });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(selectUnpushedIds(db)).toEqual([1]);
	});

	it("drains a backlog larger than the batch size in multiple POSTs", async () => {
		// Seed >1 batch worth (FLUSH_BATCH_SIZE = 50) so the worker has to loop.
		// 127 chosen to land on a non-multiple boundary (2 full batches + a
		// partial final one), exercising both the LIMIT semantics and the
		// "remainder smaller than batch" tail.
		const total = 127;
		for (let i = 0; i < total; i++) insertGrievance(db, "glob", `report-${i}`);

		const seenBatchSizes: number[] = [];
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init: RequestInit | undefined) => {
			const body = JSON.parse(String(init?.body)) as { entries: unknown[] };
			seenBatchSizes.push(body.entries.length);
			return new Response("", { status: 200 });
		});

		const result = await flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });

		expect(result).toEqual({ pushed: total, ok: true });
		// Three batches: 50 + 50 + 27.
		expect(seenBatchSizes).toEqual([50, 50, 27]);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(selectUnpushedIds(db)).toEqual([]);
		expect(selectPushedIds(db).length).toBe(total);
	});

	it("stops the loop on a mid-batch failure and preserves unpushed rows", async () => {
		// Two batches' worth — first batch ships, second batch errors. The
		// pushed-so-far count surfaces in the result and only the unsent
		// rows stay flagged unpushed.
		const firstBatch = 50;
		const secondBatch = 10;
		for (let i = 0; i < firstBatch + secondBatch; i++) insertGrievance(db, "glob", `r-${i}`);

		let call = 0;
		const fetchSpy = vi.fn(() => {
			call += 1;
			return new Response("", { status: call === 1 ? 200 : 500 });
		});

		const result = await flushGrievances(db, pushSettings(), { fetch: mockFetch(fetchSpy) });

		expect(result).toEqual({ pushed: firstBatch, ok: false });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(selectPushedIds(db).length).toBe(firstBatch);
		expect(selectUnpushedIds(db).length).toBe(secondBatch);
	});
});

describe("dispatchReportIssueDevice", () => {
	afterEach(() => {
		__resetAutoQaConsentForTests();
	});

	/** Drain the fire-and-forget consent → insert → flush pipeline. */
	async function settlePipeline(): Promise<void> {
		await __awaitAutoQaRecordPipelineForTests();
	}

	/** Auto QA on, consent already granted, push disabled (empty endpoint). */
	function consentedSettings(): Settings {
		return Settings.isolated({
			"dev.autoqa": true,
			"dev.autoqaConsent": "granted",
			"dev.autoqaPush.endpoint": "",
		});
	}

	it("records a grievance from `<tool>: <report>` text", async () => {
		Bun.env.PI_AUTO_QA = "1";
		const db = openTempDb();
		const openSpy = vi.spyOn(reportIssue, "openAutoQaDb").mockReturnValue(db);
		try {
			const session = { settings: consentedSettings() } as ToolSession;
			const { result, xdev } = await dispatchReportIssueDevice(
				session,
				"read: selector parse dropped trailing line",
			);
			const first = result.content[0];
			expect(first?.type).toBe("text");
			if (first?.type === "text") expect(first.text).toBe("Noted, thanks!");
			expect(xdev.tool).toBe("report_issue");
			await settlePipeline();
			expect(selectIds(db)).toHaveLength(1);
			const row = db.prepare("SELECT tool, report FROM grievances").get() as { tool: string; report: string };
			expect(row).toEqual({ tool: "read", report: "selector parse dropped trailing line" });
		} finally {
			openSpy.mockRestore();
			db.close();
		}
	});

	it("accepts the two-line fallback body format", async () => {
		Bun.env.PI_AUTO_QA = "1";
		const db = openTempDb();
		const openSpy = vi.spyOn(reportIssue, "openAutoQaDb").mockReturnValue(db);
		try {
			const session = { settings: consentedSettings() } as ToolSession;
			await dispatchReportIssueDevice(session, "grep\nreported matches include a deleted file");
			await settlePipeline();
			const row = db.prepare("SELECT tool, report FROM grievances").get() as { tool: string; report: string };
			expect(row).toEqual({ tool: "grep", report: "reported matches include a deleted file" });
		} finally {
			openSpy.mockRestore();
			db.close();
		}
	});

	it("writes nothing while consent is unresolved", async () => {
		Bun.env.PI_AUTO_QA = "1";
		const originalPush = Bun.env.PI_AUTO_QA_PUSH;
		delete Bun.env.PI_AUTO_QA_PUSH;
		const db = openTempDb();
		const openSpy = vi.spyOn(reportIssue, "openAutoQaDb").mockReturnValue(db);
		try {
			// Consent unset and no UI handler registered → resolves to false.
			const session = { settings: Settings.isolated({ "dev.autoqa": true }) } as ToolSession;
			const { result } = await dispatchReportIssueDevice(session, "read: selector parse dropped trailing line");
			const first = result.content[0];
			if (first?.type === "text") expect(first.text).toBe("Noted, thanks!");
			await settlePipeline();
			expect(selectIds(db)).toHaveLength(0);
		} finally {
			if (originalPush === undefined) delete Bun.env.PI_AUTO_QA_PUSH;
			else Bun.env.PI_AUTO_QA_PUSH = originalPush;
			openSpy.mockRestore();
			db.close();
		}
	});

	it("rejects malformed body text with a usage hint", async () => {
		const session = { settings: Settings.isolated({ "dev.autoqa": true }) } as ToolSession;
		await expect(dispatchReportIssueDevice(session, "just a vague sentence")).rejects.toThrow(
			reportIssueDeviceUsage(),
		);
	});
});
