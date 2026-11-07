import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, getProjectAgentDir, isRecord, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { Settings } from "../src/config/settings";
import { excludeReviewedResources, isRootExcluded } from "../src/extensibility/resource-decisions";
import {
	cfgResourceExclusions,
	cfgUserResourceExclusions,
	type ResourceExclusion,
} from "../src/extensibility/resource-settings";
import {
	type ResourceCandidate,
	type ResourceSnapshot,
	snapshotResource,
} from "../src/extensibility/resource-snapshot";
import { loadSkills } from "../src/extensibility/skills";
import { cfgSkills } from "../src/extensibility/settings";
import { AgentStorage } from "../src/session/agent-storage";
import { discoverSessionExtensionPaths } from "../src/sdk";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const temporaryRoots: string[] = [];
afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function skillCandidate(id: string): Promise<ResourceCandidate> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-decision-"));
	temporaryRoots.push(root);
	await Bun.write(path.join(root, "SKILL.md"), `---\nname: review\ndescription: Review code\n---\n${id}\n`);
	await Bun.write(path.join(root, "scripts", "check.py"), "print('review')\n");
	return { id, label: id, kind: "skill", root, entrypoint: path.join(root, "SKILL.md") };
}

test("explicit review decisions hide only the reviewed copy and expire when supporting code changes", async () => {
	const keep = await skillCandidate("keep");
	const hide = await skillCandidate("hide");
	const snapshots = await Promise.all([snapshotResource(keep), snapshotResource(hide)]);
	const settings = Settings.isolated({});
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(false);
	await excludeReviewedResources(snapshots, "keep", settings);
	expect(await isRootExcluded(keep.root, cfgUserResourceExclusions.get(settings))).toBe(false);
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(true);
	await Bun.write(path.join(hide.root, "scripts", "check.py"), "print('updated contract')\n");
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(false);
});

test("changing the preferred copy also restores the previously hidden copy", async () => {
	const keep = await skillCandidate("keep");
	const hide = await skillCandidate("hide");
	const snapshots = await Promise.all([snapshotResource(keep), snapshotResource(hide)]);
	const settings = Settings.isolated({});
	await excludeReviewedResources(snapshots, "keep", settings);
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(true);
	await Bun.write(path.join(keep.root, "SKILL.md"), "new preferred workflow\n");
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(false);
});

test("a stale review refuses every mutation, including still-current sibling copies", async () => {
	const keep = await skillCandidate("keep");
	const hide = await skillCandidate("hide");
	const third = await skillCandidate("third");
	const snapshots = await Promise.all([snapshotResource(keep), snapshotResource(hide), snapshotResource(third)]);
	await Bun.write(path.join(keep.root, "SKILL.md"), "changed after analysis\n");
	const settings = Settings.isolated({});
	await expect(excludeReviewedResources(snapshots, "keep", settings)).rejects.toThrow();
	expect(cfgUserResourceExclusions.get(settings)).toEqual({});
});

test("revoked session authorization prevents all global preference writes", async () => {
	const keep = await skillCandidate("keep");
	const hide = await skillCandidate("hide");
	const snapshots = await Promise.all([snapshotResource(keep), snapshotResource(hide)]);
	const settings = Settings.isolated({});
	await expect(
		excludeReviewedResources(snapshots, "keep", settings, () => {
			throw new Error("Session changed");
		}),
	).rejects.toThrow("Session changed");
	expect(cfgUserResourceExclusions.get(settings)).toEqual({});
	expect(await isRootExcluded(hide.root, cfgUserResourceExclusions.get(settings))).toBe(false);
});

test("unknown preferred IDs and incomplete reviews cannot authorize exclusions", async () => {
	const keep = await skillCandidate("keep");
	const hide = await skillCandidate("hide");
	const snapshots = await Promise.all([snapshotResource(keep), snapshotResource(hide)]);
	const settings = Settings.isolated({});
	await expect(excludeReviewedResources(snapshots, "forged", settings)).rejects.toThrow();
	await expect(
		excludeReviewedResources([{ ...snapshots[0], complete: false }, snapshots[1]], "keep", settings),
	).rejects.toThrow();
	expect(cfgUserResourceExclusions.get(settings)).toEqual({});
});

