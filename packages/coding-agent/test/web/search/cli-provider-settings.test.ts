import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SEARCH_PROVIDER_ORDER,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";

const WEB_SEARCH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"FIRECRAWL_API_KEY",
	"JINA_API_KEY",
	"KAGI_API_KEY",
	"MOONSHOT_API_KEY",
	"MOONSHOT_SEARCH_API_KEY",
	"PARALLEL_API_KEY",
	"PERPLEXITY_API_KEY",
	"SEARXNG_ENDPOINT",
	"SYNTHETIC_API_KEY",
	"TAVILY_API_KEY",
	"TINYFISH_API_KEY",
	"XAI_API_KEY",
] as const;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

let tempAgentDir: TempDir | undefined;
let originalEnv: Partial<Record<(typeof WEB_SEARCH_ENV_KEYS)[number], string | undefined>> = {};
let originalExitCode: typeof process.exitCode;

function responseUrl(input: string | Request | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL, _init?: RequestInit): Promise<Response> => {
			const url = responseUrl(input);
			if (url.startsWith("https://s.jina.ai/")) {
				return new Response(
					JSON.stringify({ data: [{ title: "Jina result", url: "https://jina.example", content: "jina" }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.tavily.com/search") {
				return new Response(
					JSON.stringify({
						answer: "Tavily answer",
						results: [{ title: "Tavily result", url: "https://tavily.example", content: "tavily" }],
						request_id: "req-test",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalEnv = Object.fromEntries(WEB_SEARCH_ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of WEB_SEARCH_ENV_KEYS) delete process.env[key];
	process.env.JINA_API_KEY = "test-jina-key";
	process.env.TAVILY_API_KEY = "test-tavily-key";
	originalExitCode = process.exitCode;
	process.exitCode = undefined;

	resetSettingsForTest();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	await Settings.init({
		inMemory: true,
		cwd: tempAgentDir.path(),
		overrides: {
			"providers.webSearchOrder": ["tavily"],
			"providers.webSearchExclude": ["jina"],
		},
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
	process.exitCode = originalExitCode;
	for (const key of WEB_SEARCH_ENV_KEYS) {
		restoreEnv(key, originalEnv[key]);
	}
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand provider settings", () => {
	it("applies the configured web-search order and exclusions before resolving the implicit chain", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());

		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "provider selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("Provider: Tavily (API)");
		expect(plain).not.toContain("Provider: Jina");
	});

	it("treats an explicit --provider as a one-shot override of the configured order", async () => {
		// Tavily heads the configured order, but an explicit `--provider jina`
		// forces Jina for this invocation without touching the configured chain.
		const currentTempDir = tempAgentDir;
		if (!currentTempDir) throw new Error("tempAgentDir missing");
		const onlyJinaTavily = SEARCH_PROVIDER_ORDER.filter(id => id !== "jina" && id !== "tavily");
		resetSettingsForTest();
		setSearchProviderOrder([]);
		setExcludedSearchProviders(onlyJinaTavily);
		await Settings.init({
			inMemory: true,
			cwd: currentTempDir.path(),
			overrides: { "providers.webSearchOrder": ["tavily"], "providers.webSearchExclude": onlyJinaTavily },
		});

		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());

		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "explicit provider override", provider: "jina", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("Provider: Jina");
		expect(plain).not.toContain("Provider: Tavily (API)");
	});
});
