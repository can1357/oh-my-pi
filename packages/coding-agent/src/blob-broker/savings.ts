import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/** One request-level group of image references written to the provider wire. */
export interface BlobBrokerSavingsRecord {
	/** Unix epoch milliseconds when the provider request was decorated. */
	readonly timestamp: number;
	readonly provider: string;
	readonly model: string;
	/** Provider-native files use `provider-files`; URLs use their publication destination. */
	readonly destination: string;
	readonly imageCount: number;
	/** UTF-8 bytes occupied by the base64 values replaced by references. */
	readonly inlineBytes: number;
	/** UTF-8 bytes occupied by the URL or provider-file references. */
	readonly referenceBytes: number;
	readonly savedBytes: number;
}

/** Additive counters shared by the total and per-destination status views. */
export interface BlobBrokerSavingsCounters {
	readonly entries: number;
	readonly imageCount: number;
	readonly inlineBytes: number;
	readonly referenceBytes: number;
	readonly savedBytes: number;
}

/** Durable savings summary exposed by `omp images status`. */
export interface BlobBrokerSavingsStatus extends BlobBrokerSavingsCounters {
	readonly journalPath: string;
	readonly byDestination: Readonly<Record<string, BlobBrokerSavingsCounters>>;
}

function projectHash(projectDir: string): string {
	return Bun.hash.wyhash(path.resolve(projectDir)).toString(16);
}

/** Deterministic per-project append-only journal path. */
export function blobBrokerSavingsJournalPath(settings: Settings, projectDir: string): string {
	return path.join(getBlobsDir(settings.getAgentDir()), `image-savings-${projectHash(projectDir)}.jsonl`);
}

function emptyCounters(): BlobBrokerSavingsCounters {
	return { entries: 0, imageCount: 0, inlineBytes: 0, referenceBytes: 0, savedBytes: 0 };
}

function addRecord(counters: BlobBrokerSavingsCounters, record: BlobBrokerSavingsRecord): BlobBrokerSavingsCounters {
	return {
		entries: counters.entries + 1,
		imageCount: counters.imageCount + record.imageCount,
		inlineBytes: counters.inlineBytes + record.inlineBytes,
		referenceBytes: counters.referenceBytes + record.referenceBytes,
		savedBytes: counters.savedBytes + record.savedBytes,
	};
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRecord(line: string): BlobBrokerSavingsRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<BlobBrokerSavingsRecord>;
	if (
		!isFiniteNonNegativeInteger(candidate.timestamp) ||
		typeof candidate.provider !== "string" ||
		typeof candidate.model !== "string" ||
		typeof candidate.destination !== "string" ||
		candidate.destination.length === 0 ||
		!isFiniteNonNegativeInteger(candidate.imageCount) ||
		candidate.imageCount === 0 ||
		!isFiniteNonNegativeInteger(candidate.inlineBytes) ||
		!isFiniteNonNegativeInteger(candidate.referenceBytes) ||
		typeof candidate.savedBytes !== "number" ||
		!Number.isSafeInteger(candidate.savedBytes)
	) {
		return undefined;
	}
	return candidate as BlobBrokerSavingsRecord;
}

/** Aggregate the durable journal in one linear scan; malformed lines are ignored. */
export async function readBlobBrokerSavingsStatus(journalPath: string): Promise<BlobBrokerSavingsStatus> {
	let text: string;
	try {
		text = await fs.readFile(journalPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { journalPath, ...emptyCounters(), byDestination: {} };
		throw error;
	}
	let total = emptyCounters();
	const byDestination: Record<string, BlobBrokerSavingsCounters> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record = parseRecord(line);
		if (!record) continue;
		total = addRecord(total, record);
		byDestination[record.destination] = addRecord(byDestination[record.destination] ?? emptyCounters(), record);
	}
	return { journalPath, ...total, byDestination };
}

/** Append-only recorder. Failures are diagnostic-only and never break a provider request. */
export class BlobBrokerSavingsJournal {
	readonly path: string;
	#dirEnsured = false;

	constructor(journalPath: string) {
		this.path = journalPath;
	}

	async append(records: readonly BlobBrokerSavingsRecord[]): Promise<void> {
		if (records.length === 0) return;
		try {
			if (!this.#dirEnsured) {
				await fs.mkdir(path.dirname(this.path), { recursive: true });
				this.#dirEnsured = true;
			}
			await fs.appendFile(this.path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
		} catch (error) {
			logger.debug("blob-broker: savings journal append failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	status(): Promise<BlobBrokerSavingsStatus> {
		return readBlobBrokerSavingsStatus(this.path);
	}
}
