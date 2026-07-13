export interface Env {
	/** Durable Object namespace backing the atomic job queue. */
	JOB_QUEUE: DurableObjectNamespace;
	/** Linear webhook signing secret (verifies `linear-signature`). */
	LINEAR_WEBHOOK_SECRET: string;
	/** Linear app developer token used to read issues and post comments. */
	LINEAR_API_TOKEN: string;
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

export type JobStatus = "pending" | "leased" | "done" | "failed";

export interface JobResult {
	success: boolean;
	output: string;
	error?: string;
	completedAt: string;
}

export interface Job {
	id: string;
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
	/** Current lease fencing identity; only the holder may complete. */
	attemptId?: string;
	leaseToken?: string;
	leaseExpiresAt?: string;
	leasedAt?: string;
	leasedBy?: string;
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
	leasedAt?: string;
	leasedBy?: string;
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
		...(job.result ? { result: { success: job.result.success, completedAt: job.result.completedAt } } : {}),
	};
}
