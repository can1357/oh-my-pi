import * as fs from "node:fs";
import * as path from "node:path";
import type { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { AnnotationOverlayDraft, TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { isEnoent, logger, postmortem, toError } from "@oh-my-pi/pi-utils";
import type { ReadonlySessionManager } from "../../../../session/session-manager";
import { writeFileAtomically } from "../../../../utils/atomic-file";
import { parseReviewDiffSnapshot } from "../review/diff";
import type { ResolvedReviewTarget } from "../review/target";

export type AnnotationDraftSource =
	| { kind: "text"; source: TextReviewSource }
	| { kind: "diff"; target: ResolvedReviewTarget; focus?: string };

/** An `/annotate` session's notes, saved when its overlay closes without sending them for review. */
export interface AnnotationDraft {
	key: string;
	updatedAt: number;
	source: AnnotationDraftSource;
	state: AnnotationOverlayDraft;
}

type DraftSession = Pick<ReadonlySessionManager, "getArtifactsDir" | "getSessionId" | "ensureOnDisk">;

const DRAFT_FILE = /^draft-([0-9a-f]{64})\.json$/;
/** Draft directories with an overlay open in this process; their session is kept until the draft is saved. */
const OPEN_DRAFTS = new Set<string>();

function hash(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function draftDirectory(artifactsDir: string, sessionId: string): string {
	// Keyed by session id, so the copy a fork makes of the artifacts directory stays inert.
	return path.join(artifactsDir, "annotation-drafts", /^[\w-]+$/.test(sessionId) ? sessionId : hash(sessionId));
}

/** One draft per annotated source: the same text or the same frozen diff reopens it. */
export function annotationDraftKey(source: AnnotationDraftSource): string {
	const { kind } = source;
	const identity =
		kind === "text"
			? [kind, source.source.kind, source.source.id, source.source.provenance ?? null, source.source.text]
			: [kind, source.target.kind, source.target.mode, source.target.rawDiff, source.focus ?? null];
	return hash(JSON.stringify(identity));
}

/** The session's drafts, newest first; unreadable files are skipped. */
export async function loadAnnotationDrafts(session: DraftSession): Promise<AnnotationDraft[]> {
	const artifactsDir = session.getArtifactsDir();
	if (!artifactsDir) return [];
	const directory = draftDirectory(artifactsDir, session.getSessionId());
	let names: string[];
	try {
		names = await fs.promises.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const drafts: AnnotationDraft[] = [];
	for (const name of names) {
		const key = DRAFT_FILE.exec(name)?.[1];
		if (!key) continue;
		try {
			const draft = JSON.parse(await fs.promises.readFile(path.join(directory, name), "utf8")) as AnnotationDraft;
			if (draft.key !== key || annotationDraftKey(draft.source) !== key) throw new Error("key mismatch");
			if (draft.state?.kind !== draft.source.kind || !Array.isArray(draft.state.annotations)) {
				throw new Error("malformed state");
			}
			// The parsed diff is not stored; it is derived from the raw patch exactly as the review target was.
			if (draft.source.kind === "diff") {
				draft.source.target.snapshot = parseReviewDiffSnapshot(draft.source.target.rawDiff);
			}
			drafts.push(draft);
		} catch (error) {
			logger.warn("Ignoring unreadable annotation draft", { name, error: toError(error).message });
		}
	}
	return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function saveDraft(session: DraftSession, draft: AnnotationDraft): Promise<void> {
	const artifactsDir = session.getArtifactsDir();
	if (!artifactsDir) return;
	// Materialize the session so it is listed, resumable, and kept by empty-session cleanup.
	await session.ensureOnDisk();
	const directory = draftDirectory(artifactsDir, session.getSessionId());
	const stored =
		draft.source.kind === "diff"
			? { ...draft, source: { ...draft.source, target: { ...draft.source.target, snapshot: undefined } } }
			: draft;
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFileAtomically(path.join(directory, `draft-${draft.key}.json`), JSON.stringify(stored));
}

export async function removeAnnotationDraft(session: DraftSession, key: string): Promise<void> {
	const artifactsDir = session.getArtifactsDir();
	if (!artifactsDir || !/^[0-9a-f]{64}$/.test(key)) return;
	await fs.promises.rm(path.join(draftDirectory(artifactsDir, session.getSessionId()), `draft-${key}.json`), {
		force: true,
	});
}

/** Whether the session holds a draft file or an open overlay; empty-session cleanup must keep such a session. */
export function hasAnnotationDraftsSync(artifactsDir: string, sessionId: string): boolean {
	const directory = draftDirectory(artifactsDir, sessionId);
	if (OPEN_DRAFTS.has(directory)) return true;
	try {
		return fs.readdirSync(directory).some(name => DRAFT_FILE.test(name));
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/**
 * Tie an overlay to the draft for `source`: {@link restore} replays the saved state
 * (`resumed`, or the draft saved for the same source), and {@link close} saves the
 * overlay's state, or removes the draft once its notes were sent for review or emptied.
 * The state is also saved if the process exits while the overlay is open.
 */
export async function openAnnotationDraft(
	session: DraftSession,
	source: AnnotationDraftSource,
	resumed?: AnnotationDraft,
): Promise<{
	restored: boolean;
	restore(overlay: AnnotationOverlay): void;
	close(result: { action: string } | undefined): Promise<void>;
}> {
	const key = annotationDraftKey(source);
	const saved = resumed ?? (await loadAnnotationDrafts(session)).find(draft => draft.key === key);
	// An open overlay holds the session: a close-time cleanup (or shutdown) racing the save must not delete it.
	const artifactsDir = session.getArtifactsDir();
	const openDirectory = artifactsDir ? draftDirectory(artifactsDir, session.getSessionId()) : undefined;
	if (openDirectory) OPEN_DRAFTS.add(openDirectory);
	let overlay: AnnotationOverlay | undefined;
	const persist = async (sent: boolean) => {
		const state = overlay?.getDraft();
		if (!state) return;
		const empty = !state.annotations.length && !state.editor?.text && !("editedText" in state && state.editedText);
		if (sent || empty) await removeAnnotationDraft(session, key);
		else await saveDraft(session, { key, updatedAt: Date.now(), source, state });
	};
	const unregister = postmortem.register(`annotation-draft:${key}`, () => persist(false));
	return {
		restored: saved !== undefined,
		restore(mounted) {
			overlay = mounted;
			if (saved) mounted.restoreDraft(saved.state);
		},
		async close(result) {
			unregister();
			try {
				await persist(result?.action === "review");
			} finally {
				if (openDirectory) OPEN_DRAFTS.delete(openDirectory);
			}
		},
	};
}
