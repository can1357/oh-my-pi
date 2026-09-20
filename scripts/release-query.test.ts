import { expect, test } from "bun:test";
import { queryReleaseRuns } from "./release-query";

test("release watcher recovers from transient GitHub failures with bounded backoff", async () => {
	let attempts = 0;
	const delays: number[] = [];
	const output = await queryReleaseRuns(
		"commit",
		async () => {
			if (++attempts < 3)
				throw Object.assign(new Error("gh exited with code 1"), { stderr: Buffer.from("HTTP 502: Bad Gateway") });
			return '[{"status":"completed","conclusion":"failure"}]';
		},
		async ms => {
			delays.push(ms);
		},
	);
	expect(JSON.parse(output)).toEqual([{ status: "completed", conclusion: "failure" }]);
	expect(attempts).toBe(3);
	expect(delays).toEqual([1000, 2000]);
});

test("release watcher stops after three transport failures and preserves the error", async () => {
	let attempts = 0;
	const failure = new Error("read ECONNRESET");
	await expect(
		queryReleaseRuns(
			"commit",
			async () => {
				attempts++;
				throw failure;
			},
			async () => {},
		),
	).rejects.toBe(failure);
	expect(attempts).toBe(3);
});

test("release watcher does not retry authentication or command failures", async () => {
	for (const message of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden", "unknown flag: --commit"]) {
		let attempts = 0;
		const failure = new Error(message);
		await expect(
			queryReleaseRuns(
				"commit",
				async () => {
					attempts++;
					throw failure;
				},
				async () => {
					throw new Error("must not sleep");
				},
			),
		).rejects.toBe(failure);
		expect(attempts).toBe(1);
	}
});
