import {
	createConfiguredInstallationToken,
	fetchGitHubWorkItem,
	getGitHubCollaboratorPermission,
	postGitHubComment,
} from "./github";
import { fetchIssue, postComment } from "./linear";
import type { Env } from "./types";
import type { JobQueueStub } from "./worker";
import { createWorker } from "./worker";

export { JobQueue } from "./queue-do";

function queueStub(env: Env): JobQueueStub {
	// RPC stubs are typed as DurableObjectStub; the JobQueue class methods are
	// invocable on it via Workers RPC but not expressible without coupling the
	// worker module to `cloudflare:workers` types, so assert the RPC surface once here.
	const stub = env.JOB_QUEUE.get(env.JOB_QUEUE.idFromName("default")) as unknown as JobQueueStub;
	return stub;
}

export default createWorker({
	fetchIssue,
	postComment,
	github: {
		createInstallationToken: createConfiguredInstallationToken,
		fetchWorkItem: fetchGitHubWorkItem,
		postComment: (token, target, body) => postGitHubComment(token, target.owner, target.repo, target.number, body),
		getCollaboratorPermission: getGitHubCollaboratorPermission,
	},
	queue: queueStub,
});
