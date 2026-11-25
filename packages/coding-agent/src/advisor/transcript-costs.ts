import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { defaultSessionStorage, type SessionStorage } from "../session/session-storage";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_STEM,
	isAdvisorTranscriptName,
	JSONL_SUFFIX,
} from "./transcript-names";

/** Controls resume-time advisor transcript cost restoration. */
export interface LoadAdvisorTranscriptCostsOptions {
	/** Resolves once active recorder writes are paused at the snapshot boundary. */
	beforeSnapshot?: Promise<unknown>;
	/**
	 * Runs synchronously after every transcript's byte length has been captured
	 * and before parsing begins. Callers release recorder write barriers at this
	 * boundary; later appends remain excluded from the captured disk totals.
	 */
	onSnapshot?: () => void;
	/** Stop metadata discovery and transcript parsing when the owning session is gone. */
	shouldContinue?: () => boolean;
	/**
	 * When provided, receives the distinct providers that billed each advisor
	 * slug (populated only for slugs with nonzero cost), so callers can
	 * re-derive subscription attribution from persisted spend without a second
	 * scan (#10129).
	 */
	providersBySlug?: Map<string, Set<string>>;
	/**
	 * Storage the transcripts are read from: the owning session's, where its
	 * {@link AdvisorTranscriptRecorder}s write them. Omitted: the default
	 * session storage.
	 */
	storage?: SessionStorage;
}

interface AdvisorTranscriptCostFileSnapshot {
	file: string;
	slug: string;
	maxBytes: number;
}

/**
 * Sum advisor spend already persisted next to a primary session transcript,
 * keyed by advisor slug.
 *
 * Each transcript is read only through the byte length captured before
 * `onSnapshot` runs. This fixed prefix lets resume reconcile the persisted
 * total with advisor turns billed while the asynchronous scan is running,
 * without either dropping or double-counting those concurrent turns.
 *
 * Only the session's own advisors count: subagent advisors write to
 * `<session>/<SubId>/__advisor.jsonl`, and their spend belongs to the subagent,
 * not to this roster. Hence the scan stays at the top level of the directory.
 *
 * The transcripts are read where {@link AdvisorTranscriptRecorder} writes them:
 * the session's storage (`options.storage`), which keeps them as rows rather
 * than files under `session.storage: sql`.
 */
export async function loadAdvisorTranscriptCosts(
	sessionFile: string | undefined,
	options: LoadAdvisorTranscriptCostsOptions = {},
): Promise<Map<string, number>> {
	await options.beforeSnapshot;
	const storage = options.storage ?? defaultSessionStorage();
	const snapshots: AdvisorTranscriptCostFileSnapshot[] = [];
	if (sessionFile?.endsWith(JSONL_SUFFIX)) {
		const directory = sessionFile.slice(0, -JSONL_SUFFIX.length);
		await storage.refresh?.();
		let names: string[] = [];
		try {
			// Regular files only, as the `Dirent.isFile()` this replaced required.
			names = storage
				.listEntriesSync(directory)
				.filter(entry => entry.isFile)
				.map(entry => entry.name);
		} catch (err) {
			logger.debug("advisor transcript listing failed", { err: String(err) });
		}
		for (const name of names) {
			if (options.shouldContinue?.() === false) break;
			const file = path.join(directory, name);
			if (!isAdvisorTranscriptName(name)) continue;
			try {
				snapshots.push({
					file,
					slug:
						name === ADVISOR_TRANSCRIPT_FILENAME
							? ""
							: name.slice(`${ADVISOR_TRANSCRIPT_STEM}.`.length, -JSONL_SUFFIX.length),
					maxBytes: storage.statSync(file).size,
				});
			} catch {}
		}
	}
	options.onSnapshot?.();

	const costs = new Map<string, number>();
	for (const snapshot of snapshots) {
		let total = 0;
		const providers = new Set<string>();
		let validHeader: boolean | undefined;
		try {
			await visitEntriesFromFileStream(
				snapshot.file,
				entry => {
					const isObject = typeof entry === "object" && entry !== null;
					if (validHeader === undefined) {
						validHeader = isObject && entry.type === "session" && typeof entry.id === "string";
						return;
					}
					// A syntactically valid but non-object entry (e.g. a bare
					// `null` line) must cost only itself, not crash entry.type
					// access and discard everything accumulated for this transcript.
					if (!validHeader || !isObject || entry.type !== "message") return;
					const message = entry.message;
					if (!message || typeof message !== "object" || message.role !== "assistant") return;
					// One malformed usage block must cost that entry only, not the
					// whole transcript's total.
					const total_ = message.usage?.cost?.total;
					if (typeof total_ === "number" && Number.isFinite(total_)) {
						total += total_;
						if (total_ > 0 && typeof message.provider === "string" && message.provider) {
							providers.add(message.provider);
						}
					}
				},
				{ maxBytes: snapshot.maxBytes, shouldContinue: options.shouldContinue, storage },
			);
		} catch (err) {
			logger.debug("advisor transcript cost read failed", { file: path.basename(snapshot.file), err: String(err) });
			continue;
		}
		if (total > 0) {
			costs.set(snapshot.slug, total);
			if (options.providersBySlug && providers.size > 0) options.providersBySlug.set(snapshot.slug, providers);
		}
	}
	return costs;
}
