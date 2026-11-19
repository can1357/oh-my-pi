/** GitLab Duo OAuth residue: invalidate direct-access credentials after token rotation. */

import { clearGitLabDuoDirectAccessCache } from "../../providers/gitlab-duo";
import type { AfterExchangeHook } from "../hooks/types";

export const gitLabDuoClearCacheHook: AfterExchangeHook = async credentials => {
	clearGitLabDuoDirectAccessCache();
	return credentials;
};
