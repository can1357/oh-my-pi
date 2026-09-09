import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildGitLabDuoWorkflowFallbackModel,
	buildGitLabDuoWorkflowModelSpec,
	discoverGitLabDuoWorkflowNamespace,
	discoverGitLabDuoWorkflowRuntimeNamespace,
	fetchGitLabDuoWorkflowModels,
} from "@oh-my-pi/pi-catalog/discovery/gitlab-duo-workflow";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isCatalogDescriptor } from "@oh-my-pi/pi-catalog/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const TEST_TOKEN = "redacted-test-token";
const originalNamespaceId = Bun.env.GITLAB_DUO_NAMESPACE_ID;
const originalProjectId = Bun.env.GITLAB_DUO_PROJECT_ID;
const originalProjectPath = Bun.env.GITLAB_DUO_PROJECT_PATH;

type MockCall = {
	url: string;
	body: unknown;
};

type AvailableModelsPayload = {
	defaultModel?: { name: string; ref: string } | null;
	selectableModels?: { name: string; ref: string }[] | null;
	pinnedModel?: { name: string; ref: string } | null;
} | null;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function createMockFetch(options: {
	projects?: Record<string, unknown>;
	graphqlProjects?: Record<string, unknown>;
	groups?: unknown[];
	groupsById?: Record<string, unknown>;
	models?: Record<string, AvailableModelsPayload>;
}): { fetch: FetchImpl; calls: MockCall[] } {
	const calls: MockCall[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		calls.push({ url, body });

		const parsed = new URL(url);
		if (parsed.pathname.startsWith("/api/v4/projects/")) {
			const projectId = decodeURIComponent(parsed.pathname.slice("/api/v4/projects/".length));
			const project = options.projects?.[projectId];
			return project ? jsonResponse(project) : jsonResponse({ message: "not found" }, 404);
		}
		if (parsed.pathname.startsWith("/api/v4/groups/")) {
			const groupId = decodeURIComponent(parsed.pathname.slice("/api/v4/groups/".length));
			const group = options.groupsById?.[groupId];
			return group ? jsonResponse(group) : jsonResponse({ message: "not found" }, 404);
		}
		if (parsed.pathname === "/api/v4/groups") {
			return jsonResponse(options.groups ?? []);
		}
		if (parsed.pathname === "/api/graphql") {
			const variables = (body as { variables?: { rootNamespaceId?: string; fullPath?: string } })?.variables;
			if (variables?.fullPath) {
				return jsonResponse({
					data: { project: (options.graphqlProjects ?? options.projects)?.[variables.fullPath] ?? null },
				});
			}
			const rootNamespaceId = String(variables?.rootNamespaceId ?? "");
			const models = options.models?.[rootNamespaceId];
			return jsonResponse({ data: { aiChatAvailableModels: models ?? null } });
		}
		return jsonResponse({ message: "unexpected" }, 404);
	}) as FetchImpl;
	return { fetch, calls };
}

function availableModels(ref: string): AvailableModelsPayload {
	return {
		defaultModel: { name: `Default ${ref}`, ref },
		selectableModels: [{ name: `Selectable ${ref}`, ref }],
		pinnedModel: null,
	};
}

afterEach(() => {
	if (originalNamespaceId === undefined) {
		delete Bun.env.GITLAB_DUO_NAMESPACE_ID;
	} else {
		Bun.env.GITLAB_DUO_NAMESPACE_ID = originalNamespaceId;
	}
	if (originalProjectId === undefined) {
		delete Bun.env.GITLAB_DUO_PROJECT_ID;
	} else {
		Bun.env.GITLAB_DUO_PROJECT_ID = originalProjectId;
	}
	if (originalProjectPath === undefined) {
		delete Bun.env.GITLAB_DUO_PROJECT_PATH;
	} else {
		Bun.env.GITLAB_DUO_PROJECT_PATH = originalProjectPath;
	}
});

