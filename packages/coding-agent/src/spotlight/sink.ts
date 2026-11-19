import { logger, parseSpillUrl, spillUrl } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";
import type { ShapedTool, ShapeSink } from "./types";

/**
 * Text of a session spill, by id or as its `local://N.log` URL (a tool's full output, a shaped result's original),
 * or null when it is gone or unreadable.
 */
export async function readArtifactText(
	sessionManager: Pick<SessionManager, "getArtifactPath">,
	ref: string,
): Promise<string | null> {
	const id = String(parseSpillUrl(ref) ?? ref);
	const artifactPath = await sessionManager.getArtifactPath(id);
	if (!artifactPath) return null;
	try {
		return await Bun.file(artifactPath).text();
	} catch (error) {
		logger.debug("spotlight: artifact unreadable", { id, error: String(error) });
		return null;
	}
}

/**
 * Saves the text a shaped result hides as a session spill, read back with `read local://N.log` (and line
 * selectors, `local://N.log:A-B`). Sessions without a file spill under the temporary `local://` root.
 */
export class ArtifactShapeSink implements ShapeSink {
	readonly #sessionManager: Pick<SessionManager, "saveArtifact">;

	constructor(sessionManager: Pick<SessionManager, "saveArtifact">) {
		this.#sessionManager = sessionManager;
	}

	/** @throws {Error} when the session no longer stores artifacts (released); shaping then keeps the result whole. */
	async save(text: string, label: ShapedTool): Promise<string> {
		const id = await this.#sessionManager.saveArtifact(text);
		if (id === undefined) throw new Error(`spotlight: session stores no spills (${label})`);
		return spillUrl(id);
	}
}
