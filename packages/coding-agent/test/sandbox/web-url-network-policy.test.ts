/**
 * The sandbox's `network.mode` on web URLs that omp's in-process tools (`read`, `grep`, `ast_grep`)
 * fetch on the agent's behalf: the fetch runs on the host, so the tool declares the URL's host and the
 * gate refuses it before any request when the policy does not allow that host. Every host the read then
 * contacts, the URL's own included (redirects, page-derived links, reader backends), passes the same
 * policy in the transport, and a name allowed by name is also checked by the addresses it resolves to.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { sandboxCallDenial, sandboxSubjects } from "@oh-my-pi/pi-coding-agent/sandbox/gate";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxEnabled,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersFetch } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgToolsMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import {
	fetchWithHostGuard,
	guardedFetch,
	HostRefusal,
	HostUndecided,
	loadPage,
	primaryRequest,
	withRequestHostGuard,
} from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { fetchBinary } from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_SUPPORTED, SANDBOX_UNAVAILABLE } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
let agentDir: string;
let workspace: string;
let runtimes: SandboxRuntime[];
let authRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let server: Bun.Server<undefined>;
let requests: number;
/** Requests `server` received, by path. */
let hits: Map<string, number>;
let origin: string;
/**
 * Redirects to `server`: `/other-host` at `localhost` (another host than its own `127.0.0.1`),
 * `/same-host` at `127.0.0.1`, `/unlisted` at `unlisted.example`.
 */
let redirector: Bun.Server<undefined>;
/** What `Bun.dns.lookup` answers per name in a test; any other name fails to resolve. */
let dnsRecords: Record<string, string[]>;
/** The `Bun.dns.lookup` stub answering from {@link dnsRecords}. */
let dnsLookup: Mock<typeof Bun.dns.lookup>;

/** One line of prose long enough for the native reader to accept the page as rendered. */
const PARAGRAPH = "The guarded page body is ordinary prose that renders to markdown. ".repeat(12);

function htmlPage(head = ""): Response {
	const html = `<!doctype html><html><head><title>Guarded page</title>${head}</head><body><article><h1>Guarded page</h1><p>${PARAGRAPH}</p></article></body></html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

beforeAll(async () => {
	authRoot = TempDir.createSync("@omp-web-url-policy-auth-");
	authStorage = await AuthStorage.create(path.join(authRoot.path(), "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage);
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: request => {
			requests++;
			const { pathname } = new URL(request.url);
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			if (pathname === "/alt-page") {
				// A page-specific markdown alternate on another host, which the page alone chose.
				return htmlPage(
					`<link rel="alternate" type="text/markdown" href="http://localhost:${server.port}/alt-page.md">`,
				);
			}
			if (pathname === "/reader-page") return htmlPage();
			if (pathname === "/alt-page.md") {
				return new Response(`# Alternate\n\n${PARAGRAPH}`, { headers: { "content-type": "text/markdown" } });
			}
			return new Response("served page body", { headers: { "content-type": "text/plain" } });
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	redirector = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: request => {
			const { pathname } = new URL(request.url);
			const host =
				pathname === "/other-host" ? "localhost" : pathname === "/unlisted" ? "unlisted.example" : "127.0.0.1";
			return new Response(null, { status: 302, headers: { location: `http://${host}:${server.port}/final` } });
		},
	});
});

afterAll(async () => {
	await server.stop(true);
	await redirector.stop(true);
	authStorage.close();
	authRoot.removeSync();
});

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-web-url-policy-");
	const root = fs.realpathSync(scratch.path());
	agentDir = path.join(root, "agent");
	workspace = path.join(root, "workspace");
	const tmp = path.join(root, "tmp");
	for (const dir of [agentDir, workspace, tmp]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	runtimes = [];
	requests = 0;
	hits = new Map();
	dnsRecords = { "github.com": ["140.82.121.4"], "www.youtube.com": ["142.250.185.78"] };
	dnsLookup = vi.spyOn(Bun.dns, "lookup").mockImplementation(async (hostname: string) => {
		const addresses = dnsRecords[hostname];
		if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
		return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4, ttl: 0 }));
	});
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
	cfgSandboxEnabled.set(settings, true);
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

function toolSession(fetch?: FetchImpl): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		getSessionSpawns: () => null,
		getSessionFile: () => null,
		settings,
		fetch,
	} as unknown as ToolSession;
}

