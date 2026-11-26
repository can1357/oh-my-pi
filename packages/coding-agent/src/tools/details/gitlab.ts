import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
import type { OutputMeta } from "../output-meta-format";

/** Display metadata for GitLab operations. */
export interface GlToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	pipelineId?: number;
	jobId?: number;
	status?: string;
	failedJobs?: string[];
	watch?: GlPipelineWatchViewDetails;
	checkouts?: GlMrCheckoutSummary[];
}

/** Checkout location and branch metadata for a merge request. */
export interface GlMrCheckoutSummary {
	mrIid?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

/** Display state of a watched GitLab CI job. */
export interface GlPipelineWatchJobDetails {
	id: number;
	name: string;
	stage?: string;
	status?: string;
	allowFailure?: boolean;
	failureReason?: string;
	durationSeconds?: number;
	url?: string;
}

/** Captured log preview for a failed GitLab CI job. */
export interface GlPipelineWatchFailedLogDetails {
	pipelineId: number;
	jobId: number;
	jobName: string;
	stage?: string;
	status?: string;
	tail?: string;
	available: boolean;
	unavailableReason?: string;
}

/** Live pipeline watcher display snapshot. */
export interface GlPipelineWatchViewDetails {
	state: "watching" | "completed";
	repo: string;
	pipelineId?: number;
	status?: string;
	ref?: string;
	headSha?: string;
	source?: string;
	url?: string;
	pollCount?: number;
	note?: string;
	jobs: GlPipelineWatchJobDetails[];
	failedLogs?: GlPipelineWatchFailedLogDetails[];
}
