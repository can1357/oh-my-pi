/**
 * Short-lived infer client for the issue #12067 regression in
 * `test/daemon/infer-module.test.ts`: sends one request whose reply the fake
 * worker delays, prints the reply, and never closes anything. The process must
 * stay alive for the reply, then exit on its own.
 *
 * Env: `FAKE_JSONL_WORKER` (worker script path), `OMP_DAEMON_DIR` (isolated daemon).
 */
import * as path from "node:path";
import { InferConnection } from "../../src/daemon/modules/infer";

const worker = process.env.FAKE_JSONL_WORKER;
if (!worker) throw new Error("FAKE_JSONL_WORKER is required");

const connection = new InferConnection<
	{ type: "echo"; id: string; text: string; delayMs: number },
	{ type: string; id?: string; text?: string; error?: string }
>(
	async () => ({
		key: "embed:issue-12067",
		params: {
			worker: "embed",
			label: "issue-12067 fake worker",
			application: process.execPath,
			args: [worker],
			cwd: path.dirname(worker),
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
		},
	}),
	message => {
		if (message.id === "late") console.log(JSON.stringify(message));
	},
	error => {
		console.error(`connection closed: ${error.message}`);
		process.exitCode = 1;
	},
);
connection.send({ type: "echo", id: "late", text: "reply after delay", delayMs: 750 });
