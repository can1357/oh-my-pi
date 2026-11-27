import type { StatusLineHost, StatusLineSession } from "./view-model/status-line/host";
import { Settings, settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { getSessionCompactionBoundaries } from "../session/context-usage-runtime";
import { claimResetExpiryNotice, classifyResetExpiry } from "../session/reset-expiry";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { resolveActiveRepoContextSync } from "../utils/active-repo-context";
import { GH_COMMAND_TIMEOUT_MS, github } from "../utils/github";
import { calculateTokensPerSecond } from "../utils/token-rate";

import {
	cfgGitEnabled,
	cfgStatusLineCompactThinkingLevel,
	cfgStatusLineContextLine,
	cfgStatusLineLeftSegments,
	cfgStatusLinePreset,
	cfgStatusLineRightSegments,
	cfgStatusLineSegmentOptions,
	cfgStatusLineSeparator,
	cfgStatusLineSessionAccent,
	cfgStatusLineShowHookStatus,
	cfgStatusLineTransparent,
	cfgTuiCodexResetFireworks,
} from "./settings";
import { cfgGoalStatusInFooter } from "../goals/settings";

/**
 * Session capabilities the host consults beyond the display subset. Every
 * field is optional so display-only sessions (collab guest replicas, test
 * fixtures) still render; a live `AgentSession` satisfies it structurally.
 */
export type StatusLineHostSession = StatusLineSession &
	Partial<Pick<AgentSession, "settings" | "modelRegistry" | "sessionId" | "fetchUsageReports">>;

/** Application policy and runtime services consumed by the portable status renderer. */
export const statusLineHost: StatusLineHost<StatusLineHostSession> = {
	getSettings: () => ({
		preset: cfgStatusLinePreset.get(settings),
		leftSegments: cfgStatusLineLeftSegments.get(settings),
		rightSegments: cfgStatusLineRightSegments.get(settings),
		separator: cfgStatusLineSeparator.get(settings),
		showHookStatus: cfgStatusLineShowHookStatus.get(settings),
		segmentOptions: cfgStatusLineSegmentOptions.get(settings),
		sessionAccent: cfgStatusLineSessionAccent.get(settings),
		transparent: cfgStatusLineTransparent.get(settings),
		compactThinkingLevel: cfgStatusLineCompactThinkingLevel.get(settings),
		contextLine: cfgStatusLineContextLine.get(settings),
	}),
	gitEnabled: () => cfgGitEnabled.get(settings),
	codexResetFireworksEnabled: () => cfgTuiCodexResetFireworks.get(settings),
	// Read per frame: skip the `settings` proxy trap and hit the instance getter directly.
	getSettingsRevision: () => Settings.instance.revision,
	getSessionSettingsIdentity: session => session.settings,
	getSessionSettingsRevision: session => session.settings?.revision ?? 0,
	goalStatusInFooter: session => cfgGoalStatusInFooter.get(session.settings ?? settings),
	activeAccount: (session, provider) => {
		const authStorage = session.modelRegistry?.authStorage;
		const oauthIdentity = authStorage?.oauth?.identity(provider, session.sessionId);
		if (oauthIdentity) return oauthIdentity;
		// API-key credentials have no OAuth identity (resolveCredentialIdentityKey
		// is OAuth-only), so nothing above can attribute the session's usage.
		// Fall back to the stored row the router actually serves this session
		// from; usage reports probed from stored rows carry metadata.credentialId
		// for exactly this match. Without a sticky row (env/runtime key, or a
		// seam that does not expose it) attribution stays unknown, matching the
		// previous behavior.
		const sticky = authStorage?.sessions?.sticky?.(provider, session.sessionId);
		return sticky?.credentialId !== undefined ? { credentialId: sticky.credentialId } : undefined;
	},
	canFetchUsageReports: session => typeof session.fetchUsageReports === "function",
	fetchUsageReports: (session, signal) => session.fetchUsageReports?.(signal) ?? Promise.resolve(null),
	resolveActiveRepo: resolveActiveRepoContextSync,
	lookupPullRequest: cwd =>
		github.run(cwd, ["pr", "view", "--json", "number,url"], AbortSignal.timeout(GH_COMMAND_TIMEOUT_MS)),
	calculateTokensPerSecond,
	limitMatchesActiveAccount,
	classifyResetExpiry,
	resetExpiryNotice: (session, reports, nowMs) => {
		// agent.db records which resets were warned about across omp processes; without it, stay quiet
		// rather than repeat the warning on every refresh.
		const storage = (session.settings ?? settings).getStorage();
		return storage
			? claimResetExpiryNotice(reports, nowMs, (key, expiresAtMs) => storage.claimNotice(key, expiresAtMs))
			: undefined;
	},
	computeCompactionBoundaries: (session, contextWindow, model) =>
		getSessionCompactionBoundaries(session.settings ?? settings, contextWindow, model),
};
