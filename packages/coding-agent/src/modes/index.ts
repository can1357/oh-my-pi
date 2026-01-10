/**
 * Run modes for the coding agent.
 */

import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui";
import { runAsyncCleanup } from "./cleanup";

/**
 * Install handlers that restore terminal state on crash/signal.
 * Must be called before entering interactive mode.
 */
export function installTerminalCrashHandlers(): void {
	const cleanup = () => {
		emergencyTerminalRestore();
	};

	// Signals - run async cleanup before exit
	process.on("SIGINT", () => {
		cleanup();
		void runAsyncCleanup().finally(() => process.exit(128 + 2));
	});
	process.on("SIGTERM", () => {
		cleanup();
		void runAsyncCleanup().finally(() => process.exit(128 + 15));
	});
	process.on("SIGHUP", () => {
		cleanup();
		void runAsyncCleanup().finally(() => process.exit(128 + 1));
	});

	// Crashes - exit immediately (async cleanup may not be safe in corrupted state)
	process.on("uncaughtException", (err) => {
		cleanup();
		console.error("Uncaught exception:", err);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		cleanup();
		console.error("Unhandled rejection:", reason);
		process.exit(1);
	});
}

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client";
export { runRpcMode } from "./rpc/rpc-mode";
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types";