/** A wrapped tool's call. */
type ToolCall = (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;

/** `tool` behind the wrapper every registry tool runs through, so the sandbox gate sees its call. */
async function wrapped(tool: AgentTool): Promise<ToolCall> {
	runtimes.push(await SandboxRuntime.for(workspace));
	const session = SessionManager.inMemory(workspace);
	const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, session, modelRegistry);
	const wrapper = new ExtensionToolWrapper(tool, runner);
	const context = { sessionManager: session, modelRegistry, settings } as unknown as AgentToolContext;
	return args => wrapper.execute("c1", args, undefined, undefined, context);
}

/** The read tool behind the wrapper. */
async function wrappedRead(fetch?: FetchImpl): Promise<(target: string) => Promise<AgentToolResult<unknown>>> {
	const execute = await wrapped(new ReadTool(toolSession(fetch)) as unknown as AgentTool);
	return target => execute({ path: target });
}

const bodyOf = (result: AgentToolResult<unknown>) =>
	result.content.map(block => (block.type === "text" ? block.text : "")).join("");

/** The refusal text of `call`, or `""` when it succeeded. */
const refusalOf = (call: Promise<unknown>) =>
	call.then(
		() => "",
		(error: Error) => error.message,
	);

/** Records the hostname of every request `fetch` is asked to make and answers each with an HTML page. */
function recordFetches(): string[] {
	const contacted: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		contacted.push(new URL(input instanceof Request ? input.url : input).hostname);
		return htmlPage();
	}) as typeof fetch);
	return contacted;
}

describe("web URL reads under sandbox.network.mode", () => {
	it("deny refuses the read before any request is made", async () => {
		cfgSandboxNetworkMode.set(settings, "deny");
		const read = await wrappedRead();
		const refusal = await read(`${origin}/page`).then(
			() => "",
			(error: Error) => error.message,
		);
		expect(refusal).toContain("sandbox.network.mode. NEVER");
		expect(refusal).not.toContain("..");
		expect(requests).toBe(0);
	});

	it("allowlist admits a listed host and refuses an unlisted one naming kind host and the host", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		const result = await read(`${origin}/page`);
		expect(bodyOf(result)).toContain("served page body");
		expect(requests).toBe(1);

		await expect(read(`http://unlisted.example:${server.port}/page`)).rejects.toThrow(
			"`host` access to `unlisted.example`",
		);
		expect(requests).toBe(1);
	});

	it("allow admits every host, and a disabled sandbox does not check the host at all", async () => {
		cfgSandboxNetworkMode.set(settings, "allow");
		const read = await wrappedRead();
		await read(`${origin}/page`);
		expect(requests).toBe(1);

		cfgSandboxNetworkMode.set(settings, "deny");
		cfgSandboxEnabled.set(settings, false);
		await read(`${origin}/page`);
		expect(requests).toBe(2);
	});

	it("a session grant of the host lifts an allowlist refusal", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, []);
		const runtime = await SandboxRuntime.for(workspace);
		runtimes.push(runtime);
		const read = new ReadTool(toolSession()) as unknown as AgentTool;
		const denial = () =>
			sandboxCallDenial({
				settings,
				workspace,
				name: "read",
				subjects: () => sandboxSubjects(read, { path: "https://docs.example/page" }, "read"),
				requestTool: () => true,
			});
		expect(await denial()).toContain("docs.example is not on the sandbox's network allowlist");
		runtime.grantHost("docs.example", "session");
		expect(await denial()).toBeUndefined();
	});

	it("a list naming an allowed and an unlisted host is refused whole", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		await expect(read(`${origin}/a;http://unlisted.example:${server.port}/b`)).rejects.toThrow("`unlisted.example`");
		expect(requests).toBe(0);
	});

	it("grep of a URL root is refused in deny mode before any request", async () => {
		cfgSandboxNetworkMode.set(settings, "deny");
		const grep = await wrapped(new GrepTool(toolSession()) as unknown as AgentTool);
		await expect(grep({ pattern: "x", path: `${origin}/page` })).rejects.toThrow(/network is off/i);
		expect(requests).toBe(0);
	});
});

