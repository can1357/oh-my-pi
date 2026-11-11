import type { SandboxProbe } from "../types";
import { declared } from "./shared";

/**
 * A Docker container: `/.dockerenv`, or PID 1's cgroup path names docker. Containerd and CRI containers (most
 * Kubernetes pods) have neither marker, so they are not called docker. Declared.
 */
export const dockerProbe: SandboxProbe = {
	id: "docker",
	detect(host) {
		if (host.platform !== "linux") return undefined;
		if (host.exists("/.dockerenv")) return declared("docker", "/.dockerenv present");
		if (/\bdocker\b/.test(host.readFile("/proc/1/cgroup") ?? "")) {
			return declared("docker", "/proc/1/cgroup names docker");
		}
		return undefined;
	},
};
