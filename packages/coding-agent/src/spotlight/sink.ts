import { logger } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";
import type { ShapedTool, ShapeSink } from "./types";

/**
 * Text of a session artifact, by id or as its `artifact://N` URL (a tool's full output, a shaped result's original),
 * or null when it is gone or unreadable.
 */
export async function readArtifactText(
	sessionManager: Pick<SessionManager, "getArtifactPath"> & {
		getArtifactContent(id: string): string | null | Promise<string | null>;
	},
	ref: string,
): Promise<string | null> {
	const id = ref.startsWith("artifact://") ? ref.slice("artifact://".length) : ref;
	const inMemory = await sessionManager.getArtifactContent(id);
	if (inMemory !== null) return inMemory;
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
 * Saves the text a shaped result hides as a session artifact, read back with `read artifact://N` (and line
 * selectors, `artifact://N:A-B`). Non-persistent sessions keep it in memory, as the generic artifact spill does.
 */
export class ArtifactShapeSink implements ShapeSink {
	readonly #sessionManager: Pick<SessionManager, "saveArtifact">;

	constructor(sessionManager: Pick<SessionManager, "saveArtifact">) {
		this.#sessionManager = sessionManager;
	}

	/** @throws {Error} when the session no longer stores artifacts (released); shaping then keeps the result whole. */
	async save(text: string, label: ShapedTool): Promise<string> {
		const id = await this.#sessionManager.saveArtifact(text, `spotlight-${label}`);
		if (id === undefined) throw new Error("spotlight: session stores no artifacts");
		return `artifact://${id}`;
	}
}
