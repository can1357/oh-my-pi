/**
 * Fingerprint-bound resource exclusions applied to extension/package discovery.
 *
 * `diagnostics.resourceExclusions` records resource roots the user reviewed and
 * chose to hide in OMP (see `extensibility/resource-decisions.ts`). Only the
 * user's global configuration can carry such a decision
 * (`cfgUserResourceExclusions`). Every discovery route that can load or execute
 * a resource consults these helpers with that value; `isRootExcluded`
 * re-verifies the reviewed content on each check, so a changed resource, a
 * missing root, or an unreadable file keeps the resource visible (fail open).
 * An exclusion covers everything inside the excluded root, however it is
 * reached. Nothing here is ever a deletion.
 */
import * as fs from "node:fs/promises";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import { effectsSettings, type SettingValueOf } from "../config/registry";
import { isRootExcluded } from "../extensibility/resource-decisions";
import { cfgResourceExclusions, cfgUserResourceExclusions } from "../extensibility/resource-settings";

/** Decisions as stored in settings (canonical real root -> reviewed fingerprint data). */
export type ResourceExclusions = SettingValueOf<typeof cfgResourceExclusions>;

export const NO_RESOURCE_EXCLUSIONS: ResourceExclusions = {};

/** The user's exclusions in the settings instance driving process-wide effects; none before one is bound. */
export function globalResourceExclusions(): ResourceExclusions {
	const settings = effectsSettings();
	return settings ? cfgUserResourceExclusions.get(settings) : NO_RESOURCE_EXCLUSIONS;
}

/**
 * Verdicts being computed right now, per exclusions object. Providers load
 * concurrently and each asks about the same roots; sharing the pending check
 * snapshots a root once per burst. Entries are dropped when settled, so a later
 * pass always re-verifies current content.
 */
const pendingVerdicts = new WeakMap<object, Map<string, Promise<boolean>>>();

function rootIsExcluded(root: string, exclusions: ResourceExclusions): Promise<boolean> {
	let byRoot = pendingVerdicts.get(exclusions);
	if (!byRoot) {
		byRoot = new Map();
		pendingVerdicts.set(exclusions, byRoot);
	}
	const pending = byRoot.get(root);
	if (pending) return pending;
	const table = byRoot;
	const verdict = isRootExcluded(root, exclusions).finally(() => table.delete(root));
	table.set(root, verdict);
	return verdict;
}

/**
 * Gate for real (symlink-resolved) paths: resolves true when the path lies
 * inside an excluded root whose reviewed content still verifies. Each root is
 * verified at most once per gate, and only when some checked path is inside it,
 * so a loader creates one gate per pass and asks it about every candidate.
 */
export function excludedPathGate(exclusions: ResourceExclusions): (realPath: string) => Promise<boolean> {
	const roots = Object.keys(exclusions);
	const verdicts = new Map<string, Promise<boolean>>();
	return async realPath => {
		const containing = roots.filter(root => pathIsWithin(root, realPath));
		const excluded = await Promise.all(
			containing.map(root => {
				let verdict = verdicts.get(root);
				if (!verdict) {
					verdict = rootIsExcluded(root, exclusions);
					verdicts.set(root, verdict);
				}
				return verdict;
			}),
		);
		return excluded.some(Boolean);
	};
}

async function realpathOrNull(target: string): Promise<string | null> {
	try {
		return await fs.realpath(target);
	} catch {
		return null;
	}
}

/**
 * Drop items whose real path lies inside a still-valid excluded root. Covers
 * packages, modules and skills reached through any route (native directories,
 * configured/explicit paths, npm/link and marketplace packages, symlinks)
 * without knowing which root produced them. Paths that cannot be resolved stay.
 */
export async function dropExcludedPaths<T>(
	items: readonly T[],
	pathOf: (item: T) => string,
	exclusions: ResourceExclusions,
): Promise<T[]> {
	if (Object.keys(exclusions).length === 0) return [...items];
	const isExcluded = excludedPathGate(exclusions);
	const real = await Promise.all(items.map(item => realpathOrNull(pathOf(item))));
	const verdicts = await Promise.all(real.map(target => target !== null && isExcluded(target)));
	return items.filter((_, index) => !verdicts[index]);
}