describe("web URLs execution unquotes or peels further than the call names them, under sandbox.network.mode", () => {
	it("refuses a quoted URL part of a read list before any request", async () => {
		cfgSandboxNetworkMode.set(settings, "deny");
		const read = await wrappedRead();
		expect(await refusalOf(read(`nosuch;"${origin}/x"`))).toMatch(/network is off/i);
		expect(requests).toBe(0);
	});

	it("refuses a list whose quoted second part names an unlisted host before any request", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		const refusal = await refusalOf(read(`${origin}/a;"http://localhost:${server.port}/b"`));
		expect(refusal).toContain("Sandbox refused `read`");
		expect(refusal).toContain("localhost");
		expect(requests).toBe(0);
	});

	it("checks the URL's own host in the transport as well, naming the calling tool", async () => {
		cfgSandboxNetworkMode.set(settings, "deny");
		const refusal = await refusalOf(
			fetchReadUrl(toolSession(), { path: `${origin}/page` }, undefined, { toolName: "grep" }),
		);
		expect(refusal).toContain("Sandbox refused `grep`: The sandbox's network is off");
		expect(requests).toBe(0);

		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const entry = await fetchReadUrl(toolSession(), { path: `${origin}/page` }, undefined, { toolName: "grep" });
		expect(entry.content).toContain("served page body");
		expect(requests).toBe(1);
	});
});

describe("web URL hosts allowed by name, by the addresses they resolve to", () => {
	beforeEach(() => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
	});

	it("refuses a wildcard-matched name that resolves to loopback or a private range, without contacting it", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		dnsRecords["app.localtest.me"] = ["127.0.0.1"];
		dnsRecords["intra.localtest.me"] = ["10.1.2.3"];
		const contacted = recordFetches();
		const read = await wrappedRead();
		const loopback = await refusalOf(read(`http://app.localtest.me:${server.port}/`));
		expect(loopback).toContain("app.localtest.me resolves to 127.0.0.1");
		expect(loopback).toContain("this cannot be requested");
		expect(await refusalOf(read("http://intra.localtest.me/"))).toContain("intra.localtest.me resolves to 10.1.2.3");
		expect(contacted).toEqual([]);
	});

	it("refuses a wildcard-matched name when any one of its addresses is not public", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		dnsRecords["mixed.localtest.me"] = ["93.184.215.14", "127.0.0.1"];
		const contacted = recordFetches();
		const read = await wrappedRead();
		const refusal = await refusalOf(read("http://mixed.localtest.me/"));
		expect(refusal).toContain("mixed.localtest.me resolves to 93.184.215.14, 127.0.0.1");
		expect(refusal).toContain("this cannot be requested");
		expect(contacted).toEqual([]);
	});

	it("admits a wildcard-matched name that resolves to public addresses only", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		dnsRecords["docs.localtest.me"] = ["93.184.215.14"];
		const contacted = recordFetches();
		const read = await wrappedRead();
		expect(bodyOf(await read("http://docs.localtest.me/"))).toContain("The guarded page body is ordinary prose");
		expect(contacted).toContain("docs.localtest.me");
	});

	it("refuses a session-granted name that resolves to loopback, and no grant lifts it", async () => {
		cfgSandboxAllowedHosts.set(settings, []);
		dnsRecords["granted.example"] = ["127.0.0.1"];
		const runtime = await SandboxRuntime.for(workspace);
		runtimes.push(runtime);
		runtime.grantHost("granted.example", "session");
		const contacted = recordFetches();
		const read = await wrappedRead();
		const refusal = await refusalOf(read(`http://granted.example:${server.port}/`));
		expect(refusal).toContain("granted.example resolves to 127.0.0.1");
		expect(refusal).toContain("this cannot be requested");
		expect(contacted).toEqual([]);
	});

	it("admits a session-granted name that resolves to a private range", async () => {
		cfgSandboxAllowedHosts.set(settings, []);
		dnsRecords["granted.example"] = ["10.1.2.3"];
		const runtime = await SandboxRuntime.for(workspace);
		runtimes.push(runtime);
		runtime.grantHost("granted.example", "session");
		const contacted = recordFetches();
		const read = await wrappedRead();
		expect(bodyOf(await read("http://granted.example/"))).toContain("The guarded page body is ordinary prose");
		expect(contacted).toContain("granted.example");
	});

	it("admits an exactly listed name that resolves to a private range, and refuses it on loopback", async () => {
		cfgSandboxAllowedHosts.set(settings, ["intranet.example"]);
		dnsRecords["intranet.example"] = ["10.1.2.3"];
		const contacted = recordFetches();
		const read = await wrappedRead();
		expect(bodyOf(await read("http://intranet.example/"))).toContain("The guarded page body is ordinary prose");
		expect(contacted).toContain("intranet.example");

		contacted.length = 0;
		dnsRecords["intranet.example"] = ["127.0.0.1"];
		const fresh = await wrappedRead();
		const refusal = await refusalOf(fresh("http://intranet.example/other"));
		expect(refusal).toContain("intranet.example resolves to 127.0.0.1");
		expect(refusal).toContain("this cannot be requested");
		expect(contacted).toEqual([]);
	});

	it("judges a name listed exactly and matched by a wildcard as listed, admitting a private range", async () => {
		cfgSandboxAllowedHosts.set(settings, ["intranet.example", "*.example"]);
		dnsRecords["intranet.example"] = ["10.1.2.3"];
		const contacted = recordFetches();
		const read = await wrappedRead();
		expect(bodyOf(await read("http://intranet.example/"))).toContain("The guarded page body is ordinary prose");
		expect(contacted).toContain("intranet.example");
	});

	it("fails the read of an allowed name that does not resolve without contacting it, as no sandbox refusal", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		dnsRecords["empty.localtest.me"] = [];
		const contacted = recordFetches();
		const read = await wrappedRead();
		for (const host of ["gone.localtest.me", "empty.localtest.me"]) {
			const body = bodyOf(await read(`http://${host}/`));
			expect(body).toContain(`cannot resolve ${host}`);
		}
		expect(contacted).toEqual([]);
	});

	it("stops waiting for a lookup that never answers when the read is cancelled", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		const controller = new AbortController();
		dnsLookup.mockImplementation(() => {
			controller.abort();
			return new Promise(() => {});
		});
		const contacted = recordFetches();
		const read = fetchReadUrl(toolSession(), { path: "http://slow.localtest.me/" }, controller.signal);
		await expect(read).rejects.toBeInstanceOf(ToolAbortError);
		expect(contacted).toEqual([]);
	}, 5_000);

	// The read's timeout is an `AbortSignal.timeout` on the platform clock, which fake timers do not drive.
	it("gives up on a lookup that never answers after the read's timeout, as no sandbox refusal", async () => {
		cfgSandboxAllowedHosts.set(settings, ["*.localtest.me"]);
		cfgToolsMaxTimeout.set(settings, 1);
		dnsLookup.mockImplementation(() => new Promise(() => {}));
		const contacted = recordFetches();
		const entry = await fetchReadUrl(toolSession(), { path: "http://slow.localtest.me/" });
		expect(entry.output).toContain("checking slow.localtest.me timed out");
		expect(contacted).toEqual([]);
	}, 10_000);
});

