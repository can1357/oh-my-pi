import type {
	SandboxFileAccess,
	SandboxLayer,
	SandboxNetwork,
	SandboxNetworkAccess,
	SandboxStatus,
	SandboxWriteAccess,
} from "./types";

/** `id`, or `id:role` when the layer names a role. */
export function sandboxLayerLabel(layer: SandboxLayer): string {
	return layer.role ? `${layer.id}:${layer.role}` : layer.id;
}

/** All layers taken together: the strictest answer any layer gives. */
export interface SandboxSummary {
	/** Layer labels outermost first, e.g. `docker + nono:build`; empty when no layer was found. */
	label: string;
	/** `read-only` if any layer says so, else `writable` if any does; layers that report no files do not count. */
	files: SandboxFileAccess;
	/** The most restrictive access a layer reports; absent when no layer reports the network. */
	network?: SandboxNetwork;
}

function stricter(a: SandboxWriteAccess, b: SandboxWriteAccess): SandboxWriteAccess {
	if (a === "read-only" || b === "read-only") return "read-only";
	return a === "writable" || b === "writable" ? "writable" : "unknown";
}

const NETWORK_RANK: Record<SandboxNetworkAccess, number> = { blocked: 0, filtered: 1, open: 2 };

export function summarizeSandbox(status: SandboxStatus): SandboxSummary {
	let files: SandboxFileAccess = { cwd: "unknown", home: "unknown" };
	let network: SandboxNetwork | undefined;
	for (const layer of status.layers) {
		if (layer.files) {
			files = { cwd: stricter(files.cwd, layer.files.cwd), home: stricter(files.home, layer.files.home) };
		}
		if (layer.network && (!network || NETWORK_RANK[layer.network.access] < NETWORK_RANK[network.access])) {
			network = layer.network;
		}
	}
	const label = status.layers.map(sandboxLayerLabel).join(" + ");
	return network ? { label, files, network } : { label, files };
}
