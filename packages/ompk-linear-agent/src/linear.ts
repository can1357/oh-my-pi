const LINEAR_API_URL = "https://api.linear.app/graphql";

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Verifies the `linear-signature` header against the raw request body. */
export async function verifyLinearSignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string,
): Promise<boolean> {
	if (!signatureHeader) return false;
	const expected = await hmacSha256Hex(secret, rawBody);
	return timingSafeEqual(expected, signatureHeader);
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

async function linearGraphQL<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(LINEAR_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: token,
		},
		body: JSON.stringify({ query, variables }),
	});
	const json = (await res.json()) as GraphQLResponse<T>;
	if (json.errors?.length) {
		throw new Error(`Linear API error: ${json.errors.map(e => e.message).join("; ")}`);
	}
	if (!json.data) throw new Error("Linear API returned no data");
	return json.data;
}

export interface IssueDetails {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	labels: string[];
	assigneeId: string | null;
	projectId: string | null;
	updatedAt: string | null;
}

export async function fetchIssue(token: string, issueId: string): Promise<IssueDetails> {
	const data = await linearGraphQL<{
		issue: {
			id: string;
			identifier: string;
			title: string;
			description: string | null;
			updatedAt: string | null;
			assignee: { id: string } | null;
			project: { id: string } | null;
			labels: { nodes: Array<{ name: string }> };
		};
	}>(
		token,
		`query($id: String!) {
			issue(id: $id) {
				id
				identifier
				title
				description
				updatedAt
				assignee { id }
				project { id }
				labels { nodes { name } }
			}
		}`,
		{ id: issueId },
	);
	return {
		id: data.issue.id,
		identifier: data.issue.identifier,
		title: data.issue.title,
		description: data.issue.description,
		labels: data.issue.labels.nodes.map(n => n.name),
		assigneeId: data.issue.assignee?.id ?? null,
		projectId: data.issue.project?.id ?? null,
		updatedAt: data.issue.updatedAt ?? null,
	};
}

export async function postComment(token: string, issueId: string, body: string): Promise<void> {
	await linearGraphQL(
		token,
		`mutation($issueId: String!, $body: String!) {
			commentCreate(input: { issueId: $issueId, body: $body }) { success }
		}`,
		{ issueId, body },
	);
}

export interface LinearProject {
	id: string;
	name: string;
	description: string;
	archivedAt: string | null;
}

const PROJECT_FIELDS = `id name description archivedAt`;

/** Fetch one project by id; `null` when Linear reports it does not exist. */
export async function fetchProject(token: string, projectId: string): Promise<LinearProject | null> {
	try {
		const data = await linearGraphQL<{ project: LinearProject | null }>(
			token,
			`query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
			{ id: projectId },
		);
		return data.project;
	} catch (err) {
		if (err instanceof Error && /not found|could not be found/i.test(err.message)) return null;
		throw err;
	}
}

/**
 * List projects a page at a time (newest workspaces here are small; the
 * resolver caps pagination). Archived projects are included so the resolver
 * can refuse to silently recreate an archived registry target.
 */
export async function listProjects(
	token: string,
	after: string | null,
): Promise<{ nodes: LinearProject[]; endCursor: string | null; hasNextPage: boolean }> {
	const data = await linearGraphQL<{
		projects: {
			nodes: LinearProject[];
			pageInfo: { endCursor: string | null; hasNextPage: boolean };
		};
	}>(
		token,
		`query($after: String) {
			projects(first: 100, after: $after, includeArchived: true) {
				nodes { ${PROJECT_FIELDS} }
				pageInfo { endCursor hasNextPage }
			}
		}`,
		{ after },
	);
	return {
		nodes: data.projects.nodes,
		endCursor: data.projects.pageInfo.endCursor,
		hasNextPage: data.projects.pageInfo.hasNextPage,
	};
}

/** Create a project bound to one team; the description must embed the repo-key token. */
export async function createLinearProject(
	token: string,
	input: { name: string; description: string; teamId: string },
): Promise<LinearProject> {
	const data = await linearGraphQL<{
		projectCreate: { success: boolean; project: LinearProject | null };
	}>(
		token,
		`mutation($input: ProjectCreateInput!) {
			projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } }
		}`,
		{ input: { name: input.name, description: input.description, teamIds: [input.teamId] } },
	);
	if (!data.projectCreate.success || !data.projectCreate.project) {
		throw new Error("Linear project creation failed");
	}
	return data.projectCreate.project;
}

/**
 * Issue comment for a job parked in reconcile (liveness uncertain). Shared
 * by the /poll sweep and the Durable Object alarm so both surfaces post the
 * identical, bounded notice. Never embeds prompts or runner output.
 */
export function reconcileComment(job: {
	model: string;
	attempts: number;
	leasedBy?: string;
	reconcileReason?: string;
}): string {
	const runner = job.leasedBy ?? "unknown relay";
	const reason = job.reconcileReason ?? "no heartbeat";
	return (
		`**ompk (${job.model}) — liveness uncertain**\n\n` +
		`Attempt ${job.attempts} on relay \`${runner}\` stopped heartbeating (${reason}). ` +
		`The job is parked in reconcile and its claims are retained: confirm or terminate ` +
		`the runner, then requeue or dead-letter it. A replacement will not start until then.`
	);
}

/**
 * Issue comment for a dead-lettered or explicitly failed reconcile
 * resolution: last error plus the concrete recovery action, per the
 * automation contract.
 */
export function deadLetterComment(job: { model: string; attempts: number }, error: string): string {
	return (
		`**ompk (${job.model}) — dead-lettered**\n\n` +
		`${error}\n\n` +
		`Recovery: fix the underlying failure, then re-apply the \`Queue/Queued\` admission ` +
		`state so a fresh delivery admits a new job (attempt budget was ${job.attempts}).`
	);
}

/** Extracts the 9router/model combo id from a `model:<combo-id>` label, if present. */
export function extractModelLabel(labels: string[]): string | null {
	const label = labels.find(l => l.toLowerCase().startsWith("model:"));
	return label ? label.slice("model:".length) : null;
}
