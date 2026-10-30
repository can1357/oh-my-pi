/** Control requests understood by every machine-shared worker. */
export type SharedWorkerControl = { type: "ping"; id: string } | { type: "shutdown"; id: string };

/** Launch identity echoed by a shared worker so clients can detect a stale version. */
export type SharedWorkerPong = { type: "pong"; id: string; tag: string };
