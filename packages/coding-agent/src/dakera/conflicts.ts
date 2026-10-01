/**
 * Client-side ledger of near-duplicate conflicts: when a stored fact lands
 * close to (but below the supersede floor of) an existing row, the old row's
 * id is recorded here so the recall renderer can demote and mark it
 * `[outdated?]`. Deliberately client-side and mark-only — the server row is
 * never deleted or rewritten, and a missing/corrupt ledger degrades to
 * today's behavior.
 */

import { isEnoent } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export interface ConflictRecord {
	/** The row that contradicted (and effectively replaced) the old fact. */
	supersededBy: string;
	/** When the conflict was recorded (ISO-8601); drives the idle prune. */
	at: string;
	/** Token-Jaccard similarity that triggered the detection (below the supersede threshold). */
	near: number;
}

/** Entries idle longer than this are pruned on load — the contradicted row has long been restated or compacted. */
const IDLE_PRUNE_MS = 90 * 86_400_000;
/** Hard cap on tracked ids; overflow drops the oldest-marked entries first. */
const MAX_LEDGER_IDS = 10_000;

function isConflictRecord(value: unknown): value is ConflictRecord {
	if (!isRecord(value)) return false;
	return typeof value.supersededBy === "string" && typeof value.at === "string" && typeof value.near === "number";
}

export class ConflictLedger {
	readonly #filePath: string;
	readonly #records = new Map<string, ConflictRecord>();

	constructor(filePath: string, records?: Record<string, unknown>) {
		this.#filePath = filePath;
		const cutoff = Date.now() - IDLE_PRUNE_MS;
		if (records !== undefined) {
			for (const [id, record] of Object.entries(records)) {
				if (!isConflictRecord(record)) continue;
				if (Date.parse(record.at) <= cutoff) continue;
				this.#records.set(id, record);
			}
		}
		this.#capOldest();
	}

	/**
	 * Load the ledger at `filePath`; a missing file starts empty. Corrupt
	 * entries are dropped individually so one bad row cannot lose the rest.
	 */
	static async load(filePath: string): Promise<ConflictLedger> {
		let raw: unknown;
		try {
			raw = await Bun.file(filePath).json();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			raw = {};
		}
		return new ConflictLedger(filePath, isRecord(raw) ? raw : {});
	}

	/** Upsert by old id, keeping the newest record for that id. */
	record(oldId: string, record: ConflictRecord): void {
		this.#records.set(oldId, record);
	}

	get(oldId: string): ConflictRecord | undefined {
		return this.#records.get(oldId);
	}

	/** Persist the ledger; `Bun.write` creates parent directories. */
	async flush(): Promise<void> {
		await Bun.write(this.#filePath, JSON.stringify(Object.fromEntries(this.#records), null, "\t"));
	}

	/** Beyond the cap, evict lowest-`at` first (stable sort keeps insertion order on ties). */
	#capOldest(): void {
		const overflow = this.#records.size - MAX_LEDGER_IDS;
		if (overflow <= 0) return;
		const oldest = [...this.#records.entries()]
			.sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at))
			.slice(0, overflow);
		for (const [id] of oldest) this.#records.delete(id);
	}
}
