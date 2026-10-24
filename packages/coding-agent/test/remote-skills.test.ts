import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import {
	assertSkillRelativePath,
	listRemoteSkillFiles,
	parseRemoteSourceSpec,
	type FetchFn,
} from "../src/skills/remote/source";
import {
	ensureRemoteSkillResource,
	loadRemoteSkillDescriptors,
	readRemoteSkillIndex,
	remoteSkillCachePath,
} from "../src/skills/remote/store";
import { addRemoteSkills, removeRemoteSkills, syncRemoteSkills } from "../src/skills/remote/sync";
import { RemoteSkillError } from "../src/skills/remote/types";

const REPO = "acme/skills";
const COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);

const TREE = {
	tree: [
		{ path: "README.md", type: "blob" },
		{ path: "skills/pdf/SKILL.md", type: "blob" },
		{ path: "skills/pdf/REFERENCE.md", type: "blob" },
		{ path: "skills/writing/SKILL.md", type: "blob" },
	],
};

function skillDoc(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

interface Stub {
	fetch: FetchFn;
	calls: string[];
}

/** Route by URL substring; unmatched requests are a 404. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): Stub {
	const calls: string[] = [];
	const fetch: FetchFn = async input => {
		calls.push(input);
		for (const [needle, respond] of Object.entries(routes)) {
			if (input.includes(needle)) return await respond();
		}
		return new Response("not found", { status: 404 });
	};
	return { fetch, calls };
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function text(value: string): Response {
	return new Response(value);
}

function githubTreeStub(commit: string, docs: Record<string, string>): Stub {
	const routes: Record<string, () => Response | Promise<Response>> = {
		"/commits/": () => json({ sha: commit }),
		"/git/trees/": () =>
			json({
				tree: Object.keys(docs).map(name => ({ path: `skills/${name}/SKILL.md`, type: "blob" })),
			}),
	};
	for (const [name, body] of Object.entries(docs)) {
		routes[`/skills/${name}/SKILL.md`] = () => text(body);
	}
	return stubFetch(routes);
}

describe("remote skill sources", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-remote-skill-"));
		cwd = path.join(root, "project");
		agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(root);
	});

	test("parses owner/repo with optional ref and directory", () => {
		expect(parseRemoteSourceSpec("anthropics/skills")).toEqual({
			repository: "anthropics/skills",
			ref: "",
			directory: "",
		});
		expect(parseRemoteSourceSpec("anthropics/skills@v1.0.0#skills/pdf")).toEqual({
			repository: "anthropics/skills",
			ref: "v1.0.0",
			directory: "skills/pdf",
		});
		expect(parseRemoteSourceSpec("acme/skills#/skills/").directory).toBe("skills");
	});

	test("rejects URL sources and escaping paths", () => {
		expect(() => parseRemoteSourceSpec("https://example.com/skills")).toThrow(RemoteSkillError);
		expect(() => parseRemoteSourceSpec("acme/skills#skills/../secrets")).toThrow(RemoteSkillError);
		expect(() => assertSkillRelativePath("../../etc/passwd")).toThrow(RemoteSkillError);
	});

	test("lists only SKILL.md files under the requested directory", async () => {
		const stub = stubFetch({ "/git/trees/": () => json(TREE) });
		expect(await listRemoteSkillFiles(REPO, COMMIT, "skills", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
		expect(await listRemoteSkillFiles(REPO, COMMIT, "", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
	});

	test("add pins the resolved commit and records frontmatter descriptions", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		const result = await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		expect(result.added.sort()).toEqual(["pdf", "writing"]);
		expect(result.commit).toBe(COMMIT);

		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(index.skills.pdf?.commit).toBe(COMMIT);
		expect(index.skills.pdf?.directory).toBe("skills/pdf");
		expect(index.skills.pdf?.description).toBe("Use for PDF work.");
	});

	test("add rejects skill documents that violate the spec", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: "---\nname: other\ndescription: Mismatched directory.\n---\n",
			writing: skillDoc("writing", "Use for prose."),
		});
		await expect(addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch })).rejects.toThrow(
			/does not match directory/,
		);
	});

	test("sync repins a moving ref and keeps an explicit commit untouched", async () => {
		const first = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Old description."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: first.fetch });

		const moved = githubTreeStub(NEXT_COMMIT, {
			pdf: skillDoc("pdf", "New description."),
			writing: skillDoc("writing", "Use for prose."),
		});
		const synced = await syncRemoteSkills({ cwd, agentDir, fetch: moved.fetch });
		expect(synced.changes.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ name: "pdf", from: COMMIT, to: NEXT_COMMIT },
			{ name: "writing", from: COMMIT, to: NEXT_COMMIT },
		]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(index.skills.pdf).toMatchObject({ commit: NEXT_COMMIT, description: "New description." });

		const pinned = githubTreeStub(COMMIT, { pinned: skillDoc("pinned", "Fixed.") });
		await addRemoteSkills(`${REPO}@${COMMIT}#skills`, {
			cwd: path.join(root, "pinned"),
			global: false,
			fetch: pinned.fetch,
		});
		const callsBefore = pinned.calls.length;
		const pinnedSync = await syncRemoteSkills({
			cwd: path.join(root, "pinned"),
			agentDir,
			fetch: pinned.fetch,
		});
		expect(pinnedSync.changes).toEqual([]);
		expect(pinned.calls.slice(callsBefore).some(url => url.includes("/commits/"))).toBe(false);
	});

	test("resources are fetched once and cached at the pinned commit", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const [entry] = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entry?.descriptor.name).toBe("pdf");

		const withResource = stubFetch({
			"/skills/pdf/REFERENCE.md": () => text("# Reference\n"),
		});
		const file = await ensureRemoteSkillResource(entry!.descriptor, "REFERENCE.md", {
			fetch: withResource.fetch,
			agentDir,
		});
		expect(await Bun.file(file).text()).toBe("# Reference\n");
		expect(file).toBe(remoteSkillCachePath(entry!.descriptor, "REFERENCE.md", agentDir));

		const again = await ensureRemoteSkillResource(entry!.descriptor, "REFERENCE.md", {
			fetch: withResource.fetch,
			agentDir,
		});
		expect(again).toBe(file);
		expect(withResource.calls.length).toBe(1);
	});

	test("a moved ref does not change where an already-bound task reads from", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const [entry] = await loadRemoteSkillDescriptors(cwd, agentDir);
		const bound = entry!.descriptor;

		const moved = githubTreeStub(NEXT_COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await syncRemoteSkills({ cwd, agentDir, fetch: moved.fetch });

		const resource = stubFetch({ [`/${COMMIT}/`]: () => text("# old\n") });
		const file = await ensureRemoteSkillResource(bound, "SKILL.md", { fetch: resource.fetch, agentDir });
		expect(file).toContain(COMMIT);
	});

	test("a missing resource and an unreachable source surface distinct errors", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const [entry] = await loadRemoteSkillDescriptors(cwd, agentDir);

		await expect(
			ensureRemoteSkillResource(entry!.descriptor, "MISSING.md", { fetch: stub.fetch, agentDir }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const offline: FetchFn = async () => {
			throw new TypeError("fetch failed");
		};
		const error = await ensureRemoteSkillResource(entry!.descriptor, "REFERENCE.md", {
			fetch: offline,
			agentDir,
		}).catch(err => err);
		expect(error).toBeInstanceOf(RemoteSkillError);
		expect(error.code).toBe("OFFLINE_RESOURCE_MISSING");
		expect(error.message).toContain("REFERENCE.md");
	});

	test("oversized resources are rejected before reaching the cache", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const [entry] = await loadRemoteSkillDescriptors(cwd, agentDir);

		const big = stubFetch({ "/skills/pdf/big.bin": () => text("x".repeat(2048)) });
		await expect(
			ensureRemoteSkillResource(entry!.descriptor, "big.bin", {
				fetch: big.fetch,
				agentDir,
				maxBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
	});

	test("remove unregisters only the named skills", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const removed = await removeRemoteSkills({ cwd, agentDir, names: ["pdf"] });
		expect(removed.removed).toEqual(["pdf"]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(Object.keys(index.skills)).toEqual(["writing"]);
		await expect(removeRemoteSkills({ cwd, agentDir, names: ["pdf"] })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("project descriptors shadow a same-named user descriptor", async () => {
		const project = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Project copy.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: project.fetch });
		const user = githubTreeStub(NEXT_COMMIT, { pdf: skillDoc("pdf", "User copy.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: true, agentDir, fetch: user.fetch });

		const entries = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ level: "project", descriptor: { description: "Project copy." } });
	});
});
