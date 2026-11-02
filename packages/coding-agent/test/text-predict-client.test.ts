import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import * as launchClient from "../src/launch/client";
import { closeTextPrediction, requestTextPrediction } from "../src/predict/client";
import { type TextPredictRequest, type TextPredictResponse, textPredictDaemon } from "../src/predict/protocol";
import { rejectionOf } from "./helpers/rejection";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	closeTextPrediction();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Serve the text-predict endpoint as a daemon of `version` and route the
 * client's broker to a stand-in that knows no daemons, so the client can only
 * use this daemon or fail. Returns the ops the daemon received.
 */
async function serveDaemon(version: string): Promise<string[]> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-text-predict-client-"));
	const received: string[] = [];
	const server = await IpcServer.listen(
		textPredictDaemon(runtimeDir, getAgentDir()).endpoint,
		{ framing: "lines" },
		connection => {
			connection.start(
				line => {
					const request = JSON.parse(line) as TextPredictRequest;
					received.push(request.op);
					const response: TextPredictResponse =
						request.op === "ping"
							? { id: request.id, ok: true, op: "ping", version, pid: process.pid, engines: [] }
							: request.op === "complete"
								? { id: request.id, ok: true, op: "complete", suggestion: { suffix: "ady", confidence: 0.9 } }
								: request.op === "shutdown"
									? { id: request.id, ok: true, op: "shutdown" }
									: { id: request.id, ok: false, error: `unexpected ${request.op}` };
					connection.send(JSON.stringify(response));
				},
				() => {},
			);
		},
	);
	vi.spyOn(launchClient, "daemonClientForGlobal").mockResolvedValue({
		projectDir: runtimeDir,
		onCompletion: () => () => {},
		request: async operation => {
			if (operation.op === "ping") return { op: "ping", projectDir: runtimeDir };
			throw new launchClient.DaemonBrokerRejectedError(`no daemon ${operation.op} in this test`);
		},
		close: () => {},
	});
	cleanups.push(async () => {
		await server.close();
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});
	return received;
}

describe("text-predict client against a daemon from another omp version", () => {
	it("uses a daemon from a newer omp instead of shutting it down", async () => {
		// After an in-place upgrade, a session still running the old build must not
		// stop the daemon every session on the new build is using.
		const [major] = VERSION.split(".");
		const received = await serveDaemon(`${Number(major) + 1}.0.0`);

		const prediction = await requestTextPrediction("ngram", "please ", "re");

		expect(prediction).toEqual({ engine: "ngram", suggestion: { suffix: "ady", confidence: 0.9 } });
		expect(received).toEqual(["ping", "complete"]);
	});

	it("shuts down a daemon from an older omp so this version's can start", async () => {
		const received = await serveDaemon("0.0.1");

		const error = await rejectionOf(requestTextPrediction("ngram", "please ", "re"));
		expect(error).toMatchObject({ message: "text-predict daemon did not start" });
		expect(received).toContain("shutdown");
		expect(received).not.toContain("complete");
	});
});
