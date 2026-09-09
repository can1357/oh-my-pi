import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	formatBytes,
	getAgentDbPath,
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getModelDbPath,
	getSessionsDir,
	getStatsDbPath,
	isEnoent,
} from "@oh-my-pi/pi-utils";
import { BLOB_HASH_RE } from "../session/blob-store";

const CATEGORY_LABELS = {
	sessionJournals: "Session journals",
	sessionLogs: "Session output logs",
	sessionArtifacts: "Other session artifacts",
	archiveJournals: "Archived journals",
	archiveLogs: "Archived output logs",
	archiveArtifacts: "Other archived artifacts",
	blobs: "Content-addressed blob files",
	blobAuxiliary: "Other blob-store files",
	databases: "Databases",
	databaseSidecars: "Database WAL/SHM files",
} as const;

export type StorageCategory = keyof typeof CATEGORY_LABELS;

export interface StorageSize {
	files: number;
	logicalBytes: number;
}

export interface StorageFile {
	path: string;
	category: StorageCategory;
	logicalBytes: number;
}

export interface StorageReport {
	agentDir: string;
	startedAt: string;
	finishedAt: string;
	/** A live directory scan is not a transactionally consistent filesystem snapshot. */
	consistentSnapshot: false;
	categories: Record<StorageCategory, StorageSize>;
	total: StorageSize;
	largestFiles: StorageFile[];
	skipped: { symlinks: number; specialFiles: number };
	errors: Array<{ path: string; message: string }>;
}

const LARGEST_FILE_LIMIT = 10;
const BLOB_EXTENSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

type StorageTree = "sessions" | "archive" | "blobs";

function treeFileCategory(name: string, tree: StorageTree): StorageCategory {
	if (tree === "blobs") {
		const separator = name.indexOf(".");
		const isBlob =
			BLOB_HASH_RE.test(name) ||
			(separator > 0 &&
				BLOB_HASH_RE.test(name.slice(0, separator)) &&
				BLOB_EXTENSION_RE.test(name.slice(separator + 1)));
		return isBlob ? "blobs" : "blobAuxiliary";
	}
	const journal = name.endsWith(".jsonl") || name.endsWith(".jsonl.gz") || /\.jsonl\..+\.bak$/.test(name);
	if (tree === "sessions") {
		return journal ? "sessionJournals" : name.endsWith(".log") ? "sessionLogs" : "sessionArtifacts";
	}
	return journal ? "archiveJournals" : name.endsWith(".log") ? "archiveLogs" : "archiveArtifacts";
}

