export interface Env {
	/** Durable Object namespace backing the atomic job queue. */
	JOB_QUEUE: DurableObjectNamespace;
	/** Linear webhook signing secret (verifies `linear-signature`). */
	LINEAR_WEBHOOK_SECRET: string;
	/** Linear app developer token used to read issues and post comments. */
	LINEAR_API_TOKEN: string;
	/** GitHub App webhook signing secret. */
	GITHUB_WEBHOOK_SECRET?: string;
	/** GitHub App numeric id used to mint installation tokens. */
	GITHUB_APP_ID?: string;
	/** GitHub App PKCS#8 private key in PEM form. */
	GITHUB_APP_PRIVATE_KEY?: string;
	/** Account-wide installation id allowed to dispatch work. */
	GITHUB_INSTALLATION_ID?: string;
	/** GitHub account login allowed to dispatch work. */
	GITHUB_ACCOUNT_LOGIN?: string;
	/** Mention handle and model used by the GitHub adapter. */
	GITHUB_MENTION_HANDLE?: string;
	GITHUB_MODEL?: string;
	/** Shared secret the execution relay presents on /poll and /result. */
	RELAY_TOKEN: string;
	/** Separate administrative credential required for /status. Never the relay or webhook secret. */
	STATUS_TOKEN: string;
	/** Linear user id of the agent principal; only issues assigned to it dispatch. */
	LINEAR_AGENT_USER_ID: string;
	/** Comma-separated Linear project ids allowed to dispatch. Empty disables dispatch. */
	ALLOWED_PROJECT_IDS: string;
	/** Comma-separated `model:` combo ids allowed to dispatch. Empty disables dispatch. */
	ALLOWED_MODELS: string;
}

export type JobSource = "linear" | "github";

export interface GitHubJobTarget {
	owner: string;
	repo: string;
	number: number;
	installationId: string;
	defaultBranch: string;
	headRef?: string;
	headRepo?: string;
	isPullRequest: boolean;
	htmlUrl?: string;
}

export type JobStatus = "pending" | "leased" | "reconcile" | "done" | "failed";

export interface JobResult {
	success: boolean;
	output: string;
	error?: string;
	/**
	 * Failure taxonomy for retry decisions: `transient` (spawn failure,
	 * timeout, provider hiccup) may requeue with backoff; `permanent`
	 * (deterministic failure, invalid contract, auth) is terminal. Absent
	 * means permanent — older relays fail closed.
	 */
	failureClass?: "transient" | "permanent";
	completedAt: string;
}

export interface Job {
	id: string;
	/** Source adapter; missing on pre-migration jobs means Linear. */
	source?: JobSource;
	/** GitHub target metadata for account-wide jobs. */
	github?: GitHubJobTarget;
	issueId: string;
	issueIdentifier: string;
	model: string;
	prompt: string;
	status: JobStatus;
	createdAt: string;
	/** Webhook delivery id + issue revision that admitted this job (replay guard). */
	dedupeKey: string;
	/** Number of lease attempts consumed so far. */
	attempts: number;
	/** Linear workspace this job belongs to, from the webhook payload. */
	organizationId?: string;
	/**
	 * Logical attempt identity, `linear:<org>:<issueId>:<attempt>`, stamped
	 * per grant. Stable across systems for audit and cross-referencing;
	 * the unguessable fence (`attemptId` + `leaseToken`) stays separate.
	 */
	logicalAttemptKey?: string;
	/**
	 * Prompt refresh staged while an attempt is in flight (issue revised
	 * mid-run); applied on the next grant. Latest revision wins.
	 */
	stagedPrompt?: string;
	/** Current lease fencing identity; only the holder may complete. */
	attemptId?: string;
	leaseToken?: string;
	leaseExpiresAt?: string;
	leasedAt?: string;
	leasedBy?: string;
	/** Last accepted fenced heartbeat; liveness signal while leased. */
	lastHeartbeatAt?: string;
	/** When the job entered reconcile (liveness uncertain). */
	reconcileAt?: string;
	/** Why the job entered reconcile (queue-generated, never runner text). */
	reconcileReason?: string;
	/** Earliest time a pending retry may be granted (backoff gate). */
	notBefore?: string;
	/** Error of the most recent failed attempt, kept across retries. */
	lastError?: string;
	/** Fencing identity that produced the accepted terminal result. */
	completedAttemptId?: string;
	completedLeaseToken?: string;
	result?: JobResult;
}

/** Redacted job view safe for administrative status responses. Never carries prompts or output. */
export interface RedactedJob {
	id: string;
	issueIdentifier: string;
	model: string;
	status: JobStatus;
	createdAt: string;
	attempts: number;
	logicalAttemptKey?: string;
	leasedAt?: string;
	leasedBy?: string;
	lastHeartbeatAt?: string;
	reconcileAt?: string;
	reconcileReason?: string;
	notBefore?: string;
	result?: { success: boolean; completedAt: string };
}

export function redactJob(job: Job): RedactedJob {
	return {
		id: job.id,
		issueIdentifier: job.issueIdentifier,
		model: job.model,
		status: job.status,
		createdAt: job.createdAt,
		attempts: job.attempts,
		...(job.leasedAt ? { leasedAt: job.leasedAt } : {}),
		...(job.leasedBy ? { leasedBy: job.leasedBy } : {}),
		...(job.lastHeartbeatAt ? { lastHeartbeatAt: job.lastHeartbeatAt } : {}),
		...(job.reconcileAt ? { reconcileAt: job.reconcileAt } : {}),
		...(job.reconcileReason ? { reconcileReason: job.reconcileReason } : {}),
		...(job.notBefore ? { notBefore: job.notBefore } : {}),
		...(job.logicalAttemptKey ? { logicalAttemptKey: job.logicalAttemptKey } : {}),
		...(job.result ? { result: { success: job.result.success, completedAt: job.result.completedAt } } : {}),
	};
}
