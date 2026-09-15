/**
 * Interactive mode and embeddable RPC client exports for the coding agent.
 *
 * Branch-specific runners live in their concrete modules so importing this
 * barrel does not pull print, RPC server, or ACP server mode into the normal
 * TUI graph.
 */
export * from "./composer";
export * from "./interactive-mode";
export * from "./rpc/rpc-client";
export * from "./rpc/rpc-types";

// planSaveFileName moved to plan-mode/plan-autosave; preserved here so its
// pre-existing barrel reachability survives the move.
export { planSaveFileName } from "../plan-mode/plan-autosave";
