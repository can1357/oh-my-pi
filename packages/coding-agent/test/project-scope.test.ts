import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// The projects registry (`ProjectsConfigFile`) freezes its path from
// `getAgentDir()` the first time `projects-config` is imported. Point the agent
// dir at a throwaway temp dir BEFORE that import so the registry never reads or
// writes the developer's real `~/.omp/agent`, then defer the import.
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-scope-agent-")));
setAgentDir(AGENT_DIR);

const { ProjectsConfigFile, getProjectsConfigPath, loadProjects, projectIdFromRemoteUrl, saveProjects } = await import(
	"@oh-my-pi/pi-coding-agent/config/projects-config"
);
const {
	decodeWireKey,
	encodeWireKey,
	fromWirePath,
	invalidateProjectScope,
	projectObjectSlug,
	resolveProject,
	toWirePath,
} = await import("@oh-my-pi/pi-coding-agent/state-broker/project-scope");

type Entry = { id: string; path: string; sync: boolean };

/** Persist a registry and drop every cache so the change is visible at once. */
function setProjects(entries: Entry[]): void {
	saveProjects(entries, AGENT_DIR);
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
}

const cleanupRoots: string[] = [];

/** A realpath-canonical temp workspace so path comparisons are stable. */
function makeWorkspace(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-scope-ws-")));
	cleanupRoots.push(root);
	return root;
}

beforeEach(() => {
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
});

afterEach(async () => {
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	for (const root of cleanupRoots.splice(0)) await removeWithRetries(root);
});

describe("projectIdFromRemoteUrl", () => {
	test("normalizes scp-like, https, ported-https, and ssh URLs as documented", () => {
		expect(projectIdFromRemoteUrl("git@github.com:o/r.git")).toBe("git:github.com/o/r");
		expect(projectIdFromRemoteUrl("https://github.com/o/r")).toBe("git:github.com/o/r");
		expect(projectIdFromRemoteUrl("https://user@host:8443/o/r.git")).toBe("git:host/o/r");
		expect(projectIdFromRemoteUrl("ssh://git@host/o/r")).toBe("git:host/o/r");
	});

	test("scp-like and https forms of the same repo yield the IDENTICAL id", () => {
		// This equality is the whole cross-machine identity mechanism: two clones
		// over different transports must agree on one project id.
		expect(projectIdFromRemoteUrl("git@github.com:o/r.git")).toBe(projectIdFromRemoteUrl("https://github.com/o/r"));
	});

	test("returns undefined for input it cannot normalize confidently", () => {
		expect(projectIdFromRemoteUrl("")).toBeUndefined();
		expect(projectIdFromRemoteUrl("   ")).toBeUndefined();
		expect(projectIdFromRemoteUrl("not a url")).toBeUndefined();
		expect(projectIdFromRemoteUrl("/just/a/path")).toBeUndefined();
	});
});

describe("saveProjects / loadProjects", () => {
	test("round-trips through the agent dir", () => {
		const entries: Entry[] = [
			{ id: "git:github.com/o/a", path: "/tmp/a", sync: true },
			{ id: "git:github.com/o/b", path: "/tmp/b", sync: false },
		];
		setProjects(entries);
		// saveProjects sorts by id; both entries survive verbatim.
		expect(loadProjects()).toEqual(entries);
	});

	test("a malformed projects.yml fails closed to [] rather than throwing", () => {
		fs.writeFileSync(getProjectsConfigPath(AGENT_DIR), "projects: [ { id: 'x', path:", "utf-8");
		ProjectsConfigFile.invalidate();
		invalidateProjectScope();
		expect(loadProjects()).toEqual([]);
	});

	test("a schema-invalid projects.yml fails closed to []", () => {
		// `sync` is required and must be boolean; a string violates the schema.
		fs.writeFileSync(getProjectsConfigPath(AGENT_DIR), "projects:\n  - id: x\n    path: /tmp/x\n    sync: nope\n");
		ProjectsConfigFile.invalidate();
		invalidateProjectScope();
		expect(loadProjects()).toEqual([]);
	});
});

