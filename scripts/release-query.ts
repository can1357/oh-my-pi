import { $ } from "bun";

/** Retry transport/server failures only; authentication and command errors stay fatal. */
export async function queryReleaseRuns(
	commitSha: string,
	query: () => Promise<string> = () =>
		$`gh run list --commit ${commitSha} --json databaseId,status,conclusion,name`.quiet().text(),
	sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await query();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
			if (
				attempt >= 2 ||
				!/HTTP 5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|i\/o timeout|connection reset|temporary failure|unexpected EOF/i.test(
					`${message}\n${stderr}`,
				)
			) {
				throw error;
			}
			await sleep(1000 * 2 ** attempt);
		}
	}
}
