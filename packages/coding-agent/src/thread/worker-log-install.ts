/**
 * First import of the subagent worker entry: routes this worker's log records to
 * the main thread (`./worker-log`) before any other module of the entry's graph
 * evaluates, so no record ever reaches the worker's own logger.
 */
import { parentPort } from "node:worker_threads";
import { installWorkerLogPort } from "./worker-log";

if (parentPort) installWorkerLogPort(parentPort);