describe("web URL sandbox subjects", () => {
	const readSubjects = (target: string) => new ReadTool(toolSession()).sandboxSubjects({ path: target });

	it("names the canonical host: punycode, lowercase, no port, no IPv6 brackets, no trailing path or selector", () => {
		expect(readSubjects("https://Example.COM:8443/a/b?q=1")).toEqual([{ kind: "host", target: "example.com" }]);
		expect(readSubjects("https://bücher.example/x")).toEqual([{ kind: "host", target: "xn--bcher-kva.example" }]);
		expect(readSubjects("http://[::1]:8080/")).toEqual([{ kind: "host", target: "::1" }]);
		expect(readSubjects("https://example.org/doc:10-20")).toEqual([{ kind: "host", target: "example.org" }]);
		expect(readSubjects("www.example.net/page")).toEqual([{ kind: "host", target: "www.example.net" }]);
	});

	it("names each distinct host of a list once", () => {
		expect(readSubjects("https://a.example/x;https://b.example/y;https://a.example/z")).toEqual([
			{ kind: "host", target: "a.example" },
			{ kind: "host", target: "b.example" },
		]);
	});

	it("names the hosts of quoted list parts and doubly quoted entries, and of a URL with a malformed selector", () => {
		// The unparsed entry also rides along as a read path subject: execution may take it as a file name.
		expect(readSubjects('nosuch;"https://q.example/x"')).toContainEqual({ kind: "host", target: "q.example" });
		expect(readSubjects('""https://qq.example/x""')).toContainEqual({ kind: "host", target: "qq.example" });
		expect(readSubjects("https://r.example/x:5-10:20-30")).toEqual([{ kind: "host", target: "r.example" }]);
	});

	it("declares nothing for local paths and internal URLs, so the gate derives path subjects as before", () => {
		expect(readSubjects("src/a.ts")).toBeUndefined();
		expect(readSubjects("skill://brainstorming")).toBeUndefined();
		expect(readSubjects("local://plan.md")).toBeUndefined();
		expect(readSubjects("pr://1")).toBeUndefined();
	});

	it("grep and ast_grep declare the hosts of the URL roots they fetch", () => {
		const grep = new GrepTool(toolSession());
		expect(grep.sandboxSubjects({ pattern: "x", path: "https://docs.example/api" })).toEqual([
			{ kind: "host", target: "docs.example" },
		]);
		expect(grep.sandboxSubjects({ pattern: "x", path: "src" })).toBeUndefined();
		const astGrep = new AstGrepTool(toolSession());
		expect(astGrep.sandboxSubjects({ pat: ["x"], path: "https://docs.example/api.ts" })).toEqual([
			{ kind: "host", target: "docs.example" },
		]);
		expect(astGrep.sandboxSubjects({ pat: ["x"], path: "src" })).toBeUndefined();
	});

	it("grep and ast_grep declare the hosts of quoted list parts, doubly quoted entries and a URL with several range groups", () => {
		const grep = new GrepTool(toolSession()) as unknown as AgentTool;
		const astGrep = new AstGrepTool(toolSession()) as unknown as AgentTool;
		const hosts = (tool: AgentTool, args: Record<string, unknown>) =>
			sandboxSubjects(tool, args, "read")
				.filter(subject => subject.kind === "host")
				.map(subject => subject.target);
		expect(hosts(grep, { pattern: "x", path: 'notes.md;"https://q.example/x"' })).toEqual(["q.example"]);
		expect(hosts(astGrep, { pat: ["x"], path: 'a.ts;"https://q.example/x.ts"' })).toEqual(["q.example"]);
		expect(hosts(grep, { pattern: "x", path: '""https://qq.example/x""' })).toEqual(["qq.example"]);
		expect(hosts(grep, { pattern: "x", path: ['""https://qq.example/x""'] })).toEqual(["qq.example"]);
		expect(hosts(astGrep, { pat: ["x"], path: '""https://qq.example/x.ts""' })).toEqual(["qq.example"]);
		expect(hosts(grep, { pattern: "x", path: "https://r.example/x:5-10:20-30" })).toEqual(["r.example"]);
	});

	it("keeps the local files of a mixed call as read subjects beside its hosts, since declared subjects replace derived ones", () => {
		fs.writeFileSync(path.join(workspace, "notes.md"), "x");
		const grep = new GrepTool(toolSession());
		expect(grep.sandboxSubjects({ pattern: "x", path: ["https://docs.example/api", "notes.md"] })).toEqual([
			{ kind: "host", target: "docs.example" },
			{ kind: "read", target: path.join(workspace, "notes.md"), recursive: false },
		]);
	});
});

