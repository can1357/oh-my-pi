/**
 * The highlight language of a file path: special basenames first, then the
 * last extension (case-insensitive).
 */

/** Highlight language → the extensions (or extension-less basenames) that select it. */
const LANGUAGES: Readonly<Record<string, readonly string[]>> = {
	typescript: ["ts", "cts", "mts"],
	tsx: ["tsx"],
	javascript: ["js", "jsx", "mjs", "cjs"],
	rust: ["rs"],
	go: ["go"],
	c: ["c", "h"],
	cpp: ["cpp", "cc", "cxx", "hh", "hpp", "hxx", "inl", "ipp", "tpp", "cppm", "ixx", "cu", "cuh", "ino"],
	zig: ["zig"],
	python: ["py", "pyi"],
	ruby: ["rb", "rbw", "gemspec"],
	erb: ["erb"],
	lua: ["lua"],
	bash: ["sh", "bash", "zsh", "ksh", "bats", "tmux", "cgi", "fcgi", "command", "tool"],
	fish: ["fish"],
	perl: ["pl", "pm", "perl"],
	php: ["php"],
	java: ["java"],
	kotlin: ["kt", "ktm", "kts"],
	scala: ["scala", "sc", "sbt"],
	groovy: ["groovy"],
	clojure: ["clj", "cljc", "cljs", "edn"],
	"emacs-lisp": ["el"],
	csharp: ["cs"],
	fsharp: ["fs"],
	vb: ["vb"],
	html: ["html", "htm", "xhtml"],
	css: ["css"],
	scss: ["scss"],
	sass: ["sass"],
	less: ["less"],
	vue: ["vue"],
	svelte: ["svelte"],
	astro: ["astro"],
	json: ["json"],
	jsonc: ["jsonc"],
	yaml: ["yaml", "yml"],
	toml: ["toml"],
	xml: ["xml", "xsl", "xslt", "svg", "plist"],
	ini: ["ini"],
	markdown: ["md", "markdown", "mdx", "mdc", "mkd", "mdown"],
	restructuredtext: ["rst"],
	asciidoc: ["adoc"],
	latex: ["tex"],
	sql: ["sql"],
	graphql: ["graphql", "gql"],
	protobuf: ["proto"],
	dockerfile: ["dockerfile", "containerfile"],
	hcl: ["tf", "hcl", "tfvars"],
	nix: ["nix"],
	elixir: ["ex", "exs"],
	erlang: ["erl", "hrl"],
	haskell: ["hs"],
	ocaml: ["ml", "mli"],
	swift: ["swift"],
	r: ["r"],
	julia: ["jl"],
	dart: ["dart"],
	elm: ["elm"],
	verilog: ["v", "sv", "svh", "vh"],
	nim: ["nim"],
	crystal: ["cr"],
	d: ["d"],
	pascal: ["pas", "pp"],
	lisp: ["lisp", "lsp"],
	racket: ["rkt"],
	scheme: ["scm"],
	powershell: ["ps1", "psm1"],
	bat: ["bat", "cmd"],
	tlaplus: ["tla", "tlaplus"],
	objc: ["m", "mm"],
	solidity: ["sol"],
	odin: ["odin"],
	starlark: ["star", "bzl"],
	vim: ["vim"],
	ipynb: ["ipynb"],
	handlebars: ["hbs", "hsb", "handlebars"],
	diff: ["diff", "patch"],
	make: ["makefile", "mk", "mak"],
	cmake: ["cmake"],
	just: ["justfile"],
	text: ["txt", "text"],
	log: ["log"],
	csv: ["csv"],
	tsv: ["tsv"],
	conf: [
		"cfg",
		"conf",
		"config",
		"properties",
		"gitignore",
		"gitattributes",
		"gitmodules",
		"editorconfig",
		"npmrc",
		"prettierrc",
		"eslintrc",
		"prettierignore",
		"eslintignore",
	],
	env: ["env"],
};

const BY_EXTENSION = new Map<string, string>();
for (const language in LANGUAGES) {
	for (const extension of LANGUAGES[language]!) BY_EXTENSION.set(extension, language);
}

/** The highlight language of `path` (`typescript`, `bash`, `dockerfile`), or undefined when unknown. */
export function languageFromPath(path: string): string | undefined {
	const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
	if (base.startsWith(".env.")) return "env";
	if (base === "dockerfile" || base.startsWith("dockerfile.") || base === "containerfile") return "dockerfile";
	if (base === ".emacs") return "emacs-lisp";
	if (base === "cmakelists.txt") return "cmake";
	if (base === "gnumakefile") return "make";
	const dot = base.lastIndexOf(".");
	return BY_EXTENSION.get(dot < 0 ? base : base.slice(dot + 1));
}
