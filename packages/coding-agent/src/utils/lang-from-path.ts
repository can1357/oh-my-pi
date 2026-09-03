import * as path from "node:path";

/**
 * Extension segment → [highlight language id, LSP language id].
 * Highlight ids match tree-sitter / native highlighter; LSP ids match Language Server Protocol.
 */
const EXTENSION_LANG: Record<string, readonly [string, string]> = {
	// TypeScript / JavaScript
	ts: ["typescript", "typescript"],
	cts: ["typescript", "typescript"],
	mts: ["typescript", "typescript"],
	tsx: ["tsx", "typescriptreact"],
	js: ["javascript", "javascript"],
	jsx: ["javascript", "javascriptreact"],
	mjs: ["javascript", "javascript"],
	cjs: ["javascript", "javascript"],

	// Systems
	rs: ["rust", "rust"],
	go: ["go", "go"],
	c: ["c", "c"],
	h: ["c", "c"],
	cpp: ["cpp", "cpp"],
	cc: ["cpp", "cpp"],
	cxx: ["cpp", "cpp"],
	hh: ["cpp", "cpp"],
	hpp: ["cpp", "cpp"],
	hxx: ["cpp", "cpp"],
	cu: ["cpp", "cpp"],
	ino: ["cpp", "cpp"],
	zig: ["zig", "zig"],

	// Scripting
	py: ["python", "python"],
	pyi: ["python", "python"],
	rb: ["ruby", "ruby"],
	rbw: ["ruby", "ruby"],
	gemspec: ["ruby", "ruby"],
	lua: ["lua", "lua"],
	sh: ["bash", "shellscript"],
	bash: ["bash", "shellscript"],
	zsh: ["bash", "shellscript"],
	ksh: ["bash", "shellscript"],
	bats: ["bash", "shellscript"],
	tmux: ["bash", "shellscript"],
	cgi: ["bash", "shellscript"],
	fcgi: ["bash", "shellscript"],
	command: ["bash", "shellscript"],
	tool: ["bash", "shellscript"],
	fish: ["fish", "fish"],
	pl: ["perl", "perl"],
	pm: ["perl", "perl"],
	perl: ["perl", "perl"],
	php: ["php", "php"],

	// JVM
	java: ["java", "java"],
	kt: ["kotlin", "kotlin"],
	ktm: ["kotlin", "kotlin"],
	kts: ["kotlin", "kotlin"],
	scala: ["scala", "scala"],
	sc: ["scala", "scala"],
	sbt: ["scala", "scala"],
	groovy: ["groovy", "groovy"],
	clj: ["clojure", "clojure"],
	cljc: ["clojure", "clojure"],
	cljs: ["clojure", "clojure"],
	edn: ["clojure", "clojure"],
	el: ["emacs-lisp", "emacs-lisp"],

	// .NET
	cs: ["csharp", "csharp"],
	fs: ["fsharp", "fsharp"],
	vb: ["vb", "vb"],

	// Web
	html: ["html", "html"],
	htm: ["html", "html"],
	xhtml: ["html", "html"],
	css: ["css", "css"],
	scss: ["scss", "scss"],
	sass: ["sass", "sass"],
	less: ["less", "less"],
	vue: ["vue", "vue"],
	svelte: ["svelte", "svelte"],
	astro: ["astro", "astro"],

	// Data
	json: ["json", "json"],
	jsonc: ["jsonc", "jsonc"],
	yaml: ["yaml", "yaml"],
	yml: ["yaml", "yaml"],
	toml: ["toml", "toml"],
	xml: ["xml", "xml"],
	xsl: ["xml", "xml"],
	xslt: ["xml", "xml"],
	svg: ["xml", "xml"],
	plist: ["xml", "xml"],
	ini: ["ini", "ini"],

	// Docs
	md: ["markdown", "markdown"],
	markdown: ["markdown", "markdown"],
	mdx: ["markdown", "markdown"],
	mdc: ["markdown", "markdown"],
	mkd: ["markdown", "markdown"],
	mdown: ["markdown", "markdown"],
	rst: ["restructuredtext", "restructuredtext"],
	adoc: ["asciidoc", "asciidoc"],
	tex: ["latex", "latex"],

	// Other languages
	sql: ["sql", "sql"],
	graphql: ["graphql", "graphql"],
	gql: ["graphql", "graphql"],
	proto: ["protobuf", "protobuf"],
	dockerfile: ["dockerfile", "dockerfile"],
	containerfile: ["dockerfile", "dockerfile"],
	tf: ["hcl", "terraform"],
	hcl: ["hcl", "hcl"],
	tfvars: ["hcl", "hcl"],
	nix: ["nix", "nix"],
	ex: ["elixir", "elixir"],
	exs: ["elixir", "elixir"],
	erl: ["erlang", "erlang"],
	hrl: ["erlang", "erlang"],
	hs: ["haskell", "haskell"],
	ml: ["ocaml", "ocaml"],
	mli: ["ocaml", "ocaml"],
	swift: ["swift", "swift"],
	r: ["r", "r"],
	jl: ["julia", "julia"],
	dart: ["dart", "dart"],
	elm: ["elm", "elm"],
	v: ["verilog", "v"],
	nim: ["nim", "nim"],
	cr: ["crystal", "crystal"],
	d: ["d", "d"],
	pas: ["pascal", "pascal"],
	pp: ["pascal", "pascal"],
	lisp: ["lisp", "lisp"],
	lsp: ["lisp", "lisp"],
	rkt: ["racket", "racket"],
	scm: ["scheme", "scheme"],
	ps1: ["powershell", "powershell"],
	psm1: ["powershell", "powershell"],
	bat: ["bat", "bat"],
	cmd: ["bat", "bat"],
	tla: ["tlaplus", "tlaplus"],
	tlaplus: ["tlaplus", "tlaplus"],
	m: ["objc", "plaintext"],
	mm: ["objc", "plaintext"],
	sol: ["solidity", "plaintext"],
	odin: ["odin", "plaintext"],
	star: ["starlark", "plaintext"],
	bzl: ["starlark", "plaintext"],
	sv: ["verilog", "plaintext"],
	svh: ["verilog", "plaintext"],
	vh: ["verilog", "plaintext"],
	vim: ["vim", "plaintext"],
	ipynb: ["ipynb", "plaintext"],
	hbs: ["handlebars", "plaintext"],
	hsb: ["handlebars", "plaintext"],
	handlebars: ["handlebars", "plaintext"],
	diff: ["diff", "plaintext"],
	patch: ["diff", "plaintext"],
	makefile: ["make", "plaintext"],
	mk: ["make", "plaintext"],
	mak: ["make", "plaintext"],
	cmake: ["cmake", "cmake"],
	justfile: ["just", "plaintext"],
	txt: ["text", "plaintext"],
	text: ["text", "plaintext"],
	log: ["log", "plaintext"],
	csv: ["csv", "plaintext"],
	tsv: ["tsv", "plaintext"],
	cfg: ["conf", "plaintext"],
	conf: ["conf", "plaintext"],
	config: ["conf", "plaintext"],
	properties: ["conf", "plaintext"],
	env: ["env", "plaintext"],
	gitignore: ["conf", "plaintext"],
	gitattributes: ["conf", "plaintext"],
	gitmodules: ["conf", "plaintext"],
	editorconfig: ["conf", "plaintext"],
	npmrc: ["conf", "plaintext"],
	prettierrc: ["conf", "plaintext"],
	eslintrc: ["conf", "plaintext"],
	prettierignore: ["conf", "plaintext"],
	eslintignore: ["conf", "plaintext"],
};

