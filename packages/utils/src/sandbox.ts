/**
 * Sandbox detection: kernel facts measured on this process, and the named sandboxes (layers) that probes
 * recognize. Detection only; nothing here changes behavior.
 */
export * from "./sandbox/detector";
export * from "./sandbox/facts";
export * from "./sandbox/host";
export * from "./sandbox/probes/builtin";
export * from "./sandbox/probes/docker";
export * from "./sandbox/probes/k8s";
export * from "./sandbox/probes/nono";
export * from "./sandbox/probes/podman";
export * from "./sandbox/summary";
export * from "./sandbox/types";
