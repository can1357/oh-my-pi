import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { settingValuesEqual } from "../config/registry";
import type { Settings } from "../config/settings";
import { type ResourceSnapshot, snapshotResource } from "./resource-snapshot";
import {
	cfgResourceExclusions,
	cfgUserResourceExclusions,
	MAX_REVIEWED_RESOURCES,
	type ResourceExclusion,
	type ReviewedResource,
	resourceDecisionProblem,
} from "./resource-settings";

/** A reviewed copy changed; callers must invalidate its recommendation rather than retry a save. */
export class StaleResourceReviewError extends Error {}

/** A user-approved exclusion only applies while all reviewed resource files remain unchanged. */
export async function isRootExcluded(
	root: string,
	exclusions: Readonly<Record<string, ResourceExclusion>>,
): Promise<boolean> {
	if (Object.keys(exclusions).length === 0) return false;
	try {
		const real = await fs.realpath(root);
		const decision = exclusions[real];
		if (!decision) return false;
		// Revalidate the whole comparison: an update to the preferred copy also invalidates the choice.
		const current = await Promise.all(
			decision.reviewed.map(reviewed =>
				snapshotResource({
					id: reviewed.root,
					label: reviewed.root,
					kind: reviewed.kind,
					root: reviewed.root,
				}),
			),
		);
		return current.every(
			(snapshot, index) => snapshot.complete && snapshot.fingerprint === decision.reviewed[index].fingerprint,
		);
	} catch (error) {
		// A missing/unreadable/changed resource must never inherit an old suppression decision.
		logger.debug("Resource exclusion could not be verified; keeping resource", { root, error: String(error) });
		return false;
	}
}

/**
 * Called only after a separate human confirmation, never by the analyzer or doctor --fix.
 *
 * Resolves only once the decision is in the user's global configuration and effective. A failed save
 * or an external edit that supersedes it restores this call's entries (leaving every other entry,
 * including concurrent edits, untouched) and throws.
 */
export async function excludeReviewedResources(
	snapshots: readonly ResourceSnapshot[],
	preferredId: string,
	settings: Settings,
	assertAuthorized?: () => void,
): Promise<void> {
	if (
		snapshots.length < 2 ||
		snapshots.length > MAX_REVIEWED_RESOURCES ||
		!snapshots.some(snapshot => snapshot.candidate.id === preferredId)
	) {
		throw new Error("The preferred candidate must be one of at least two reviewed resources");
	}
	if (new Set(snapshots.map(snapshot => snapshot.candidate.id)).size !== snapshots.length) {
		throw new Error("Reviewed candidate IDs must be distinct");
	}
	if (snapshots.some(snapshot => !snapshot.complete)) {
		throw new Error("Incomplete resource reviews cannot authorize hiding copies");
	}
	const current = await Promise.all(snapshots.map(snapshot => snapshotResource(snapshot.candidate)));
	if (current.some((snapshot, index) => !snapshot.complete || snapshot.fingerprint !== snapshots[index].fingerprint)) {
		throw new StaleResourceReviewError(
			"Resource contents changed after analysis; nothing was saved. Prepare and analyze the changed copies again.",
		);
	}
	const roots = await Promise.all(snapshots.map(snapshot => fs.realpath(snapshot.candidate.root)));
	const preferredRoot = roots[snapshots.findIndex(snapshot => snapshot.candidate.id === preferredId)];
	const reviewed = snapshots.map((snapshot, index): ReviewedResource => ({
		root: roots[index],
		fingerprint: snapshot.fingerprint,
		kind: snapshot.candidate.kind,
	}));
	// The kept copy has no entry: choosing it also lifts any earlier decision that hid it.
	const entries = snapshots.map((snapshot, index): [string, ResourceExclusion | undefined] => [
		roots[index],
		snapshot.candidate.id === preferredId
			? undefined
			: { fingerprint: snapshot.fingerprint, preferred: preferredRoot, reviewed },
	]);
	// Validate the whole group before the first write so no entry lands without its siblings.
	for (const [root, entry] of entries) {
		const problem = entry && resourceDecisionProblem(root, entry);
		if (problem) throw new Error(`Reviewed resources cannot be hidden together: ${problem}`);
	}

	// Recheck session ownership after the filesystem awaits, before any global setting changes.
	assertAuthorized?.();
	const before = cfgUserResourceExclusions.get(settings);
	for (const [root, entry] of entries) cfgResourceExclusions.setEntry(settings, root, entry);
	let failure: unknown;
	try {
		await settings.flush();
	} catch (error) {
		failure = error ?? new Error("The configuration could not be saved");
	}
	const saved = cfgUserResourceExclusions.get(settings);
	if (failure === undefined && entries.every(([root, entry]) => settingValuesEqual(saved[root], entry))) return;

	// Undo only entries still holding this call's value; a concurrent edit of the same resource wins.
	for (const [root, entry] of entries) {
		if (settingValuesEqual(saved[root], entry)) cfgResourceExclusions.setEntry(settings, root, before[root]);
	}
	await settings.flush().catch(error => {
		logger.warn("Resource decision rollback could not be saved", { error: String(error) });
	});
	throw new Error(
		failure === undefined
			? "The settings file changed while saving; the decision was not applied"
			: `The decision was not applied; saving the settings failed: ${failure instanceof Error ? failure.message : String(failure)}`,
		{ cause: failure },
	);
}
