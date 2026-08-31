import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import { ASSIGNMENT_TOOL_WORKER_ARG, ASSIGNMENT_TOOL_WORKER_SCHEMA } from "./tool-worker-protocol";

const MAX_SMOKE_REQUEST_BYTES = 1024;

type JsonRecord = Record<string, unknown>;

function closedRecord(value: unknown, fields: readonly string[]): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("assignment worker smoke failed: response was not an object");
	}
	const record = value as JsonRecord;
	const keys = Object.keys(record);
	if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
		throw new Error("assignment worker smoke failed: response was not closed");
	}
	return record;
}

function validateDenial(source: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error("assignment worker smoke failed: response was not JSON");
	}
	const response = closedRecord(parsed, ["schema", "requestId", "ok", "error"]);
	if (response.schema !== ASSIGNMENT_TOOL_WORKER_SCHEMA || response.requestId !== "smoke" || response.ok !== false) {
		throw new Error("assignment worker smoke failed: response was not a correlated worker denial");
	}
	const error = closedRecord(response.error, ["code", "message"]);
	if (error.code !== "INVALID_SCHEMA" || typeof error.message !== "string" || error.message.length === 0) {
		throw new Error("assignment worker smoke failed: invalid-schema denial was malformed");
	}
}

/** Exercise the assignment selector without requiring a live Assignment capability. */
export async function smokeTestAssignmentToolWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const request = JSON.stringify({
		schema: "juiz.assignment-tool-worker/smoke-invalid",
		requestId: "smoke",
		attempt: null,
		operationCredential: "",
		tool: "",
		effectiveArgs: null,
		logicalPathMapping: null,
		projection: "",
	});
	if (Buffer.byteLength(request) > MAX_SMOKE_REQUEST_BYTES) {
		throw new Error("assignment worker smoke failed: invalid request exceeded its bound");
	}

	const spawn = resolveWorkerSpawnCmd(ASSIGNMENT_TOOL_WORKER_ARG);
	const proc = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);

	try {
		proc.stdin.write(request);
		proc.stdin.end();
		const outcome = await Promise.race([proc.exited, timeout.promise]);
		if (outcome === "timeout") {
			throw new Error(`assignment worker smoke failed: selector did not deny within ${timeoutMs}ms`);
		}
		const [response, diagnostics] = await Promise.all([stdout, stderr]);
		if (outcome !== 1) {
			throw new Error(
				`assignment worker smoke failed: expected denial exit 1, got ${outcome} (${diagnostics.slice(-500) || "no stderr"})`,
			);
		}
		validateDenial(response);
	} finally {
		clearTimeout(timer);
		try {
			proc.stdin.end();
		} catch {
			// Already closed.
		}
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already exited.
			}
		}
		await Promise.allSettled([proc.exited, stdout, stderr]);
	}
}
