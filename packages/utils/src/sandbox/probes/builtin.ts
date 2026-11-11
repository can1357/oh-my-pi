import { dockerProbe } from "./docker";
import { k8sProbe } from "./k8s";
import { nonoProbe } from "./nono";
import { podmanProbe } from "./podman";
import type { SandboxProbe } from "../types";

/** Outermost first: a pod wraps a container, which may run nono. */
export const BUILTIN_SANDBOX_PROBES: readonly SandboxProbe[] = [k8sProbe, dockerProbe, podmanProbe, nonoProbe];
