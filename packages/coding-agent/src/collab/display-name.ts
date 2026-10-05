import * as os from "node:os";
import type { InteractiveModeContext } from "../modes/types";

import { cfgCollabDisplayName } from "./settings";

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: InteractiveModeContext): string {
	const configured = cfgCollabDisplayName.get(ctx.settings).trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}

/**
 * Badge for host-typed prompts (`Bauke · host`), or `undefined` outside a room.
 * A host names itself from {@link collabDisplayName}; a guest reads the host's
 * name off the replicated participant list, so both sides render the same
 * badge on a prompt the host sent — the counterpart to the `«guest»` badge
 * {@link COLLAB_PROMPT_MESSAGE_TYPE} rows already carry.
 */
export function collabHostBadge(ctx: InteractiveModeContext): string | undefined {
	if (ctx.collabController.host) return `${collabDisplayName(ctx)} · host`;
	const name = ctx.collabGuest?.state?.participants.find(participant => participant.role === "host")?.name.trim();
	return name ? `${name} · host` : undefined;
}
