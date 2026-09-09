import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { CodexSecurityCloudFetch } from "../../src/security";
import {
	CodexSecurityCloudClient,
	CodexSecurityCloudHttpError,
	pullCodexSecurityCloudResults,
	SecurityStore,
} from "../../src/security";
import type { AuthStorage } from "../../src/session/auth-storage";

const ACCOUNT = { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" } as const;

function jwt(subject = "user-a"): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function authStorage(accessToken = jwt()): AuthStorage {
	return {
		getOAuthAccessByCredentialId: async (_provider: string, credentialId: number) => ({
			ok: true as const,
			accessToken,
			credentialId,
			accountId: "workspace-a",
		}),
	} as unknown as AuthStorage;
}

function configuration() {
	return {
		id: "config-source",
		hid: "config-public",
		created_at: "2026-07-29T00:00:00.000Z",
		updated_at: "2026-07-29T00:05:00.000Z",
		current_step: "waiting_for_new_commits",
		scans_remaining: 4,
		total_scans: 5,
		scan_input: {
			environment_id: "env-a",
			repo_id: "repo-a",
			repo_url: "https://github.com/example/repository",
			state: "enabled",
		},
	};
}

describe("Codex Security cloud client", () => {
	test("pins one account and refreshes the same credential once after a 401", async () => {
		const resolutions: boolean[] = [];
		const requests: Array<{ authorization: string | null; accountId: string | null }> = [];
		const storage = {
			getOAuthAccessByCredentialId: async (
				_provider: string,
				credentialId: number,
				options: { forceRefresh: boolean },
			) => {
				resolutions.push(options.forceRefresh);
				return {
					ok: true as const,
					accessToken: options.forceRefresh ? "refreshed-token" : "initial-token",
					credentialId,
					accountId: "workspace-a",
				};
			},
		} as unknown as AuthStorage;
		let attempt = 0;
		const fetchMock: CodexSecurityCloudFetch = async (_input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				authorization: headers.get("Authorization"),
				accountId: headers.get("ChatGPT-Account-Id"),
			});
			attempt += 1;
			return attempt === 1 ? json({}, 401) : json({ items: [configuration()], total_in_account: 1 });
		};
		const client = new CodexSecurityCloudClient({
			authStorage: storage,
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		const page = await client.listConfigurations();

		expect(resolutions).toEqual([false, true]);
		expect(requests).toEqual([
			{ authorization: "Bearer initial-token", accountId: "workspace-a" },
			{ authorization: "Bearer refreshed-token", accountId: "workspace-a" },
		]);
		expect(page.items[0]).toMatchObject({
			id: "config-public",
			sourceId: "config-source",
			repositoryId: "repo-a",
			environmentId: "env-a",
			remainingScans: 4,
		});
	});

	test("creates the documented cloud scan configuration without runtime attribution spoofing", async () => {
		let requestUrl = "";
		let requestBody: unknown;
		const fetchMock: CodexSecurityCloudFetch = async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body));
			return json(configuration());
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(jwt("user-exact")),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		await client.startScan({
			repositoryId: "repo-a",
			repositoryUrl: "https://github.com/example/repository",
			environmentId: "env-a",
			lookbackDays: "all",
		});

		expect(requestUrl).toBe("https://example.test/backend-api/aardvark/scan_configurations");
		expect(requestBody).toEqual({
			scan_input: {
				environment_id: "env-a",
				lookback_days: null,
				notification_rules: [],
				owner_id: "user-exact",
				repo_id: "repo-a",
				repo_url: "https://github.com/example/repository",
				share_targets: [],
				state: "enabled",
			},
		});
		expect(JSON.stringify(requestBody)).not.toContain("codex_sdk_ts");
	});

	test("imports cloud findings into the canonical store and SARIF", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-state-"));
		await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet();
		await $`git remote add origin https://github.com/example/repository.git`.cwd(repositoryRoot).quiet();
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const fetchMock: CodexSecurityCloudFetch = async input => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/scan_configurations")) {
				return json({ items: [configuration()], total_in_account: 1 });
			}
			if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
				return json({
					config_id: "config-source",
					current_step: "waiting_for_new_commits",
					pending_commits: 0,
					finished_commits: 3,
					failed_commits: 0,
					critical_findings: 0,
					high_findings: 1,
					medium_findings: 0,
					low_findings: 0,
					informational_findings: 0,
					last_scanned_commit_hash: "abc123",
					last_scanned_commit_dt: "2026-07-29T00:04:00.000Z",
					updated_at: "2026-07-29T00:05:00.000Z",
				});
			}
			if (url.pathname.endsWith("/scan-findings")) {
				expect(url.searchParams.get("status")).toBe(
					"new,triaged,in_progress,fixed,wontfix,duplicate,false_positive",
				);
				return json({
					items: [{ id: "finding-source", hid: "finding-public", configured_scan_id: "config-source" }],
					next_cursor: null,
				});
			}
			if (url.pathname.endsWith("/scan-findings/finding-public")) {
				return json({
					id: "finding-source",
					hid: "finding-public",
					configured_scan_id: "config-source",
					scan_id: "cloud-scan-a",
					job_id: "cloud-job-a",
					created_at: "2026-07-29T00:02:00.000Z",
					updated_at: "2026-07-29T00:03:00.000Z",
					criticality: "high",
					criticality_reason: "Attacker-controlled data reaches a command sink.",
					status: "new",
					version: 2,
					commit_analysis: {
						title: "Command injection",
						description: "Untrusted input reaches shell execution.",
						commit_hash: "abc123",
						validated: true,
						validation_confidence: 1,
						validation_method: "crash",
						validation_finished_at: "2026-07-29T00:03:00.000Z",
						validation_report: "The exploit reproduced in an isolated environment.",
						proposed_patch: "Use argument-array process execution.",
						relevant_lines: [
							{
								path: "src/command.ts",
								start_line_number: 7,
								end_line_number: 9,
								content: "exec(input)",
								comment: "Untrusted input is interpolated into a shell command.",
							},
						],
					},
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		const bundle = await pullCodexSecurityCloudResults({ client, configurationId: "config-public", store });

		expect(bundle.scan.producer.kind).toBe("codex-security-cloud");
		expect(bundle.scan.target.revision).toBe("abc123");
		expect(bundle.findings).toHaveLength(1);
		expect(bundle.findings[0]).toMatchObject({
			title: "Command injection",
			severity: { level: "high" },
			confidence: { level: "high" },
			validation: { status: "validated" },
			disposition: { status: "open" },
			remediation: "Use argument-array process execution.",
		});
		expect(bundle.findings[0]!.occurrences[0]!.locations[0]).toEqual({
			path: "src/command.ts",
			startLine: 7,
			endLine: 9,
		});
		expect(bundle.findings[0]!.evidence.map(item => item.kind)).toEqual(["code", "validation"]);
		expect(bundle.sarif?.runs).toBeArray();
		expect((await store.getBundle(bundle.scan.id))?.findings[0]?.provenance.sourceIds).toMatchObject({
			cloudConfigurationId: "config-public",
			cloudFindingId: "finding-public",
			cloudScanId: "cloud-scan-a",
		});
		expect(JSON.stringify(bundle)).not.toContain("workspace-a");
	});

	test("drops finding details attributed to another cloud configuration", async () => {
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async input => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/scan-findings")) {
					return json({ items: [{ hid: "finding-public" }] });
				}
				if (url.pathname.endsWith("/scan-findings/finding-public")) {
					return json({ hid: "finding-public", configured_scan_id: "different-config" });
				}
				throw new Error(`Unexpected request: ${url}`);
			},
		});
		const details = await client.listFindingDetails("https://github.com/example/repository", {
			id: "config-public",
			sourceId: "config-source",
			repositoryId: "repo-a",
			repositoryUrl: "https://github.com/example/repository",
			environmentId: "env-a",
		});
		expect(details).toEqual([]);
	});

	test("refuses cloud imports when repository identity cannot be verified", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-no-origin-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-no-origin-state-"));
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async input => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/scan_configurations")) {
					return json({ items: [configuration()], total_in_account: 1 });
				}
				if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
					return json({
						config_id: "config-source",
						pending_commits: 0,
						finished_commits: 1,
						failed_commits: 0,
					});
				}
				throw new Error(`Finding data should not be fetched without repository identity: ${url}`);
			},
		});

		await expect(pullCodexSecurityCloudResults({ client, configurationId: "config-public", store })).rejects.toThrow(
			"has no 'origin' remote",
		);
	});

	test("refuses to import a cloud configuration for another repository", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-mismatch-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-mismatch-state-"));
		await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet();
		await $`git remote add origin https://github.com/example/different-repository.git`.cwd(repositoryRoot).quiet();
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const fetchMock: CodexSecurityCloudFetch = async input => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/scan_configurations")) {
				return json({ items: [configuration()], total_in_account: 1 });
			}
			if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
				return json({
					config_id: "config-source",
					current_step: "waiting_for_new_commits",
					pending_commits: 0,
					finished_commits: 1,
					failed_commits: 0,
				});
			}
			throw new Error(`Finding data should not be fetched for a mismatched repository: ${url}`);
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		await expect(pullCodexSecurityCloudResults({ client, configurationId: "config-public", store })).rejects.toThrow(
			"does not match this project's origin remote",
		);
	});

	test("returns a sanitized error without reflecting response bodies", async () => {
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async () => new Response("secret backend detail", { status: 403 }),
		});
		let caught: unknown;
		try {
			await client.listConfigurations();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CodexSecurityCloudHttpError);
		if (!(caught instanceof Error)) throw new Error("expected cloud HTTP error");
		expect(caught.message).not.toContain("secret backend detail");
	});
});
