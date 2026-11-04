/**
 * Build identity across subagent worker links: a worker adopts the main
 * thread's runtime identity (`../../session/runtime-identity`) at boot,
 * so every thread stamps the same build.
 */
import { adoptRuntimeIdentity, currentRuntimeIdentity, type RuntimeIdentity } from "../../session/runtime-identity";
import type { ThreadService } from "../services";

/** Boot globals of {@link runtimeIdentityThreadService}. */
export interface RuntimeIdentityGlobals {
	/** Main's build identity. */
	readonly identity: RuntimeIdentity;
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "version") === "string";
}

/** Hands main's runtime identity to each worker; see the module doc. */
export const runtimeIdentityThreadService: ThreadService = {
	name: "runtime-identity",

	globals(): RuntimeIdentityGlobals {
		return { identity: currentRuntimeIdentity() };
	},

	boot(globals: unknown): void {
		const identity: unknown =
			typeof globals === "object" && globals !== null ? Reflect.get(globals, "identity") : undefined;
		if (!isRuntimeIdentity(identity)) throw new Error("runtime identity service: malformed boot globals");
		adoptRuntimeIdentity(identity);
	},
};
