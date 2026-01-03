/**
 * Centralized file logger for omp.
 *
 * Logs to ~/.omp/logs/ with size-based rotation, supporting concurrent omp instances.
 * Each log entry includes process.pid for traceability.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { CONFIG_DIR_NAME } from "../config";

/** Get the logs directory (~/.omp/logs/) */
function getLogsDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "logs");
}

/** Ensure logs directory exists */
function ensureLogsDir(): string {
	const logsDir = getLogsDir();
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
	}
	return logsDir;
}

/** Custom format that includes pid and flattens metadata */
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		const entry: Record<string, unknown> = {
			timestamp,
			level,
			pid: process.pid,
			message,
		};
		// Flatten metadata into entry
		for (const [key, value] of Object.entries(meta)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") {
				entry[key] = value;
			}
		}
		return JSON.stringify(entry);
	}),
);

/** Size-based rotating file transport */
const fileTransport = new DailyRotateFile({
	dirname: ensureLogsDir(),
	filename: "omp.%DATE%.log",
	datePattern: "YYYY-MM-DD",
	maxSize: "10m",
	maxFiles: 5,
	zippedArchive: true,
});

/** The winston logger instance */
const winstonLogger = winston.createLogger({
	level: "debug",
	format: logFormat,
	transports: [fileTransport],
	// Don't exit on error - logging failures shouldn't crash the app
	exitOnError: false,
});

/** Logger type exposed to plugins and internal code */
export interface Logger {
	error(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Centralized logger for omp.
 *
 * Logs to ~/.omp/logs/omp.YYYY-MM-DD.log with size-based rotation.
 * Safe for concurrent access from multiple omp instances.
 *
 * @example
 * ```typescript
 * import { logger } from "../core/logger";
 *
 * logger.error("MCP request failed", { url, method });
 * logger.warn("Theme file invalid, using fallback", { path });
 * logger.debug("LSP fallback triggered", { reason });
 * ```
 */
export const logger: Logger = {
	error(message: string, context?: Record<string, unknown>): void {
		try {
			winstonLogger.error(message, context);
		} catch {
			// Silently ignore logging failures
		}
	},
	warn(message: string, context?: Record<string, unknown>): void {
		try {
			winstonLogger.warn(message, context);
		} catch {
			// Silently ignore logging failures
		}
	},
	debug(message: string, context?: Record<string, unknown>): void {
		try {
			winstonLogger.debug(message, context);
		} catch {
			// Silently ignore logging failures
		}
	},
};
