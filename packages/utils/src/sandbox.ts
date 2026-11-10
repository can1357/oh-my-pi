/**
 * Sandbox detection: kernel facts measured on this process, and the named sandboxes (layers) that probes
 * recognize. Detection only; nothing here changes behavior.
 */
export * from "./sandbox/detector";
export * from "./sandbox/facts";
export * from "./sandbox/host";
export * from "./sandbox/probes";
export * from "./sandbox/summary";
export * from "./sandbox/types";