describe("web URL reads that redirect, under sandbox.network.mode", () => {
	it("refuses a redirect from an allowed host to an unlisted one before requesting it", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		await expect(read(`http://127.0.0.1:${redirector.port}/unlisted`)).rejects.toThrow(
			"Sandbox refused `read`: unlisted.example is not on the sandbox's network allowlist",
		);
		expect(requests).toBe(0);
	});

	it("names the calling tool when a grep root redirects to an unlisted host", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const grep = await wrapped(new GrepTool(toolSession()) as unknown as AgentTool);
		await expect(grep({ pattern: "x", path: `http://127.0.0.1:${redirector.port}/unlisted` })).rejects.toThrow(
			"Sandbox refused `grep`: unlisted.example is not on the sandbox's network allowlist",
		);
		expect(requests).toBe(0);
	});

	it("follows a redirect within the allowed hosts, and to a host the allowlist names", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		const same = await read(`http://127.0.0.1:${redirector.port}/same-host`);
		expect(bodyOf(same)).toContain("served page body");
		expect(requests).toBe(1);

		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1", "localhost"]);
		const other = await read(`http://127.0.0.1:${redirector.port}/other-host`);
		expect(bodyOf(other)).toContain("served page body");
		expect(requests).toBe(2);
	});

	it("follows redirects as before in allow mode and with the sandbox off", async () => {
		cfgSandboxNetworkMode.set(settings, "allow");
		const read = await wrappedRead();
		expect(bodyOf(await read(`http://127.0.0.1:${redirector.port}/other-host`))).toContain("served page body");
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		cfgSandboxEnabled.set(settings, false);
		expect(bodyOf(await read(`http://127.0.0.1:${redirector.port}/other-host`))).toContain("served page body");
		expect(requests).toBe(2);
	});

	it("the final URL of a followed redirect is the page it reached", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		const result = await read(`http://127.0.0.1:${redirector.port}/same-host`);
		expect(bodyOf(result)).toContain(`URL: ${origin}/final`);
	});
});

