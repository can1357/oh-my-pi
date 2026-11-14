/**
 * Subagent run, follow-up turn, and cold-revive entry points across worker links.
 *
 * Worker side: serves main's routed `runSubprocess` (`../executor-routing`), follow-up
 * turns of sessions homed here, and cold revives. Main side: serves follow-up turns a
 * worker forwards for sessions homed elsewhere, routing them on.
 */
import { runFollowUpTurnOnThisThread, runSubagentFollowUpTurn, runSubagentRunRequest } from "../../task/executor";
import { revivePersistedSubagent } from "../../task/persisted-revive";
import { invalidateRemoteAuthAvailability } from "./auth-remote";
import { setWorkerMainLink } from "../executor-routing";
import type { ThreadService } from "../services";

/** Subagent run, follow-up turn, and cold-revive entry points across worker links; see the module doc. */
export const executorThreadService: ThreadService = {
	name: "executor",

	installMain(peer) {
		// A worker routes follow-ups of sessions homed elsewhere through main.
		peer.link.handle("runFollowUpTurn", options => runSubagentFollowUpTurn(options));
	},

	installWorker(link) {
		setWorkerMainLink(link);
		link.handle("runSubprocess", request => {
			// Main may have changed key overrides (e.g. `--api-key` on a session switch) since the last run here.
			const storage = request.options.modelRegistry?.authStorage ?? request.options.authStorage;
			if (storage) invalidateRemoteAuthAvailability(storage);
			return runSubagentRunRequest(request);
		});
		// Main resolved the home already; running here never bounces the turn back.
		link.handle("runFollowUpTurn", options => runFollowUpTurnOnThisThread(options));
		link.handle("revivePersisted", (spec, expected) => revivePersistedSubagent(spec, expected));
	},
};
