import { describe, expect, it } from "bun:test";
import {
	applyQueryConstraints,
	formatQuery,
	formatScraperQuery,
	GOOGLE_QUERY_SYNTAX,
	matchesQueryConstraints,
	matchesSite,
	parseDateValue,
	parseSearchQuery,
} from "@oh-my-pi/pi-coding-agent/web/search/query";
import type { SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("parseSearchQuery", () => {
	it("leaves plain queries untouched", () => {
		const q = parseSearchQuery("rust async runtime comparison");
		expect(q.text).toBe("rust async runtime comparison");
		expect(q.hasDirectives).toBe(false);
		expect(q.hasConstraints).toBe(false);
		expect(q.terms.map(t => t.text)).toEqual(["rust", "async", "runtime", "comparison"]);
	});

	it("keeps unknown colon tokens (URLs, paths, error codes) as text", () => {
		const q = parseSearchQuery("error TS2345: https://example.com/a?b=c C:\\Users\\me");
		expect(q.hasConstraints).toBe(false);
		expect(q.terms.map(t => t.text)).toEqual(["error", "TS2345:", "https://example.com/a?b=c", "C:\\Users\\me"]);
	});

	it("parses site: aliases and exclusions with normalization", () => {
		const q = parseSearchQuery(
			"kubernetes site:HTTPS://Docs.K8s.IO/ domain:cncf.io -site:*.reddit.com host:github.com/kubernetes",
		);
		expect(q.sites).toEqual(["docs.k8s.io", "cncf.io", "github.com/kubernetes"]);
		expect(q.excludedSites).toEqual(["reddit.com"]);
		expect(q.text).toBe("kubernetes");
		expect(q.hasConstraints).toBe(true);
	});

	it("adopts the next token when a directive value is space-separated", () => {
		const q = parseSearchQuery("site: arxiv.org transformer scaling");
		expect(q.sites).toEqual(["arxiv.org"]);
		expect(q.text).toBe("transformer scaling");
	});

	it("does not adopt operators or directives as space-separated values", () => {
		const q = parseSearchQuery("site: OR site:example.com");
		expect(q.sites).toEqual(["example.com"]);
	});

	it("parses inurl/intitle/intext variants including quoted values", () => {
		const q = parseSearchQuery('inurl:docs intitle:"getting started" -intitle:deprecated inbody:websocket handshake');
		expect(q.inUrl).toEqual(["docs"]);
		expect(q.inTitle).toEqual(["getting started"]);
		expect(q.excludedInTitle).toEqual(["deprecated"]);
		expect(q.inText).toEqual(["websocket"]);
		expect(q.text).toBe("handshake");
	});

	it("routes every following term for allintitle:", () => {
		const q = parseSearchQuery("allintitle: budget planning tips");
		expect(q.inTitle).toEqual(["budget", "planning", "tips"]);
		expect(q.text).toBe("");
	});

	it("parses filetype/ext with normalization", () => {
		const q = parseSearchQuery("quarterly report filetype:PDF ext:.xlsx -filetype:doc");
		expect(q.filetypes).toEqual(["pdf", "xlsx"]);
		expect(q.excludedFiletypes).toEqual(["doc"]);
	});

	it("parses date bounds in common forms", () => {
		const q = parseSearchQuery("llm evals after:2024 before:2025-06-15");
		expect(q.after).toBe("2024-01-01");
		expect(q.before).toBe("2025-06-15");
		expect(q.text).toBe("llm evals");

		expect(parseSearchQuery("x since:2023/07/01").after).toBe("2023-07-01");
		expect(parseSearchQuery("x until:2024-02").before).toBe("2024-02-01");
		expect(parseSearchQuery("x after:6/15/2024").after).toBe("2024-06-15");
		expect(parseSearchQuery("x after:15/6/2024").after).toBe("2024-06-15");
	});

	it("degrades unparseable date values to plain terms", () => {
		const q = parseSearchQuery("release before:soon");
		expect(q.before).toBeUndefined();
		expect(q.terms.map(t => t.text)).toEqual(["release", "before:soon"]);
	});

	it("parses quoted phrases including smart quotes and negated phrases", () => {
		const q = parseSearchQuery('"exact phrase" \u201csmart quoted\u201d -"not this"');
		expect(q.terms).toEqual([
			{ text: "exact phrase", phrase: true },
			{ text: "smart quoted", phrase: true },
			{ text: "not this", phrase: true, negated: true },
		]);
		expect(q.text).toBe('"exact phrase" "smart quoted" -"not this"');
	});

	it("groups OR alternatives and treats AND as default conjunction", () => {
		const q = parseSearchQuery("(react OR vue OR svelte) AND hooks");
		const groups = q.terms.map(t => t.group);
		expect(q.terms.map(t => t.text)).toEqual(["react", "vue", "svelte", "hooks"]);
		expect(groups[0]).toBeDefined();
		expect(groups[0]).toBe(groups[1]);
		expect(groups[1]).toBe(groups[2]);
		expect(groups[3]).toBeUndefined();
		expect(q.text).toBe("(react OR vue OR svelte) hooks");
	});

	it("supports pipe as OR and NOT as negation", () => {
		const q = parseSearchQuery("deno | bun NOT node");
		expect(q.terms[0].group).toBe(q.terms[1].group);
		expect(q.terms[2]).toMatchObject({ text: "node", negated: true });
	});

	it("swallows OR between directives instead of grouping terms", () => {
		const q = parseSearchQuery("caching site:redis.io OR site:memcached.org");
		expect(q.sites).toEqual(["redis.io", "memcached.org"]);
		expect(q.terms).toEqual([{ text: "caching" }]);
	});

	it("keeps wikipedia-style parens inside directive values", () => {
		const q = parseSearchQuery("site:en.wikipedia.org/wiki/Rust_(programming_language) borrow checker");
		expect(q.sites).toEqual(["en.wikipedia.org/wiki/rust_(programming_language)"]);
		expect(q.text).toBe("borrow checker");
	});

	it("treats legacy +term as an exact phrase", () => {
		const q = parseSearchQuery("+immutable data");
		expect(q.terms[0]).toEqual({ text: "immutable", phrase: true });
	});

	it("parses lang: into a language code", () => {
		const q = parseSearchQuery("documentation lang:EN-us");
		expect(q.lang).toBe("en-us");
		expect(q.hasConstraints).toBe(false);
	});
});

describe("parseDateValue", () => {
	it("rejects invalid components", () => {
		expect(parseDateValue("2024-13-01")).toBeUndefined();
		expect(parseDateValue("2024-00-10")).toBeUndefined();
		expect(parseDateValue("notadate")).toBeUndefined();
		expect(parseDateValue("24-01-01")).toBeUndefined();
	});
});

describe("formatQuery", () => {
	it("re-emits full Google syntax", () => {
		const q = parseSearchQuery(
			'release notes site:github.com -site:gist.github.com filetype:md after:2024-05-01 intitle:"v2"',
		);
		expect(formatQuery(q, GOOGLE_QUERY_SYNTAX)).toBe(
			"release notes site:github.com -site:gist.github.com intitle:v2 filetype:md after:2024-05-01",
		);
	});

	it("emits OR-grouped sites for multi-site queries", () => {
		const q = parseSearchQuery("cve site:nvd.nist.gov site:mitre.org");
		expect(formatQuery(q, GOOGLE_QUERY_SYNTAX)).toBe("cve (site:nvd.nist.gov OR site:mitre.org)");
	});

	it("produces plain keywords when the engine supports no syntax", () => {
		const q = parseSearchQuery('(react OR vue) "state management" -redux site:dev.to filetype:pdf');
		expect(formatQuery(q, {})).toBe("react vue state management");
	});

	it("falls back to constraint values for directive-only queries", () => {
		const q = parseSearchQuery("site:kubernetes.io filetype:yaml");
		expect(formatQuery(q, {})).toBe("kubernetes.io yaml");
	});
});

describe("formatScraperQuery", () => {
	it("demotes path-carrying site: and inurl: to plain terms, keeping bare-domain site:", () => {
		expect(formatScraperQuery("site:github.com/can1357/oh-my-pi inurl:releases site:github.com 17.1.1 release")).toBe(
			"17.1.1 release github.com/can1357/oh-my-pi releases site:github.com",
		);
	});

	it("demotes every site in an OR-groupable multi-site query when all carry paths", () => {
		expect(formatScraperQuery("cve site:nvd.nist.gov/vuln site:mitre.org/cgi-bin")).toBe(
			"cve nvd.nist.gov/vuln mitre.org/cgi-bin",
		);
	});

	it("passes negated site:/inurl: through as operators", () => {
		expect(formatScraperQuery("foo -site:github.com/x -inurl:bar")).toBe("foo -site:github.com/x -inurl:bar");
	});

	it("passes directive-free queries through byte-identical", () => {
		expect(formatScraperQuery("github.com/can1357/oh-my-pi 17.1.1 release")).toBe(
			"github.com/can1357/oh-my-pi 17.1.1 release",
		);
	});

	it("respects a narrower engine syntax while still demoting hostile operators", () => {
		expect(
			formatScraperQuery("a site:x.com site:y.com/z inurl:w", undefined, {
				phrases: true,
				negation: true,
				site: true,
			}),
		).toBe("a y.com/z w site:x.com");
	});
});

describe("matchesSite", () => {
	it("matches exact hosts, subdomains, and path prefixes", () => {
		expect(matchesSite("https://docs.k8s.io/setup", "k8s.io")).toBe(true);
		expect(matchesSite("https://k8s.io/", "k8s.io")).toBe(true);
		expect(matchesSite("https://notk8s.io/", "k8s.io")).toBe(false);
		expect(matchesSite("https://github.com/anthropics/sdk", "github.com/anthropics")).toBe(true);
		expect(matchesSite("https://github.com/other/sdk", "github.com/anthropics")).toBe(false);
		expect(matchesSite("not a url", "k8s.io")).toBe(false);
	});
});

describe("applyQueryConstraints", () => {
	const sources: SearchSource[] = [
		{ title: "K8s docs — Install", url: "https://kubernetes.io/docs/setup/install.pdf" },
		{ title: "Random blog", url: "https://blog.example.com/k8s", publishedDate: "2023-01-15" },
		{ title: "Reddit thread", url: "https://www.reddit.com/r/kubernetes/post" },
		{ title: "K8s blog", url: "https://kubernetes.io/blog/2024", ageSeconds: 3600 },
	];

	it("filters by included site", () => {
		const q = parseSearchQuery("install site:kubernetes.io");
		const { sources: out, dropped } = applyQueryConstraints(sources, q);
		expect(out.map(s => s.url)).toEqual([
			"https://kubernetes.io/docs/setup/install.pdf",
			"https://kubernetes.io/blog/2024",
		]);
		expect(dropped).toEqual([]);
	});

	it("drops a constraint that would eliminate every result and reports it", () => {
		const q = parseSearchQuery("install site:nonexistent.example");
		const { sources: out, dropped } = applyQueryConstraints(sources, q);
		expect(out).toHaveLength(sources.length);
		expect(dropped).toEqual(["site:nonexistent.example"]);
	});

	it("relaxes dimensions independently", () => {
		// site matches two sources, filetype:docx matches none of those → only filetype relaxed.
		const q = parseSearchQuery("install site:kubernetes.io filetype:docx");
		const { sources: out, dropped } = applyQueryConstraints(sources, q);
		expect(out.map(s => s.url)).toEqual([
			"https://kubernetes.io/docs/setup/install.pdf",
			"https://kubernetes.io/blog/2024",
		]);
		expect(dropped).toEqual(["filetype:docx"]);
	});

	it("applies exclusions and filetype filters", () => {
		const q = parseSearchQuery("k8s -site:reddit.com filetype:pdf");
		const { sources: out, dropped } = applyQueryConstraints(sources, q);
		expect(out.map(s => s.url)).toEqual(["https://kubernetes.io/docs/setup/install.pdf"]);
		expect(dropped).toEqual([]);
	});

	it("filters by date bounds while letting undated sources pass", () => {
		const q = parseSearchQuery("k8s after:2024-01-01");
		const { sources: out } = applyQueryConstraints(sources, q);
		// 2023 blog post is provably too old; undated sources survive.
		expect(out.map(s => s.url)).toEqual([
			"https://kubernetes.io/docs/setup/install.pdf",
			"https://www.reddit.com/r/kubernetes/post",
			"https://kubernetes.io/blog/2024",
		]);
	});

	it("parses relative published dates", () => {
		const q = parseSearchQuery("news before:2020");
		const relative: SearchSource[] = [
			{ title: "old", url: "https://a.example/1", publishedDate: "2 days ago" },
			{ title: "undated", url: "https://a.example/2" },
		];
		const { sources: out, dropped } = applyQueryConstraints(relative, q);
		// "2 days ago" is provably after 2020 → violates before:2020 → only undated survives.
		expect(out.map(s => s.url)).toEqual(["https://a.example/2"]);
		expect(dropped).toEqual([]);
	});

	it("returns empty input untouched", () => {
		const q = parseSearchQuery("x site:a.com");
		expect(applyQueryConstraints([], q)).toEqual({ sources: [], dropped: [] });
	});
});

describe("matchesQueryConstraints", () => {
	it("checks all dimensions strictly", () => {
		const q = parseSearchQuery("site:kubernetes.io inurl:docs");
		expect(matchesQueryConstraints({ title: "t", url: "https://kubernetes.io/docs/setup" }, q)).toBe(true);
		expect(matchesQueryConstraints({ title: "t", url: "https://kubernetes.io/blog/x" }, q)).toBe(false);
	});
});
