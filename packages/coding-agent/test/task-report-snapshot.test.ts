import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MAX_TASK_REPORT_BYTES,
	publishTaskReport,
	readTaskReportHistory,
	recordTaskReportHistory,
} from "@oh-my-pi/pi-coding-agent/task/report";
import type { TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("task report snapshots", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-task-report-snapshot-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	async function snapshotPath(manager: ArtifactManager, report: TaskReportReference): Promise<string> {
		if (!report.artifact) throw new Error("Expected a readable report artifact");
		const file = await manager.getPath(report.artifact.id);
		if (!file) throw new Error("Expected the report artifact to resolve");
		return file;
	}

	async function snapshotText(manager: ArtifactManager, report: TaskReportReference): Promise<string> {
		const text = await Bun.file(await snapshotPath(manager, report)).text();
		expect(report.artifact?.bytes).toBe(Buffer.byteLength(text));
		expect(report.artifact?.sha256).toBe(new Bun.SHA256().update(text).digest("hex"));
		return text;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("returns explicit storage-failed partial without an artifact after a short write", async () => {
		const manager = new ArtifactManager(freshDir());
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async target => {
			await realWrite(target as string, "cut");
			return 3;
		});

		expect(await publishTaskReport({ manager, runId: "short", text: "complete report" })).toEqual({
			version: 1,
			runId: "short",
			status: "partial",
			reason: "storage-failed",
		});
	});

	it("returns explicit storage-failed partial rather than throwing when the write fails", async () => {
		const manager = new ArtifactManager(freshDir());
		vi.spyOn(Bun, "write").mockRejectedValue(new Error("injected disk failure"));

		expect(await publishTaskReport({ manager, runId: "failed-write", text: "latest report" })).toEqual({
			version: 1,
			runId: "failed-write",
			status: "partial",
			reason: "storage-failed",
		});
	});

	it("does not advertise a complete artifact when a successful write stores same-size corrupted content", async () => {
		const manager = new ArtifactManager(freshDir());
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			return realWrite(target as string, "X".repeat(Buffer.byteLength(String(content))));
		});

		expect(await publishTaskReport({ manager, runId: "corrupted-write", text: "expected report" })).toEqual({
			version: 1,
			runId: "corrupted-write",
			status: "partial",
			reason: "storage-failed",
		});
	});

	it("returns storage-unavailable partial without claiming a reference when there is no artifact manager", async () => {
		expect(await publishTaskReport({ runId: "no-manager", text: "latest report" })).toEqual({
			version: 1,
			runId: "no-manager",
			status: "partial",
			reason: "storage-unavailable",
		});
	});

	it("publishes exactly 4 MiB of UTF-8 but rejects one extra byte before saving", async () => {
		const manager = new ArtifactManager(freshDir());
		const text = "é".repeat(MAX_TASK_REPORT_BYTES / 2);
		const exact = await publishTaskReport({ manager, runId: "exact", text });
		expect(exact.status).toBe("complete");
		expect(await snapshotText(manager, exact)).toBe(text);
		const save = vi.spyOn(manager, "save");

		expect(await publishTaskReport({ manager, runId: "oversize", text: `${text}a` })).toEqual({
			version: 1,
			runId: "oversize",
			status: "partial",
			reason: "too-large",
		});
		expect(save).not.toHaveBeenCalled();
	});

	it("counts prior UTF-8 bytes and the separator toward the 4 MiB cumulative snapshot limit", async () => {
		const manager = new ArtifactManager(freshDir());
		const text = "é".repeat((MAX_TASK_REPORT_BYTES - 4) / 2);
		const previous = await publishTaskReport({ manager, runId: "prior-bound", text });
		const exact = await publishTaskReport({ manager, runId: "cumulative-exact", previous, text: "é" });
		expect(exact.status).toBe("complete");
		expect(await snapshotText(manager, exact)).toBe(`${text}\n\né`);
		const save = vi.spyOn(manager, "save");

		expect(await publishTaskReport({ manager, runId: "cumulative-over", previous, text: "éa" })).toEqual({
			version: 1,
			runId: "cumulative-over",
			status: "partial",
			reason: "too-large",
		});
		expect(save).not.toHaveBeenCalled();
		expect(await snapshotText(manager, previous)).toBe(text);
	});

	it("keeps capture overflow explicit even when the supplied retained text fits the byte limit", async () => {
		const manager = new ArtifactManager(freshDir());
		const save = vi.spyOn(manager, "save");
		expect(await publishTaskReport({ manager, runId: "overflow", text: "retained prefix", overflow: true })).toEqual({
			version: 1,
			runId: "overflow",
			status: "partial",
			reason: "too-large",
		});
		expect(save).not.toHaveBeenCalled();
	});

	it.each([
		["path-like id", { id: "../foreign" }],
		["mutable agent URI", { uri: "agent://ForeignChild" }],
		["different numeric artifact URI", { uri: "artifact://9007199254740991" }],
		["invalid digest", { sha256: "not-a-sha256" }],
		["out-of-bounds byte count", { bytes: MAX_TASK_REPORT_BYTES + 1 }],
	])("retains latest text as history-unavailable without resolving a previous ref with %s", async (_name, patch) => {
		const manager = new ArtifactManager(freshDir());
		const original = await publishTaskReport({ manager, runId: "original", text: "must not inherit" });
		if (!original.artifact) throw new Error("Expected original artifact");
		const previous: TaskReportReference = { ...original, artifact: { ...original.artifact, ...patch } };
		const getPath = vi.spyOn(manager, "getPath");

		const latest = await publishTaskReport({ manager, runId: "latest", previous, text: "latest only" });

		expect(latest).toMatchObject({ status: "partial", reason: "history-unavailable" });
		if (!latest.artifact) throw new Error("Expected the latest text to remain readable");
		expect(getPath.mock.calls).toEqual([[latest.artifact.id]]);
		expect(await snapshotText(manager, latest)).toBe("latest only");
	});

	it("does not resolve an artifact from a previous reference with an invalid envelope", async () => {
		const manager = new ArtifactManager(freshDir());
		const original = await publishTaskReport({ manager, runId: "valid", text: "old report" });
		const getPath = vi.spyOn(manager, "getPath");
		const latest = await publishTaskReport({
			manager,
			runId: "latest",
			previous: { ...original, runId: "" },
			text: "latest only",
		});

		expect(latest).toMatchObject({ status: "partial", reason: "history-unavailable" });
		if (!latest.artifact) throw new Error("Expected the latest text to remain readable");
		expect(getPath.mock.calls).toEqual([[latest.artifact.id]]);
		expect(await snapshotText(manager, latest)).toBe("latest only");
	});

	it.each([
		["byte count", "short"],
		["SHA-256 with unchanged byte count", "CORRUPT!"],
	])(
		"retains latest text and marks history-unavailable when previous %s no longer matches",
		async (_name, corrupt) => {
			const manager = new ArtifactManager(freshDir());
			const previous = await publishTaskReport({ manager, runId: "prior", text: "ORIGINAL" });
			await Bun.write(await snapshotPath(manager, previous), corrupt);

			const latest = await publishTaskReport({ manager, runId: "latest", previous, text: "latest survives" });

			expect(latest).toMatchObject({ status: "partial", reason: "history-unavailable" });
			expect(await snapshotText(manager, latest)).toBe("latest survives");
		},
	);

	it("never upgrades an earlier partial report to complete when a later publication succeeds", async () => {
		const manager = new ArtifactManager(freshDir());
		const previous = await publishTaskReport({
			manager,
			runId: "failed-child",
			text: "partial findings",
			partialReason: "failed",
		});
		const latest = await publishTaskReport({ manager, runId: "resumed", previous, text: "more findings" });

		expect(latest).toMatchObject({ status: "partial", reason: "failed" });
		expect(await snapshotText(manager, latest)).toBe("partial findings\n\nmore findings");
	});

	it("keeps a prior artifact-less storage failure partial while making the latest text readable", async () => {
		const unavailable = await publishTaskReport({ runId: "unavailable", text: "lost prior findings" });
		const manager = new ArtifactManager(freshDir());
		const latest = await publishTaskReport({
			manager,
			runId: "recovered",
			previous: unavailable,
			text: "latest findings",
		});

		expect(latest).toMatchObject({ status: "partial", reason: "storage-unavailable" });
		expect(await snapshotText(manager, latest)).toBe("latest findings");
	});

	it("keeps every previously published snapshot readable and unchanged after later publications and manager recreation", async () => {
		const dir = freshDir();
		const manager = new ArtifactManager(dir);
		const first = await publishTaskReport({ manager, runId: "first", text: "first findings" });
		const firstReference = JSON.stringify(first);
		const second = await publishTaskReport({ manager, runId: "second", previous: first, text: "second findings" });
		const secondReference = JSON.stringify(second);
		expect(await snapshotText(manager, first)).toBe("first findings");

		const reopened = new ArtifactManager(dir);
		const third = await publishTaskReport({
			manager: reopened,
			runId: "third",
			previous: second,
			text: "third findings",
		});

		expect(new Set([first.artifact?.id, second.artifact?.id, third.artifact?.id]).size).toBe(3);
		expect(JSON.stringify(first)).toBe(firstReference);
		expect(JSON.stringify(second)).toBe(secondReference);
		expect(await snapshotText(reopened, first)).toBe("first findings");
		expect(await snapshotText(reopened, second)).toBe("first findings\n\nsecond findings");
		expect(await snapshotText(reopened, third)).toBe("first findings\n\nsecond findings\n\nthird findings");
	});

	it("selects the current child's latest task report without importing a foreign child with the same task id", async () => {
		const manager = new ArtifactManager(freshDir());
		const session = SessionManager.inMemory();
		const foreign = SessionManager.inMemory();
		const old = await publishTaskReport({ manager, runId: "old", text: "old current findings" });
		const current = await publishTaskReport({ manager, runId: "current", text: "current findings" });
		const excluded = await publishTaskReport({ manager, runId: "foreign", text: "foreign findings" });
		recordTaskReportHistory(session, "same-task", old);
		recordTaskReportHistory(session, "same-task", current);
		recordTaskReportHistory(session, "different-task", excluded);
		recordTaskReportHistory(foreign, "same-task", excluded);
		for (const entry of foreign.getBranchView()) {
			if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
		}

		const previous = readTaskReportHistory(session, "same-task");
		const latest = await publishTaskReport({ manager, runId: "next", previous, text: "next findings" });

		expect(previous?.runId).toBe("current");
		expect(readTaskReportHistory(session, "absent-task")).toBeUndefined();
		expect(await snapshotText(manager, latest)).toBe("current findings\n\nnext findings");
	});

	it("does not resurrect stale history when the current child's newest report reference is invalid", async () => {
		const manager = new ArtifactManager(freshDir());
		const session = SessionManager.inMemory();
		const stale = await publishTaskReport({ manager, runId: "stale", text: "stale findings" });
		recordTaskReportHistory(session, "task", stale);
		session.appendCustomEntry("task-public-report", {
			sessionId: session.getSessionId(),
			taskId: "task",
			report: { ...stale, version: 2 },
		});

		const previous = readTaskReportHistory(session, "task");
		expect(previous).toMatchObject({ status: "partial", reason: "history-unavailable" });
		const latest = await publishTaskReport({ manager, runId: "latest", previous, text: "latest findings" });
		expect(latest).toMatchObject({ status: "partial", reason: "history-unavailable" });
		expect(await snapshotText(manager, latest)).toBe("latest findings");
	});

	it("does not seed the active branch with an abandoned branch's later publication", async () => {
		const manager = new ArtifactManager(freshDir());
		const session = SessionManager.inMemory();
		const common = await publishTaskReport({ manager, runId: "common", text: "common findings" });
		recordTaskReportHistory(session, "task", common);
		const branchPoint = session.getLeafId();
		if (!branchPoint) throw new Error("Expected a branch point after the common publication");
		const abandoned = await publishTaskReport({
			manager,
			runId: "abandoned",
			previous: common,
			text: "abandoned findings",
		});
		recordTaskReportHistory(session, "task", abandoned);
		session.branch(branchPoint);
		session.appendCustomEntry("active-branch", { label: "new branch" });

		const previous = readTaskReportHistory(session, "task");
		const latest = await publishTaskReport({ manager, runId: "active", previous, text: "active findings" });

		expect(previous?.runId).toBe("common");
		expect(await snapshotText(manager, latest)).toBe("common findings\n\nactive findings");
	});
});
