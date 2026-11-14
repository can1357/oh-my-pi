/**
 * A discovery `/models` response that refused the caller's credentials.
 *
 * Model managers rethrow it instead of treating the probe as an outage, and
 * the coding agent's registry classifies it as an authentication rejection
 * (the `/login` remedy). The message matches `DiscoveryHttpError`:
 * `HTTP <status> from <url>`.
 */
export class DiscoveryAuthRejectionError extends Error {
	readonly status: 401 | 403;

	constructor(status: 401 | 403, url: string) {
		super(`HTTP ${status} from ${url}`);
		this.name = "DiscoveryAuthRejectionError";
		this.status = status;
	}
}