describe("resolveProject", () => {
	test("exact root, subdirectory, unregistered, nested-deepest, and sibling-prefix", () => {
		const ws = makeWorkspace();
		const foo = path.join(ws, "foo");
		const inner = path.join(foo, "inner");
		const foobar = path.join(ws, "foobar");
		fs.mkdirSync(path.join(foo, "pkg", "a"), { recursive: true });
		fs.mkdirSync(inner, { recursive: true });
		fs.mkdirSync(foobar, { recursive: true });
		setProjects([
			{ id: "proj:foo", path: foo, sync: true },
			{ id: "proj:inner", path: inner, sync: true },
		]);

		// Exact root -> empty rel.
		const atRoot = resolveProject(foo);
		expect(atRoot?.project.id).toBe("proj:foo");
		expect(atRoot?.rel).toBe("");

		// Subdirectory -> POSIX rel.
		const atSub = resolveProject(path.join(foo, "pkg", "a"));
		expect(atSub?.project.id).toBe("proj:foo");
		expect(atSub?.rel).toBe("pkg/a");

		// Unregistered path -> undefined.
		expect(resolveProject(path.join(ws, "unregistered"))).toBeUndefined();

		// Nested projects: the DEEPEST match wins.
		const atInner = resolveProject(path.join(inner, "x"));
		expect(atInner?.project.id).toBe("proj:inner");
		expect(atInner?.rel).toBe("x");
	});

	test("a sibling sharing a name prefix does NOT match (the trailing-boundary guard)", () => {
		const ws = makeWorkspace();
		const foo = path.join(ws, "foo");
		const foobar = path.join(ws, "foobar");
		fs.mkdirSync(foo, { recursive: true });
		fs.mkdirSync(foobar, { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);

		// `/ws/foobar` must never be claimed by the project rooted at `/ws/foo`.
		expect(resolveProject(foobar)).toBeUndefined();
		expect(resolveProject(path.join(foobar, "deep"))).toBeUndefined();
	});
});

describe("encodeWireKey / decodeWireKey", () => {
	test("round-trips ids containing / and :, and rels including empty", () => {
		for (const [id, rel] of [
			["git:github.com/o/r", "pkg/a"],
			["git:github.com/o/r", ""],
			["proj:with:colons", "a/b/c"],
		] as const) {
			const decoded = decodeWireKey(encodeWireKey(id, rel));
			expect(decoded).toEqual({ id, rel });
		}
	});

	test("a key with no NUL separator decodes to undefined (never a bare path)", () => {
		expect(decodeWireKey("no-separator-here")).toBeUndefined();
		// A leading separator (empty id) is equally invalid.
		expect(decodeWireKey("\u0000rel")).toBeUndefined();
	});
});

describe("toWirePath / fromWirePath", () => {
	test("a synced project round-trips absolute <-> wire", () => {
		const ws = makeWorkspace();
		const foo = path.join(ws, "foo");
		fs.mkdirSync(path.join(foo, "pkg", "a"), { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);

		const abs = path.join(foo, "pkg", "a");
		const wire = toWirePath(abs);
		expect(wire).toBe(encodeWireKey("proj:foo", "pkg/a"));
		expect(fromWirePath(wire as string)).toBe(abs);

		// Project root round-trips with an empty rel.
		expect(fromWirePath(toWirePath(foo) as string)).toBe(foo);
	});

	test("a sync:false project returns undefined in BOTH directions (fail closed)", () => {
		const ws = makeWorkspace();
		const bar = path.join(ws, "bar");
		fs.mkdirSync(bar, { recursive: true });
		setProjects([{ id: "proj:bar", path: bar, sync: false }]);

		expect(toWirePath(bar)).toBeUndefined();
		expect(toWirePath(path.join(bar, "sub"))).toBeUndefined();
		expect(fromWirePath(encodeWireKey("proj:bar", "sub"))).toBeUndefined();
	});
});

describe("projectObjectSlug", () => {
	test("is filesystem/S3-safe and stable for the same id", () => {
		const slug = projectObjectSlug("git:github.com/o/r");
		expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
		expect(slug).not.toContain("/");
		expect(slug).not.toContain(":");
		expect(projectObjectSlug("git:github.com/o/r")).toBe(slug);
	});

	test("disambiguates two ids that sanitize to the same readable prefix", () => {
		// `a/b` and `a:b` both sanitize to the readable stem `a-b`; the appended
		// digest must keep their slugs distinct so bucket keys never collide.
		const slugSlash = projectObjectSlug("a/b");
		const slugColon = projectObjectSlug("a:b");
		expect(slugSlash.startsWith("a-b-")).toBe(true);
		expect(slugColon.startsWith("a-b-")).toBe(true);
		expect(slugSlash).not.toBe(slugColon);
	});
});

describe("invalidateProjectScope", () => {
	test("makes a saveProjects change visible immediately", () => {
		const ws = makeWorkspace();
		const foo = path.join(ws, "foo");
		fs.mkdirSync(foo, { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);
		expect(resolveProject(foo)?.project.sync).toBe(true); // caches the snapshot

		// Rewrite the registry WITHOUT dropping the project-scope snapshot: the
		// cached snapshot must still be observed (proving the cache exists).
		saveProjects([{ id: "proj:foo", path: foo, sync: false }], AGENT_DIR);
		ProjectsConfigFile.invalidate();
		expect(resolveProject(foo)?.project.sync).toBe(true);

		// Now drop it: the change is visible on the very next resolve.
		invalidateProjectScope();
		expect(resolveProject(foo)?.project.sync).toBe(false);
	});
});
