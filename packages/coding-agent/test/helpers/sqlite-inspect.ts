import { Database } from "bun:sqlite";

export function readTableSql(dbPath: string, tableName: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
			| { sql?: string | null }
			| undefined;
		return row?.sql ?? null;
	} finally {
		db.close();
	}
}