describe("optional requests of a web URL read, under sandbox.network.mode", () => {
	it("skips a page's markdown alternate on an unlisted host and returns the page with a note", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		const read = await wrappedRead();
		const body = bodyOf(await read(`${origin}/alt-page`));
		expect(hits.get("/alt-page.md")).toBeUndefined();
		expect(body).toContain("The guarded page body is ordinary prose");
		expect(body).toContain("Skipped requests to localhost: not allowed by the sandbox's network policy");
	});

	it("skips a reader backend on an unlisted host and renders the page natively with a note", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		cfgProvidersFetch.set(settings, "jina");
		const readerUrls: string[] = [];
		const reader: FetchImpl = async input => {
			readerUrls.push(String(input));
			return new Response("reader unavailable", { status: 503 });
		};
		const read = await wrappedRead(reader);
		const body = bodyOf(await read(`${origin}/reader-page`));
		expect(readerUrls).toEqual([]);
		expect(body).toContain("The guarded page body is ordinary prose");
		expect(body).toContain("Skipped requests to r.jina.ai: not allowed by the sandbox's network policy");

		// The same read with the sandbox off reaches the reader, so the refusal above is the policy's.
		cfgSandboxEnabled.set(settings, false);
		await read(`${origin}/reader-page`);
		expect(readerUrls).toEqual([`https://r.jina.ai/${origin}/reader-page`]);
	});

	it("does not run trafilatura, which fetches outside the policy, unless the network mode admits every host", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		cfgProvidersFetch.set(settings, "trafilatura");
		const ensureTool = vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		const read = await wrappedRead();
		const body = bodyOf(await read(`${origin}/reader-page`));
		expect(ensureTool).not.toHaveBeenCalled();
		expect(body).toContain("The guarded page body is ordinary prose");
		expect(body).toContain("Skipped trafilatura: it fetches outside the sandbox's network policy");

		cfgSandboxNetworkMode.set(settings, "allow");
		await read(`${origin}/reader-page`);
		expect(ensureTool).toHaveBeenCalledTimes(1);
	});

	it("runs trafilatura without a note when no backend contains the session under fallback warn", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["127.0.0.1"]);
		cfgProvidersFetch.set(settings, "trafilatura");
		const ensureTool = vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		const read = await wrappedRead();
		const body = bodyOf(await read(`${origin}/reader-page`));
		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(body).toContain("The guarded page body is ordinary prose");
		expect(body).not.toContain("Skipped");
	});

	it("skips a site handler's API on an unlisted host and reads the listed page itself", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		cfgSandboxAllowedHosts.set(settings, ["github.com"]);
		const contacted: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			contacted.push(new URL(input instanceof Request ? input.url : input).hostname);
			return htmlPage();
		}) as typeof fetch);
		const read = await wrappedRead();
		const body = bodyOf(await read("https://github.com/owner/repo/issues/1"));
		expect(contacted).not.toContain("api.github.com");
		expect(contacted).toContain("github.com");
		expect(body).toContain("The guarded page body is ordinary prose");
		expect(body).toContain("Skipped requests to api.github.com: not allowed by the sandbox's network policy");
	});
});

