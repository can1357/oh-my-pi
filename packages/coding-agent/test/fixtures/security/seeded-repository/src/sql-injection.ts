export interface QueryClient {
	query(sql: string): Promise<unknown>;
}

export function findAccount(client: QueryClient, accountName: string): Promise<unknown> {
	// Deliberately vulnerable fixture: untrusted input is concatenated into SQL.
	return client.query(`SELECT * FROM accounts WHERE name = '${accountName}'`);
}
