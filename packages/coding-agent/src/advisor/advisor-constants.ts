/** Pure advisor enum constants shared by settings, config types, and transcript messages. */

export const ADVISOR_REVIEW_MODES = ["turn", "agent-end"] as const;

export const ADVISOR_SYNC_BACKLOG_MODES = ["off", "1", "3", "5", "strict"] as const;

export const ADVISOR_SESSION_SCOPES = ["main", "subagent", "all"] as const;

export const ADVISOR_SEVERITIES = ["nit", "concern", "blocker"] as const;

export type AdvisorReviewMode = (typeof ADVISOR_REVIEW_MODES)[number];

export type AdvisorSyncBacklog = (typeof ADVISOR_SYNC_BACKLOG_MODES)[number];

export type AdvisorSessionScope = (typeof ADVISOR_SESSION_SCOPES)[number];

export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];
