import type { TaskReportArtifact, TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ArtifactManagerApi } from "../session/artifacts";
import type { SessionManager } from "../session/session-manager";

/** Bounds both captured public text and the cumulative published snapshot. */
export const MAX_TASK_REPORT_BYTES = 4 * 1024 * 1024;
const REPORT_HISTORY_TYPE = "task-public-report";

type PartialReason = Exclude<TaskReportReference["reason"], undefined>;

function isPartialReason(value: unknown): value is PartialReason {
	return (
		value === "failed" ||
		value === "aborted" ||
		value === "schema-invalid" ||
		value === "too-large" ||
		value === "storage-unavailable" ||
		value === "storage-failed" ||
		value === "empty" ||
		value === "history-unavailable"
	);
}

function isReportArtifact(value: unknown): value is TaskReportArtifact {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		/^(0|[1-9]\d*)$/.test(value.id) &&
		Number.isSafeInteger(Number(value.id)) &&
		value.uri === `artifact://${value.id}` &&
		typeof value.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.sha256) &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes > 0 &&
		value.bytes <= MAX_TASK_REPORT_BYTES
	);
}

function parseReportReference(value: unknown): TaskReportReference | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.runId !== "string" || !value.runId) return;
	const artifact = isReportArtifact(value.artifact)
		? Object.freeze({
				id: value.artifact.id,
				uri: value.artifact.uri,
				sha256: value.artifact.sha256,
				bytes: value.artifact.bytes,
			})
		: undefined;
	if (value.status === "complete" && artifact && value.reason === undefined) {
		return Object.freeze({ version: 1, runId: value.runId, status: "complete", artifact });
	}
	if (value.status === "partial" && isPartialReason(value.reason) && (value.artifact === undefined || artifact)) {
		return Object.freeze({ version: 1, runId: value.runId, status: "partial", artifact, reason: value.reason });
	}
}

/** Only this child's explicit publication entries can seed a later invocation. */
export function readTaskReportHistory(session: SessionManager, taskId: string): TaskReportReference | undefined {
	const entries = session.getBranchView();
	const sessionId = session.getSessionId();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== REPORT_HISTORY_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.taskId !== taskId || entry.data.sessionId !== sessionId) continue;
		return (
			parseReportReference(entry.data.report) ??
			Object.freeze({ version: 1, runId: "unavailable", status: "partial", reason: "history-unavailable" })
		);
	}
}

export function recordTaskReportHistory(session: SessionManager, taskId: string, report: TaskReportReference): void {
	session.appendCustomEntry(REPORT_HISTORY_TYPE, { sessionId: session.getSessionId(), taskId, report });
}

export interface PublishTaskReportOptions {
	runId: string;
	manager?: ArtifactManagerApi;
	/** Selected child-owned public output only, never raw transcript/tool output. */
	text: string;
	overflow?: boolean;
	partialReason?: PartialReason;
	previous?: TaskReportReference;
}

async function readReportArtifact(manager: ArtifactManagerApi, artifact: TaskReportArtifact): Promise<Uint8Array> {
	const artifactPath = await manager.getPath(artifact.id);
	if (!artifactPath) throw new Error("Report snapshot is unavailable");
	const file = Bun.file(artifactPath);
	if (file.size !== artifact.bytes) throw new Error("Report snapshot byte count differs");
	const bytes = await file.slice(0, artifact.bytes + 1).bytes();
	if (bytes.length !== artifact.bytes || new Bun.SHA256().update(bytes).digest("hex") !== artifact.sha256) {
		throw new Error("Report snapshot integrity differs");
	}
	return bytes;
}

/**
 * Publish a new numeric snapshot before any caller previews the output. Prior
 * snapshots are resolved only through the owning manager, never via text URIs
 * or the mutable agent-name protocol. An unavailable history remains partial.
 */
export async function publishTaskReport(options: PublishTaskReportOptions): Promise<TaskReportReference> {
	const partial = (reason: PartialReason): TaskReportReference =>
		Object.freeze({ version: 1, runId: options.runId, status: "partial", reason });
	if (options.overflow || Buffer.byteLength(options.text) > MAX_TASK_REPORT_BYTES) return partial("too-large");
	const manager = options.manager;
	if (!manager) return partial("storage-unavailable");
	let text = options.text;
	let partialReason = options.partialReason;
	if (options.previous) {
		const previous = parseReportReference(options.previous);
		if (previous?.status === "partial") partialReason ??= previous.reason;
		if (!previous?.artifact) {
			partialReason ??= "history-unavailable";
		} else {
			try {
				const bytes = await readReportArtifact(manager, previous.artifact);
				if (bytes.length + (text ? 2 + Buffer.byteLength(text) : 0) > MAX_TASK_REPORT_BYTES)
					return partial("too-large");
				const previousText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				text = text ? `${previousText}\n\n${text}` : previousText;
			} catch {
				partialReason ??= "history-unavailable";
			}
		}
	}
	if (!text.trim()) return partial(partialReason ?? "empty");
	try {
		const bytes = Buffer.byteLength(text);
		const sha256 = new Bun.SHA256().update(text).digest("hex");
		const id = await manager.save(text, "task-report");
		const artifact = Object.freeze({ id, uri: `artifact://${id}`, sha256, bytes });
		await readReportArtifact(manager, artifact);
		return partialReason
			? Object.freeze({ version: 1, runId: options.runId, status: "partial", artifact, reason: partialReason })
			: Object.freeze({ version: 1, runId: options.runId, status: "complete", artifact });
	} catch {
		return partial("storage-failed");
	}
}
