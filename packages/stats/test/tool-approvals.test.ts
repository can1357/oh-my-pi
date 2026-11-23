import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-tool-approvals-");

const FOLDER_SLUG = "--tmp--tool-approvals";

interface ToolApprovalRow {
	session_file: string;
	tool_call_id: string;
	parent_tool_call_id: string | null;
	folder: string;
	tool_name: string;
	approval_mode: string | null;
	requested_at: number | null;
	request_reason: string | null;
	approved: number | null;
	resolved_at: number | null;
	resolve_reason: string | null;
}

function sessionHeader(id: string, timestamp: string) {
	return { type: "session", version: 1, id, timestamp, cwd: "/tmp/tool-approvals" };
}

function approvalRequested(opts: {
	id: string;
	toolCallId: string;
	parentToolCallId?: string;
	toolName: string;
	approvalMode: string;
	reason?: string;
	requestedAt: string;
}) {
	return {
		type: "custom",
		id: opts.id,
		timestamp: opts.requestedAt,
		customType: "tool_approval_requested",
		data: {
			toolCallId: opts.toolCallId,
			...(opts.parentToolCallId ? { parentToolCallId: opts.parentToolCallId } : {}),
			toolName: opts.toolName,
			approvalMode: opts.approvalMode,
			...(opts.reason ? { reason: opts.reason } : {}),
			requestedAt: opts.requestedAt,
		},
	};
}

function approvalResolved(opts: {
	id: string;
	toolCallId: string;
	toolName: string;
	approved: boolean;
	reason?: string;
	resolvedAt: string;
}) {
	return {
		type: "custom",
		id: opts.id,
		timestamp: opts.resolvedAt,
		customType: "tool_approval_resolved",
		data: {
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			approved: opts.approved,
			...(opts.reason ? { reason: opts.reason } : {}),
			resolvedAt: opts.resolvedAt,
		},
	};
}

async function writeSession(filename: string, entries: unknown[]): Promise<string> {
	const filePath = path.join(getSessionsDir(), FOLDER_SLUG, filename);
	await Bun.write(filePath, `${entries.map(e => JSON.stringify(e)).join("\n")}\n`);
	return filePath;
}