describe("GitLab Duo Workflow discovery", () => {
	it("validates a namespace override directly with aiChatAvailableModels", async () => {
		const { fetch, calls } = createMockFetch({ models: { "gid://gitlab/Namespace/10": availableModels("claude") } });

		const selection = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			namespaceId: "gid://gitlab/Namespace/10",
			fetch,
		});

		expect(selection).toEqual({ rootNamespaceId: "gid://gitlab/Namespace/10", source: "override" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/graphql"]);
		expect((calls[0].body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId).toBe(
			"gid://gitlab/Namespace/10",
		);
	});

	it("uses GitLab Group GID only for numeric namespace model queries", async () => {
		const { fetch, calls } = createMockFetch({
			models: { "gid://gitlab/Group/10": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			namespaceId: "10",
			fetch,
		});

		expect(selection).toEqual({ rootNamespaceId: "10", source: "override" });
		expect((calls[0].body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId).toBe(
			"gid://gitlab/Group/10",
		);
	});

	it("uses GITLAB_DUO_NAMESPACE_ID when no explicit namespace is passed", async () => {
		Bun.env.GITLAB_DUO_NAMESPACE_ID = "env-root";
		const { fetch, calls } = createMockFetch({ models: { "env-root": availableModels("claude") } });

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });

		expect(selection).toEqual({ rootNamespaceId: "env-root", source: "override" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/graphql"]);
	});

	it("resolves a runtime namespace override without aiChatAvailableModels", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-runtime-"));
		try {
			const unavailablePayloads: AvailableModelsPayload[] = [
				null,
				{ defaultModel: null, selectableModels: [], pinnedModel: null },
			];
			for (const unavailableModels of unavailablePayloads) {
				const { fetch, calls } = createMockFetch({ models: { "runtime-root": unavailableModels } });

				const selection = await discoverGitLabDuoWorkflowRuntimeNamespace({
					apiKey: TEST_TOKEN,
					namespaceId: "runtime-root",
					cwd: tmpDir,
					fetch,
				});

				expect(selection).toEqual({ rootNamespaceId: "runtime-root", source: "override" });
				expect(calls).toEqual([]);

				try {
					await fetchGitLabDuoWorkflowModels({
						apiKey: TEST_TOKEN,
						namespaceId: "runtime-root",
						cwd: tmpDir,
						fetch,
					});
					throw new Error("expected model discovery to fail");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					expect(message).toContain("available models");
				}
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves a runtime namespace override path without aiChatAvailableModels", async () => {
		const { fetch, calls } = createMockFetch({
			groupsById: {
				"134945106": { id: "134945106", full_path: "runtime-group" },
			},
			models: { "134945106": null },
		});

		const selection = await discoverGitLabDuoWorkflowRuntimeNamespace({
			apiKey: TEST_TOKEN,
			namespaceId: "134945106",
			fetch,
		});

		expect(selection).toEqual({
			rootNamespaceId: "134945106",
			namespacePath: "runtime-group",
			source: "override",
		});
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/v4/groups/134945106"]);
	});

	it("resolves a runtime project namespace without aiChatAvailableModels", async () => {
		const { fetch, calls } = createMockFetch({
			projects: {
				"42": { id: 42, namespace: { rootAncestor: { id: "runtime-project-root" } } },
			},
			models: { "runtime-project-root": null },
		});

		const selection = await discoverGitLabDuoWorkflowRuntimeNamespace({ apiKey: TEST_TOKEN, projectId: "42", fetch });

		expect(selection).toEqual({ rootNamespaceId: "runtime-project-root", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/v4/projects/42"]);
	});

	it("resolves a runtime project path root via GraphQL when REST only exposes the leaf namespace", async () => {
		const { fetch, calls } = createMockFetch({
			projects: {
				"group/project": { id: 7, namespace: { id: "leaf-namespace" } },
			},
			graphqlProjects: {
				"group/project": { namespace: { rootAncestor: { id: "runtime-graphql-root" } } },
			},
			models: { "runtime-graphql-root": null },
		});

		const selection = await discoverGitLabDuoWorkflowRuntimeNamespace({
			apiKey: TEST_TOKEN,
			projectId: "group/project",
			fetch,
		});

		expect(selection).toEqual({
			rootNamespaceId: "runtime-graphql-root",
			projectPath: "group/project",
			source: "project",
		});
		expect(calls.map(call => new URL(call.url).pathname)).toEqual([
			"/api/v4/projects/group%2Fproject",
			"/api/graphql",
		]);
		expect((calls[1].body as { variables: { fullPath: string; rootNamespaceId?: string } }).variables).toEqual({
			fullPath: "group/project",
		});
	});

	it("resolves a runtime group namespace without aiChatAvailableModels", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-runtime-"));
		try {
			const { fetch, calls } = createMockFetch({
				groups: [{ id: "runtime-group-root", full_path: "runtime-group", duo_features_enabled: true }],
				models: { "runtime-group-root": null },
			});

			const selection = await discoverGitLabDuoWorkflowRuntimeNamespace({
				apiKey: TEST_TOKEN,
				cwd: tmpDir,
				fetch,
			});

			expect(selection).toEqual({
				rootNamespaceId: "runtime-group-root",
				namespacePath: "runtime-group",
				source: "group",
			});
			expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/v4/groups"]);
			expect(calls.some(call => new URL(call.url).pathname === "/api/graphql")).toBe(false);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves a project override root namespace before model validation", async () => {
		const { fetch, calls } = createMockFetch({
			projects: {
				"42": { id: 42, namespace: { id: "child", rootAncestor: { id: "root-from-project" } } },
			},
			models: { "root-from-project": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, projectId: "42", fetch });

		expect(selection).toEqual({ rootNamespaceId: "root-from-project", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/v4/projects/42", "/api/graphql"]);
		expect((calls[1].body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId).toBe(
			"root-from-project",
		);
	});

	it("resolves a numeric project id via the rootAncestor GraphQL fallback when REST exposes no root", async () => {
		// A real GitLab REST project payload exposes only `path_with_namespace` and
		// the immediate `namespace` (no `root_namespace_id`/`rootAncestor`), so a leaf
		// project under a subgroup yields no explicit root. A numeric id has no slash,
		// so the path/GraphQL fallback must key off the REST `path_with_namespace`.
		const { fetch, calls } = createMockFetch({
			projects: {
				"42": { id: 42, path_with_namespace: "top/sub/project", namespace: { id: 9, full_path: "top/sub" } },
			},
			graphqlProjects: {
				"top/sub/project": { namespace: { id: 9, rootAncestor: { id: "top-root" } } },
			},
			models: { "top-root": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, projectId: "42", fetch });

		expect(selection).toEqual({ rootNamespaceId: "top-root", source: "project" });
		const graphqlCalls = calls.filter(call => new URL(call.url).pathname === "/api/graphql");
		expect((graphqlCalls[0].body as { variables: { fullPath?: string } }).variables.fullPath).toBe("top/sub/project");
	});

	it("uses an explicit project REST root without a ProjectRootNamespaceQuery", async () => {
		const { fetch, calls } = createMockFetch({
			projects: {
				"group/project": { id: 7, namespace: { id: "leaf" }, root_namespace_id: "top-level-root" },
			},
			models: { "top-level-root": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			projectId: "group/project",
			fetch,
		});

		expect(selection).toEqual({ rootNamespaceId: "top-level-root", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual([
			"/api/v4/projects/group%2Fproject",
			"/api/graphql",
		]);
		expect((calls[1].body as { variables: { rootNamespaceId: string; fullPath?: string } }).variables).toEqual({
			rootNamespaceId: "top-level-root",
		});
	});

	it("falls back to GraphQL when project path REST payload only exposes the leaf namespace", async () => {
		const { fetch, calls } = createMockFetch({
			projects: {
				"group/project": { id: 7, namespace: { id: "leaf-namespace" } },
			},
			graphqlProjects: {
				"group/project": { namespace: { rootAncestor: { id: "graphql-root" } } },
			},
			models: { "graphql-root": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			projectId: "group/project",
			fetch,
		});

		expect(selection).toEqual({ rootNamespaceId: "graphql-root", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual([
			"/api/v4/projects/group%2Fproject",
			"/api/graphql",
			"/api/graphql",
		]);
		expect((calls[1].body as { variables: { fullPath: string } }).variables.fullPath).toBe("group/project");
		expect((calls[2].body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId).toBe(
			"graphql-root",
		);
	});

	it("falls back to GraphQL when project REST lookup cannot resolve a path", async () => {
		const { fetch, calls } = createMockFetch({
			graphqlProjects: {
				"group/project": { namespace: { rootAncestor: { id: "graphql-root" } } },
			},
			models: { "graphql-root": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			projectId: "group/project",
			fetch,
		});

		expect(selection).toEqual({ rootNamespaceId: "graphql-root", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual([
			"/api/v4/projects/group%2Fproject",
			"/api/graphql",
			"/api/graphql",
		]);
		expect((calls[1].body as { variables: { fullPath: string } }).variables.fullPath).toBe("group/project");
		expect((calls[2].body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId).toBe(
			"graphql-root",
		);
	});

	it("uses GITLAB_DUO_PROJECT_ID when no explicit project is passed", async () => {
		Bun.env.GITLAB_DUO_PROJECT_ID = "env-project";
		const { fetch, calls } = createMockFetch({
			projects: {
				"env-project": { id: 84, namespace: { rootAncestor: { id: "env-project-root" } } },
			},
			models: { "env-project-root": availableModels("claude") },
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });

		expect(selection).toEqual({ rootNamespaceId: "env-project-root", source: "project" });
		expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/v4/projects/env-project", "/api/graphql"]);
	});

	it("honors GITLAB_DUO_PROJECT_PATH and the projectPath config field for namespace discovery", async () => {
		Bun.env.GITLAB_DUO_PROJECT_PATH = "group/path-project";
		const { fetch } = createMockFetch({
			projects: {
				"group/path-project": { id: 91, namespace: { rootAncestor: { id: "path-project-root" } } },
				"explicit/path": { id: 92, namespace: { rootAncestor: { id: "explicit-path-root" } } },
			},
			models: {
				"path-project-root": availableModels("claude"),
				"explicit-path-root": availableModels("claude"),
			},
		});

		// Env-var fallback resolves the project pinned by path.
		const fromEnv = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });
		expect(fromEnv).toEqual({ rootNamespaceId: "path-project-root", source: "project" });

		// Explicit projectPath config wins over the env var.
		const fromConfig = await discoverGitLabDuoWorkflowNamespace({
			apiKey: TEST_TOKEN,
			projectPath: "explicit/path",
			fetch,
		});
		expect(fromConfig).toEqual({ rootNamespaceId: "explicit-path-root", source: "project" });
	});

	it("skips group candidates whose model availability is null or empty", async () => {
		const { fetch, calls } = createMockFetch({
			groups: [
				{ id: "no-models", duo_features_enabled: true },
				{ id: "empty-models", duo_core_features_enabled: true },
				{ id: "usable-models", fullPath: "usable-models-group" },
			],
			models: {
				"no-models": null,
				"empty-models": { defaultModel: null, selectableModels: [], pinnedModel: null },
				"usable-models": availableModels("claude_sonnet_4_6_vertex"),
			},
		});

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });

		expect(selection).toEqual({
			rootNamespaceId: "usable-models",
			namespacePath: "usable-models-group",
			source: "group",
		});
		const graphqlRootIds = calls
			.filter(call => new URL(call.url).pathname === "/api/graphql")
			.map(call => (call.body as { variables: { rootNamespaceId: string } }).variables.rootNamespaceId);
		expect(graphqlRootIds).toEqual(["no-models", "empty-models", "usable-models"]);
	});

	it("uses pinnedModel instead of selectableModels and defaultModel", async () => {
		const { fetch } = createMockFetch({
			models: {
				root: {
					defaultModel: { name: "Default Model", ref: "default_ref" },
					selectableModels: [{ name: "Selectable Model", ref: "selectable_ref" }],
					pinnedModel: { name: "Pinned Model", ref: "pinned_ref" },
				},
			},
		});

		const models = await fetchGitLabDuoWorkflowModels({ apiKey: TEST_TOKEN, namespaceId: "root", fetch });

		expect(models?.map(model => model.id)).toEqual(["pinned_ref"]);
		expect(models?.[0]).toMatchObject({
			name: "Pinned Model",
			api: "gitlab-duo-agent",
			provider: "gitlab-duo-agent",
			baseUrl: "https://gitlab.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: null,
			supportsTools: true,
		});
		expect(models?.[0]?.gitlabDuoWorkflowRootNamespaceId).toBe("root");
	});

	it("matches contextWindow to the model ref family with a 200k default fallback", () => {
		expect(buildGitLabDuoWorkflowModelSpec({ name: "Opus", ref: "claude_opus_4_8" }).contextWindow).toBe(1_000_000);
		expect(buildGitLabDuoWorkflowModelSpec({ name: "Sonnet", ref: "claude_sonnet_4_6" }).contextWindow).toBe(
			1_000_000,
		);
		expect(buildGitLabDuoWorkflowModelSpec({ name: "Gemini", ref: "gemini_2_5_pro" }).contextWindow).toBe(1_000_000);
		expect(buildGitLabDuoWorkflowModelSpec({ name: "Mystery", ref: "some_unknown_model" }).contextWindow).toBe(
			200_000,
		);
	});
	it("marks models as non-reasoning so the thinking-effort selector stays hidden", () => {
		const spec = buildGitLabDuoWorkflowModelSpec({ name: "Opus", ref: "claude_opus_4_8" });
		expect(getSupportedEfforts(spec)).toEqual([]);
	});

	it("keeps the gitlab-duo-agent descriptor out of catalog generation discovery", () => {
		// The descriptor must NOT carry `catalogDiscovery`: that field is the sole gate
		// for the generator's discovery loop (`isCatalogDescriptor`). Were it present,
		// \`gen:models\` running on a machine with GitLab credentials would fetch the
		// account's namespace-scoped `aiChatAvailableModels` and bundle one private
		// namespace's pinned/selectable catalog into models.json as authoritative for
		// every fresh install. Only the generic, namespace-free fallback may be bundled;
		// live namespace-scoped models are discovered at runtime per credential/workspace.
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "gitlab-duo-agent");
		expect(descriptor).toBeDefined();
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(descriptor && isCatalogDescriptor(descriptor)).toBe(false);
	});

	it("seeds a namespace-free fallback model carrying no account-scoped namespace id", () => {
		// The bundled seed must never leak the generating machine's root namespace.
		const seed = buildGitLabDuoWorkflowFallbackModel();
		expect(seed).not.toHaveProperty("gitlabDuoWorkflowRootNamespaceId");
		// A credentialed runtime discovery, by contrast, pins the namespace it resolved.
		const scoped = buildGitLabDuoWorkflowModelSpec(
			{ name: "Sonnet", ref: "claude_sonnet_4_6_vertex" },
			undefined,
			"root-namespace-123",
		);
		expect(scoped.gitlabDuoWorkflowRootNamespaceId).toBe("root-namespace-123");
	});

	it("does not include bearer credentials in namespace discovery errors", async () => {
		const { fetch } = createMockFetch({ groups: [{ id: "missing" }], models: { missing: null } });

		try {
			await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });
			throw new Error("expected discovery to fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("GITLAB_DUO_NAMESPACE_ID");
			expect(message).not.toContain("Authorization");
			expect(message).not.toContain("Bearer");
			expect(message).not.toContain("PAT");
			expect(message).not.toContain("workflow token");
			expect(message).not.toContain(TEST_TOKEN);
		}
	});

	it("returns null when model refetch fails after namespace discovery succeeds", async () => {
		let availabilityCalls = 0;
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const parsed = new URL(url);
			if (parsed.pathname !== "/api/graphql") {
				return jsonResponse({ message: "unexpected" }, 404);
			}
			availabilityCalls += 1;
			if (availabilityCalls === 1) {
				return jsonResponse({ data: { aiChatAvailableModels: availableModels("claude") } });
			}
			return jsonResponse({ message: "temporary failure" }, 503);
		}) as FetchImpl;

		const models = await fetchGitLabDuoWorkflowModels({ apiKey: TEST_TOKEN, namespaceId: "root", fetch });

		expect(models).toBeNull();
		expect(availabilityCalls).toBe(2);
	});

	it("uses the current workspace GitLab remote before group candidates", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-"));
		try {
			await fs.mkdir(path.join(tmpDir, ".git"));
			await fs.writeFile(
				path.join(tmpDir, ".git", "config"),
				`[remote "origin"]\n\turl = git@gitlab.com:group/project.git\n`,
			);
			const { fetch, calls } = createMockFetch({
				projects: {
					"group/project": { id: 7, namespace: { rootAncestor: { id: "remote-root" } } },
				},
				groups: [{ id: "group-root" }],
				models: {
					"remote-root": availableModels("remote_model"),
					"group-root": availableModels("group_model"),
				},
			});

			const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, cwd: tmpDir, fetch });

			expect(selection).toEqual({ rootNamespaceId: "remote-root", source: "remote" });
			expect(calls.map(call => new URL(call.url).pathname)).toEqual([
				"/api/v4/projects/group%2Fproject",
				"/api/graphql",
			]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("follows the worktree commondir to read remotes from the common Git config", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-"));
		try {
			// Simulate a linked worktree: `<work>/.git` is a file pointing at the worktree
			// gitdir, whose own config has no remotes; the remote lives in the common dir
			// named by the gitdir's `commondir` file.
			const mainGit = path.join(tmpDir, "main", ".git");
			const workDir = path.join(tmpDir, "wt");
			const worktreeGitDir = path.join(mainGit, "worktrees", "wt");
			await fs.mkdir(worktreeGitDir, { recursive: true });
			await fs.mkdir(workDir, { recursive: true });
			await fs.writeFile(path.join(workDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
			await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n");
			await fs.writeFile(path.join(worktreeGitDir, "config"), "[core]\n\tbare = false\n");
			await fs.writeFile(
				path.join(mainGit, "config"),
				`[remote "origin"]\n\turl = git@gitlab.com:group/project.git\n`,
			);
			const { fetch, calls } = createMockFetch({
				projects: {
					"group/project": { id: 7, namespace: { rootAncestor: { id: "remote-root" } } },
				},
				groups: [{ id: "group-root" }],
				models: {
					"remote-root": availableModels("remote_model"),
					"group-root": availableModels("group_model"),
				},
			});

			const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, cwd: workDir, fetch });

			expect(selection).toEqual({ rootNamespaceId: "remote-root", source: "remote" });
			expect(calls.map(call => new URL(call.url).pathname)).toEqual([
				"/api/v4/projects/group%2Fproject",
				"/api/graphql",
			]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("strips a relative GitLab install base path from the remote project path", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-"));
		try {
			await fs.mkdir(path.join(tmpDir, ".git"));
			await fs.writeFile(
				path.join(tmpDir, ".git", "config"),
				`[remote "origin"]\n\turl = https://host.example.com/gitlab/group/project.git\n`,
			);
			const calls: { url: string }[] = [];
			const fetch: FetchImpl = (async (input: string | URL | Request) => {
				const url = String(input);
				calls.push({ url });
				// The DWS install lives under /gitlab; match on the API path beneath it.
				const pathname = new URL(url).pathname.replace(/^\/gitlab/, "");
				if (pathname === "/api/v4/projects/group%2Fproject") {
					return jsonResponse({ id: 7, namespace: { rootAncestor: { id: "remote-root" } } });
				}
				if (pathname === "/api/graphql") {
					return jsonResponse({ data: { aiChatAvailableModels: availableModels("remote_model") } });
				}
				return jsonResponse({ message: "not found" }, 404);
			}) as FetchImpl;

			const selection = await discoverGitLabDuoWorkflowNamespace({
				apiKey: TEST_TOKEN,
				baseUrl: "https://host.example.com/gitlab",
				cwd: tmpDir,
				fetch,
			});
			expect(selection.rootNamespaceId).toBe("remote-root");

			// The remote URL carries the `/gitlab` install path, but the project full path
			// is `group/project`; the lookup must not query `.../projects/gitlab%2Fgroup%2Fproject`.
			const projectCall = calls.find(call => call.url.includes("/api/v4/projects/"));
			expect(projectCall?.url).toContain("/api/v4/projects/group%2Fproject");
			expect(projectCall?.url).not.toContain("gitlab%2Fgroup");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not treat a same-host different-port remote as the workspace project", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-"));
		try {
			await fs.mkdir(path.join(tmpDir, ".git"));
			// The configured GitLab is on :8443; the remote points at the same hostname
			// on :9443 — a different GitLab service. It must NOT be accepted as this
			// instance's project, so discovery falls through to the group candidate
			// instead of querying :8443 for a project path that lives elsewhere.
			await fs.writeFile(
				path.join(tmpDir, ".git", "config"),
				`[remote "origin"]\n\turl = https://gitlab.example.com:9443/group/project.git\n`,
			);
			const { fetch, calls } = createMockFetch({
				projects: {
					"group/project": { id: 7, namespace: { rootAncestor: { id: "remote-root" } } },
				},
				groups: [{ id: "group-root" }],
				models: {
					"remote-root": availableModels("remote_model"),
					"group-root": availableModels("group_model"),
				},
			});

			const selection = await discoverGitLabDuoWorkflowNamespace({
				apiKey: TEST_TOKEN,
				baseUrl: "https://gitlab.example.com:8443",
				cwd: tmpDir,
				fetch,
			});

			// Falls through to the group candidate, never queries the cross-port project.
			expect(selection.rootNamespaceId).toBe("group-root");
			expect(calls.some(call => call.url.includes("/api/v4/projects/group%2Fproject"))).toBe(false);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("accepts an SSH remote whose port differs from the web base URL", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitlab-duo-workflow-"));
		try {
			await fs.mkdir(path.join(tmpDir, ".git"));
			// Self-managed GitLab: web UI on https://host (443), SSH on a dedicated port.
			// The SSH port must NOT cause the remote to be rejected as a different host.
			await fs.writeFile(
				path.join(tmpDir, ".git", "config"),
				`[remote "origin"]\n\turl = ssh://git@gitlab.example.com:2222/group/project.git\n`,
			);
			const { fetch, calls } = createMockFetch({
				projects: {
					"group/project": { id: 7, namespace: { rootAncestor: { id: "remote-root" } } },
				},
				groups: [{ id: "group-root" }],
				models: {
					"remote-root": availableModels("remote_model"),
					"group-root": availableModels("group_model"),
				},
			});

			const selection = await discoverGitLabDuoWorkflowNamespace({
				apiKey: TEST_TOKEN,
				baseUrl: "https://gitlab.example.com",
				cwd: tmpDir,
				fetch,
			});

			// The SSH-port remote resolves the workspace project, not the group fallback.
			expect(selection).toEqual({ rootNamespaceId: "remote-root", source: "remote" });
			expect(calls.some(call => call.url.includes("/api/v4/projects/group%2Fproject"))).toBe(true);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("pages through top-level groups to find a usable Duo namespace on a later page", async () => {
		// The token belongs to >1 page of top-level groups; the only usable namespace is
		// on page 2. Discovery must follow `x-next-page` rather than stop at page 1.
		const calls: { url: string }[] = [];
		const fetch: FetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url });
			const parsed = new URL(url);
			if (parsed.pathname === "/api/v4/groups") {
				const page = parsed.searchParams.get("page") ?? "1";
				if (page === "1") {
					return new Response(JSON.stringify([{ id: "page1-root" }]), {
						status: 200,
						headers: { "content-type": "application/json", "x-next-page": "2" },
					});
				}
				return new Response(JSON.stringify([{ id: "page2-root" }]), {
					status: 200,
					headers: { "content-type": "application/json", "x-next-page": "" },
				});
			}
			if (parsed.pathname === "/api/graphql") {
				const body =
					typeof init?.body === "string"
						? (JSON.parse(init.body) as { variables?: { rootNamespaceId?: string } })
						: null;
				const rootNamespaceId = body?.variables?.rootNamespaceId ?? "";
				// Only the page-2 group has usable models; the page-1 candidate is rejected,
				// forcing discovery to continue onto the second page.
				const models = rootNamespaceId === "page2-root" ? availableModels("page2_model") : null;
				return jsonResponse({ data: { aiChatAvailableModels: models } });
			}
			return jsonResponse({ message: "not found" }, 404);
		}) as FetchImpl;

		const selection = await discoverGitLabDuoWorkflowNamespace({ apiKey: TEST_TOKEN, fetch });

		// The candidate from page 2 was discovered and validated.
		expect(selection.rootNamespaceId).toBe("page2-root");
		// Both pages were fetched (page=1 then page=2).
		const groupPages = calls
			.filter(call => new URL(call.url).pathname === "/api/v4/groups")
			.map(call => new URL(call.url).searchParams.get("page"));
		expect(groupPages).toEqual(["1", "2"]);
	});
});
