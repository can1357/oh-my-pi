import type { SandboxProbe } from "../types";
import { declared } from "./shared";

/** A Podman container: `/run/.containerenv`. Declared. */
export const podmanProbe: SandboxProbe = {
	id: "podman",
	detect(host) {
		if (host.platform !== "linux" || !host.exists("/run/.containerenv")) return undefined;
		return declared("podman", "/run/.containerenv present");
	},
};