describe("tool_approvals indexing", () => {
	it("indexes requested and resolved approval records including eval parentToolCallId", async () => {
		const req1 = "2026-11-23T10:00:00.000Z";
		const res1 = "2026-11-23T10:00:03.500Z";
		const req2 = "2026-11-23T10:01:00.000Z";
		const res2 = "2026-11-23T10:01:02.000Z";

		const sessionFile = await writeSession("s1.jsonl", [
			sessionHeader("s1", req1),
			approvalRequested({
				id: "e1",
				toolCallId: "call_bash_1",
				toolName: "bash",
				approvalMode: "write",
				reason: "unmatched command",
				requestedAt: req1,
			}),
			approvalResolved({
				id: "e2",
				toolCallId: "call_bash_1",
				toolName: "bash",
				approved: true,
				resolvedAt: res1,
			}),
			approvalRequested({
				id: "e3",
				toolCallId: "call_nested_1",
				parentToolCallId: "call_eval_1",
				toolName: "bash",
				approvalMode: "write",
				requestedAt: req2,
			}),
			approvalResolved({
				id: "e4",
				toolCallId: "call_nested_1",
				toolName: "bash",
				approved: false,
				reason: "denied by user",
				resolvedAt: res2,
			}),
			// Malformed entries should be ignored without failing sync
			{
				type: "custom",
				id: "e5",
				timestamp: res2,
				customType: "tool_approval_requested",
				data: { toolName: "bash" },
			},
			{ type: "custom", id: "e6", timestamp: res2, customType: "tool_approval_resolved", data: null },
			{
				type: "custom",
				id: "e7",
				timestamp: res2,
				customType: "tool_approval_resolved",
				data: { toolCallId: "call_bad_res", toolName: "bash", approved: "false", resolvedAt: res2 },
			},
			{
				type: "custom",
				id: "e8",
				timestamp: res2,
				customType: "tool_approval_resolved",
				data: { toolCallId: "call_missing_approved", toolName: "bash", resolvedAt: res2 },
			},
		]);

		await syncAllSessions({ workers: 1 });
		const db = await initDb();
		const rows = db.query<ToolApprovalRow, []>("SELECT * FROM tool_approvals ORDER BY tool_call_id").all();

		expect(rows).toEqual([
			{
				session_file: sessionFile,
				tool_call_id: "call_bash_1",
				parent_tool_call_id: null,
				folder: "/tmp/tool-approvals",
				tool_name: "bash",
				approval_mode: "write",
				requested_at: Date.parse(req1),
				request_reason: "unmatched command",
				approved: 1,
				resolved_at: Date.parse(res1),
				resolve_reason: null,
			},
			{
				session_file: sessionFile,
				tool_call_id: "call_nested_1",
				parent_tool_call_id: "call_eval_1",
				folder: "/tmp/tool-approvals",
				tool_name: "bash",
				approval_mode: "write",
				requested_at: Date.parse(req2),
				request_reason: null,
				approved: 0,
				resolved_at: Date.parse(res2),
				resolve_reason: "denied by user",
			},
		]);
	});

	it("merges request and resolution across incremental tail syncs", async () => {
		const reqTs = "2026-11-23T11:00:00.000Z";
		const resTs = "2026-11-23T11:00:05.000Z";

		const sessionFile = await writeSession("s2.jsonl", [
			sessionHeader("s2", reqTs),
			approvalRequested({
				id: "e1",
				toolCallId: "call_tail_1",
				parentToolCallId: "call_eval_9",
				toolName: "bash",
				approvalMode: "write",
				reason: "needs approval",
				requestedAt: reqTs,
			}),
		]);

		await syncAllSessions({ workers: 1 });
		const db = await initDb();
		const pending = db
			.query<ToolApprovalRow, [string]>("SELECT * FROM tool_approvals WHERE tool_call_id = ?")
			.get("call_tail_1");
		expect(pending).toMatchObject({
			session_file: sessionFile,
			tool_call_id: "call_tail_1",
			parent_tool_call_id: "call_eval_9",
			approval_mode: "write",
			requested_at: Date.parse(reqTs),
			request_reason: "needs approval",
			approved: null,
			resolved_at: null,
			resolve_reason: null,
		});

		await fs.appendFile(
			sessionFile,
			`${JSON.stringify(
				approvalResolved({
					id: "e2",
					toolCallId: "call_tail_1",
					toolName: "bash",
					approved: true,
					resolvedAt: resTs,
				}),
			)}\n`,
		);

		await syncAllSessions({ workers: 1 });
		const resolved = db
			.query<ToolApprovalRow, [string]>("SELECT * FROM tool_approvals WHERE tool_call_id = ?")
			.get("call_tail_1");
		expect(resolved).toMatchObject({
			session_file: sessionFile,
			tool_call_id: "call_tail_1",
			parent_tool_call_id: "call_eval_9",
			approval_mode: "write",
			requested_at: Date.parse(reqTs),
			request_reason: "needs approval",
			approved: 1,
			resolved_at: Date.parse(resTs),
			resolve_reason: null,
		});
	});

	it("deduplicates forked sessions sharing the same toolCallId", async () => {
		const reqTs = "2026-11-23T12:00:00.000Z";
		const resTs = "2026-11-23T12:00:01.000Z";
		const entries = [
			sessionHeader("s3", reqTs),
			approvalRequested({
				id: "e1",
				toolCallId: "call_fork_1",
				toolName: "bash",
				approvalMode: "write",
				requestedAt: reqTs,
			}),
			approvalResolved({
				id: "e2",
				toolCallId: "call_fork_1",
				toolName: "bash",
				approved: true,
				resolvedAt: resTs,
			}),
		];

		await writeSession("s3-orig.jsonl", entries);
		await writeSession("s3-fork.jsonl", entries);

		await syncAllSessions({ workers: 1 });
		const db = await initDb();
		const rows = db
			.query<ToolApprovalRow, [string]>("SELECT * FROM tool_approvals WHERE tool_call_id = ?")
			.all("call_fork_1");
		expect(rows).toHaveLength(1);
	});

	it("merges a resolution recorded only in a fork after the pending source was synced", async () => {
		const reqTs = "2026-11-23T12:10:00.000Z";
		const resTs = "2026-11-23T12:10:04.000Z";
		const pendingRequest = approvalRequested({
			id: "e1",
			toolCallId: "call_fork_pending_1",
			toolName: "bash",
			approvalMode: "write",
			requestedAt: reqTs,
		});

		const origFile = await writeSession("s4-orig.jsonl", [sessionHeader("s4-orig", reqTs), pendingRequest]);
		await syncAllSessions({ workers: 1 });

		await writeSession("s4-fork.jsonl", [
			sessionHeader("s4-fork", reqTs),
			pendingRequest,
			approvalResolved({
				id: "e2",
				toolCallId: "call_fork_pending_1",
				toolName: "bash",
				approved: false,
				reason: "denied in fork",
				resolvedAt: resTs,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const db = await initDb();
		const rows = db
			.query<ToolApprovalRow, [string]>("SELECT * FROM tool_approvals WHERE tool_call_id = ?")
			.all("call_fork_pending_1");
		expect(rows).toEqual([
			{
				session_file: origFile,
				tool_call_id: "call_fork_pending_1",
				parent_tool_call_id: null,
				folder: "/tmp/tool-approvals",
				tool_name: "bash",
				approval_mode: "write",
				requested_at: Date.parse(reqTs),
				request_reason: null,
				approved: 0,
				resolved_at: Date.parse(resTs),
				resolve_reason: "denied in fork",
			},
		]);
	});

	it("backfills recent transcripts with up-to-date cursors on upgrade", async () => {
		const reqTs = "2026-11-23T13:00:00.000Z";
		const resTs = "2026-11-23T13:00:02.000Z";
		const sessionFile = await writeSession("s5-upgrade.jsonl", [
			sessionHeader("s5", reqTs),
			approvalRequested({
				id: "e1",
				toolCallId: "call_upgrade_1",
				toolName: "bash",
				approvalMode: "write",
				requestedAt: reqTs,
			}),
			approvalResolved({
				id: "e2",
				toolCallId: "call_upgrade_1",
				toolName: "bash",
				approved: true,
				resolvedAt: resTs,
			}),
		]);
		const stat = await fs.stat(sessionFile);

		const db = await initDb();
		db.run("DELETE FROM meta WHERE key = 'tool_approvals_v1'");
		db.run("DELETE FROM tool_approvals");
		db.query("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			sessionFile,
			stat.size,
			stat.mtimeMs,
		);
		closeDb();

		await syncAllSessions({ workers: 1 });
		const upgradedDb = await initDb();
		const row = upgradedDb
			.query<ToolApprovalRow, [string]>("SELECT * FROM tool_approvals WHERE tool_call_id = ?")
			.get("call_upgrade_1");
		expect(row).toMatchObject({
			session_file: sessionFile,
			tool_call_id: "call_upgrade_1",
			approved: 1,
			requested_at: Date.parse(reqTs),
			resolved_at: Date.parse(resTs),
		});
	});
});
