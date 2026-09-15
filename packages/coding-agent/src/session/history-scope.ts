import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import type { SettingValue } from "../config/settings-schema";
import type { HistoryScope } from "./history-storage";

/**
 * Maps the `historyScope` setting onto a recall filter; `undefined` keeps the
 * shared cross-project history every scope-unaware caller (session ranking in
 * the resume picker) relies on.
 *
 * Project scope matches the directory the editor stamps onto each submission
 * ({@link getProjectDir}). Session scope pins the project as well, so a session
 * resumed from another project cannot pull that project's prompts in, and
 * degrades to project scope while the session has no id yet.
 */
export function resolveHistoryScope(
	scope: SettingValue<"historyScope">,
	sessionId: string | undefined,
): HistoryScope | undefined {
	if (scope === "global") return undefined;
	const cwd = getProjectDir();
	if (scope === "session" && sessionId) return { cwd, sessionId };
	return { cwd };
}
