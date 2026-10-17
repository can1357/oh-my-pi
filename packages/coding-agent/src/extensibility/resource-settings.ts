import * as path from "node:path";
import { isRecord, logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import { type AnySetting, Derived, register } from "../config/registry";
import type { Settings } from "../config/settings";
import type { ResourceCandidate } from "./resource-snapshot";

/** Most copies one decision can review. */
export const MAX_REVIEWED_RESOURCES = 8;

export interface ReviewedResource {
	root: string;
	fingerprint: string;
	kind: ResourceCandidate["kind"];
}

/** A decision hiding the resource at its record key in favor of {@link preferred}. */
export interface ResourceExclusion {
	/** Fingerprint of the hidden resource. */
	fingerprint: string;
	/** Reviewed copy that stays visible instead. */
	preferred: string;
	/** Every reviewed copy, hidden and kept; all must stay unchanged for the decision to apply. */
	reviewed: ReviewedResource[];
}

type ResourceExclusionRecord = Record<string, ResourceExclusion>;

const SHA256 = /^[a-f0-9]{64}$/;

/** Why `decision` cannot hide `root`, or `undefined` when it can. Ignores fields it does not define. */
export function resourceDecisionProblem(root: string, decision: unknown): string | undefined {
	if (!path.isAbsolute(root)) return "the hidden resource path is not absolute";
	if (!isRecord(decision)) return "the decision is not a record";
	const { fingerprint, preferred, reviewed } = decision;
	if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) return "the fingerprint is not a SHA-256 digest";
	if (typeof preferred !== "string") return "the kept resource is missing";
	if (!Array.isArray(reviewed) || reviewed.length < 2 || reviewed.length > MAX_REVIEWED_RESOURCES) {
		return `a decision must review two to ${MAX_REVIEWED_RESOURCES} copies`;
	}
	const roots = new Set<string>();
	let hiddenFingerprint: unknown;
	for (const copy of reviewed) {
		if (
			!isRecord(copy) ||
			typeof copy.root !== "string" ||
			!path.isAbsolute(copy.root) ||
			typeof copy.fingerprint !== "string" ||
			!SHA256.test(copy.fingerprint) ||
			(copy.kind !== "skill" && copy.kind !== "extension")
		) {
			return "a reviewed copy has an invalid path, fingerprint, or kind";
		}
		if (roots.has(copy.root)) return "reviewed copies must be distinct";
		roots.add(copy.root);
		if (copy.root === root) hiddenFingerprint = copy.fingerprint;
	}
	if (hiddenFingerprint !== fingerprint) {
		return "the hidden resource is not a reviewed copy with the recorded fingerprint";
	}
	if (preferred === root || !roots.has(preferred)) return "the kept resource must be another reviewed copy";
	for (const outer of roots) {
		for (const inner of roots) {
			if (outer !== inner && pathIsWithin(outer, inner)) return "reviewed copies must not contain one another";
		}
	}
	return undefined;
}

/** Valid decisions of `raw` in canonical form; each rejected entry goes to `reject`. */
function readDecisions(
	raw: Record<string, unknown>,
	reject: (root: string, problem: string) => void,
): ResourceExclusionRecord {
	const decisions: ResourceExclusionRecord = {};
	for (const [root, decision] of Object.entries(raw)) {
		const problem = resourceDecisionProblem(root, decision);
		if (problem !== undefined) {
			reject(root, problem);
			continue;
		}
		const { fingerprint, preferred, reviewed } = decision as ResourceExclusion;
		decisions[root] = {
			fingerprint,
			preferred,
			reviewed: reviewed.map(copy => ({ root: copy.root, fingerprint: copy.fingerprint, kind: copy.kind })),
		};
	}
	return decisions;
}

/**
 * The persisted record. Writes (`set`, `setEntry`, `config set`) are strict; loading never is — a
 * malformed record in any layer must not stop startup, so reads go through {@link cfgUserResourceExclusions}.
 */
export const cfgResourceExclusions = register({
	id: "diagnostics.resourceExclusions",
	type: "record",
	default: {} as ResourceExclusionRecord,
	normalize(value: unknown) {
		if (!isRecord(value)) {
			throw new Error("diagnostics.resourceExclusions must map absolute resource paths to reviewed decisions");
		}
		return readDecisions(value, (root, problem) => {
			throw new Error(`Invalid resource decision for "${root}": ${problem}`);
		});
	},
});

const SOURCES: readonly AnySetting[] = [cfgResourceExclusions as AnySetting];

class UserResourceExclusions extends Derived<ResourceExclusionRecord> {
	get sources(): readonly AnySetting[] {
		return SOURCES;
	}

	inputs(settings: Settings): readonly unknown[] {
		let layer: unknown = settings.getGlobalSettings();
		for (const segment of cfgResourceExclusions.segments) layer = isRecord(layer) ? layer[segment] : undefined;
		return [layer];
	}

	compute(inputs: readonly unknown[], settings: Settings): ResourceExclusionRecord {
		const raw = inputs[0];
		const ignore = (key: string, value: unknown, problem: string) => {
			const warned = settings.warnState.invalid;
			const warnKey = `${cfgResourceExclusions.id}:${key}`;
			if (warned.has(warnKey) && Bun.deepEquals(warned.get(warnKey), value)) return;
			warned.set(warnKey, value);
			logger.warn("Settings: ignoring invalid resource decision; the resource stays visible", {
				setting: cfgResourceExclusions.id,
				resource: key,
				problem,
			});
		};
		if (raw === undefined) return {};
		if (!isRecord(raw)) {
			ignore("", raw, "the record is not a map of resource paths to decisions");
			return {};
		}
		return readDecisions(raw, (root, problem) => ignore(root, raw[root], problem));
	}
}

/**
 * Decisions allowed to hide resources: those the user persisted in the global configuration, with
 * malformed entries ignored (warned once, resource stays visible). Project and `--config` files, runtime
 * overrides, and the environment never contribute, so a repository cannot approve its own hiding of
 * user-level hooks or skills. Every loader reads this, not {@link cfgResourceExclusions}.
 */
export const cfgUserResourceExclusions: Derived<ResourceExclusionRecord> = new UserResourceExclusions();
