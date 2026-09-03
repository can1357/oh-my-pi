import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Regression: Errors logged via `logger.error("msg", { err })` previously
 * serialized to `"err":{}` because Error's own properties are non-enumerable.
 * The replacer in `logFormat` must unwrap Error instances so `name`, `message`,
 * `stack`, and custom enumerable fields all reach the rotating log.
 */

let tempDir: string;
let prevAgentDir: string | undefined;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-logger-error-"));
	// `getLogsDir()` honors OMP_AGENT_DIR / HOME for its base; pin to our tmp.
	// Restore only this key on teardown — reassigning `process.env` wholesale
	// would replace the live binding with a plain object, diverging it from
	// `Bun.env` and poisoning every env-reading test that runs afterwards.
	prevAgentDir = process.env.OMP_AGENT_DIR;
	process.env.OMP_AGENT_DIR = tempDir;
	logger.setTransports({ file: tempDir, console: false });
});

afterAll(() => {
	if (prevAgentDir === undefined) {
		delete process.env.OMP_AGENT_DIR;
	} else {
		process.env.OMP_AGENT_DIR = prevAgentDir;
	}
	logger.setTransports({ file: false, console: false });
	fs.rmSync(tempDir, { force: true, recursive: true });
});

/**
 * Poll the rotating log file until an entry whose `message` field equals
 * `targetMessage` appears. Winston's DailyRotateFile flushes asynchronously,
 * so single-shot reads race the write.
 */
async function waitForLogEntry(targetMessage: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 40; i++) {
		const files = fs.readdirSync(tempDir).filter(f => f.startsWith("omp.") && f.endsWith(".log"));
		for (const f of files) {
			const text = fs.readFileSync(path.join(tempDir, f), "utf8");
			for (const line of text.split("\n")) {
				if (line.length === 0) continue;
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Torn tail of an in-flight write; the line completes on a later poll.
					continue;
				}
				if (entry.message === targetMessage) return entry;
			}
		}
		await Bun.sleep(25);
	}
	throw new Error(`no log entry with message=${targetMessage} observed`);
}

describe("logger error serialization", () => {
	it("unwraps Error.message, Error.stack, and Error.name", async () => {
		const err = new Error("boom message");
		logger.error("test-error-fixture-msg", { err });

		const entry = await waitForLogEntry("test-error-fixture-msg");
		const serializedErr = entry.err as { name?: string; message?: string; stack?: string };
		expect(serializedErr.name).toBe("Error");
		expect(serializedErr.message).toBe("boom message");
		expect(serializedErr.stack).toContain("boom message");
		expect(serializedErr.stack).toContain("at ");
	});

	it("preserves Error.cause and custom enumerable fields", async () => {
		const cause = new Error("downstream");
		const err = new Error("upstream", { cause }) as Error & { code: string };
		err.code = "E_REGRESSION";
		logger.error("test-error-fixture-cause", { err });

		const entry = await waitForLogEntry("test-error-fixture-cause");
		const serializedErr = entry.err as { message?: string; code?: string; cause?: { message?: string } };
		expect(serializedErr.message).toBe("upstream");
		expect(serializedErr.code).toBe("E_REGRESSION");
		expect(serializedErr.cause?.message).toBe("downstream");
	});
});
