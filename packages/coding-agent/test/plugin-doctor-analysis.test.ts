/**
 * `omp plugin doctor --analyze`: the consent, visibility and no-mutation boundaries of the CLI flow.
 * Only the provider call and the terminal are replaced; snapshots, the analyzer and its parser,
 * model resolution, decisions and settings are real, so each assertion is an exit code, a model-call
 * count, a stdout shape or persisted settings state.
 */
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parsePluginArgs, runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { defaultPluginDoctorIo, type PluginDoctorIo } from "@oh-my-pi/pi-coding-agent/cli/plugin-doctor-analysis";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { cfgUserResourceExclusions } from "@oh-my-pi/pi-coding-agent/extensibility/resource-settings";
import { snapshotResource } from "@oh-my-pi/pi-coding-agent/extensibility/resource-snapshot";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const BASE = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!BASE) throw new Error("Expected bundled Claude Sonnet 4.6 model");
const SMOL: Model<Api> = { ...BASE, provider: "analysis-lab", id: "smol-reader" };
const OTHER: Model<Api> = { ...BASE, provider: "analysis-lab", id: "other-reader" };

function registryOf(models: Model<Api>[]): ModelRegistry {
	const auth = createInMemoryAuthStorage();
	for (const provider of new Set(models.map(model => model.provider))) auth.keys.setRuntime(provider, "test-key");
	const registry = new ModelRegistry(auth, "/nonexistent/doctor-analysis-models.yml");
	spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

const settingsWith = (extra: Record<string, unknown> = {}) =>
	Settings.isolated({ modelRoles: { smol: "analysis-lab/smol-reader" }, ...extra });

/** Make a stream look like a terminal (or not) for the duration of a call. */
function withTty(states: Record<"stdin" | "stdout" | "stderr", boolean>, check: () => void): void {
	const streams = [
		["stdin", process.stdin],
		["stdout", process.stdout],
		["stderr", process.stderr],
	] as const;
	const saved = streams.map(([, stream]) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
	try {
		for (const [name, stream] of streams) {
			Object.defineProperty(stream, "isTTY", { value: states[name], configurable: true, writable: true });
		}
		check();
	} finally {
		streams.forEach(([, stream], index) => {
			const descriptor = saved[index];
			if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
			else Reflect.deleteProperty(stream, "isTTY");
		});
	}
}

describe("omp plugin doctor --analyze", () => {
	let tmpRoot: string;
	let first: string;
	let second: string;
	let settings: Settings;
	let registry: ModelRegistry;
	let tty: boolean;
	let answers: boolean[];
	let io: PluginDoctorIo & {
		confirm: Mock<PluginDoctorIo["confirm"]>;
		openRuntime: Mock<PluginDoctorIo["openRuntime"]>;
	};
	let registryRequested: Mock<() => Promise<ModelRegistry>>;
	let modelCall: Mock<typeof ai.completeSimple>;
	/** Roots the fake provider cites as evidence; the real parser validates the quotes against them. */
	let analyzedRoots: string[];
	let verdict: "prefer-first" | "keep-all";
	let beforeReply: (() => Promise<unknown>) | undefined;
	let doctor: Mock<PluginManager["doctor"]>;
	let exit: Mock<typeof process.exit>;

	async function plugin(name: string, body: string): Promise<string> {
		const root = path.join(tmpRoot, name);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({ name, version: "1.0.0", omp: { extensions: ["./index.ts"] } }),
		);
		await Bun.write(path.join(root, "index.ts"), body);
		return fs.realpath(root);
	}

	async function script(name: string, body: string): Promise<string> {
		const file = path.join(tmpRoot, "ext", name);
		await Bun.write(file, body);
		return fs.realpath(file);
	}

	const run = (
		flags: Record<string, unknown>,
		args: string[] = [first, second],
		action: "doctor" | "list" = "doctor",
	) => runPluginCommand({ action, args, flags }, io);
	/** The command ended with exit code 1 (the only way the CLI reports a refused request). */
	const refused = async (flags: Record<string, unknown>, args?: string[]) => {
		await expect(run(flags, args)).rejects.toThrow("process.exit");
		expect(exit.mock.calls.at(-1)?.[0]).toBe(1);
	};
	const printed = () => (console.log as unknown as Mock<typeof console.log>).mock.calls.map(call => String(call[0]));
	const exclusions = () => cfgUserResourceExclusions.get(settings);
	const sentToModel = () => JSON.stringify(modelCall.mock.calls[0]?.[1].messages);

	beforeEach(async () => {
		await initTheme();
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doctor-analysis-"));
		const pluginsDir = path.join(tmpRoot, "plugins");
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		doctor = spyOn(PluginManager.prototype, "doctor").mockResolvedValue([
			{ name: "bun", status: "ok", message: "fine" },
		]);
		spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(console, "log").mockImplementation(() => undefined);
		spyOn(console, "error").mockImplementation(() => undefined);
		exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		first = await plugin("alpha-tools", "export default function (pi) { /* alpha */ }\n");
		second = await plugin("beta-tools", "export default function (pi) { /* beta */ }\n");
		settings = settingsWith();
		registry = registryOf([SMOL, OTHER]);
		registryRequested = mock(async () => registry);
		tty = false;
		answers = [];
		analyzedRoots = [first, second];
		verdict = "prefer-first";
		beforeReply = undefined;
		io = {
			isInteractive: () => tty,
			confirm: mock(async () => answers.shift() ?? false),
			openRuntime: mock(async () => ({ settings, modelRegistry: registryRequested, close: () => undefined })),
		};
		modelCall = spyOn(ai, "completeSimple").mockImplementation((async () => {
			const snapshots = await Promise.all(
				analyzedRoots.map((root, index) =>
					snapshotResource({ id: `extension-${index + 1}`, label: "x", kind: "extension", root }),
				),
			);
			const evidence = snapshots.map(snapshot => ({
				candidateId: snapshot.candidate.id,
				file: snapshot.files.find(file => file.content.includes("export default"))?.path,
				quote: "export default",
				explanation: "entrypoint",
			}));
			await beforeReply?.();
			const recommendation =
				verdict === "prefer-first"
					? { action: "prefer", preferredId: "extension-1", reason: "the first is a superset" }
					: { action: "keep-all", reason: "they serve different purposes" };
			return {
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							relationship: "overlap",
							evidence,
							differences: ["they differ in behaviour"],
							recommendation,
							limitations: [],
						}),
					},
				],
			};
		}) as never);
	});
	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	test("parses the analysis flags", () => {
		const parsed = parsePluginArgs(["plugin", "doctor", "--analyze", "a", "b", "--model", "p/m", "--yes", "--apply"]);
		expect(parsed).toEqual({
			action: "doctor",
			args: ["a", "b"],
			flags: { analyze: true, model: "p/m", yes: true, apply: true },
		});
	});

	test("plain doctor runs the health check and opens no runtime, registry or model", async () => {
		await run({}, []);
		expect(doctor).toHaveBeenCalledTimes(1);
		expect(io.openRuntime).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
	});

	test("doctor --json output is unchanged without --analyze", async () => {
		await run({ json: true }, []);
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(printed()[0]).toBe(JSON.stringify([{ name: "bun", status: "ok", message: "fine" }], null, 2));
	});

	test("--fix with --analyze is rejected before any repair, runtime or model call", async () => {
		await refused({ analyze: true, fix: true, yes: true });
		expect(doctor).not.toHaveBeenCalled();
		expect(io.openRuntime).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
	});

	test("analysis flags are refused outside doctor --analyze", async () => {
		await expect(run({ analyze: true }, [], "list")).rejects.toThrow("process.exit");
		await expect(run({ yes: true }, [])).rejects.toThrow("process.exit");
		expect(io.openRuntime).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
	});

	test("the default terminal is interactive only when stdin, stdout and stderr are all terminals", () => {
		const states = [true, false];
		for (const stdin of states) {
			for (const stdout of states) {
				for (const stderr of states) {
					withTty({ stdin, stdout, stderr }, () => {
						expect(defaultPluginDoctorIo.isInteractive()).toBe(stdin && stdout && stderr);
					});
				}
			}
		}
	});

	test("without a terminal nothing is consented to: no runtime, catalog, model call or write, with or without --apply", async () => {
		await refused({ analyze: true });
		await refused({ analyze: true, yes: true, apply: true });
		expect(io.openRuntime).not.toHaveBeenCalled();
		expect(registryRequested).not.toHaveBeenCalled();
		expect(io.confirm).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});

	test("--apply with --json is refused before any model call even on a terminal", async () => {
		tty = true;
		await refused({ analyze: true, yes: true, apply: true, json: true });
		expect(registryRequested).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
	});

	test("declining the consent prompt sends nothing and exits cleanly", async () => {
		tty = true;
		answers = [false];
		await run({ analyze: true });
		expect(io.confirm).toHaveBeenCalledTimes(1);
		expect(modelCall).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});

	test("--yes runs the analysis read-only and sends exactly the two selected extensions", async () => {
		await plugin("gamma-tools", "export default function (pi) { /* gamma */ }\n");
		await run({ analyze: true, yes: true });
		expect(modelCall).toHaveBeenCalledTimes(1);
		const sent = sentToModel();
		expect(sent).toContain("/* alpha */");
		expect(sent).toContain("/* beta */");
		expect(sent).not.toContain("/* gamma */");
		expect(io.confirm).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});

	test("--yes --json writes one JSON document to stdout and keeps status text off it", async () => {
		await run({ analyze: true, yes: true, json: true });
		expect(console.log).toHaveBeenCalledTimes(1);
		const out = JSON.parse(printed()[0]);
		expect(out.applied).toBe(false);
		expect(out.model).toBe("analysis-lab/smol-reader");
		expect(out.candidates.map((candidate: { root: string }) => candidate.root)).toEqual([first, second]);
		const preferred = out.candidates.find(
			(candidate: { id: string }) => candidate.id === out.analysis.recommendation.preferredId,
		);
		expect(preferred?.root).toBe(first);
		expect(console.error).toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});

	test("the default model is the smol role and --model sends the request to exactly the model it names", async () => {
		await run({ analyze: true, yes: true });
		expect(modelCall.mock.calls[0]?.[0].id).toBe("smol-reader");

		await run({ analyze: true, yes: true, model: "analysis-lab/other-reader:high" });
		expect(modelCall.mock.calls[1]?.[0].id).toBe("other-reader");
		expect(modelCall.mock.calls[1]?.[2]).toMatchObject({ reasoning: "high" });
	});

	test("a --model that is not an exact authenticated model stops before any consent, snapshot send or model call", async () => {
		for (const model of ["reader", "analysis-lab/other", "nonexistent/model"]) {
			await refused({ analyze: true, yes: true, model });
		}
		expect(io.confirm).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
	});

	test("--apply asks its own confirmation after the report; --yes does not answer it", async () => {
		tty = true;
		answers = [false];
		await run({ analyze: true, yes: true, apply: true });
		expect(io.confirm).toHaveBeenCalledTimes(1);
		expect(modelCall).toHaveBeenCalledTimes(1);
		expect(io.confirm.mock.invocationCallOrder[0]).toBeGreaterThan(modelCall.mock.invocationCallOrder[0]);
		expect(exclusions()).toEqual({});
	});

	test("a confirmed --apply hides only the non-preferred copy and leaves installed files alone", async () => {
		tty = true;
		answers = [true];
		await run({ analyze: true, yes: true, apply: true });
		expect(Object.keys(exclusions())).toEqual([second]);
		expect(await Bun.file(path.join(second, "index.ts")).text()).toContain("beta");
		expect(await Bun.file(path.join(first, "index.ts")).text()).toContain("alpha");
	});

	test("an interactive run is two separate prompts: consent before the model call, apply after it", async () => {
		tty = true;
		answers = [true, true];
		await run({ analyze: true, apply: true });
		expect(io.confirm).toHaveBeenCalledTimes(2);
		const [consentAt, applyAt] = io.confirm.mock.invocationCallOrder;
		expect(consentAt).toBeLessThan(modelCall.mock.invocationCallOrder[0]);
		expect(modelCall.mock.invocationCallOrder[0]).toBeLessThan(applyAt);
		expect(Object.keys(exclusions())).toEqual([second]);
	});

	test("consenting to send does not consent to apply: a declined second prompt changes nothing", async () => {
		tty = true;
		answers = [true, false];
		await run({ analyze: true, apply: true });
		expect(modelCall).toHaveBeenCalledTimes(1);
		expect(exclusions()).toEqual({});
	});

	test("a keep-all recommendation never reaches the apply prompt", async () => {
		tty = true;
		verdict = "keep-all";
		await run({ analyze: true, yes: true, apply: true });
		expect(io.confirm).not.toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});

	test("content changed after analysis refuses the decision", async () => {
		tty = true;
		answers = [true];
		beforeReply = () => Bun.write(path.join(second, "index.ts"), "export default function (pi) { /* changed */ }\n");
		await refused({ analyze: true, yes: true, apply: true });
		expect(exclusions()).toEqual({});
		expect(await Bun.file(path.join(second, "index.ts")).text()).toContain("changed");
	});

	test("a partly read extension can be analyzed read-only, but --apply is refused before the model is paid", async () => {
		const partial = await plugin("partial-tools", "export default function (pi) { /* partial */ }\n");
		await fs.symlink(path.join(tmpRoot, "elsewhere"), path.join(partial, "linked"));
		tty = true;
		await refused({ analyze: true, yes: true, apply: true }, [partial, second]);
		expect(registryRequested).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();

		analyzedRoots = [partial, second];
		await run({ analyze: true, yes: true, json: true }, [partial, second]);
		const out = JSON.parse(printed().at(-1) as string);
		expect(out.candidates[0].complete).toBe(false);
		expect(modelCall).toHaveBeenCalledTimes(1);
		expect(exclusions()).toEqual({});
	});

	test("invalid selections stop before the catalog, a prompt or a model call", async () => {
		await refused({ analyze: true, yes: true }, [first]);
		await refused({ analyze: true, yes: true }, [first, first]);
		await refused({ analyze: true, yes: true }, [first, "no-such-plugin"]);
		expect(registryRequested).not.toHaveBeenCalled();
		expect(modelCall).not.toHaveBeenCalled();
		expect(io.confirm).not.toHaveBeenCalled();
	});

	test("a name resolves through configured roots and an ambiguous name is refused", async () => {
		settings = settingsWith({ extensions: [first, second] });
		await run({ analyze: true, yes: true }, ["alpha-tools", "beta-tools"]);
		expect(sentToModel()).toContain("/* alpha */");
		expect(sentToModel()).toContain("/* beta */");

		const twin = await plugin("twin", "export default function () {}\n");
		const otherTwin = path.join(tmpRoot, "nested", "twin");
		await fs.mkdir(path.dirname(otherTwin), { recursive: true });
		await fs.cp(twin, otherTwin, { recursive: true });
		settings = settingsWith({ extensions: [twin, otherTwin] });
		await refused({ analyze: true, yes: true }, ["twin", first]);
		expect(modelCall).toHaveBeenCalledTimes(1);
	});

	test("single extension files are selectable by name or path and only the non-preferred file is hidden", async () => {
		const solo = await script("solo.ts", "export default function (pi) { /* solo */ }\n");
		const duo = await script("duo.ts", "export default function (pi) { /* duo */ }\n");
		const other = await script("other.ts", "export default function (pi) { /* other */ }\n");
		settings = settingsWith({ extensions: [solo, duo, other] });
		tty = true;
		answers = [true];
		analyzedRoots = [solo, duo];
		await run({ analyze: true, yes: true, apply: true }, ["solo", duo]);
		expect(sentToModel()).toContain("/* solo */");
		expect(sentToModel()).toContain("/* duo */");
		expect(Object.keys(exclusions())).toEqual([duo]);
		// The decision names one file: its siblings in the same directory still load.
		const loaded = await discoverExtensionPaths([solo, duo, other], tmpRoot, [], {
			ambient: true,
			resourceExclusions: exclusions(),
		});
		const inExtDir = loaded.filter(file => file.startsWith(path.dirname(solo)));
		expect(inExtDir.sort()).toEqual([other, solo].sort());
	});

	test("a directory holding other extensions, the home directory, nested selections and a part of a known extension are refused", async () => {
		const a = await script("a.ts", "export default function () {}\n");
		await script("b.ts", "export default function () {}\n");
		settings = settingsWith({ extensions: [a, path.join(path.dirname(a), "b.ts")] });
		await refused({ analyze: true, yes: true }, [path.dirname(a), first]);
		await refused({ analyze: true, yes: true }, [os.homedir(), first]);
		await refused({ analyze: true, yes: true }, [first, path.join(first, "index.ts")]);

		// Hiding a package's entrypoint alone would leave its hooks, tools and skills loading.
		settings = settingsWith({ extensions: [first, second] });
		await refused({ analyze: true, yes: true, apply: true }, [path.join(first, "index.ts"), second]);
		await refused({ analyze: true, yes: true }, [first, path.join(second, "package.json")]);

		expect(modelCall).not.toHaveBeenCalled();
		expect(exclusions()).toEqual({});
	});
});
