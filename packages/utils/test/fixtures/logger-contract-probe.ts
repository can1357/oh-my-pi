import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "../../src/logger";

const scenario = process.argv[2];
const primaryDir = process.argv[3];
const secondaryDir = process.argv[4];
const resultPath = process.argv[5];

if (!scenario || !primaryDir || !secondaryDir || !resultPath) {
	throw new Error("expected scenario, primary directory, secondary directory, and result path");
}

function disableTransports(): void {
	logger.setTransports({ console: false, file: false });
}

function writeResult(value: unknown): void {
	fs.writeFileSync(resultPath, JSON.stringify(value));
}

switch (scenario) {
	case "matrix": {
		logger.setTransports({ console: false, file: primaryDir });
		logger.error("level-error", { ordinal: 1 });
		logger.warn("level-warn", { ordinal: 2 });
		logger.info("level-info", { ordinal: 3 });
		logger.debug("level-debug", { ordinal: 4 });

		const hidden = Symbol("hidden");
		const context: Record<string, unknown> & { [hidden]?: unknown } = {
			stringValue: "text",
			numberValue: 7,
			booleanValue: false,
			nullValue: null,
			nested: { alpha: "a", values: [1, undefined, () => "omitted", Number.NaN] },
			undefinedValue: undefined,
			functionValue: () => "omitted",
			infinity: Number.POSITIVE_INFINITY,
			nan: Number.NaN,
		};
		context[hidden] = "omitted";
		logger.info("context-matrix", context);
		logger.warn("reserved-primary", {
			before: "first",
			message: "metadata-message",
			level: "context-level",
			timestamp: "context-timestamp",
			after: "last",
		});
		logger.debug("reserved-falsy", { message: "", after: true });

		const cause = new Error("downstream");
		cause.stack = "CAUSE_STACK";
		const error = new Error("upstream", { cause }) as Error & { code: string; detail: { retry: boolean } };
		error.name = "CustomError";
		error.stack = "OUTER_STACK";
		error.code = "E_FIXTURE";
		error.detail = { retry: false };
		logger.error("error-matrix", { error });
		disableTransports();
		break;
	}
	case "format-tokens": {
		logger.setTransports({ console: false, file: primaryDir });
		for (const token of ["s", "c", "d", "j", "i", "f", "o", "O", "%"]) {
			logger.info(`token-%${token}`, { value: 7 });
		}
		logger.info("non-token-%q", { value: 7 });
		interface TokenCircularContext extends Record<string, unknown> {
			self?: TokenCircularContext;
		}
		const circular: TokenCircularContext = { kind: "circular" };
		circular.self = circular;
		logger.info("circular-%s", circular);
		logger.info("bigint-%d", { value: 1n });
		disableTransports();
		break;
	}
	case "serialization-failures": {
		logger.setTransports({ console: false, file: primaryDir });
		interface CircularContext extends Record<string, unknown> {
			self?: CircularContext;
		}
		const circular: CircularContext = { kind: "circular" };
		circular.self = circular;
		const bigintContext: Record<string, unknown> = { value: 1n };
		const expectedContexts: Record<string, unknown>[] = [circular, bigintContext];
		const events: Array<{ level: logger.LogLevel; message: string; sameContext: boolean; timestamp: string }> = [];
		const dispose = logger.registerLogSink(event => {
			const expected = expectedContexts[events.length];
			events.push({
				level: event.level,
				message: event.message,
				sameContext: event.context === expected,
				timestamp: event.timestamp.toISOString(),
			});
		});
		logger.info("circular-drop", circular);
		logger.error("bigint-drop", bigintContext);
		dispose();
		disableTransports();
		writeResult({ events });
		break;
	}
	case "default-file":
		logger.info("mode-default", { mode: "default" });
		disableTransports();
		break;
	case "file-only":
		logger.setTransports({ console: false, file: primaryDir });
		logger.info("mode-file", { mode: "file" });
		disableTransports();
		break;
	case "console-only":
		logger.setTransports({ console: true, file: false });
		logger.info("mode-console", { mode: "console" });
		disableTransports();
		break;
	case "both":
		logger.setTransports({ console: true, file: primaryDir });
		logger.info("mode-both", { mode: "both" });
		disableTransports();
		break;
	case "disabled-reenable": {
		const contexts: Record<string, unknown>[] = [];
		const disabledContext = { mode: "disabled" };
		const dispose = logger.registerLogSink(event => {
			if (event.context) contexts.push(event.context);
		});
		const setReturn = logger.setTransports({ console: false, file: false });
		const logReturn = logger.warn("mode-disabled", disabledContext);
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("mode-reenabled", { mode: "file" });
		const disposeReturn = dispose();
		disableTransports();
		writeResult({
			disabledSinkSameContext: contexts[0] === disabledContext,
			sinkCount: contexts.length,
			returnsUndefined: setReturn === undefined && logReturn === undefined && disposeReturn === undefined,
		});
		break;
	}
	case "reconfigure":
		logger.setTransports({ console: false, file: primaryDir });
		logger.info("directory-a", { destination: "a" });
		logger.setTransports({ console: false, file: secondaryDir });
		logger.info("directory-b", { destination: "b" });
		disableTransports();
		break;
	case "reconfigure-failure": {
		logger.setTransports({ console: false, file: primaryDir });
		logger.info("before-failed-reconfigure");
		const blockerPath = path.join(secondaryDir, "not-a-directory");
		fs.writeFileSync(blockerPath, "blocked");
		let reconfigureThrew = false;
		try {
			logger.setTransports({ console: false, file: path.join(blockerPath, "child") });
		} catch {
			reconfigureThrew = true;
		}
		const sinkContext = { after: "failure" };
		let sinkSameContext = false;
		let sinkCount = 0;
		const dispose = logger.registerLogSink(event => {
			sinkCount++;
			sinkSameContext = event.context === sinkContext;
		});
		logger.info("after-failed-reconfigure", sinkContext);
		dispose();
		await Bun.sleep(20);
		writeResult({ reconfigureThrew, sinkCount, sinkSameContext });
		break;
	}
	case "burst-close":
		logger.setTransports({ console: false, file: primaryDir });
		for (let index = 0; index < 1_000; index++) logger.info("burst-close", { index });
		disableTransports();
		break;
	case "burst-natural":
		logger.setTransports({ console: false, file: primaryDir });
		for (let index = 0; index < 1_000; index++) logger.info("burst-natural", { index });
		break;
	case "sink-order": {
		logger.setTransports({ console: true, file: false });
		const sinkContext = { identity: "same" };
		const dispose = logger.registerLogSink(event => {
			process.stdout.write(`SINK:${event.context === sinkContext}\n`);
			throw new Error("sink failure must be isolated");
		});
		logger.info("sink-first", sinkContext);
		dispose();
		logger.info("sink-disposed");
		disableTransports();
		break;
	}
	case "date-retention": {
		const dates = [
			"2026-01-02T03:04:05.006Z",
			"2026-01-03T03:04:05.006Z",
			"2026-01-04T03:04:05.006Z",
			"2026-01-05T03:04:05.006Z",
			"2026-01-06T03:04:05.006Z",
			"2026-01-07T03:04:05.006Z",
		];
		process.env.OMP_LOGGER_TEST_NOW = dates[0];
		logger.setTransports({ console: false, file: primaryDir });
		for (const [index, date] of dates.entries()) {
			process.env.OMP_LOGGER_TEST_NOW = date;
			logger.info(`date-${index + 1}`);
			await Bun.sleep(10);
		}
		disableTransports();
		break;
	}
	case "size-rotation":
		logger.setTransports({ console: false, file: primaryDir });
		logger.info("size-nine-mib", { payload: "x".repeat(9 * 1024 * 1024) });
		logger.info("size-half-mib", { payload: "y".repeat(512 * 1024) });
		logger.info("size-crosses-ten-mib", { payload: "z".repeat(1024 * 1024) });
		logger.info("rotation-trigger");
		disableTransports();
		break;
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}
