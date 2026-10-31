import { runSqliteRead } from "./read-sqlite";
import type { SqliteReadWorkerRequest, SqliteReadWorkerResponse } from "./sqlite-read-worker-client";
import { toWorkerErrorPayload } from "./tool-errors";

/** Own a query-only connection in a process the read caller can hard-kill. */
export function startSqliteReadWorker(transport: {
	send(message: SqliteReadWorkerResponse): void;
	onMessage(handler: (message: SqliteReadWorkerRequest) => void): () => void;
}): void {
	transport.onMessage(message => {
		void (async () => {
			let response: SqliteReadWorkerResponse;
			try {
				response = { ok: true, result: await runSqliteRead(message.path) };
			} catch (error) {
				response = { ok: false, error: toWorkerErrorPayload(error) };
			}
			transport.send(response);
		})();
	});
}