test("nested resources cannot hide the container while retaining a copy inside it", async () => {
	const outer = await skillCandidate("outer");
	const root = path.join(outer.root, "nested");
	await Bun.write(path.join(root, "SKILL.md"), "Nested skill instructions\n");
	const inner: ResourceCandidate = { id: "inner", label: "inner", kind: "skill", root };
	const snapshots = await Promise.all([snapshotResource(outer), snapshotResource(inner)]);
	const settings = Settings.isolated({});
	await expect(excludeReviewedResources(snapshots, "inner", settings)).rejects.toThrow();
	expect(cfgUserResourceExclusions.get(settings)).toEqual({});
});

test("two reviewed candidates for one directory cannot authorize hiding it", async () => {
	const keep = await skillCandidate("keep");
	const snapshot = await snapshotResource(keep);
	const again: ResourceSnapshot = { ...snapshot, candidate: { ...snapshot.candidate, id: "again" } };
	const settings = Settings.isolated({});
	await expect(excludeReviewedResources([snapshot, again], "keep", settings)).rejects.toThrow();
	expect(cfgUserResourceExclusions.get(settings)).toEqual({});
});

/** A well-formed decision hiding `/decision/hide` in favor of `/decision/keep`, as plain data. */
const HIDE = "/decision/hide";
const KEEP = "/decision/keep";
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const validDecision: ResourceExclusion = {
	fingerprint: FINGERPRINT_A,
	preferred: KEEP,
	reviewed: [
		{ root: HIDE, fingerprint: FINGERPRINT_A, kind: "skill" },
		{ root: KEEP, fingerprint: FINGERPRINT_B, kind: "skill" },
	],
};

/** Each mutation breaks exactly one rule a hiding decision must satisfy. */
const invalidDecisions: [string, string, unknown][] = [
	["a relative resource path", "decision/hide", validDecision],
	["a malformed fingerprint", HIDE, { ...validDecision, fingerprint: "not-a-digest" }],
	[
		"a duplicated reviewed root",
		HIDE,
		{ ...validDecision, reviewed: [...validDecision.reviewed, validDecision.reviewed[1]] },
	],
	["a single reviewed copy", HIDE, { ...validDecision, reviewed: [validDecision.reviewed[0]] }],
	["a kept root equal to the hidden root", HIDE, { ...validDecision, preferred: HIDE }],
	["a kept root outside the reviewed group", HIDE, { ...validDecision, preferred: "/decision/other" }],
	["no kept root", HIDE, { fingerprint: FINGERPRINT_A, reviewed: validDecision.reviewed }],
	[
		"a hidden resource whose reviewed fingerprint differs",
		HIDE,
		{
			...validDecision,
			reviewed: [{ ...validDecision.reviewed[0], fingerprint: FINGERPRINT_B }, validDecision.reviewed[1]],
		},
	],
	[
		"reviewed copies that contain one another",
		`${KEEP}/hide`,
		{
			...validDecision,
			reviewed: [
				{ root: `${KEEP}/hide`, fingerprint: FINGERPRINT_A, kind: "skill" },
				{ root: KEEP, fingerprint: FINGERPRINT_B, kind: "skill" },
			],
		},
	],
];

describe("decision records", () => {
	test("accept a well-formed decision", () => {
		const settings = Settings.isolated({});
		cfgResourceExclusions.setEntry(settings, HIDE, validDecision);
		expect(cfgUserResourceExclusions.get(settings)).toEqual({ [HIDE]: validDecision });
	});

	test.each(invalidDecisions)("refuse to be written with %s", (_name, root, decision) => {
		const settings = Settings.isolated({});
		expect(() => cfgResourceExclusions.setEntry(settings, root, decision as ResourceExclusion)).toThrow();
		expect(() => cfgResourceExclusions.set(settings, { [root]: decision } as never)).toThrow();
		expect(cfgUserResourceExclusions.get(settings)).toEqual({});
	});
});

