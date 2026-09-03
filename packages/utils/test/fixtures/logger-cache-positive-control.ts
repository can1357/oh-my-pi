import * as fs from "node:fs";
import { RotatingFileSink } from "../../src/logger/rotating-file";
import { snapshotLoggerRuntime } from "./logger-cache-snapshot";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("expected output path");

void RotatingFileSink;
fs.writeFileSync(outputPath, JSON.stringify(snapshotLoggerRuntime()));
