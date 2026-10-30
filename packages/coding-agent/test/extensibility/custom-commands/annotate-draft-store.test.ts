import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { AnnotationOverlayDraft } from "@oh-my-pi/pi-tui/overlays/annotation-types";
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
			({ getDraft: () => state, restoreDraft }) as unknown as AnnotationOverlay;

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
});
