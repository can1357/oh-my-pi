/**
 * Exa Error Logger
 *
 * Append-only logging to ~/.pi/ for debugging production issues.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME } from "../../../config.js";

/** Get the base config directory (e.g., ~/.pi/) */
function getConfigDir(): string {
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Log file paths */
const LOG_FILES = {
	exa: "exa_errors.log",
	view: "view_errors.log",
} as const;

type LogType = keyof typeof LOG_FILES;

/** Format a log entry with timestamp */
function formatEntry(message: string, context?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	const contextStr = context ? ` ${JSON.stringify(context)}` : "";
	return `[${timestamp}] ${message}${contextStr}\n`;
}

/** Append to log file (creates directory if needed) */
export function logError(type: LogType, message: string, context?: Record<string, unknown>): void {
	try {
		const configDir = getConfigDir();
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}

		const logPath = join(configDir, LOG_FILES[type]);
		const entry = formatEntry(message, context);
		appendFileSync(logPath, entry);
	} catch {
		// Silently ignore logging failures - we don't want to break tool execution
	}
}

/** Log MCP fetch/call errors */
export function logExaError(message: string, context?: Record<string, unknown>): void {
	logError("exa", message, context);
}

/** Log render/view errors */
export function logViewError(message: string, context?: Record<string, unknown>): void {
	logError("view", message, context);
}