describe("persisted decisions", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-resource-decisions-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const projectConfigPath = () => path.join(getProjectAgentDir(cwd), "config.yml");
	const writeYaml = (file: string, value: unknown) => Bun.write(file, YAML.stringify(value));
	const readYaml = async (file: string): Promise<Record<string, unknown>> =>
		YAML.parse(await Bun.file(file).text()) as Record<string, unknown>;

	async function directory(...segments: string[]): Promise<string> {
		const dir = path.join(cwd, ...segments);
		await fs.mkdir(dir, { recursive: true });
		return await fs.realpath(dir);
	}

	async function writeSkill(dir: string, name: string, body: string): Promise<void> {
		await Bun.write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
	}

	async function reviewed(keep: string, hide: string, kind: ResourceCandidate["kind"]): Promise<ResourceSnapshot[]> {
		return await Promise.all(
			[keep, hide].map(root => snapshotResource({ id: root, label: path.basename(root), kind, root })),
		);
	}

	/** The decisions a user's confirmation of `snapshots` produces, computed on throwaway settings. */
	async function decisionsFor(snapshots: ResourceSnapshot[]): Promise<Record<string, ResourceExclusion>> {
		const scratch = Settings.isolated({});
		await excludeReviewedResources(snapshots, snapshots[0].candidate.id, scratch);
		return cfgUserResourceExclusions.get(scratch);
	}

	test("a malformed record is ignored with a warning instead of stopping startup", async () => {
		const [keep, hide] = [await directory("keep"), await directory("hide")];
		await Promise.all([writeSkill(keep, "keep", "a"), writeSkill(hide, "hide", "b")]);
		const good = await decisionsFor(await reviewed(keep, hide, "skill"));
		const malformed = Object.fromEntries(invalidDecisions.map(([, root, decision]) => [root, decision]));
		await writeYaml(configPath(), { diagnostics: { resourceExclusions: { ...malformed, ...good } } });
		await writeYaml(projectConfigPath(), { diagnostics: { resourceExclusions: malformed } });
		const warn = spyOn(logger, "warn");

		const settings = await Settings.loadIsolated({ agentDir, cwd });

		expect(cfgUserResourceExclusions.get(settings)).toEqual(good);
		expect(warn.mock.calls.some(([, fields]) => isRecord(fields) && fields.resource === "decision/hide")).toBe(true);
	});

	test("a record that is not a map is ignored too", async () => {
		await writeYaml(configPath(), { diagnostics: { resourceExclusions: ["/decision/hide"] } });
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		expect(cfgUserResourceExclusions.get(settings)).toEqual({});
	});

	test("an unrelated invalid setting still stops startup", async () => {
		await writeYaml(configPath(), {
			providers: { maxInFlightRequests: { openai: 0 } },
			diagnostics: { resourceExclusions: { "decision/hide": validDecision } },
		});
		await expect(Settings.loadIsolated({ agentDir, cwd })).rejects.toThrow(
			"Provider request limits must be positive numbers",
		);
	});

	test.each(["project", "overlay", "runtime"] as const)(
		"a %s record cannot hide the user's skills and extensions, while the user's own decision can",
		async layer => {
			const hideSkill = await directory(".omp", "skills", "forged-hide");
			const keepSkill = await directory("keep-skills", "forged-keep");
			const hideExtension = await directory(".omp", "extensions", "forged-hide-ext");
			const keepExtension = await directory(".omp", "extensions", "forged-keep-ext");
			await Promise.all([
				writeSkill(hideSkill, "forged-hide", "a"),
				writeSkill(keepSkill, "forged-keep", "b"),
				Bun.write(path.join(hideExtension, "index.ts"), "export default function (pi) {}\n"),
				Bun.write(path.join(keepExtension, "index.ts"), "export default function (pi) {}\n"),
			]);
			const skillReview = await reviewed(keepSkill, hideSkill, "skill");
			const extensionReview = await reviewed(keepExtension, hideExtension, "extension");
			// Anyone who can read the files can compute a valid record: only its source may vary.
			const forged = { ...(await decisionsFor(skillReview)), ...(await decisionsFor(extensionReview)) };
			const overlayPath = tempDir.join("overlay.yml");
			let settings: Settings;
			if (layer === "project") {
				await writeYaml(projectConfigPath(), { diagnostics: { resourceExclusions: forged } });
				settings = await Settings.loadIsolated({ agentDir, cwd });
			} else if (layer === "overlay") {
				await writeYaml(overlayPath, { diagnostics: { resourceExclusions: forged } });
				settings = await Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] });
			} else {
				settings = await Settings.loadIsolated({
					agentDir,
					cwd,
					overrides: { "diagnostics.resourceExclusions": forged },
				});
			}
			const loaded = async () => ({
				skills: (await loadSkills({ ...cfgSkills.get(settings), cwd })).skills.map(skill => skill.name),
				extensions: await discoverSessionExtensionPaths({}, cwd, settings),
			});

			// The record really is the effective value of the layer; it must still not be honored.
			expect(cfgResourceExclusions.get(settings)).toEqual(forged);
			expect(cfgResourceExclusions.provenance(settings)).toBe(layer);
			expect(cfgUserResourceExclusions.get(settings)).toEqual({});
			const untouched = await loaded();
			expect(untouched.skills).toContain("forged-hide");
			expect(untouched.extensions).toContain(path.join(hideExtension, "index.ts"));

			await excludeReviewedResources(skillReview, skillReview[0].candidate.id, settings);
			const hiddenSkill = await loaded();
			expect(hiddenSkill.skills).not.toContain("forged-hide");
			expect(hiddenSkill.extensions).toContain(path.join(hideExtension, "index.ts"));

			await excludeReviewedResources(extensionReview, extensionReview[0].candidate.id, settings);
			const hidden = await loaded();
			expect(hidden.extensions).not.toContain(path.join(hideExtension, "index.ts"));
			expect(hidden.extensions).toContain(path.join(keepExtension, "index.ts"));
		},
	);

	/** Persisted settings that already hold one unrelated decision. */
	async function settingsWithOtherDecision() {
		const [otherKeep, otherHide] = [await directory("other-keep"), await directory("other-hide")];
		await Promise.all([writeSkill(otherKeep, "other", "a"), writeSkill(otherHide, "other", "b")]);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		await excludeReviewedResources(await reviewed(otherKeep, otherHide, "skill"), otherKeep, settings);
		return { settings, other: cfgUserResourceExclusions.get(settings) };
	}

	test("a failed save restores the previous decisions and reports the failure", async () => {
		const [keep, hide] = [await directory("keep"), await directory("hide")];
		await Promise.all([writeSkill(keep, "keep", "a"), writeSkill(hide, "hide", "b")]);
		const { settings, other } = await settingsWithOtherDecision();
		expect(Object.keys(other)).toHaveLength(1);
		// A directory where config.yml should be makes every later save fail.
		await fs.rm(configPath());
		await fs.mkdir(configPath());

		await expect(excludeReviewedResources(await reviewed(keep, hide, "skill"), keep, settings)).rejects.toThrow();

		expect(cfgUserResourceExclusions.get(settings)).toEqual(other);
		expect(await isRootExcluded(hide, cfgUserResourceExclusions.get(settings))).toBe(false);
	});

	test("a save superseded by an external edit is neither reported as saved nor overwrites the edit", async () => {
		const [keep, hide] = [await directory("keep"), await directory("hide")];
		await Promise.all([writeSkill(keep, "keep", "a"), writeSkill(hide, "hide", "b")]);
		const { settings, other } = await settingsWithOtherDecision();
		const ours = await decisionsFor(await reviewed(keep, hide, "skill"));
		const external: ResourceExclusion = {
			...ours[hide],
			reviewed: ours[hide].reviewed.map(copy =>
				copy.root === hide ? copy : { ...copy, fingerprint: FINGERPRINT_B },
			),
		};

		const review = await reviewed(keep, hide, "skill");
		const written = Promise.withResolvers<void>();
		const stopListening = cfgUserResourceExclusions.listen(settings, decisions => {
			if (decisions[hide]) written.resolve();
		});
		const lock = await acquireFileLock(configPath());
		let outcome: Promise<unknown> | undefined;
		try {
			outcome = excludeReviewedResources(review, keep, settings).then(
				() => undefined,
				error => error,
			);
			// The in-memory write lands first; the save then waits on the lock while another process edits the file.
			await Promise.race([written.promise, outcome]);
			await writeYaml(configPath(), { diagnostics: { resourceExclusions: { ...other, [hide]: external } } });
		} finally {
			lock.release();
			stopListening();
		}

		expect(await outcome).toBeInstanceOf(Error);
		expect(cfgUserResourceExclusions.get(settings)).toEqual({ ...other, [hide]: external });
		expect(await readYaml(configPath())).toEqual({
			diagnostics: { resourceExclusions: { ...other, [hide]: external } },
		});
	});
});
