import { describe, expect, it } from "bun:test";
import { fuzzyFilter, type MatchFields, MatchCorpus, matchText, rankByText } from "@oh-my-pi/pi-tui/text-match";

const rank = (query: string, candidates: MatchFields[]) =>
	rankByText(query, candidates, candidate => candidate).map(({ item, match }) => [item.names[0], match.kind]);
const names = (query: string, candidates: string[]) =>
	rankByText(query, candidates, name => ({ names: [name] })).map(({ item }) => item);

describe("text-match", () => {
	it("ranks letter-for-letter matches by position, then typos and abbreviations by letters off, then details", () => {
		const candidates: MatchFields[] = [
			{ names: ["zzz"], details: "Switch mode" },
			{ names: ["mxoxdxe"] },
			{ names: ["edit-monadev"] },
			{ names: ["edit-mdoe"] },
			{ names: ["monadev"] },
			{ names: ["modxtool"] },
			{ names: ["mdoe"] },
			{ names: ["remodel"] },
			{ names: ["edit-mode"] },
			{ names: ["model"] },
			{ names: ["mode"] },
		];

		expect(rank("Mode", candidates)).toEqual([
			["mode", "exact"],
			["model", "prefix"],
			["edit-mode", "word"],
			["remodel", "substring"],
			// One letter off each: the whole name, then from the name's start, then from a later word.
			["mdoe", "typo"],
			["modxtool", "prefixTypo"],
			["monadev", "abbreviation"],
			["edit-mdoe", "wordTypo"],
			["edit-monadev", "wordAbbreviation"],
			// Three breaks rank below one letter off anywhere.
			["mxoxdxe", "abbreviation"],
			["zzz", "detail"],
		]);
	});

	it("counts a typo with punctuation left out, so it may span words", () => {
		expect(matchText("gtp5", { names: ["gpt-5"] })?.kind).toBe("typo");
		expect(matchText("claudfable", { names: ["claude-fable-5-1"] })?.kind).toBe("prefixTypo");
		expect(matchText("cluade-fabel", { names: ["claude-fable-5-1"] })).toMatchObject({ kind: "prefixTypo", cost: 2 });
		expect(matchText("sonet45", { names: ["claude-sonnet-4-5"] })?.kind).toBe("wordTypo");
		expect(matchText("rolestorgae", { names: ["modelRoleStorage"] })?.kind).toBe("wordTypo");
	});

	it("finds a typo of an unfinished word wherever the word starts", () => {
		// `dabl` is one letter off `fabl`, the unfinished `fable`.
		expect(matchText("dabl", { names: ["claude-fable-5-1"] })?.kind).toBe("wordTypo");
		expect(matchText("agne", { names: ["agents"] })?.kind).toBe("prefixTypo");
		// Punctuation before the first word does not move the name's start.
		expect(matchText("openw", { names: ["~openai/gpt-5"] })?.kind).toBe("prefixTypo");
	});

	it("keeps matching while a mistyped word is typed out", () => {
		const name = "~openai/gpt-sol-latest";
		const word = "openai";
		for (let at = 0; at < word.length; at++) {
			const typed = `${word.slice(0, at)}x${word.slice(at + 1)}`;
			let matched = false;
			for (let length = 4; length <= typed.length; length++) {
				const match = matchText(typed.slice(0, length), { names: [name] });
				if (matched) expect(match).not.toBeNull();
				matched ||= match !== null;
			}
			expect(matched).toBe(true);
		}
	});

	it("allows typos of a whole name from three letters and of any other span from four", () => {
		expect(matchText("hbu", { names: ["hub"] })?.kind).toBe("typo");
		expect(matchText("jbo", { names: ["jobs"] })).toBeNull();
		expect(matchText("dab", { names: ["claude-fable-5-1"] })).toBeNull();
		expect(matchText("opu", { names: ["claude-ops-4"] })).toBeNull();
	});

	it("allows two typos from six letters only up to a word end", () => {
		expect(matchText("antrhopci", { names: ["anthropic-x"] })).toMatchObject({ kind: "prefixTypo", cost: 2 });
		// Two swaps inside the unfinished `anthrop`.
		expect(matchText("antrhpo", { names: ["anthropic"] })).toBeNull();
		expect(matchText("antrhop", { names: ["anthropic"] })).toMatchObject({ kind: "prefixTypo", cost: 1 });
	});

	it("abbreviates within one word or by word starts, never a mix of both", () => {
		expect(matchText("clr", { names: ["clear"] })?.kind).toBe("abbreviation");
		expect(matchText("pgn", { names: ["reload-plugins"] })?.kind).toBe("wordAbbreviation");
		expect(matchText("rp", { names: ["reload-plugins"] })?.kind).toBe("abbreviation");
		expect(matchText("mrs", { names: ["modelRoleStorage"] })?.kind).toBe("abbreviation");
		expect(matchText("lr", { names: ["clear"] })).toBeNull();
		// `w` sits mid-word in a later word; `b·r` inside "bedrock" then `d·p` inside "deepseek" mixes both shapes.
		expect(matchText("uwb", { names: ["retry/usageAwareFallback"] })).toBeNull();
		expect(matchText("brdp", { names: ["amazon-bedrock/deepseek-v3"] }, { typos: false })).toBeNull();
		// An in-word break never crosses into the next word.
		expect(matchText("abd", { names: ["abc-xd"] }, { typos: false })).toBeNull();
	});

	it("finds an abbreviation a letter-by-letter scan would miss", () => {
		// Taking `b` right after `a` leaves `c` mid-word; the `b` starting `bc` completes it.
		expect(matchText("abc", { names: ["ab-bc"] }, { typos: false })).toMatchObject({ kind: "abbreviation", cost: 1 });
	});

	it("prefers fewer breaks, then an abbreviation from the name's start", () => {
		// `mdalz` breaks once (m·d … l), `model` twice (m … d … l).
		expect(names("mdl", ["model", "mdalz"])).toEqual(["mdalz", "model"]);
		expect(rank("rp", [{ names: ["x-reload-plugins"] }, { names: ["reload-plugins"] }])).toEqual([
			["reload-plugins", "abbreviation"],
			["x-reload-plugins", "wordAbbreviation"],
		]);
	});

	it("starts a word at every character of scripts written without spaces", () => {
		expect(matchText("搜索", { names: ["zzz"], details: "文件搜索" })?.kind).toBe("detail");
		expect(matchText("ツール", { names: ["zzz"], details: "ファイル検索ツール" })?.kind).toBe("detail");
		expect(matchText("검색", { names: ["zzz"], details: "파일검색" })?.kind).toBe("detail");
		expect(matchText("ค้นหา", { names: ["zzz"], details: "เครื่องมือค้นหา" })?.kind).toBe("detail");
		expect(matchText("搜索", { names: ["文件搜索"] })?.kind).toBe("word");
		// A Latin word after them starts there too, and still continues inside itself only from its start.
		expect(matchText("tool", { names: ["zzz"], details: "文件tool" })?.kind).toBe("detail");
		expect(matchText("ool", { names: ["zzz"], details: "文件tool" })).toBeNull();
	});

	it("starts a word at the capital that ends an acronym before a lowercase letter", () => {
		expect(matchText("webview", { names: ["zzz"], details: "Use WKWebView" })?.kind).toBe("detail");
		expect(matchText("server", { names: ["MCPServer"] })?.kind).toBe("word");
		expect(matchText("http", { names: ["XMLHttpParser"] })?.kind).toBe("word");
		expect(matchText("mcp", { names: ["MCPServer"] })?.kind).toBe("prefix");
		// An all-caps run stays one word.
		expect(matchText("cp", { names: ["zzz"], details: "MCP" })).toBeNull();
	});

	it("matches details only where a word starts, below every name match", () => {
		expect(matchText("ode", { names: ["zzz"], details: "Switch model" })).toBeNull();
		expect(matchText("mod", { names: ["zzz"], details: "Switch model" })?.kind).toBe("detail");
		expect(matchText("mod", { names: ["remodel"], details: "Model picker" })?.kind).toBe("substring");
		// Details never take typos: a transcript has a word one edit from almost anything.
		expect(matchText("modle", { names: ["zzz"], details: "Switch model" })).toBeNull();
	});

	it("matches identifiers by fragments anywhere, letter for letter, below details", () => {
		const fields: MatchFields = { names: ["Fix build"], details: "please reload", identifiers: ["0f3a9c21-77b1"] };
		expect(matchText("9c21", fields)?.kind).toBe("identifier");
		expect(matchText("9c12", fields)).toBeNull();
		expect(matchText("reload", { ...fields, identifiers: ["/tmp/reload"] })?.kind).toBe("detail");
		expect(matchText("load", fields)).toBeNull();
	});

	it("keeps the earlier name when several names match equally", () => {
		expect(matchText("mod", { names: ["model", "models"] })?.nameIndex).toBe(0);
		expect(matchText("models", { names: ["model", "models"] })?.nameIndex).toBe(1);
	});

	it("keeps letter-for-letter matches only when typos and abbreviations are off", () => {
		const fields: MatchFields = { names: ["Render Buffer"], details: "rb issue" };
		expect(matchText("rb", fields)?.kind).toBe("abbreviation");
		expect(matchText("rb", fields, { typos: false, abbreviations: false })?.kind).toBe("detail");
	});

	it("drops typo kinds when typos are off", () => {
		expect(matchText("mdoe", { names: ["mode"] }, { typos: false })).toBeNull();
		expect(matchText("modx", { names: ["mode-tool"] }, { typos: false })).toBeNull();
		expect(matchText("opsu", { names: ["claude-opus"] }, { typos: false })).toBeNull();
	});

	it("compares with punctuation left out from a word start", () => {
		expect(matchText("gpt5", { names: ["gpt-5-mini"] })?.kind).toBe("prefix");
		expect(matchText("statusline", { names: ["status line"] })?.kind).toBe("exact");
		expect(matchText("5mini", { names: ["gpt-5-mini"] })?.kind).toBe("word");
		expect(matchText("mn", { names: ["random notes"] }, { typos: false })).toBeNull();
	});

	it("reads trailing punctuation as more of the name to come", () => {
		expect(names("openai/gpt-5:", ["openai/gpt-5", "openai/gpt-5:batch"])).toEqual([
			"openai/gpt-5:batch",
			"openai/gpt-5",
		]);
	});

	it("compares Unicode text without accents, compatibility forms or invisible characters", () => {
		expect(matchText("cafe", { names: ["café"] })?.kind).toBe("exact");
		expect(matchText("cafe\u0301", { names: ["caf\u00e9"] })?.kind).toBe("exact");
		expect(matchText("istanbul", { names: ["İstanbul"] })?.kind).toBe("exact");
		expect(matchText("claude", { names: ["ｃｌａｕｄｅ"] })?.kind).toBe("exact");
		expect(matchText("claude", { names: ["cla\u200bude"] })?.kind).toBe("exact");
		// Punctuation and symbols outside ASCII separate words like `-` does.
		expect(matchText("bar", { names: ["foo—bar"] })?.kind).toBe("word");
		expect(matchText("bar", { names: ["zzz"], details: "foo–bar" })?.kind).toBe("detail");
		expect(matchText("bar", { names: ["foo🙂bar"] })?.kind).toBe("word");
	});

	describe("several words", () => {
		it("requires every word and ranks by the weakest", () => {
			const candidates: MatchFields[] = [
				{ names: ["claude-sonnet-4-5"] },
				{ names: ["claude-opus-4-8"] },
				{ names: ["gpt-5"], details: "OpenAI opus-class model" },
			];
			// `opsu` is a typo of `opus`, so Claude Opus ranks at `wordTypo`; `gpt-5` lacks `claude`.
			expect(rank("claude opsu", candidates)).toEqual([["claude-opus-4-8", "wordTypo"]]);
			expect(rank("opus claude", candidates)).toEqual([["claude-opus-4-8", "word"]]);
		});

		it("ranks the whole query found in a name above the same words found apart", () => {
			const candidates: MatchFields[] = [
				{ names: ["Theme"], details: "Dark mode colours used when the terminal is dark" },
				{ names: ["Dark Theme"] },
			];
			expect(rank("dark theme", candidates)).toEqual([
				["Dark Theme", "exact"],
				["Theme", "detail"],
			]);
		});

		it("lets each word match a name or the details", () => {
			expect(
				matchText("theme background", { names: ["Dark Theme"], details: "Used on a dark background" })?.kind,
			).toBe("detail");
		});
	});

	it("ranks a prepared corpus exactly like rankByText", () => {
		const items = ["claude-opus-4-8", "gpt-5-mini", "status line", "reload-plugins", "claude-fable-5"];
		const corpus = new MatchCorpus(items, item => ({ names: [item] }));
		for (const query of ["opus", "gpt5", "opsu claude", "plgins", "rp", "dabl", "", "zzz"]) {
			expect(corpus.rank(query)).toEqual(rankByText(query, items, item => ({ names: [item] })));
		}
	});

	it("keeps upstream Pi's fuzzyFilter contract for extensions", () => {
		const items = ["apple", "banana", "cherry"];
		expect(fuzzyFilter(items, "", item => item)).toEqual(items);
		expect(fuzzyFilter(items, "ban", item => item)).toEqual(["banana"]);
		expect(fuzzyFilter(["a_p_p", "application", "app"], "app", item => item)[0]).toBe("app");
	});
});