/** Inventory managed storage using metadata only; never open databases, journals, or settings. */
export async function collectStorageReport(agentDir = getAgentDir()): Promise<StorageReport> {
	const resolvedAgentDir = path.resolve(agentDir);
	const report: StorageReport = {
		agentDir: resolvedAgentDir,
		startedAt: new Date().toISOString(),
		finishedAt: "",
		consistentSnapshot: false,
		categories: {
			sessionJournals: { files: 0, logicalBytes: 0 },
			sessionLogs: { files: 0, logicalBytes: 0 },
			sessionArtifacts: { files: 0, logicalBytes: 0 },
			archiveJournals: { files: 0, logicalBytes: 0 },
			archiveLogs: { files: 0, logicalBytes: 0 },
			archiveArtifacts: { files: 0, logicalBytes: 0 },
			blobs: { files: 0, logicalBytes: 0 },
			blobAuxiliary: { files: 0, logicalBytes: 0 },
			databases: { files: 0, logicalBytes: 0 },
			databaseSidecars: { files: 0, logicalBytes: 0 },
		},
		total: { files: 0, logicalBytes: 0 },
		largestFiles: [],
		skipped: { symlinks: 0, specialFiles: 0 },
		errors: [],
	};

	const recordFile = (file: string, category: StorageCategory, logicalBytes: number): void => {
		const sizes = report.categories[category];
		sizes.files++;
		sizes.logicalBytes += logicalBytes;
		report.total.files++;
		report.total.logicalBytes += logicalBytes;
		const largest = report.largestFiles;
		const position = largest.findIndex(
			item =>
				logicalBytes > item.logicalBytes ||
				(logicalBytes === item.logicalBytes && file.localeCompare(item.path) < 0),
		);
		if (position === -1 && largest.length === LARGEST_FILE_LIMIT) return;
		largest.splice(position === -1 ? largest.length : position, 0, { path: file, category, logicalBytes });
		if (largest.length > LARGEST_FILE_LIMIT) largest.pop();
	};

	const scan = async (file: string, tree: StorageTree | undefined, category?: StorageCategory): Promise<void> => {
		try {
			const info = await fs.lstat(file);
			if (info.isSymbolicLink()) {
				report.skipped.symlinks++;
				return;
			}
			if (info.isDirectory() && tree) {
				for await (const entry of await fs.opendir(file)) {
					await scan(path.join(file, entry.name), tree);
				}
			} else if (info.isFile()) {
				recordFile(file, category ?? treeFileCategory(path.basename(file), tree!), info.size);
			} else {
				report.skipped.specialFiles++;
			}
		} catch (error) {
			if (isEnoent(error)) return;
			report.errors.push({ path: file, message: error instanceof Error ? error.message : String(error) });
		}
	};

	const sessionsRoot = getSessionsDir(resolvedAgentDir);
	const archiveContainer = path.join(path.dirname(sessionsRoot), "archive");
	await scan(sessionsRoot, "sessions");
	try {
		const archiveInfo = await fs.lstat(archiveContainer);
		if (archiveInfo.isSymbolicLink()) {
			report.skipped.symlinks++;
		} else if (archiveInfo.isDirectory()) {
			await scan(path.join(archiveContainer, "sessions"), "archive");
		} else {
			report.skipped.specialFiles++;
		}
	} catch (error) {
		if (!isEnoent(error)) {
			report.errors.push({
				path: archiveContainer,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	await scan(getBlobsDir(resolvedAgentDir), "blobs");

	const statsDb =
		resolvedAgentDir === path.resolve(getAgentDir()) ? getStatsDbPath() : path.join(resolvedAgentDir, "stats.db");
	for (const database of [
		getAgentDbPath(resolvedAgentDir),
		getHistoryDbPath(resolvedAgentDir),
		getModelDbPath(resolvedAgentDir),
		statsDb,
	]) {
		await scan(database, undefined, "databases");
		await scan(`${database}-wal`, undefined, "databaseSidecars");
		await scan(`${database}-shm`, undefined, "databaseSidecars");
	}
	report.finishedAt = new Date().toISOString();
	return report;
}

/** Text output deliberately escapes paths so filenames cannot inject terminal control sequences. */
export function formatStorageReport(report: StorageReport): string {
	const lines = [
		`Storage report (${JSON.stringify(report.agentDir)})`,
		"Logical file bytes by path, not allocated blocks or reclaimable space. Shared files may be counted more than once.",
		"Best-effort live scan; no files changed. Scope: session/archive trees, blobs, and databases (not all agent data).",
	];
	for (const category of Object.keys(CATEGORY_LABELS) as StorageCategory[]) {
		const size = report.categories[category];
		lines.push(`${CATEGORY_LABELS[category]}: ${size.files} files, ${formatBytes(size.logicalBytes)}`);
	}
	lines.push(`Inventoried total: ${report.total.files} files, ${formatBytes(report.total.logicalBytes)}`);
	if (report.largestFiles.length > 0) {
		lines.push("Largest files:");
		for (const file of report.largestFiles) {
			lines.push(`  ${formatBytes(file.logicalBytes)} ${JSON.stringify(file.path)}`);
		}
	}
	lines.push(`Skipped: ${report.skipped.symlinks} symbolic links, ${report.skipped.specialFiles} special files`);
	for (const error of report.errors) {
		lines.push(`Scan error: ${JSON.stringify(error.path)}: ${JSON.stringify(error.message)}`);
	}
	return `${lines.join("\n")}\n`;
}