describe("host guard in the page transport", () => {
	it("asks about the first request's host, once per host, and contacts it only when admitted", async () => {
		const seen: string[] = [];
		const refuse = (host: string) => {
			seen.push(host);
			throw new Error(`no ${host}`);
		};
		const refused = await withRequestHostGuard(refuse, async () => {
			await loadPage(`${origin}/page`);
			return loadPage(`${origin}/again`);
		});
		expect(refused.result.ok).toBe(false);
		expect(seen).toEqual(["127.0.0.1"]);
		expect(requests).toBe(0);

		const admitted = await withRequestHostGuard(
			host => void seen.push(host),
			() => loadPage(`${origin}/page`),
		);
		expect(admitted.result.content).toBe("served page body");
		expect(seen).toEqual(["127.0.0.1", "127.0.0.1"]);
		expect(requests).toBe(1);
	});

	it("a refused redirect fails a primary request with the denial and skips an optional one with a note", async () => {
		const refuseOthers = (host: string) => {
			if (host !== "127.0.0.1") throw new Error(`no ${host}`);
		};
		const target = `http://127.0.0.1:${redirector.port}/other-host`;
		await expect(withRequestHostGuard(refuseOthers, () => primaryRequest(() => fetchBinary(target)))).rejects.toThrow(
			"no localhost",
		);

		const optional = await withRequestHostGuard(refuseOthers, () => fetchBinary(target));
		expect(optional.result.ok).toBe(false);
		expect(optional.skipped).toEqual(["Skipped requests to localhost: not allowed by the sandbox's network policy"]);
		expect(requests).toBe(0);
	});

	it("a refused guarded fetch fails a primary request with a HostRefusal and skips an optional one with a note", async () => {
		const refuse = (host: string) => {
			throw new Error(`no ${host}`);
		};
		let reached = 0;
		const upstream = async () => {
			reached++;
			return new Response("sent");
		};
		const call = () =>
			guardedFetch(upstream)("https://api.x.ai/v1/responses", { method: "POST" }).then(
				() => undefined,
				(error: unknown) => error,
			);

		const primary = await withRequestHostGuard(refuse, () => primaryRequest(call));
		expect(primary.result).toBeInstanceOf(HostRefusal);
		expect(primary.result).toMatchObject({ host: "api.x.ai", denial: { message: "no api.x.ai" } });

		const optional = await withRequestHostGuard(refuse, call);
		expect(optional.result).toBeInstanceOf(HostRefusal);
		expect(optional.skipped).toEqual(["Skipped requests to api.x.ai: not allowed by the sandbox's network policy"]);
		expect(reached).toBe(0);
	});

	it("a redirect loop across hosts ends in a failed load and asks the guard once per new host", async () => {
		const loop = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: request => {
				const next = new URL(request.url);
				next.hostname = next.hostname === "localhost" ? "127.0.0.1" : "localhost";
				return new Response(null, { status: 302, headers: { location: next.href } });
			},
		});
		try {
			const seen: string[] = [];
			const { result } = await withRequestHostGuard(
				host => void seen.push(host),
				() => loadPage(`http://127.0.0.1:${loop.port}/start`, { timeout: 10 }),
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("redirect");
			expect(seen).toEqual(["127.0.0.1", "localhost"]);
		} finally {
			await loop.stop(true);
		}
	});

	it("a host the guard cannot decide fails the request as a transport error, unrecorded, and is asked about again", async () => {
		const seen: string[] = [];
		const undecided = (host: string) => {
			seen.push(host);
			throw new HostUndecided(new Error(`cannot resolve ${host}`));
		};
		const optional = await withRequestHostGuard(undecided, async () => {
			const first = await fetchBinary(`${origin}/page`);
			await fetchBinary(`${origin}/again`);
			return first;
		});
		expect(optional.result).toMatchObject({ ok: false, error: "cannot resolve 127.0.0.1" });
		expect(optional.skipped).toEqual([]);
		expect(seen).toEqual(["127.0.0.1", "127.0.0.1"]);

		const primary = await withRequestHostGuard(undecided, () => primaryRequest(() => fetchBinary(`${origin}/page`)));
		expect(primary.result).toMatchObject({ ok: false, error: "cannot resolve 127.0.0.1" });

		const check = await withRequestHostGuard(undecided, () =>
			guardedFetch(async () => new Response("sent"))("https://api.x.ai/v1/responses").then(
				() => undefined,
				(error: unknown) => error,
			),
		);
		expect(check.result).not.toBeInstanceOf(HostRefusal);
		expect(check.result).toMatchObject({ message: "cannot resolve api.x.ai" });
		expect(check.skipped).toEqual([]);
		expect(requests).toBe(0);
	});

	// The per-request limit is an `AbortSignal.timeout` inside `loadPage`, on the platform clock, which fake timers do not drive.
	it("a request stops waiting for a pending host decision at its own time limit, sharing the one decision", async () => {
		const seen: string[] = [];
		// A lookup bounded only by a read limit far beyond the request's: it never settles here.
		const slow = (host: string) => {
			seen.push(host);
			return Promise.withResolvers<void>().promise;
		};
		const started = Date.now();
		const { result, skipped } = await withRequestHostGuard(slow, () => loadPage(`${origin}/page`, { timeout: 1 }));
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(result).toMatchObject({ ok: false, error: "checking 127.0.0.1 timed out" });
		expect(skipped).toEqual([]);
		expect(seen).toEqual(["127.0.0.1"]);
		expect(requests).toBe(0);
	}, 15_000);

	it("drops a host decision that failed after every request gave up waiting, so the next request asks again", async () => {
		const seen: string[] = [];
		const lookup = Promise.withResolvers<void>();
		const guard = async (host: string) => {
			seen.push(host);
			if (seen.length > 1) throw new HostUndecided(new Error(`cannot resolve ${host}: again`));
			await lookup.promise;
			throw new HostUndecided(new Error(`cannot resolve ${host}: timed out`));
		};
		const { result } = await withRequestHostGuard(guard, async () => {
			const gaveUp = new AbortController();
			const pending = fetchWithHostGuard(`${origin}/page`, { signal: gaveUp.signal }).then(
				() => undefined,
				(error: unknown) => error,
			);
			gaveUp.abort();
			const first = await pending;
			// The lookup fails only after its one request stopped waiting; a macrotask lets the decision settle.
			lookup.resolve();
			const settled = Promise.withResolvers<void>();
			setImmediate(settled.resolve);
			await settled.promise;
			const second = await fetchWithHostGuard(`${origin}/page`, {}).then(
				() => undefined,
				(error: unknown) => error,
			);
			return { first, second };
		});
		expect(result.first).toMatchObject({ message: "checking 127.0.0.1 timed out" });
		expect(result.second).toMatchObject({ message: "cannot resolve 127.0.0.1: again" });
		expect(seen).toEqual(["127.0.0.1", "127.0.0.1"]);
		expect(requests).toBe(0);
	});
});

