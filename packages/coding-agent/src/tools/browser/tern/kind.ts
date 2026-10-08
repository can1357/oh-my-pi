/**
 * Tern mode: when omp runs inside a Tern pane (Tern exports `TERN_PANE_SOCKET`
 * and `TERN_PANE` into every pane), browser tabs open as browser
 * picture-in-pictures floating over omp's own pane and every tab helper drives
 * that PiP's native web view through the Tern daemon (`wire.ts`).
 */
import { parseFlag } from "@oh-my-pi/pi-utils";

/** The Tern pane omp runs in. */
export interface TernPane {
	/** The Tern daemon socket (`TERN_PANE_SOCKET`). */
	socketPath: string;
	/** The pane omp runs in (`TERN_PANE`), which owns the PiPs. */
	pane: number;
}

/** Browser kind selecting a Tern browser PiP. */
export interface TernKind extends TernPane {
	kind: "tern";
}

/** The Tern pane omp runs in, or null outside Tern (`TERN_PANE_SOCKET` unset or `TERN_PANE` not a block id). */
export function resolveTernPane(env: Record<string, string | undefined> = process.env): TernPane | null {
	const socketPath = env.TERN_PANE_SOCKET?.trim();
	const pane = env.TERN_PANE?.trim();
	if (!socketPath || !pane || !/^\d+$/.test(pane)) return null;
	const id = Number(pane);
	if (!Number.isSafeInteger(id)) return null;
	return { socketPath, pane: id };
}

/** Inputs of {@link resolveTernKind}. */
export interface ResolveTernKindOptions {
	/** `browser.tern` setting (default true); `PI_BROWSER_TERN=0|1` overrides it. */
	settingEnabled?: boolean;
}

/**
 * Resolve the Tern browser kind, or null when omp is not in a Tern pane or
 * Tern mode is off. Mirrors `resolveCmuxKind`: the setting opts in, the env
 * var is the final override in both directions.
 */
export function resolveTernKind(
	options?: ResolveTernKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): TernKind | null {
	if (!parseFlag(env.PI_BROWSER_TERN, options?.settingEnabled ?? true)) return null;
	const pane = resolveTernPane(env);
	return pane && { kind: "tern", ...pane };
}
