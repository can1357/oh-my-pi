import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { searchSearXNG } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("SearXNG web search provider", () => {
	afterEach(() => {
		resetSettingsForTest();
		delete process.env.SEARXNG_ENDPOINT;
		delete process.env.SEARXNG_TOKEN;
		delete process.env.SEARXNG_BASIC_USERNAME;
		delete process.env.SEARXNG_BASIC_PASSWORD;
	});

	it("sends RFC 7617 Basic auth when username and password are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org/";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { url?: URL; headers?: Headers } = {};
		const fetchMock: FetchImpl = (input, init) => {
			captured.url = new URL(input.toString());
			captured.headers = new Headers(init?.headers);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						results: [{ title: "SearXNG", url: "https://example.com/result", content: "Metasearch result" }],
						suggestions: ["related search"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const response = await searchSearXNG({
			query: "private search",
			num_results: 1,
			recency: "week",
			fetch: fetchMock,
		});

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.url?.pathname).toBe("/search");
		expect(captured.url?.searchParams.get("q")).toBe("private search");
		expect(captured.url?.searchParams.get("format")).toBe("json");
		expect(captured.url?.searchParams.get("time_range")).toBe("month");
		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
		expect(response).toMatchObject({
			provider: "searxng",
			relatedQuestions: ["related search"],
			sources: [{ title: "SearXNG", url: "https://example.com/result", snippet: "Metasearch result" }],
		});
	});

	it("demotes engine-hostile operators while keeping bare-domain site: filters", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";

		const captured: { q?: string | null } = {};
		const fetchMock: FetchImpl = input => {
			captured.q = new URL(input.toString()).searchParams.get("q");
			return Promise.resolve(
				new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({
			query: "site:github.com/can1357/oh-my-pi inurl:releases site:github.com 17.1.1 release",
			fetch: fetchMock,
		});

		expect(captured.q).toBe("17.1.1 release github.com/can1357/oh-my-pi releases site:github.com");
	});

	it("maps lang: to the language param and re-emits remaining directives in q", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";

		const captured: { url?: URL } = {};
		const fetchMock: FetchImpl = input => {
			captured.url = new URL(input.toString());
			return Promise.resolve(
				new Response(JSON.stringify({ results: [{ title: "r", url: "https://searxng.org/docs" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "docs lang:de site:searxng.org", fetch: fetchMock });

		expect(captured.url?.searchParams.get("q")).toBe("docs site:searxng.org");
		expect(captured.url?.searchParams.get("language")).toBe("de");
	});

	it("sends directive-free queries verbatim without a language param", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";

		const captured: { url?: URL } = {};
		const fetchMock: FetchImpl = input => {
			captured.url = new URL(input.toString());
			return Promise.resolve(
				new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "plain metasearch query", fetch: fetchMock });

		expect(captured.url?.searchParams.get("q")).toBe("plain metasearch query");
		expect(captured.url?.searchParams.get("language")).toBeNull();
	});

	it("sends configured category and safe-search filters and preserves instant answers", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-filters-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				["searxng:", "  endpoint: https://searx.example.org", "  categories: news", "  safesearch: 2", ""].join(
					"\n",
				),
			);
			await Settings.init({ agentDir });

			const captured: { url?: URL } = {};
			const fetchMock: FetchImpl = input => {
				captured.url = new URL(input.toString());
				return Promise.resolve(
					new Response(
						JSON.stringify({
							results: [{ title: "r", url: "https://example.com", snippet: "Fallback snippet" }],
							answers: [
								"  Forty-two  ",
								{ template: "answer/legacy.html", answer: "Legacy answer" },
								{
									template: "answer/translations.html",
									translations: [{ text: "Hallo" }, { text: "Guten Tag" }],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			};

			const response = await searchSearXNG({ query: "filtered answers", fetch: fetchMock });

			expect(captured.url?.searchParams.get("categories")).toBe("news");
			expect(captured.url?.searchParams.get("safesearch")).toBe("2");
			expect(response.answer).toBe("Forty-two\n\nLegacy answer\n\nHallo\nGuten Tag");
			expect(response.sources[0]?.snippet).toBe("Fallback snippet");
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("reads Basic auth credentials from nested config.yml settings", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-settings-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				[
					"searxng:",
					"  endpoint: https://searx.example.org",
					"  basicUsername: alice",
					"  basicPassword: s3cret",
					"",
				].join("\n"),
			);
			await Settings.init({ agentDir });

			const captured: { headers?: Headers } = {};
			const fetchMock: FetchImpl = (_input, init) => {
				captured.headers = new Headers(init?.headers);
				return Promise.resolve(
					new Response(JSON.stringify({ results: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			};

			await searchSearXNG({ query: "settings basic auth", fetch: fetchMock });

			expect(captured.headers?.get("Authorization")).toBe(
				`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
			);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("prefers Basic auth over bearer token when both are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		const fetchMock: FetchImpl = (_input, init) => {
			captured.headers = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "auth precedence", fetch: fetchMock });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("sends Basic auth when the password is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "";

		const captured: { headers?: Headers } = {};
		const fetchMock: FetchImpl = (_input, init) => {
			captured.headers = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "empty password", fetch: fetchMock });

		expect(captured.headers?.get("Authorization")).toBe(`Basic ${Buffer.from("alice:", "utf-8").toString("base64")}`);
	});

	it("sends Basic auth when the username is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		const fetchMock: FetchImpl = (_input, init) => {
			captured.headers = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "empty username", fetch: fetchMock });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from(":s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("requires both Basic auth username and password", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";

		await expect(searchSearXNG({ query: "missing password" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("requires a Basic auth username when only password is configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "missing username" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("rejects Basic auth usernames containing a colon", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice:admin";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "invalid username" })).rejects.toThrow(
			"SearXNG Basic auth username cannot contain ':'",
		);
	});

	it("rejects Basic auth usernames containing control characters", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice\u0007";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "invalid username control character" })).rejects.toThrow(
			"SearXNG Basic auth credentials must not contain RFC 7617 control characters",
		);
	});

	it("rejects Basic auth passwords containing control characters", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret\u0001";

		await expect(searchSearXNG({ query: "invalid password control character" })).rejects.toThrow(
			"SearXNG Basic auth credentials must not contain RFC 7617 control characters",
		);
	});

	it("keeps bearer token authentication when Basic auth is not configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";

		const captured: { headers?: Headers } = {};
		const fetchMock: FetchImpl = (_input, init) => {
			captured.headers = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "bearer search", fetch: fetchMock });

		expect(captured.headers?.get("Authorization")).toBe("Bearer bearer-token");
	});

	it("resolves engine shortcuts via /config into canonical names for the engines parameter", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-engines-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				[
					"searxng:",
					"  endpoint: https://searx-shortcuts.example.org",
					'  engines: "ddg, Brave, unknown"',
					"",
				].join("\n"),
			);
			await Settings.init({ agentDir });

			const requested: URL[] = [];
			const fetchMock: FetchImpl = input => {
				const url = new URL(input.toString());
				requested.push(url);
				if (url.pathname === "/config") {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								engines: [
									{ name: "duckduckgo", shortcut: "ddg" },
									{ name: "brave", shortcut: "br" },
								],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						),
					);
				}
				return Promise.resolve(
					new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com/r" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			};

			await searchSearXNG({ query: "engine selection", fetch: fetchMock });

			const searchUrl = requested.find(url => url.pathname === "/search");
			expect(searchUrl?.searchParams.get("engines")).toBe("duckduckgo,brave,unknown");
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("passes configured engines verbatim when /config is unavailable", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-engines-fallback-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				["searxng:", "  endpoint: https://searx-noconfig.example.org", '  engines: "ddg,brave"', ""].join("\n"),
			);
			await Settings.init({ agentDir });

			const requested: URL[] = [];
			const fetchMock: FetchImpl = input => {
				const url = new URL(input.toString());
				requested.push(url);
				if (url.pathname === "/config") {
					return Promise.resolve(new Response("forbidden", { status: 403 }));
				}
				return Promise.resolve(
					new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com/r" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			};

			await searchSearXNG({ query: "fallback engines", fetch: fetchMock });

			const searchUrl = requested.find(url => url.pathname === "/search");
			expect(searchUrl?.searchParams.get("engines")).toBe("ddg,brave");
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("strips external bang tokens but keeps engine bangs in the query", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx-bangs.example.org";

		const captured: { url?: URL } = {};
		const fetchMock: FetchImpl = input => {
			captured.url = new URL(input.toString());
			return Promise.resolve(
				new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com/r" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchSearXNG({ query: "!!g rust !ddg lifetimes", fetch: fetchMock });

		expect(captured.url?.pathname).toBe("/search");
		expect(captured.url?.searchParams.get("q")).toBe("rust !ddg lifetimes");
	});

	it("treats empty SearXNG results with upstream failures as a provider error", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";

		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						results: [],
						unresponsive_engines: [
							["brave", "Suspended: too many requests"],
							["duckduckgo", "CAPTCHA"],
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		await expect(searchSearXNG({ query: "throttled search", fetch: fetchMock })).rejects.toThrow(SearchProviderError);
		await expect(searchSearXNG({ query: "throttled search", fetch: fetchMock })).rejects.toThrow(
			"SearXNG returned no usable results; upstream engines failed: brave: Suspended: too many requests; duckduckgo: CAPTCHA",
		);
	});
});
