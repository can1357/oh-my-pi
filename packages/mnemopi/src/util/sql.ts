const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a single SQLite identifier segment before it is used in generated SQL. */
export function assertSqlIdentifier(identifier: string): string {
	if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`Invalid SQL identifier: ${identifier}`);
	return identifier;
}

/** Validate and quote one SQLite identifier segment. */
export function quoteSqlIdentifier(identifier: string): string {
	return `"${assertSqlIdentifier(identifier)}"`;
}

/** Validate and quote a dotted SQLite identifier such as schema.table or alias.column. */
export function quoteSqlQualifiedIdentifier(...identifiers: readonly string[]): string {
	if (identifiers.length === 0) throw new Error("SQL qualified identifier requires at least one segment");
	return identifiers.map(quoteSqlIdentifier).join(".");
}
