import * as fs from "node:fs";
import * as logger from "../../src/logger";
import { snapshotLoggerRuntime } from "./logger-cache-snapshot";

const scenario = process.argv[2];
const outputPath = process.argv[3];
const logsDir = process.argv[4];

if (!scenario || !outputPath) throw new Error("expected scenario and output path");

switch (scenario) {
	case "import":
		break;
	case "console":
		logger.setTransports({ console: true, file: false });
		logger.info("logger-cache-console");
		logger.setTransports({ console: false, file: false });
		break;
	case "file":
		if (!logsDir) throw new Error("file scenario requires logs directory");
		logger.setTransports({ console: false, file: logsDir });
		logger.info("logger-cache-file");
		logger.setTransports({ console: false, file: false });
		break;
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}

fs.writeFileSync(outputPath, JSON.stringify(snapshotLoggerRuntime()));
