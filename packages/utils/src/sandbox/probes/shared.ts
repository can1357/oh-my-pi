import type { SandboxLayer } from "../types";

export function declared(id: string, evidence: string): SandboxLayer {
	return { id, basis: "declared", restrictions: [], evidence: [evidence] };
}
