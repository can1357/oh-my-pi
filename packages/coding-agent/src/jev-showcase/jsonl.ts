import * as fs from "node:fs";
import * as path from "node:path";

/** Load completed cell keys from a resume-safe results.jsonl file. */
export function loadCompletedKeys(resultsPath: string, keyFn: (row: Record<string, unknown>) => string): Set<string> {
	const done = new Set<string>();
	if (!fs.existsSync(resultsPath)) return done;
	for (const line of fs.readFileSync(resultsPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			done.add(keyFn(JSON.parse(line) as Record<string, unknown>));
		} catch {
			// skip corrupt lines
		}
	}
	return done;
}

/** Append one JSON object as a line; creates parent dirs. */
export function appendJsonl(resultsPath: string, row: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
	fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
}

/** Read all rows from jsonl paths. */
export function readJsonl(paths: string[]): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const p of paths) {
		if (!fs.existsSync(p)) continue;
		for (const line of fs.readFileSync(p, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// skip
			}
		}
	}
	return rows;
}
