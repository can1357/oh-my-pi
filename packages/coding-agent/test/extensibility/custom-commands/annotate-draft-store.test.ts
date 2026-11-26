import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AnnotationReviewModel } from "@oh-my-pi/pi-coding-agent/ui/overlays/panels/annotation-review-model";
import type { AnnotationOverlayDraft } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/annotation-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	annotationDraftKey,
	loadAnnotationDrafts,
	openAnnotationDraft,
} from "../../../src/extensibility/custom-commands/bundled/annotate/draft-store";
import { createResolvedReviewTarget } from "../../../src/extensibility/custom-commands/bundled/review/target";

const DIFF = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

describe("annotation drafts", () => {
	it("keeps a closed diff draft without its parsed snapshot, restores it, and drops it once sent for review", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "s1", ensureOnDisk: vi.fn() };
		const target = createResolvedReviewTarget("uncommitted", "Uncommitted changes", DIFF, "No changes");
		const state: AnnotationOverlayDraft = {
			kind: "diff",
			annotations: [],
			editor: { fileIndex: 0, sourceIndex: 1, scope: "line", text: "unfinished" },
		};
		const overlay = (restoreDraft = vi.fn()) =>
			({ getDraft: () => state, restoreDraft }) as unknown as AnnotationReviewModel;

		const first = await openAnnotationDraft(session, { kind: "diff", target });
		first.restore(overlay());
		await first.close(undefined);
		expect(session.ensureOnDisk).toHaveBeenCalled();
		const directory = path.join(tempDir.path(), "annotation-drafts", "s1");
		const [file] = await fs.readdir(directory);
		expect(JSON.parse(await fs.readFile(path.join(directory, file!), "utf8")).source.target.snapshot).toBeUndefined();
		expect((await loadAnnotationDrafts(session))[0]?.source).toEqual({ kind: "diff", target });

		const restoreDraft = vi.fn();
		const second = await openAnnotationDraft(session, { kind: "diff", target });
		second.restore(overlay(restoreDraft));
		expect(restoreDraft).toHaveBeenCalledWith(state);
		await second.close({ action: "review" });
		expect(await loadAnnotationDrafts(session)).toEqual([]);
	});

	it("skips a draft whose state cannot be replayed", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "s1", ensureOnDisk: vi.fn() };
		const source = { kind: "text", source: { id: "p", kind: "prompt", label: "P", text: "x" } } as const;
		const key = annotationDraftKey(source);
		const file = path.join(tempDir.path(), "annotation-drafts", "s1", `draft-${key}.json`);
		await Bun.write(file, JSON.stringify({ key, updatedAt: 1, source, state: null }));
		expect(await loadAnnotationDrafts(session)).toEqual([]);
	});

	it("keeps the current snapshot when refresh cycles back to a previously saved draft", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "s1", ensureOnDisk: vi.fn() };
		const targetA = createResolvedReviewTarget("uncommitted", "Uncommitted changes", DIFF, "No changes");
		const targetB = createResolvedReviewTarget(
			"uncommitted",
			"Uncommitted changes",
			DIFF.replace("+export const value = 2;", "+export const value = 3;"),
			"No changes",
		);
		const sourceA = { kind: "diff", target: targetA } as const;
		const sourceB = { kind: "diff", target: targetB } as const;
		const state = (note: string): AnnotationOverlayDraft => ({
			kind: "diff",
			annotations: [
				{
					fileIndex: 0,
					sourceIndex: -1,
					annotation: { scope: "file", path: "src/value.ts", occurrence: 1, note },
				},
			],
		});
		const overlay = (draft: AnnotationOverlayDraft) =>
			({ getDraft: () => draft, restoreDraft: vi.fn() }) as unknown as AnnotationReviewModel;

		const seed = await openAnnotationDraft(session, sourceA);
		seed.restore(overlay(state("seed note")));
		await seed.close(undefined);

		const active = await openAnnotationDraft(session, sourceA);
		active.restore(overlay(state("latest note")));
		expect(await active.replaceSource(sourceB, () => true)).toBe(true);
		expect(await active.replaceSource(sourceA, () => true)).toBe(true);
		await active.close(undefined);

		const drafts = await loadAnnotationDrafts(session);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.source.kind).toBe("diff");
		if (drafts[0]?.source.kind !== "diff") throw new Error("expected a diff draft");
		expect(drafts[0].source.target.rawDiff).toBe(targetA.rawDiff);
		expect(drafts[0].state.annotations).toMatchObject([{ annotation: { note: "latest note" } }]);
	});

	it("does not save a reread text baseline as an empty edited-text draft", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "s1", ensureOnDisk: vi.fn() };
		const source = {
			kind: "text",
			source: {
				id: "file:/source.txt",
				kind: "file",
				label: "source.txt",
				text: "before",
				provenance: { kind: "file", path: "/source.txt" },
				sessionId: "s1",
			},
		} as const;
		const refreshedSource = { ...source, source: { ...source.source, text: "after" } };
		const state: AnnotationOverlayDraft = { kind: "text", annotations: [], editedText: "after" };
		const review = { getDraft: () => state, restoreDraft: vi.fn() } as unknown as AnnotationReviewModel;
		const draft = await openAnnotationDraft(session, source);
		draft.restore(review);
		expect(await draft.replaceSource(refreshedSource, () => true)).toBe(true);
		await draft.close(undefined);

		expect(await loadAnnotationDrafts(session)).toEqual([]);
	});

	it("leaves an independent draft untouched when refresh would reuse its source key", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "s1", ensureOnDisk: vi.fn() };
		const targetA = createResolvedReviewTarget("uncommitted", "Uncommitted changes", DIFF, "No changes");
		const targetB = createResolvedReviewTarget(
			"uncommitted",
			"Uncommitted changes",
			DIFF.replace("+export const value = 2;", "+export const value = 3;"),
			"No changes",
		);
		const sourceA = { kind: "diff", target: targetA } as const;
		const sourceB = { kind: "diff", target: targetB } as const;
		const overlay = (note: string) =>
			({
				getDraft: () => ({
					kind: "diff",
					annotations: [
						{
							fileIndex: 0,
							sourceIndex: -1,
							annotation: { scope: "file", path: "src/value.ts", occurrence: 1, note },
						},
					],
				}),
				restoreDraft: vi.fn(),
			}) as unknown as AnnotationReviewModel;

		const independent = await openAnnotationDraft(session, sourceB);
		independent.restore(overlay("independent"));
		await independent.close(undefined);
		const active = await openAnnotationDraft(session, sourceA);
		active.restore(overlay("current"));
		const replace = vi.fn(() => true);

		expect(await active.replaceSource(sourceB, replace)).toBe(false);
		expect(replace).not.toHaveBeenCalled();
		await active.close(undefined);

		const drafts = await loadAnnotationDrafts(session);
		expect(drafts).toHaveLength(2);
		expect(drafts.find(draft => draft.key === annotationDraftKey(sourceB))?.state.annotations).toMatchObject([
			{ annotation: { note: "independent" } },
		]);
	});
});
