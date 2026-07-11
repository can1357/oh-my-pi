import { describe, expect, it } from "bun:test";
import {
	validateWriteScopes,
	type WriteScope,
	type WriteScopeMode,
	type WriteScopeSpawnInput,
} from "../../src/task/write-scope";

function scope(mode: WriteScopeMode, paths: readonly string[], mergeOwner?: string): WriteScope {
	return mergeOwner === undefined ? { mode, paths } : { mode, paths, mergeOwner };
}

function lane(
	laneId: string,
	writeScope: WriteScope | undefined,
	options: { readonly editCapable?: boolean; readonly isolated?: boolean } = {},
): WriteScopeSpawnInput {
	return {
		laneId,
		writeScope,
		editCapable: options.editCapable ?? false,
		isolated: options.isolated,
	};
}

describe("write-scope validation", () => {
	it("exempts legacy lanes without write scopes", () => {
		expect(validateWriteScopes([lane("legacy", undefined, { editCapable: true })])).toEqual([]);
	});

	it("rejects edit-capable proposal-only lanes", () => {
		const diagnostics = validateWriteScopes([
			lane("proposal", scope("proposal-only", ["docs"]), { editCapable: true }),
		]);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["proposal_only_with_edit"]);
		expect(diagnostics[0]?.laneIds).toEqual(["proposal"]);
	});

	it("requires isolated-patch lanes to run in isolation", () => {
		const diagnostics = validateWriteScopes([lane("patch", scope("isolated-patch", ["src"]))]);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["isolated_patch_without_isolation"]);
		expect(diagnostics[0]?.laneIds).toEqual(["patch"]);
	});

	it("rejects overlapping exclusive scopes without a merge owner", () => {
		const diagnostics = validateWriteScopes([
			lane("writer-a", scope("exclusive", ["packages/a"])),
			lane("writer-b", scope("exclusive", ["packages/a/src/file.ts"])),
		]);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["overlap_without_owner"]);
		expect(diagnostics[0]?.laneIds).toEqual(["writer-a", "writer-b"]);
	});

	it("allows overlapping scopes with a shared merge owner naming a lane", () => {
		expect(
			validateWriteScopes([
				lane("integrator", scope("exclusive", ["packages/a"], "integrator")),
				lane("writer", scope("exclusive", ["packages/a/src/file.ts"], "integrator")),
			]),
		).toEqual([]);
	});

	it("requires a merge owner for exclusive and isolated-patch overlap", () => {
		const diagnostics = validateWriteScopes([
			lane("writer", scope("exclusive", ["packages/a"])),
			lane("patch", scope("isolated-patch", ["packages/a/src/file.ts"]), { isolated: true }),
		]);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["overlap_without_owner"]);
		expect(diagnostics[0]?.laneIds).toEqual(["writer", "patch"]);
	});

	it("allows overlapping isolated patches", () => {
		expect(
			validateWriteScopes([
				lane("patch-a", scope("isolated-patch", ["packages/a"]), { isolated: true }),
				lane("patch-b", scope("isolated-patch", ["packages/a/src/file.ts"]), { isolated: true }),
			]),
		).toEqual([]);
	});

	it("detects only normalized glob-prefix overlaps", () => {
		const recursiveGlob = validateWriteScopes([
			lane("writer-a", scope("exclusive", ["packages/a/**"])),
			lane("writer-b", scope("exclusive", ["packages/a/src/x.ts"])),
		]);
		const singleSegmentGlob = validateWriteScopes([
			lane("writer-a", scope("exclusive", ["packages/a/*"])),
			lane("writer-b", scope("exclusive", ["packages/a/src/x.ts"])),
		]);
		const disjoint = validateWriteScopes([
			lane("writer-a", scope("exclusive", ["packages/a/**"])),
			lane("writer-b", scope("exclusive", ["packages/b/**"])),
		]);

		expect(recursiveGlob.map(diagnostic => diagnostic.code)).toEqual(["overlap_without_owner"]);
		expect(singleSegmentGlob.map(diagnostic => diagnostic.code)).toEqual(["overlap_without_owner"]);
		expect(disjoint).toEqual([]);
	});

	it("rejects empty paths, blank paths, and blank merge owners", () => {
		const diagnostics = validateWriteScopes([
			lane("no-paths", scope("exclusive", [])),
			lane("blank-path", scope("exclusive", ["  "])),
			lane("blank-owner", scope("exclusive", ["packages/a"], " ")),
		]);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
			"invalid_scope",
			"invalid_scope",
			"invalid_scope",
		]);
		expect(diagnostics.map(diagnostic => diagnostic.laneIds)).toEqual([
			["no-paths"],
			["blank-path"],
			["blank-owner"],
		]);
	});

	it("orders diagnostics by first lane index and code", () => {
		const inputs = [
			lane("proposal", scope("proposal-only", []), { editCapable: true }),
			lane("writer-a", scope("exclusive", ["packages/a"])),
			lane("writer-b", scope("exclusive", ["packages/a/src/file.ts"])),
		];

		const diagnostics = validateWriteScopes(inputs);

		expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
			"invalid_scope",
			"proposal_only_with_edit",
			"overlap_without_owner",
		]);
		expect(diagnostics.map(diagnostic => diagnostic.laneIds)).toEqual([
			["proposal"],
			["proposal"],
			["writer-a", "writer-b"],
		]);
		expect(validateWriteScopes(inputs)).toEqual(diagnostics);
	});
});
