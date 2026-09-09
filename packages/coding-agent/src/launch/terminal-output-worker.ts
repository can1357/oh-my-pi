import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { renderTerminalOutput } from "./terminal-output";
import type { TerminalOutputWorkerRequest, TerminalOutputWorkerResult } from "./terminal-output-worker-protocol";

if (!parentPort) throw new Error("terminal-output-worker: missing parentPort");

const port = parentPort;
const inbox = consumeWorkerInbox();
const handle = async (message: unknown): Promise<void> => {
	const request = message as TerminalOutputWorkerRequest;
	let result: TerminalOutputWorkerResult;
	try {
		result = { ok: true, rows: await renderTerminalOutput(request.output, request.options) };
	} catch (error) {
		result = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	port.postMessage(result);
	port.close();
};

if (inbox) inbox.bind(message => void handle(message));
else port.on("message", message => void handle(message));
