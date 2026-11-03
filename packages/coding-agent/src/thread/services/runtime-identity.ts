/**
 * Build identity across subagent worker links: a worker adopts the main
 * thread's settled runtime identity (`../../session/runtime-identity`) at boot,
 * so every thread stamps the same build and no worker repeats the source
 * checkout's `git diff HEAD` before its first session.
 */
import {
	adoptRuntimeIdentity,
	currentRuntimeIdentity,
	loadRuntimeIdentity,
	type RuntimeIdentity,
} from "../../session/runtime-identity";
import type { ThreadService } from "../services";

/** Boot globals of {@link runtimeIdentityThreadService}. */
export interface RuntimeIdentityGlobals {
	/** Main's identity once its checkout diff was read. */
	readonly identity: Promise<RuntimeIdentity>;
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "version") === "string";
}

/** Hands main's runtime identity to each worker; see the module doc. */
export const runtimeIdentityThreadService: ThreadService = {
	name: "runtime-identity",

	globals(): RuntimeIdentityGlobals {
		return { identity: loadRuntimeIdentity().then(() => currentRuntimeIdentity()) };
	},

	async boot(globals: unknown): Promise<void> {
		const identity: unknown =
			typeof globals === "object" && globals !== null ? await Reflect.get(globals, "identity") : undefined;
		if (!isRuntimeIdentity(identity)) throw new Error("runtime identity service: malformed boot globals");
		adoptRuntimeIdentity(identity);
	},
};
