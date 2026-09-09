import { isRecord, readLines } from "@oh-my-pi/pi-utils";

/** One readable object record from a foreign JSONL transcript. */
export interface ForeignJsonRecord {
	readonly value: Record<string, unknown>;
	readonly line: number;
}

/** Stream valid object records while tolerating malformed or truncated lines. */
export async function* readForeignJsonRecords(filePath: string): AsyncGenerator<ForeignJsonRecord> {
	const decoder = new TextDecoder();
	let line = 0;
	for await (const bytes of readLines(Bun.file(filePath).stream())) {
		line += 1;
		try {
			const value: unknown = JSON.parse(decoder.decode(bytes));
			if (isRecord(value)) yield { value, line };
		} catch {
			// A partially-written line must not hide the readable transcript prefix.
		}
	}
}

/** Read every valid object record from a foreign JSONL transcript. */
export async function collectForeignJsonRecords(filePath: string): Promise<ForeignJsonRecord[]> {
	const records: ForeignJsonRecord[] = [];
	for await (const record of readForeignJsonRecords(filePath)) records.push(record);
	return records;
}
