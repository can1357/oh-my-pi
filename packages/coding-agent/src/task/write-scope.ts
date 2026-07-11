export type WriteScopeMode = "exclusive" | "isolated-patch" | "proposal-only";

export interface WriteScope {
	readonly mode: WriteScopeMode;
	readonly paths: readonly string[];
	readonly mergeOwner?: string;
}

export interface WriteScopeSpawnInput {
	readonly laneId: string;
	readonly writeScope?: WriteScope;
	readonly isolated?: boolean;
	readonly editCapable: boolean;
}

export interface WriteScopeDiagnostic {
	readonly code:
		| "overlap_without_owner"
		| "proposal_only_with_edit"
		| "isolated_patch_without_isolation"
		| "invalid_scope";
	readonly message: string;
	readonly laneIds: readonly string[];
}

interface ScopedLane {
	readonly lane: WriteScopeSpawnInput;
	readonly index: number;
	readonly normalizedPaths: readonly (readonly string[])[];
	readonly valid: boolean;
}

interface OrderedDiagnostic {
	readonly diagnostic: WriteScopeDiagnostic;
	readonly firstLaneIndex: number;
	readonly secondLaneIndex: number;
}

function normalizePath(path: string): readonly string[] {
	const segments: string[] = [];
	for (const segment of path.trim().replaceAll("\\", "/").split("/")) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	const lastSegment = segments.at(-1);
	return lastSegment === "*" || lastSegment === "**" ? segments.slice(0, -1) : segments;
}

function isValidScope(scope: WriteScope): boolean {
	return (
		(scope.mode === "exclusive" || scope.mode === "isolated-patch" || scope.mode === "proposal-only") &&
		scope.paths.length > 0 &&
		scope.paths.every(path => path.trim().length > 0) &&
		(scope.mergeOwner === undefined || scope.mergeOwner.trim().length > 0)
	);
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
	const sharedLength = Math.min(left.length, right.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function scopesOverlap(left: ScopedLane, right: ScopedLane): boolean {
	return left.normalizedPaths.some(leftPath =>
		right.normalizedPaths.some(rightPath => pathsOverlap(leftPath, rightPath)),
	);
}

function hasSharedMergeOwner(left: ScopedLane, right: ScopedLane, laneIds: ReadonlySet<string>): boolean {
	const mergeOwner = left.lane.writeScope?.mergeOwner;
	return mergeOwner !== undefined && mergeOwner === right.lane.writeScope?.mergeOwner && laneIds.has(mergeOwner);
}

/**
 * Validates mutually compatible write ownership before concurrent spawning.
 * Lanes without a scope preserve legacy behavior and are deliberately exempt.
 */
export function validateWriteScopes(lanes: readonly WriteScopeSpawnInput[]): readonly WriteScopeDiagnostic[] {
	const laneIds = new Set(lanes.map(lane => lane.laneId));
	const scopedLanes: ScopedLane[] = [];
	const diagnostics: OrderedDiagnostic[] = [];

	for (const [index, lane] of lanes.entries()) {
		const scope = lane.writeScope;
		if (scope === undefined) continue;

		const valid = isValidScope(scope);
		const scopedLane: ScopedLane = {
			lane,
			index,
			normalizedPaths: valid ? scope.paths.map(normalizePath) : [],
			valid,
		};
		scopedLanes.push(scopedLane);

		if (!valid) {
			diagnostics.push({
				firstLaneIndex: index,
				secondLaneIndex: index,
				diagnostic: {
					code: "invalid_scope",
					message: `Lane ${lane.laneId} has an invalid write scope.`,
					laneIds: [lane.laneId],
				},
			});
		}
		if (scope.mode === "proposal-only" && lane.editCapable) {
			diagnostics.push({
				firstLaneIndex: index,
				secondLaneIndex: index,
				diagnostic: {
					code: "proposal_only_with_edit",
					message: `Proposal-only lane ${lane.laneId} must not be edit capable.`,
					laneIds: [lane.laneId],
				},
			});
		}
		if (scope.mode === "isolated-patch" && lane.isolated !== true) {
			diagnostics.push({
				firstLaneIndex: index,
				secondLaneIndex: index,
				diagnostic: {
					code: "isolated_patch_without_isolation",
					message: `Isolated-patch lane ${lane.laneId} must run in isolation.`,
					laneIds: [lane.laneId],
				},
			});
		}
	}

	for (let leftIndex = 0; leftIndex < scopedLanes.length; leftIndex += 1) {
		const left = scopedLanes[leftIndex];
		if (!left.valid) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < scopedLanes.length; rightIndex += 1) {
			const right = scopedLanes[rightIndex];
			if (!right.valid || !scopesOverlap(left, right)) continue;
			if (left.lane.writeScope?.mode !== "exclusive" && right.lane.writeScope?.mode !== "exclusive") continue;
			if (hasSharedMergeOwner(left, right, laneIds)) continue;

			diagnostics.push({
				firstLaneIndex: left.index,
				secondLaneIndex: right.index,
				diagnostic: {
					code: "overlap_without_owner",
					message: `Write scopes overlap for lanes ${left.lane.laneId} and ${right.lane.laneId} without a shared merge owner.`,
					laneIds: [left.lane.laneId, right.lane.laneId],
				},
			});
		}
	}

	return diagnostics
		.sort((left, right) => {
			if (left.firstLaneIndex !== right.firstLaneIndex) return left.firstLaneIndex - right.firstLaneIndex;
			if (left.diagnostic.code < right.diagnostic.code) return -1;
			if (left.diagnostic.code > right.diagnostic.code) return 1;
			return left.secondLaneIndex - right.secondLaneIndex;
		})
		.map(({ diagnostic }) => diagnostic);
}
