import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { selectorCandidates, stdioModelResolver } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("uses a role-keyed chain when the role has no configured primary", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	// A retry must never move to a model the user did not select: a role's
	// built-in priority list would retry on any logged-in provider.
	it("never falls back to a role's built-in priority models", () => {
		const settings = Settings.isolated({});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		settings.setModelRole("smol", key(vertex));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([vertex]);
	});

	it("uses the inherited default chain for a role without its own chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("keeps an explicitly empty role chain from inheriting the default chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [], default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("keeps model-keyed chains ahead of configured role chains", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		cfgRetryFallbackChains.set(settings, { smol: [key(mini)], [key(fast)]: [key(vertex)] });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows model-keyed chains even when the role primary comes from its defaults", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("expands role fallbacks transitively without retrying a model in a cycle", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				smol: [key(vertex)],
				[key(vertex)]: [key(mini), key(fast)],
				[key(mini)]: [key(vertex)],
			},
		});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex, mini]);
	});

	it("does not add role defaults when model fallback is disabled", () => {
		const settings = Settings.isolated({ "retry.modelFallback": false });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("does not add role defaults to an explicit model selector", () => {
		expect(selectorCandidates(key(fast), Settings.isolated({}), registry)).toEqual([fast]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	describe("on a judge route", () => {
		const jev = getBundledModel("typesafe", "jev-1.14.0")!;
		const catalog = [...models, jev];
		const byKind = (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? catalog : catalog.filter(model => modelKind(model) === kind);
		const kinded = { getAll: byKind, getAvailable: byKind };

		it("resolves a judge model id and the judge role to the judge runner", () => {
			const settings = Settings.isolated({});
			expect(selectorCandidates(key(jev), settings, kinded, "judge")).toEqual([jev]);
			expect(selectorCandidates("@judge", settings, kinded, "judge")).toEqual([jev]);
		});

		it("keeps judge models out of chat routes", () => {
			expect(selectorCandidates(key(jev), Settings.isolated({}), kinded)).toEqual([]);
		});
	});
});

describe("auth-gateway stdio model resolver", () => {
	// A video job id is stateless: a fresh process must poll it without having submitted it.
	it("resolves an unrouted id only to the available video model it names", () => {
		const video = getBundledModel("openrouter", "alibaba/wan-2.6")!;
		const catalog = [fast, video];
		const resolve = stdioModelResolver(new Map(), {
			getAvailable: (kind: ModelKind | "all" = "chat") => catalog.filter(model => modelKind(model) === kind),
		});
		expect(resolve(key(video))).toBe(video);
		expect(resolve(key(fast))).toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("auth-gateway stdio process", () => {
	// Responses used to be cut off at 128 KiB when stdin ended before the reader caught up.
	it("delivers a response larger than the pipe buffer whole after its input ends", async () => {
		using agentDir = TempDir.createSync("@omp-gw-stdio-");
		const id = "x".repeat(300_000);
		const requestPath = agentDir.join("request.jsonl");
		await Bun.write(requestPath, `${JSON.stringify({ id, path: "/v1/unknown" })}\n`);
		// `sleep` keeps the reply unread until the gateway has had time to quit; nothing it emits marks that.
		const script = `"${process.execPath}" "${cliEntry}" auth-gateway stdio < "${requestPath}" | (sleep 3; cat)`;
		const proc = Bun.spawn(["bash", "-c", script], {
			cwd: agentDir.path(),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir.path() },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		const lines = output.trim().split("\n");
		expect(JSON.parse(lines.at(-1)!).id).toBe(id);
	}, 30_000);
});