/** Final segment after the last `.` in the full path (prior theme behavior). */
function themeExtensionKey(filePath: string): string {
	const extBeg = filePath.lastIndexOf(".");
	return extBeg !== -1 ? filePath.slice(extBeg + 1).toLowerCase() : filePath.toLowerCase();
}

function lspExtensionKey(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return ext.startsWith(".") ? ext.slice(1) : "";
}

/**
 * Language id for syntax highlighting and UI (icons, read tool), or undefined if unknown.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const baseName = path.basename(filePath).toLowerCase();
	if (baseName.startsWith(".env.")) return "env";
	if (baseName === "dockerfile" || baseName.startsWith("dockerfile.") || baseName === "containerfile") {
		return "dockerfile";
	}
	if (baseName === ".emacs") return "emacs-lisp";
	if (baseName === "justfile") return "just";
	if (baseName === "cmakelists.txt") return "cmake";

	const pair = EXTENSION_LANG[themeExtensionKey(filePath)];
	if (pair) return pair[0];

	return undefined;
}

export function isMarkdownPath(filePath: string): boolean {
	return getLanguageFromPath(filePath) === "markdown";
}

/**
 * LSP language identifier; falls back to `plaintext`.
 */
export function detectLanguageId(filePath: string): string {
	const baseName = path.basename(filePath).toLowerCase();
	if (baseName === "dockerfile" || baseName.startsWith("dockerfile.") || baseName === "containerfile") {
		return "dockerfile";
	}
	if (baseName === ".emacs") {
		return "emacs-lisp";
	}
	if (baseName === "makefile" || baseName === "gnumakefile") {
		return "makefile";
	}
	if (baseName === "justfile") {
		return "just";
	}

	const lspExt = lspExtensionKey(filePath);
	if (baseName === "cmakelists.txt" || lspExt === "cmake") {
		return "cmake";
	}

	return EXTENSION_LANG[lspExt]?.[1] ?? "plaintext";
}
