/**
 * Run modes for the coding agent.
 */

import { emergencyTerminalRestore } from "@mariozechner/pi-tui";

/**
 * Install handlers that restore terminal state on crash/signal.
 * Must be called before entering interactive mode.
 */
export function installTerminalCrashHandlers(): void {
	const cleanup = () => {
		emergencyTerminalRestore();
	};

	// Signals
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(128 + 15);
	});
	process.on("SIGHUP", () => {
		cleanup();
		process.exit(128 + 1);
	});

	// Crashes
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

export { InteractiveMode } from "./interactive/interactive-mode.js";
export { runPrintMode } from "./print-mode.js";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.js";
export { runRpcMode } from "./rpc/rpc-mode.js";
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types.js";
