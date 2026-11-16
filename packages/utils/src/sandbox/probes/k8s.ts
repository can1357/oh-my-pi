import type { SandboxProbe } from "../types";
import { declared } from "./shared";

/** A Kubernetes pod: the service env and the mounted service account. Declared. */
export const k8sProbe: SandboxProbe = {
	id: "k8s",
	detect(host) {
		if (host.platform !== "linux" || !host.env.KUBERNETES_SERVICE_HOST) return undefined;
		if (!host.exists("/var/run/secrets/kubernetes.io/serviceaccount")) return undefined;
		return declared("k8s", "KUBERNETES_SERVICE_HOST set and a service account mounted");
	},
};
