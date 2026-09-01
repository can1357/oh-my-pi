import type {
	MnemopiBackendConfig,
	MnemopiLlmMode,
	MnemopiProviderOptions,
	MnemopiScoping,
} from "../mnemopi/config";
import type {
	MnemopiMemoryEditOperation,
	MnemopiMemoryEditOptions,
	MnemopiMemoryEditResult,
	MnemopiSessionState,
	MnemopiSessionStateOptions,
} from "../mnemopi/state";

// Persistent project-memory runtime is layered onto the existing memory/session subsystem.
import "../memories/project-memory-runtime";
// Adaptive orchestration coordinates Task 01–07 through existing Agent seams.
import "../orchestration-runtime";

export * from "./local-backend";
export * from "./messages";
export * from "./off-backend";
export * from "./resolve";
export * from "./runtime";
export * from "./types";
export * from "../memories/project-memory";
export { getProjectMemoryTelemetry, getMemoryTelemetry } from "../memories/project-memory-runtime";
export { getOrchestrationState, getOrchestrationDecision } from "../orchestration-runtime";