describe("redirects followed under a host guard keep fetch's request rules", () => {
	interface Received {
		method: string;
		body: string;
		headers: Record<string, string | undefined>;
	}
	let received: Received[];
	let target: Bun.Server<undefined>;
	let source: Bun.Server<undefined>;

	beforeAll(() => {
		const record = async (request: Request) => {
			received.push({
				method: request.method,
				body: await request.text(),
				headers: Object.fromEntries(request.headers),
			});
			return new Response("ok", { headers: { "content-type": "text/plain" } });
		};
		target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: record });
		source = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: request => {
				const { pathname } = new URL(request.url);
				if (pathname === "/echo") return record(request);
				// Another port is another origin, though the host is the same.
				if (pathname === "/cross") {
					return new Response(null, {
						status: 302,
						headers: { location: `http://127.0.0.1:${target.port}/echo` },
					});
				}
				const status = Number(pathname.slice(1));
				return new Response(null, { status, headers: { location: "/echo" } });
			},
		});
	});

	afterAll(async () => {
		await target.stop(true);
		await source.stop(true);
	});

	beforeEach(() => {
		received = [];
	});

	const credentials = {
		authorization: "Bearer secret",
		cookie: "session=1",
		"proxy-authorization": "Basic secret",
	};

	const load = (pathname: string, options: { method?: string; body?: string; headers?: Record<string, string> }) =>
		withRequestHostGuard(
			() => {},
			() => loadPage(`http://127.0.0.1:${source.port}${pathname}`, { ...options, timeout: 10 }),
		);

	it("drops credentials on a cross-origin hop and keeps them on a same-origin one", async () => {
		await load("/cross", { headers: credentials });
		await load("/302", { headers: credentials });
		expect(received).toHaveLength(2);
		for (const name of Object.keys(credentials)) expect(received[0].headers[name]).toBeUndefined();
		expect(received[1].headers).toMatchObject(credentials);
	});

	it("turns a POST into a bodiless GET on 301, 302 and 303, and keeps it on 307", async () => {
		const post = { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } };
		for (const status of [301, 302, 303]) await load(`/${status}`, post);
		await load("/307", post);
		expect(received.map(({ method, body, headers }) => [method, body, headers["content-type"]])).toEqual([
			["GET", "", undefined],
			["GET", "", undefined],
			["GET", "", undefined],
			["POST", '{"a":1}', "application/json"],
		]);
	});
});
