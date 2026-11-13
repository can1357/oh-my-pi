/**
 * Builds one Spotlight dashboard for the stats server, then is terminated. A build reads every experiment session and
 * takes seconds; on the server's thread it held every other request and ingest until it ended.
 *
 * The worker opens the database read-only and builds inside one read transaction, so the payload is a single snapshot
 * while the server keeps ingesting. A `{ kind: "ping" }` request replies `{ ok: true, kind: "pong" }` for
 * `smokeTestSpotlightWorker`, which proves the worker loads in compiled binaries and the npm bundle.
 */

import { Database } from "bun:sqlite";
import { spotlightDashboard } from "./spotlight-aggregator";

export type SpotlightWorkerRequest =
	| { kind: "build"; dbPath: string; range: string | null; agent: string | null }
	| { kind: "ping" };

export type SpotlightWorkerResponse =
	| { ok: true; kind: "build"; json: string }
	| { ok: true; kind: "pong" }
	| { ok: false; error: string };

declare const self: Worker & {
	onmessage: ((event: MessageEvent<SpotlightWorkerRequest>) => void) | null;
};

self.onmessage = event => {
	const request = event.data;
	if (request.kind === "ping") {
		self.postMessage({ ok: true, kind: "pong" } satisfies SpotlightWorkerResponse);
		return;
	}
	try {
		const database = new Database(request.dbPath, { readonly: true });
		try {
			database.run("PRAGMA busy_timeout = 5000");
			const stats = database.transaction(() => spotlightDashboard(database, request.range, request.agent))();
			self.postMessage({ ok: true, kind: "build", json: JSON.stringify(stats) } satisfies SpotlightWorkerResponse);
		} finally {
			database.close();
		}
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		self.postMessage({ ok: false, error } satisfies SpotlightWorkerResponse);
	}
};
