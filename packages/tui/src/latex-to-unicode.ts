import { mathSpanAt } from "@oh-my-pi/pi-utils/math-delimiters";
import { TERMINAL } from "./terminal-capabilities";

// LaTeX → Unicode/ANSI converter.
//
// Terminals cannot lay out real math, but a surprising amount of LaTeX maps
// cleanly onto Unicode: superscripts/subscripts (x² xᵢ), Greek (α β), big
// operators (∫ ∑ ∏), relations/arrows (≤ ≠ → ⇒), fonts via the Mathematical
// Alphanumeric Symbols block (ℝ 𝐱 𝔄 𝒞), accents via combining marks (x̂ x̄ x⃗),
// fractions (½, (a+b)/c), radicals (√, ∛), and ANSI foreground/background colors
// (`\textcolor`, `\color`, `\colorbox`, `\fcolorbox`). This module turns a LaTeX math
//
// `latexToUnicode(src)` converts a *bare* math fragment (no `$`/`\(` delimiters).
// `renderMathInText(text)` scans prose for `$$…$$`, `$…$`, `\(…\)`, `\[…\]`
// spans and converts only those, with anti-currency heuristics so "$5 and $10"
// is left untouched. The markdown renderer isolates math via a Marked extension
// and calls `latexToUnicode` directly; `renderMathInText` serves callers that
// only have raw text.

// ---------------------------------------------------------------------------
// Character maps
// ---------------------------------------------------------------------------

// Unicode superscript forms. Letters are incomplete in Unicode (q, and several
// capitals have no superscript), so the converter falls back to `^(…)` when any
// character in a script group is unmappable.
const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	".": "·",
	" ": " ",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	ε: "ᵋ",
	θ: "ᶿ",
	ι: "ᶥ",
	φ: "ᵠ",
	χ: "ᵡ",
};

// Unicode subscript forms (even sparser than superscripts).
const SUBSCRIPT: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	" ": " ",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

// Prime runs: f' f'' f''' f''''.
const PRIMES = ["", "′", "″", "‴", "⁗"] as const;

// Common vulgar fractions, keyed by `${num}/${den}` of the rendered parts.
const VULGAR: Record<string, string> = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/7": "⅐",
	"1/8": "⅛",
	"3/8": "⅜",
	"5/8": "⅝",
	"7/8": "⅞",
	"1/9": "⅑",
	"1/10": "⅒",
	"0/3": "↉",
};

// `\not<rel>` negations that have a dedicated Unicode glyph (cleaner than the
// combining-solidus fallback).
const NOT_MAP: Record<string, string> = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≡": "≢",
	"∃": "∄",
	"≤": "≰",
	"≥": "≱",
	"≈": "≉",
	"≅": "≇",
	"∼": "≁",
	"≃": "≄",
	"∣": "∤",
	"∥": "∦",
	"≺": "⊀",
	"≻": "⊁",
	"⊑": "⋢",
	"⊒": "⋣",
};

// Combining diacritics for accent commands (applied after each base glyph).
const ACCENTS: Record<string, string> = {
	hat: "\u0302",
	widehat: "\u0302",
	check: "\u030C",
	widecheck: "\u030C",
	tilde: "\u0303",
	widetilde: "\u0303",
	acute: "\u0301",
	grave: "\u0300",
	dot: "\u0307",
	ddot: "\u0308",
	dddot: "\u20DB",
	ddddot: "\u20DC",
	breve: "\u0306",
	bar: "\u0304",
	vec: "\u20D7",
	overrightarrow: "\u20D7",
	overleftarrow: "\u20D6",
	mathring: "\u030A",
	overline: "\u0305",
	underline: "\u0332",
	underbar: "\u0332",
};

// Math functions rendered as their literal upright name (sin, cos, lim, …).
const FUNCTIONS: Record<string, true> = {
	sin: true,
	cos: true,
	tan: true,
	cot: true,
	sec: true,
	csc: true,
	sinh: true,
	cosh: true,
	tanh: true,
	coth: true,
	arcsin: true,
	arccos: true,
	arctan: true,
	arccot: true,
	arcsec: true,
	arccsc: true,
	sech: true,
	csch: true,
	ln: true,
	log: true,
	lg: true,
	exp: true,
	lim: true,
	limsup: true,
	liminf: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	dim: true,
	ker: true,
	hom: true,
	arg: true,
	deg: true,
	gcd: true,
	lcm: true,
	Pr: true,
	argmax: true,
	argmin: true,
	sgn: true,
	tr: true,
	rank: true,
	diag: true,
	var: true,
	cov: true,
	median: true,
	mod: true,
};

// Math-mode font commands → Mathematical Alphanumeric Symbols style.
type FontStyle =
	| "bold"
	| "italic"
	| "bolditalic"
	| "script"
	| "boldscript"
	| "fraktur"
	| "doublestruck"
	| "boldfraktur"
	| "sans"
	| "sansbold"
	| "sansitalic"
	| "sansbolditalic"
	| "mono";

const FONTS: Record<string, FontStyle> = {
	mathbf: "bold",
	boldsymbol: "bolditalic",
	bm: "bolditalic",
	pmb: "bold",
	mathbb: "doublestruck",
	Bbb: "doublestruck",
	mathds: "doublestruck",
	mathbbm: "doublestruck",
	mathcal: "script",
	mathscr: "boldscript",
	mathfrak: "fraktur",
	mathbfscr: "boldscript",
	mathbfcal: "boldscript",
	mathbffrak: "boldfraktur",
	mathfrakbold: "boldfraktur",
	mathsf: "sans",
	mathsfit: "sansitalic",
	mathsfbf: "sansbold",
	mathbfsf: "sansbold",
	mathsfbfit: "sansbolditalic",
	mathbfsfit: "sansbolditalic",
	mathtt: "mono",
	mathit: "italic",
	mathbfit: "bolditalic",
};

interface ParseStyle {
	font: FontStyle | null;
	bold: boolean;
	italic: boolean;
}

interface RenderStyle {
	bold: boolean;
	italic: boolean;
	foreground: string | null;
	background: string | null;
}

type StyleAttribute = "bold" | "italic";

type RenderEvent =
	| { kind: "scope-start"; attribute: StyleAttribute }
	| { kind: "scope-end"; attribute: StyleAttribute; restore: boolean };

interface RenderChunk {
	text: string;
	style: RenderStyle;
	before?: RenderEvent[];
	after?: RenderEvent[];
}

type Rendered = RenderChunk[];

const ROOT_STYLE: ParseStyle = { font: null, bold: false, italic: false };

const TEXT_STYLE_COMMANDS: Readonly<Record<string, Partial<Pick<ParseStyle, "bold" | "italic">>>> = {
	textbf: { bold: true },
	textit: { italic: true },
	textsl: { italic: true },
	emph: { italic: true },
	textmd: { bold: false },
	textup: { italic: false },
	texttt: {},
	textsf: {},
};

/**
 * Math font and text-style command names whose single brace argument
 * is rendered with the corresponding style. Exported for the display block
 * engine, which re-wraps inline runs inside these commands when their argument
 * contains 2-D layout so styling survives box boundaries.
 */
export const MATH_FONT_COMMANDS: ReadonlySet<string> = new Set([
	...Object.keys(FONTS),
	...Object.keys(TEXT_STYLE_COMMANDS),
]);

// Text-mode commands whose argument is passed through literally (no math).
const TEXT_COMMANDS: Record<string, true> = {
	text: true,
	textrm: true,
	textnormal: true,
	textsc: true,
	mathrm: true,
	mathnormal: true,
	mbox: true,
	hbox: true,
};

// Base code points for each style's A, a, and (where it exists) 0 in the
// Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF).
interface Plane {
	upper: number;
	lower: number;
	digit?: number;
}
const PLANES: Record<FontStyle, Plane> = {
	bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	italic: { upper: 0x1d434, lower: 0x1d44e },
	bolditalic: { upper: 0x1d468, lower: 0x1d482 },
	script: { upper: 0x1d49c, lower: 0x1d4b6 },
	boldscript: { upper: 0x1d4d0, lower: 0x1d4ea },
	fraktur: { upper: 0x1d504, lower: 0x1d51e },
	doublestruck: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8 },
	boldfraktur: { upper: 0x1d56c, lower: 0x1d586 },
	sans: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
	sansbold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
	sansitalic: { upper: 0x1d608, lower: 0x1d622 },
	sansbolditalic: { upper: 0x1d63c, lower: 0x1d656 },
	mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};

// Reserved code points in the math alphabets that Unicode places in the
// Letterlike Symbols block instead (the famous "holes").
const ALPHA_HOLES: Record<string, string> = {
	"italic:h": "ℎ",
	"script:B": "ℬ",
	"script:E": "ℰ",
	"script:F": "ℱ",
	"script:H": "ℋ",
	"script:I": "ℐ",
	"script:L": "ℒ",
	"script:M": "ℳ",
	"script:R": "ℛ",
	"script:e": "ℯ",
	"script:g": "ℊ",
	"script:o": "ℴ",
	"fraktur:C": "ℭ",
	"fraktur:H": "ℌ",
	"fraktur:I": "ℑ",
	"fraktur:R": "ℜ",
	"fraktur:Z": "ℨ",
	"doublestruck:C": "ℂ",
	"doublestruck:H": "ℍ",
	"doublestruck:N": "ℕ",
	"doublestruck:P": "ℙ",
	"doublestruck:Q": "ℚ",
	"doublestruck:R": "ℝ",
	"doublestruck:Z": "ℤ",
};

// Matrix/cases environment delimiters: [open, close].
const ENV_DELIMS: Record<string, readonly [string, string]> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	tabular: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	"cases*": ["{", ""],
	dcases: ["{", ""],
	"dcases*": ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
	aligned: ["", ""],
	"aligned*": ["", ""],
	alignedat: ["", ""],
	"alignedat*": ["", ""],
	align: ["", ""],
	"align*": ["", ""],
	alignat: ["", ""],
	"alignat*": ["", ""],
	split: ["", ""],
	gathered: ["", ""],
	equation: ["", ""],
	"equation*": ["", ""],
};

// Greek, operators, relations, arrows, delimiters, and assorted symbols.
const SYMBOLS: Record<string, string> = {
	// Greek lowercase
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	digamma: "ϝ",
	// Greek uppercase
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	// Big operators
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	iiiint: "⨌",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	bigcap: "⋂",
	bigcup: "⋃",
	bigsqcup: "⨆",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigodot: "⨀",
	bigoplus: "⨁",
	bigotimes: "⨂",
	biguplus: "⨄",
	Cap: "⋒",
	Cup: "⋓",
	bigstar: "★",
	// Binary operators
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "∙",
	cdot: "⋅",
	cdotp: "·",
	centerdot: "·",
	cap: "∩",
	cup: "∪",
	uplus: "⊎",
	sqcap: "⊓",
	sqcup: "⊔",
	vee: "∨",
	wedge: "∧",
	land: "∧",
	lor: "∨",
	setminus: "∖",
	smallsetminus: "∖",
	wr: "≀",
	amalg: "⨿",
	diamond: "⋄",
	Diamond: "◇",
	bigtriangleup: "△",
	bigtriangledown: "▽",
	triangleleft: "◁",
	triangleright: "▷",
	lhd: "⊲",
	rhd: "⊳",
	unlhd: "⊴",
	unrhd: "⊵",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	dagger: "†",
	ddagger: "‡",
	boxplus: "⊞",
	boxtimes: "⊠",
	boxdot: "⊡",
	boxminus: "⊟",
	ltimes: "⋉",
	rtimes: "⋊",
	leftthreetimes: "⋋",
	rightthreetimes: "⋌",
	curlyvee: "⋎",
	curlywedge: "⋏",
	barwedge: "⊼",
	veebar: "⊻",
	doublebarwedge: "⩞",
	circledast: "⊛",
	circledcirc: "⊚",
	circleddash: "⊝",
	divideontimes: "⋇",
	dotplus: "∔",
	// Relations
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	ll: "≪",
	gg: "≫",
	neq: "≠",
	ne: "≠",
	equiv: "≡",
	doteq: "≐",
	sim: "∼",
	simeq: "≃",
	approx: "≈",
	approxeq: "≊",
	cong: "≅",
	propto: "∝",
	asymp: "≍",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	subsetneq: "⊊",
	supsetneq: "⊋",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	in: "∈",
	ni: "∋",
	owns: "∋",
	notin: "∉",
	mid: "∣",
	nmid: "∤",
	parallel: "∥",
	nparallel: "∦",
	perp: "⊥",
	vdash: "⊢",
	dashv: "⊣",
	models: "⊨",
	vDash: "⊨",
	Vdash: "⊩",
	bowtie: "⋈",
	smile: "⌣",
	frown: "⌢",
	between: "≬",
	lessgtr: "≶",
	gtrless: "≷",
	leqslant: "⩽",
	geqslant: "⩾",
	lesssim: "≲",
	gtrsim: "≳",
	lessapprox: "⪅",
	gtrapprox: "⪆",
	leqq: "≦",
	geqq: "≧",
	lneq: "⪇",
	gneq: "⪈",
	lneqq: "≨",
	gneqq: "≩",
	nleq: "≰",
	ngeq: "≱",
	nless: "≮",
	ngtr: "≯",
	nsubseteq: "⊈",
	nsupseteq: "⊉",
	nsim: "≁",
	ncong: "≇",
	triangleq: "≜",
	coloneqq: "≔",
	eqqcolon: "≕",
	risingdotseq: "≓",
	fallingdotseq: "≒",
	circeq: "≗",
	eqcirc: "≖",
	precsim: "≾",
	succsim: "≿",
	precapprox: "⪷",
	succapprox: "⪸",
	curlyeqprec: "⋞",
	curlyeqsucc: "⋟",
	Subset: "⋐",
	Supset: "⋑",
	subseteqq: "⫅",
	supseteqq: "⫆",
	subsetneqq: "⫋",
	supsetneqq: "⫌",
	Vvdash: "⊪",
	shortmid: "∣",
	shortparallel: "∥",
	pitchfork: "⋔",
	// Arrows
	leftarrow: "←",
	gets: "←",
	rightarrow: "→",
	to: "→",
	leftrightarrow: "↔",
	Leftarrow: "⇐",
	Rightarrow: "⇒",
	Leftrightarrow: "⇔",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	Updownarrow: "⇕",
	mapsto: "↦",
	longmapsto: "⟼",
	hookleftarrow: "↩",
	hookrightarrow: "↪",
	leftharpoonup: "↼",
	rightharpoonup: "⇀",
	leftharpoondown: "↽",
	rightharpoondown: "⇁",
	rightleftharpoons: "⇌",
	longleftarrow: "⟵",
	longrightarrow: "⟶",
	longleftrightarrow: "⟷",
	Longleftarrow: "⟸",
	Longrightarrow: "⟹",
	Longleftrightarrow: "⟺",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	nleftarrow: "↚",
	nrightarrow: "↛",
	leadsto: "⇝",
	rightsquigarrow: "⇝",
	leftrightsquigarrow: "↭",
	twoheadrightarrow: "↠",
	twoheadleftarrow: "↞",
	leftrightharpoons: "⇋",
	rightleftarrows: "⇄",
	leftrightarrows: "⇆",
	leftleftarrows: "⇇",
	rightrightarrows: "⇉",
	upuparrows: "⇈",
	downdownarrows: "⇊",
	circlearrowleft: "↺",
	circlearrowright: "↻",
	curvearrowleft: "↶",
	curvearrowright: "↷",
	dashleftarrow: "⇠",
	dashrightarrow: "⇢",
	Lleftarrow: "⇚",
	Rrightarrow: "⇛",
	leftarrowtail: "↢",
	rightarrowtail: "↣",
	looparrowleft: "↫",
	looparrowright: "↬",
	multimap: "⊸",
	// Miscellaneous
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	emptyset: "∅",
	varnothing: "∅",
	neg: "¬",
	lnot: "¬",
	top: "⊤",
	bot: "⊥",
	angle: "∠",
	measuredangle: "∡",
	sphericalangle: "∢",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	hbar: "ℏ",
	hslash: "ℏ",
	ell: "ℓ",
	imath: "ı",
	jmath: "ȷ",
	wp: "℘",
	Re: "ℜ",
	Im: "ℑ",
	mho: "℧",
	complement: "∁",
	surd: "√",
	flat: "♭",
	natural: "♮",
	sharp: "♯",
	clubsuit: "♣",
	diamondsuit: "♦",
	heartsuit: "♥",
	spadesuit: "♠",
	clubs: "♣",
	diamonds: "♦",
	hearts: "♥",
	spades: "♠",
	therefore: "∴",
	because: "∵",
	checkmark: "✓",
	maltese: "✠",
	dag: "†",
	ddag: "‡",
	S: "§",
	P: "¶",
	copyright: "©",
	circledR: "®",
	pounds: "£",
	yen: "¥",
	euro: "€",
	degree: "°",
	prime: "′",
	backprime: "‵",
	colon: ":",
	semicolon: ";",
	neper: "₪",
	square: "□",
	Box: "□",
	blacksquare: "■",
	lozenge: "◊",
	blacklozenge: "⧫",
	triangle: "△",
	blacktriangle: "▴",
	blacktriangledown: "▾",
	blacktriangleleft: "◂",
	blacktriangleright: "▸",
	diagup: "╱",
	diagdown: "╲",
	backepsilon: "϶",
	Game: "⅁",
	eth: "ð",
	// Dots & ellipses
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	hdots: "…",
	mathellipsis: "…",
	dotsc: "…",
	dotsb: "⋯",
	dotsm: "⋯",
	dotsi: "⋯",
	// Delimiters
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lbrace: "{",
	rbrace: "}",
	lbrack: "[",
	rbrack: "]",
	vert: "|",
	Vert: "‖",
	lvert: "|",
	rvert: "|",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	slash: "/",
	ulcorner: "⌜",
	urcorner: "⌝",
	llcorner: "⌞",
	lrcorner: "⌟",
	lmoustache: "⎰",
	rmoustache: "⎱",
	lgroup: "⟮",
	rgroup: "⟯",
	bracevert: "⎪",
	// Blackboard / letterlike shortcuts commonly written bare
	Reals: "ℝ",
	Complex: "ℂ",
	Natural: "ℕ",
	Integer: "ℤ",
	Rational: "ℚ",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_FG_RESET = "\x1b[39m";
const ANSI_BG_RESET = "\x1b[49m";
const ANSI_BOLD_ON = "\x1b[1m";
const ANSI_BOLD_OFF = "\x1b[22m";
const ANSI_ITALIC_ON = "\x1b[3m";
const ANSI_ITALIC_OFF = "\x1b[23m";

const DEFAULT_RENDER_STYLE: RenderStyle = {
	bold: false,
	italic: false,
	foreground: null,
	background: null,
};

function renderStyle(style: ParseStyle, foreground: string | null, background: string | null): RenderStyle {
	return { bold: style.bold, italic: style.italic, foreground, background };
}

function sameRenderStyle(a: RenderStyle, b: RenderStyle): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.foreground === b.foreground && a.background === b.background;
}

function appendRendered(target: Rendered, source: Rendered): void {
	for (const chunk of source) {
		if (chunk.text === "") continue;
		const previous = target[target.length - 1];
		if (
			previous !== undefined &&
			previous.after === undefined &&
			chunk.before === undefined &&
			chunk.after === undefined &&
			sameRenderStyle(previous.style, chunk.style)
		) {
			previous.text += chunk.text;
		} else {
			target.push({ ...chunk });
		}
	}
}

function concatRendered(...parts: Rendered[]): Rendered {
	const out: Rendered = [];
	for (const part of parts) appendRendered(out, part);
	return out;
}

function styledText(text: string, style: RenderStyle): Rendered {
	return text === "" ? [] : [{ text, style }];
}

function plainText(rendered: Rendered): string {
	let text = "";
	for (const chunk of rendered) text += chunk.text;
	return text;
}

/** Map every code point of `text` through `table`; null if any is unmappable. */
function mapAll(text: Rendered, table: Record<string, string>): Rendered | null {
	const out: Rendered = [];
	for (const chunk of text) {
		let mapped = "";
		for (const ch of chunk.text) {
			const replacement = table[ch];
			if (replacement === undefined) return null;
			mapped += replacement;
		}
		appendRendered(out, [{ ...chunk, text: mapped }]);
	}
	return out;
}

/** Number of Unicode code points (not UTF-16 units) in rendered glyph text. */
function codePointLength(text: Rendered): number {
	let length = 0;
	for (const chunk of text) {
		for (const _ of chunk.text) length++;
	}
	return length;
}

/** Style a single ASCII letter/digit via the math alphanumeric block. */
function styleAlnum(ch: string, style: FontStyle): string {
	const hole = ALPHA_HOLES[`${style}:${ch}`];
	if (hole) return hole;
	const plane = PLANES[style];
	const code = ch.charCodeAt(0);
	if (code >= 65 && code <= 90) return String.fromCodePoint(plane.upper + (code - 65));
	if (code >= 97 && code <= 122) return String.fromCodePoint(plane.lower + (code - 97));
	if (code >= 48 && code <= 57 && plane.digit !== undefined) return String.fromCodePoint(plane.digit + (code - 48));
	return ch;
}

/** Identity, or math-alphanumeric styling when a font style is active. */
function styleChar(ch: string, style: ParseStyle): string {
	if (style.font === null) return ch;
	const code = ch.charCodeAt(0);
	const isAlnum = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
	return isAlnum ? styleAlnum(ch, style.font) : ch;
}
function surroundRendered(text: Rendered, left: string, right: string, fallback: RenderStyle): Rendered {
	return concatRendered(styledText(left, fallback), text, styledText(right, fallback));
}
function trimRendered(text: Rendered): Rendered {
	const out = text.map(chunk => ({ ...chunk }));
	while (out.length > 0) {
		const first = out[0];
		if (first === undefined) break;
		first.text = first.text.trimStart();
		if (first.text !== "") break;
		out.shift();
	}
	while (out.length > 0) {
		const lastIndex = out.length - 1;
		const last = out[lastIndex];
		if (last === undefined) break;
		last.text = last.text.trimEnd();
		if (last.text !== "") break;
		out.pop();
	}
	return out;
}
function scopeRendered(text: Rendered, attribute: StyleAttribute, parentActive: boolean): Rendered {
	if (!parentActive || text.length === 0) return text;
	const out = text.map(chunk => ({ ...chunk }));
	const first = out[0];
	const last = out[out.length - 1];
	if (first?.style[attribute]) {
		first.before = [...(first.before ?? []), { kind: "scope-start", attribute }];
	}
	if (last?.style[attribute]) {
		last.after = [...(last.after ?? []), { kind: "scope-end", attribute, restore: true }];
	}
	return out;
}

/** Append a combining mark after each non-space base glyph. */
function applyCombining(text: Rendered, mark: string): Rendered {
	const out: Rendered = [];
	for (const chunk of text) {
		let mapped = "";
		for (const ch of chunk.text) mapped += ch === " " ? ch : ch + mark;
		appendRendered(out, [{ ...chunk, text: mapped }]);
	}
	return out;
}

function emitStyleTransition(out: string[], from: RenderStyle, to: RenderStyle): void {
	if (from.bold && !to.bold) out.push(ANSI_BOLD_OFF);
	if (from.italic && !to.italic) out.push(ANSI_ITALIC_OFF);
	const foregroundChanged = from.foreground !== to.foreground;
	const backgroundChanged = from.background !== to.background;
	if (foregroundChanged && backgroundChanged) {
		if (to.background === null) {
			out.push(to.background ?? ANSI_BG_RESET);
			out.push(to.foreground ?? ANSI_FG_RESET);
		} else {
			out.push(to.foreground ?? ANSI_FG_RESET);
			out.push(to.background ?? ANSI_BG_RESET);
		}
	} else {
		if (foregroundChanged) out.push(to.foreground ?? ANSI_FG_RESET);
		if (backgroundChanged) out.push(to.background ?? ANSI_BG_RESET);
	}
	if (!from.bold && to.bold) out.push(ANSI_BOLD_ON);
	if (!from.italic && to.italic) out.push(ANSI_ITALIC_ON);
}

function emitStyleEvent(out: string[], event: RenderEvent, active: RenderStyle): RenderStyle {
	if (event.kind === "scope-start") {
		out.push(event.attribute === "bold" ? ANSI_BOLD_ON : ANSI_ITALIC_ON);
		return { ...active, [event.attribute]: true };
	}
	if (active[event.attribute]) out.push(event.attribute === "bold" ? ANSI_BOLD_OFF : ANSI_ITALIC_OFF);
	if (event.restore) out.push(event.attribute === "bold" ? ANSI_BOLD_ON : ANSI_ITALIC_ON);
	return { ...active, [event.attribute]: event.restore };
}

/** Materialize terminal attributes only after all glyph transforms are complete. */
function renderAnsi(text: Rendered): string {
	let out = "";
	let active = DEFAULT_RENDER_STYLE;
	for (const chunk of text) {
		const transitions: string[] = [];
		emitStyleTransition(transitions, active, chunk.style);
		out += transitions.join("");
		active = chunk.style;
		for (const event of chunk.before ?? []) {
			const events: string[] = [];
			active = emitStyleEvent(events, event, active);
			out += events.join("");
		}
		out += chunk.text;
		for (const event of chunk.after ?? []) {
			const events: string[] = [];
			active = emitStyleEvent(events, event, active);
			out += events.join("");
		}
	}
	const transitions: string[] = [];
	emitStyleTransition(transitions, active, DEFAULT_RENDER_STYLE);
	return out + transitions.join("");
}

/** Light unescape for text-mode content (`\&` → `&`, `~` → space). */
function unescapeText(s: string): string {
	return s.replace(/\\([&%$#_{}\s])/g, "$1").replace(/~/g, " ");
}

type AnsiColorFormat = "ansi-16m" | "ansi-256";

interface AnsiColor {
	foreground: string;
	background: string;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const LATEX_NAMED_COLORS: Record<string, string> = {
	black: "#000000",
	blue: "#0000ff",
	brown: "#a52a2a",
	cyan: "#00ffff",
	darkgray: "#404040",
	darkgrey: "#404040",
	gray: "#808080",
	green: "#00ff00",
	grey: "#808080",
	lightgray: "#c0c0c0",
	lightgrey: "#c0c0c0",
	lime: "#00ff00",
	magenta: "#ff00ff",
	olive: "#808000",
	orange: "#ffa500",
	pink: "#ffc0cb",
	purple: "#800080",
	red: "#ff0000",
	teal: "#008080",
	violet: "#ee82ee",
	white: "#ffffff",
	yellow: "#ffff00",
};

function colorFormat(): AnsiColorFormat {
	return TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
}

function clamp01(n: number): number {
	if (n <= 0) return 0;
	if (n >= 1) return 1;
	return n;
}

function clampByte(n: number): number {
	if (n <= 0) return 0;
	if (n >= 255) return 255;
	return Math.round(n);
}

function cssRgb(rgb: Rgb): string {
	return `rgb(${clampByte(rgb.r)}, ${clampByte(rgb.g)}, ${clampByte(rgb.b)})`;
}

function parseNumber(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed.endsWith("%") ? Number(trimmed.slice(0, -1)) / 100 : trimmed);
	return Number.isFinite(value) ? value : null;
}

function parseColorComponents(spec: string, expected: number): number[] | null {
	const parts = spec
		.split(/[,\s]+/u)
		.map(part => part.trim())
		.filter(Boolean);
	if (parts.length !== expected) return null;
	const values: number[] = [];
	for (const part of parts) {
		const value = parseNumber(part);
		if (value === null) return null;
		values.push(value);
	}
	return values;
}

function rgbFromUnit(values: readonly number[]): string | null {
	if (values.length !== 3) return null;
	return cssRgb({
		r: clamp01(values[0] ?? 0) * 255,
		g: clamp01(values[1] ?? 0) * 255,
		b: clamp01(values[2] ?? 0) * 255,
	});
}

function rgbFromByte(values: readonly number[]): string | null {
	if (values.length !== 3) return null;
	return cssRgb({ r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0 });
}

function rgbFromCmyk(values: readonly number[]): string | null {
	if (values.length !== 4) return null;
	const c = clamp01(values[0] ?? 0);
	const m = clamp01(values[1] ?? 0);
	const y = clamp01(values[2] ?? 0);
	const k = clamp01(values[3] ?? 0);
	return cssRgb({ r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) });
}

function rgbFromHsv(values: readonly number[], hueScale: number): string | null {
	if (values.length !== 3) return null;
	const h = (((values[0] ?? 0) * hueScale) % 360) / 60;
	const s = clamp01(values[1] ?? 0);
	const v = clamp01(values[2] ?? 0);
	const c = v * s;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 1) {
		r = c;
		g = x;
	} else if (h < 2) {
		r = x;
		g = c;
	} else if (h < 3) {
		g = c;
		b = x;
	} else if (h < 4) {
		g = x;
		b = c;
	} else if (h < 5) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	return cssRgb({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

function rgbFromWave(spec: string): string | null {
	const wavelength = parseNumber(spec);
	if (wavelength === null || wavelength < 380 || wavelength > 780) return null;
	let r = 0;
	let g = 0;
	let b = 0;
	if (wavelength < 440) {
		r = -(wavelength - 440) / 60;
		b = 1;
	} else if (wavelength < 490) {
		g = (wavelength - 440) / 50;
		b = 1;
	} else if (wavelength < 510) {
		g = 1;
		b = -(wavelength - 510) / 20;
	} else if (wavelength < 580) {
		r = (wavelength - 510) / 70;
		g = 1;
	} else if (wavelength < 645) {
		r = 1;
		g = -(wavelength - 645) / 65;
	} else {
		r = 1;
	}
	const factor =
		wavelength < 420
			? 0.3 + (0.7 * (wavelength - 380)) / 40
			: wavelength > 700
				? 0.3 + (0.7 * (780 - wavelength)) / 80
				: 1;
	return cssRgb({ r: r * factor * 255, g: g * factor * 255, b: b * factor * 255 });
}

function normalizeCssColor(spec: string, allowMix: boolean): string | null {
	const trimmed = spec.trim();
	if (trimmed === "") return null;
	if (allowMix && trimmed.includes("!")) {
		const mixed = resolveMixedColor(trimmed);
		if (mixed !== null) return mixed;
	}
	const named = LATEX_NAMED_COLORS[trimmed] ?? LATEX_NAMED_COLORS[trimmed.toLowerCase()];
	if (named !== undefined) return named;
	if (Bun.color(trimmed, "css") !== null) return trimmed;
	const lower = trimmed.toLowerCase();
	return lower !== trimmed && Bun.color(lower, "css") !== null ? lower : null;
}

function resolveModeledColor(model: string, spec: string): string | null {
	const trimmedModel = model.trim();
	if (trimmedModel === "" || trimmedModel === "named") return normalizeCssColor(spec, true);
	if (trimmedModel === "HTML" || trimmedModel === "Html" || trimmedModel === "html") {
		const hex = spec.trim().replace(/^#/u, "");
		return /^[0-9A-Fa-f]{3,8}$/u.test(hex) ? `#${hex}` : null;
	}
	if (trimmedModel === "wave") return rgbFromWave(spec);
	const lower = trimmedModel.toLowerCase();
	if (trimmedModel === "RGB") return rgbFromByte(parseColorComponents(spec, 3) ?? []);
	if (lower === "rgb") return rgbFromUnit(parseColorComponents(spec, 3) ?? []);
	if (lower === "cmyk") return rgbFromCmyk(parseColorComponents(spec, 4) ?? []);
	if (lower === "gray" || lower === "grey") {
		const value = parseColorComponents(spec, 1)?.[0];
		if (value === undefined) return null;
		const unit = trimmedModel === "Gray" || trimmedModel === "Grey" ? value / 15 : value;
		const byte = clamp01(unit) * 255;
		return cssRgb({ r: byte, g: byte, b: byte });
	}
	if (lower === "hsb" || lower === "hsv") {
		const values = parseColorComponents(spec, 3);
		if (values === null) return null;
		return rgbFromHsv(values, trimmedModel === "Hsb" || trimmedModel === "HSV" ? 1 : 360);
	}
	return normalizeCssColor(spec, true);
}

function resolveLatexColor(model: string | null, spec: string): string | null {
	const unescaped = unescapeText(spec).trim();
	if (unescaped === "") return null;
	return model === null ? normalizeCssColor(unescaped, true) : resolveModeledColor(model, unescaped);
}

function resolveMixedColor(spec: string): string | null {
	const parts = spec.split("!");
	if (parts.length < 2) return null;
	const first = normalizeCssColor(parts[0] ?? "", false);
	if (first === null) return null;
	let current = Bun.color(first, "{rgb}");
	if (current === null) return null;
	for (let i = 1; i < parts.length; i += 2) {
		const percent = parseNumber(parts[i] ?? "");
		if (percent === null) return null;
		const nextSpec = parts[i + 1] ?? "white";
		const nextColor = normalizeCssColor(nextSpec, false);
		if (nextColor === null) return null;
		const next = Bun.color(nextColor, "{rgb}");
		if (next === null) return null;
		const t = clamp01(percent / 100);
		current = {
			r: current.r * t + next.r * (1 - t),
			g: current.g * t + next.g * (1 - t),
			b: current.b * t + next.b * (1 - t),
		};
	}
	return cssRgb(current);
}

function ansiColor(model: string | null, spec: string): AnsiColor | null {
	const css = resolveLatexColor(model, spec);
	if (css === null) return null;
	const foreground = Bun.color(css, colorFormat());
	if (foreground === null || !foreground.startsWith("\x1b[38;")) return null;
	return { foreground, background: foreground.replace("\x1b[38;", "\x1b[48;") };
}

/**
 * Painter for a LaTeX color scope (optional model + spec, e.g. `rgb`/`1,0,0` or
 * `red`): returns a function that paints already-rendered text with the scope's
 * foreground, re-asserting it after embedded foreground resets so nested color
 * runs restore to the scope color; null when the color cannot be resolved. Used
 * by the display block engine (`latex-block`) to paint structural glyphs
 * (fraction bars, stretched delimiters, matrix brackets) inside
 * `\color`/`\textcolor` scopes.
 */
export function latexColorScope(model: string | null, spec: string): ((text: string) => string) | null {
	const color = ansiColor(model, spec);
	if (color === null) return null;
	const { foreground } = color;
	return text => foreground + text.replaceAll(ANSI_FG_RESET, foreground) + ANSI_FG_RESET;
}

function toSuperscript(text: Rendered, group: boolean, fallback: RenderStyle): Rendered {
	if (text.length === 0) return [];
	const mapped = mapAll(text, SUPERSCRIPT);
	if (mapped !== null) return mapped;
	return concatRendered(styledText(group ? "^(" : "^", fallback), text, styledText(group ? ")" : "", fallback));
}

function toSubscript(text: Rendered, group: boolean, fallback: RenderStyle): Rendered {
	if (text.length === 0) return [];
	const mapped = mapAll(text, SUBSCRIPT);
	if (mapped !== null) return mapped;
	return concatRendered(styledText(group ? "_(" : "_", fallback), text, styledText(group ? ")" : "", fallback));
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Argument {
	text: Rendered;
	/** True when the argument came from a `{…}` group (affects fraction/script parens). */
	group: boolean;
}

const BIG_DELIM = /^(?:[bB]igg?|[bB]igg?[lrm])$/;

const EXTENSIBLE_ARROWS: Record<string, string> = {
	xleftarrow: "←",
	xrightarrow: "→",
	xleftrightarrow: "↔",
	xLeftarrow: "⇐",
	xRightarrow: "⇒",
	xLeftrightarrow: "⇔",
	xhookleftarrow: "↩",
	xhookrightarrow: "↪",
	xtwoheadleftarrow: "↞",
	xtwoheadrightarrow: "↠",
	xmapsto: "↦",
	xrightharpoonup: "⇀",
	xrightharpoondown: "⇁",
	xleftharpoonup: "↼",
	xleftharpoondown: "↽",
	xrightleftharpoons: "⇌",
	xleftrightharpoons: "⇋",
};

class LatexParser {
	#s: string;
	#i = 0;
	#foreground: string | null = null;
	#background: string | null = null;

	constructor(src: string) {
		this.#s = src;
	}

	render(): string {
		return renderAnsi(this.parse(ROOT_STYLE, false));
	}

	/** Parse a run until end-of-input, or until `}` when `stopAtBrace`. */
	parse(style: ParseStyle, stopAtBrace: boolean): Rendered {
		const out: Rendered = [];
		while (this.#i < this.#s.length) {
			const c = this.#s[this.#i];
			if (c === "}") {
				if (stopAtBrace) break;
				this.#i++; // stray close brace
				continue;
			}
			appendRendered(out, this.#node(style));
		}
		return out;
	}

	#renderStyle(style: ParseStyle): RenderStyle {
		return renderStyle(style, this.#foreground, this.#background);
	}

	#node(style: ParseStyle): Rendered {
		const c = this.#s[this.#i];
		switch (c) {
			case "\\":
				return this.#command(style);
			case "{":
				return this.#group(style);
			case "^":
				this.#i++;
				return this.#script(style, true);
			case "_":
				this.#i++;
				return this.#script(style, false);
			case "$":
				this.#i++;
				return []; // stray delimiter
			case "~":
				this.#i++;
				return styledText(" ", this.#renderStyle(style)); // non-breaking space
			case "&":
				this.#i++;
				return styledText("  ", this.#renderStyle(style)); // column separator
			case "'": {
				let k = 0;
				while (this.#s[this.#i] === "'") {
					k++;
					this.#i++;
				}
				return styledText(k <= 4 ? PRIMES[k] : PRIMES[1].repeat(k), this.#renderStyle(style));
			}
			case "%": {
				const nl = this.#s.indexOf("\n", this.#i);
				this.#i = nl === -1 ? this.#s.length : nl + 1;
				return [];
			}
			default:
				this.#i++;
				return styledText(styleChar(c, style), this.#renderStyle(style));
		}
	}

	#command(style: ParseStyle): Rendered {
		this.#i++; // past backslash
		if (this.#i >= this.#s.length) return [];
		const c = this.#s[this.#i];
		if (!/[A-Za-z]/.test(c)) {
			this.#i++;
			switch (c) {
				case "\\":
					return styledText("\n", this.#renderStyle(style)); // row break
				case "{":
				case "}":
				case "$":
				case "%":
				case "&":
				case "#":
				case "_":
				case " ":
				case ".":
					return styledText(c, this.#renderStyle(style));
				case ",":
				case ":":
				case ";":
				case ">":
					return styledText(" ", this.#renderStyle(style)); // spacing
				case "!":
					return []; // negative thin space
				case "/":
					return []; // italic correction
				case "|":
					return styledText("‖", this.#renderStyle(style));
				case "(":
				case ")":
				case "[":
				case "]":
					return []; // bare math delimiters that slipped through
				default:
					return styledText(c, this.#renderStyle(style));
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		if (this.#s[this.#i] === "*") this.#i++; // starred variants (operatorname*, …)
		return this.#applyCommand(name, style);
	}

	#applyCommand(name: string, style: ParseStyle): Rendered {
		const current = this.#renderStyle(style);
		const font = FONTS[name];
		if (font) return this.#argument({ ...style, font }).text;

		const textStyle = TEXT_STYLE_COMMANDS[name];
		if (textStyle !== undefined) {
			const text = this.#argument({ ...style, ...textStyle }).text;
			const attribute = textStyle.bold === true ? "bold" : textStyle.italic === true ? "italic" : null;
			return attribute === null ? text : scopeRendered(text, attribute, style[attribute]);
		}

		if (TEXT_COMMANDS[name]) return styledText(unescapeText(this.#rawArgument()), current);
		if (name === "operatorname") {
			const fn = unescapeText(this.#rawArgument());
			return styledText(fn + this.#spaceBeforeArg(), current);
		}

		// Accents operate on glyph chunks, never on terminal escape sequences.
		const accent = ACCENTS[name];
		if (accent) return applyCombining(this.#argument(style).text, accent);

		if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
			const num = this.#argument(style);
			const den = this.#argument(style);
			return this.#fraction(num, den, current);
		}

		if (name === "genfrac") {
			const left = this.#argument(style).text;
			const right = this.#argument(style).text;
			this.#rawArgument(); // rule thickness
			this.#rawArgument(); // math style
			const num = this.#argument(style);
			const den = this.#argument(style);
			return concatRendered(left, this.#fraction(num, den, current), right);
		}

		if (name === "binom" || name === "dbinom" || name === "tbinom") {
			const n = this.#argument(style);
			const k = this.#argument(style);
			return concatRendered(
				styledText("C(", current),
				n.text,
				styledText(", ", current),
				k.text,
				styledText(")", current),
			);
		}

		if (name === "sqrt") return this.#sqrt(style);

		if (name === "not") {
			const arg = this.#argument(style);
			const mapped = NOT_MAP[plainText(arg.text)];
			return mapped === undefined
				? applyCombining(arg.text, "\u0338")
				: styledText(mapped, arg.text[0]?.style ?? current);
		}

		if (name === "overset" || name === "stackrel") return this.#scriptedAbove(style);
		if (name === "underset") return this.#scriptedBelow(style);
		if (name === "prescript") return this.#prescript(style);

		const arrow = EXTENSIBLE_ARROWS[name];
		if (arrow !== undefined) return this.#extensibleArrow(style, arrow);

		if (name === "boxed" || name === "fbox") return surroundRendered(this.#argument(style).text, "[", "]", current);
		if (name === "overbrace") return surroundRendered(this.#argument(style).text, "⏞(", ")", current);
		if (name === "underbrace") return surroundRendered(this.#argument(style).text, "⏟(", ")", current);
		if (name === "overbracket") return surroundRendered(this.#argument(style).text, "⎴(", ")", current);
		if (name === "underbracket") return surroundRendered(this.#argument(style).text, "⎵(", ")", current);
		if (name === "overparen") return surroundRendered(this.#argument(style).text, "⏜(", ")", current);
		if (name === "underparen") return surroundRendered(this.#argument(style).text, "⏝(", ")", current);
		if (name === "cancel") return applyCombining(this.#argument(style).text, "\u0338");
		if (name === "bcancel") return applyCombining(this.#argument(style).text, "\u20E5");
		if (name === "xcancel") return applyCombining(applyCombining(this.#argument(style).text, "\u0338"), "\u20E5");
		if (name === "sout") return applyCombining(this.#argument(style).text, "\u0336");
		if (name === "substack") {
			const arg = this.#argument(style).text;
			return arg.map(chunk => ({ ...chunk, text: chunk.text.replace(NEWLINES, ",") }));
		}

		if (name === "left" || name === "right" || name === "middle") return this.#delimiter(style);

		if (BIG_DELIM.test(name)) return this.#delimiter(style); // \big \Bigl \Biggr …

		if (name === "begin") return this.#environment(style);
		if (name === "end") {
			this.#rawArgument();
			return [];
		}

		if (name === "bmod") return styledText(" mod ", current);
		if (name === "pmod") return surroundRendered(this.#argument(style).text, "(mod ", ")", current);
		if (name === "pod") return surroundRendered(this.#argument(style).text, "(", ")", current);
		if (name === "tag") return surroundRendered(this.#argument(style).text, "(", ")", current);
		if (name === "label") {
			this.#rawArgument();
			return [];
		}
		if (name === "ref" || name === "eqref") return styledText(`(${unescapeText(this.#rawArgument())})`, current);
		if (name === "url") return styledText(unescapeText(this.#rawArgument()), current);
		if (name === "href") {
			this.#rawArgument();
			return this.#argument(style).text;
		}
		if (name === "textcolor") return this.#scopedForeground(this.#readAnsiColor(), style);
		if (name === "colorbox") return this.#scopedBackground(this.#readAnsiColor(), style);
		if (name === "fcolorbox") return this.#fcolorbox(style);
		if (name === "color") return this.#setForeground();
		if (name === "normalcolor") {
			this.#foreground = null;
			return [];
		}
		if (name === "phantom" || name === "hphantom") {
			const arg = this.#argument(style).text;
			return styledText(" ".repeat(codePointLength(arg)), current);
		}
		if (name === "vphantom") {
			this.#argument(style);
			return [];
		}

		if (FUNCTIONS[name]) return styledText(name + this.#spaceBeforeArg(), current);

		const symbol = SYMBOLS[name];
		if (symbol !== undefined) return styledText(symbol, current);

		// Layout-only commands that carry no visible glyph.
		switch (name) {
			case "displaystyle":
			case "textstyle":
			case "scriptstyle":
			case "scriptscriptstyle":
			case "limits":
			case "nolimits":
			case "nonumber":
			case "notag":
			case "quad":
				return styledText(name === "quad" ? "  " : "", current);
			case "qquad":
				return styledText("    ", current);
			case "thinspace":
			case "enspace":
			case "medspace":
			case "thickspace":
			case "space":
				return styledText(" ", current);
			case "negthinspace":
			case "negmedspace":
			case "negthickspace":
				return [];
		}

		// Unknown command: surface the bare name rather than dropping it silently.
		return styledText(name, current);
	}

	#group(style: ParseStyle): Rendered {
		this.#i++;
		const outerForeground = this.#foreground;
		const outerBackground = this.#background;
		const inner = this.parse(style, true);
		if (this.#s[this.#i] === "}") this.#i++;
		this.#foreground = outerForeground;
		this.#background = outerBackground;
		return inner;
	}

	#readAnsiColor(): AnsiColor | null {
		const model = this.#optionalRawArgument();
		return ansiColor(model, this.#rawArgument());
	}

	#setForeground(): Rendered {
		const color = this.#readAnsiColor();
		if (color !== null) this.#foreground = color.foreground;
		return [];
	}

	#scopedForeground(color: AnsiColor | null, style: ParseStyle): Rendered {
		const outerForeground = this.#foreground;
		if (color === null) return this.#argument(style).text;
		this.#foreground = color.foreground;
		const arg = this.#argument(style).text;
		this.#foreground = outerForeground;
		return arg;
	}

	#scopedBackground(color: AnsiColor | null, style: ParseStyle): Rendered {
		const outerBackground = this.#background;
		if (color === null) return this.#argument(style).text;
		this.#background = color.background;
		const arg = this.#argument(style).text;
		this.#background = outerBackground;
		return arg;
	}

	#fcolorbox(style: ParseStyle): Rendered {
		const frameModel = this.#optionalRawArgument();
		const frame = ansiColor(frameModel, this.#rawArgument());
		const backgroundModel = this.#optionalRawArgument() ?? frameModel;
		const background = ansiColor(backgroundModel, this.#rawArgument());
		const body = this.#scopedBackground(background, style);
		const frameStyle = renderStyle(style, frame?.foreground ?? this.#foreground, this.#background);
		return concatRendered(styledText("[", frameStyle), body, styledText("]", frameStyle));
	}

	/** Read one argument: a `{…}` group, a single command, or a single char. */
	#argument(style: ParseStyle): Argument {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === undefined) return { text: [], group: false };
		if (c === "{") {
			this.#i++;
			const inner = this.parse(style, true);
			if (this.#s[this.#i] === "}") this.#i++;
			return { text: inner, group: true };
		}
		if (c === "\\") return { text: this.#command(style), group: false };
		if (c === "^" || c === "_") {
			// Bare script with no base (e.g. `{}^{n}`): treat the script as the arg.
			this.#i++;
			return { text: this.#script(style, c === "^"), group: false };
		}
		this.#i++;
		return { text: styledText(styleChar(c, style), this.#renderStyle(style)), group: false };
	}

	/** Read a raw (unparsed) argument, returning its literal source text. */
	#rawArgument(): string {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "{") {
			const c = this.#s[this.#i];
			if (c === undefined) return "";
			if (c === "\\") {
				let t = "\\";
				this.#i++;
				if (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
					while (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
						t += this.#s[this.#i];
						this.#i++;
					}
				} else {
					t += this.#s[this.#i] ?? "";
					this.#i++;
				}
				return t;
			}
			this.#i++;
			return c;
		}
		this.#i++; // past {
		let depth = 1;
		let out = "";
		while (this.#i < this.#s.length && depth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					this.#i++;
					break;
				}
			}
			out += c;
			this.#i++;
		}
		return out;
	}

	#script(style: ParseStyle, sup: boolean): Rendered {
		const current = this.#renderStyle(style);
		const arg = this.#argument(style);
		return sup ? toSuperscript(arg.text, arg.group, current) : toSubscript(arg.text, arg.group, current);
	}

	#wrapFrac(arg: Argument, fallback: RenderStyle): Rendered {
		if (!arg.group || codePointLength(arg.text) <= 1) return arg.text;
		return surroundRendered(arg.text, "(", ")", fallback);
	}

	#fraction(num: Argument, den: Argument, fallback: RenderStyle): Rendered {
		const numText = plainText(num.text);
		const denText = plainText(den.text);
		const first = num.text[0]?.style ?? fallback;
		const same = [...num.text, ...den.text].every(chunk => sameRenderStyle(chunk.style, first));
		const vulgar = VULGAR[`${numText}/${denText}`];
		if (vulgar && same) return styledText(vulgar, first);
		return concatRendered(this.#wrapFrac(num, fallback), styledText("/", fallback), this.#wrapFrac(den, fallback));
	}

	#scriptedAbove(style: ParseStyle): Rendered {
		const current = this.#renderStyle(style);
		const above = this.#argument(style);
		const base = this.#argument(style);
		return concatRendered(base.text, toSuperscript(above.text, true, current));
	}

	#scriptedBelow(style: ParseStyle): Rendered {
		const current = this.#renderStyle(style);
		const below = this.#argument(style);
		const base = this.#argument(style);
		return concatRendered(base.text, toSubscript(below.text, true, current));
	}

	#prescript(style: ParseStyle): Rendered {
		const current = this.#renderStyle(style);
		const sup = this.#argument(style);
		const sub = this.#argument(style);
		const base = this.#argument(style);
		return concatRendered(toSuperscript(sup.text, true, current), toSubscript(sub.text, true, current), base.text);
	}

	#extensibleArrow(style: ParseStyle, arrow: string): Rendered {
		const current = this.#renderStyle(style);
		const below = this.#optionalArgument(style);
		const above = this.#argument(style);
		return concatRendered(
			styledText(arrow, current),
			toSuperscript(above.text, true, current),
			below === null ? [] : toSubscript(below.text, true, current),
		);
	}

	#delimiter(style: ParseStyle): Rendered {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		const current = this.#renderStyle(style);
		if (c === undefined) return [];
		if (c === ".") {
			this.#i++;
			return [];
		}
		if (c !== "\\") {
			this.#i++;
			return styledText(styleChar(c, style), current);
		}
		this.#i++;
		if (this.#i >= this.#s.length) return [];
		const d = this.#s[this.#i];
		if (!/[A-Za-z]/.test(d)) {
			this.#i++;
			switch (d) {
				case ".":
					return [];
				case "{":
					return styledText("{", current);
				case "}":
					return styledText("}", current);
				case "|":
					return styledText("‖", current);
				default:
					return styledText(d, current);
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		return styledText(SYMBOLS[name] ?? name, current);
	}

	#optionalArgument(style: ParseStyle): Argument | null {
		const source = this.#optionalRawArgument();
		if (source === null) return null;
		return { text: new LatexParser(source).parse(style, false), group: true };
	}

	#optionalRawArgument(): string | null {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "[") return null;
		this.#i++;
		let bracketDepth = 1;
		let braceDepth = 0;
		let out = "";
		while (this.#i < this.#s.length && bracketDepth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") braceDepth++;
			else if (c === "}" && braceDepth > 0) braceDepth--;
			else if (braceDepth === 0 && c === "[") bracketDepth++;
			else if (braceDepth === 0 && c === "]") {
				bracketDepth--;
				if (bracketDepth === 0) {
					this.#i++;
					break;
				}
			}
			out += c;
			this.#i++;
		}
		return out;
	}

	#sqrt(style: ParseStyle): Rendered {
		while (this.#s[this.#i] === " ") this.#i++;
		const current = this.#renderStyle(style);
		let radical = styledText("√", current);
		const index = this.#optionalArgument(style);
		if (index !== null) {
			const indexText = plainText(index.text);
			radical =
				indexText === "2"
					? styledText("√", current)
					: indexText === "3"
						? styledText("∛", current)
						: indexText === "4"
							? styledText("∜", current)
							: concatRendered(toSuperscript(index.text, true, current), styledText("√", current));
		}
		const radicand = this.#argument(style).text;
		return concatRendered(
			radical,
			codePointLength(radicand) > 1 ? surroundRendered(radicand, "(", ")", current) : radicand,
		);
	}

	#environment(style: ParseStyle): Rendered {
		const env = this.#rawArgument().trim();
		if (env === "array" || env === "tabular" || env === "array*" || env === "tabular*") {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column spec
		} else if (
			env === "alignedat" ||
			env === "alignedat*" ||
			env === "alignat" ||
			env === "alignat*" ||
			env === "gatheredat"
		) {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column count
		}
		const body: Rendered = [];
		while (this.#i < this.#s.length) {
			if (this.#s.startsWith("\\end", this.#i)) {
				this.#i += 4;
				this.#rawArgument();
				break;
			}
			appendRendered(body, this.#node(style));
		}
		let renderedBody = trimRendered(body);
		if (
			env === "cases" ||
			env === "cases*" ||
			env === "dcases" ||
			env === "dcases*" ||
			env === "rcases" ||
			env === "drcases"
		) {
			renderedBody = renderedBody.map(chunk => ({
				...chunk,
				text: chunk.text.replace(/[ \t]*\n+[ \t]*/g, "; ").replace(/ {3,}/g, "  "),
			}));
		}
		const delims = ENV_DELIMS[env];
		if (!delims) return renderedBody;
		const current = this.#renderStyle(style);
		return concatRendered(styledText(delims[0], current), renderedBody, styledText(delims[1], current));
	}

	/** A separator space when the next glyph is alphanumeric or a command. */
	#spaceBeforeArg(): string {
		const c = this.#s[this.#i];
		if (c === undefined) return "";
		return /[A-Za-z0-9\\]/.test(c) ? " " : "";
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a bare LaTeX math fragment (no surrounding `$`/`\(` delimiters) to its
 * best-effort Unicode rendering. Unknown commands degrade to their bare name;
 * `\\` becomes a newline. Always returns a string (never throws).
 */
export function latexToUnicode(src: string): string {
	if (typeof src !== "string" || src.length === 0) return src;
	return new LatexParser(src).render();
}

const NEWLINES = /\n+/g;
const BARE_MATH_LINE_COMMAND =
	/\\(?:operatorname|frac|dfrac|tfrac|cfrac|genfrac|sqrt|sum|prod|coprod|int|iint|iiint|lim|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|phi|varphi|pi|omega|infty|partial|nabla|forall|exists|mathbb|mathcal|mathscr|mathbf|mathrm|left|right|begin|phantom|hphantom|vphantom|cdots|ldots|dots|to|rightarrow|leftarrow|leq|geq|neq|times|cdot|overline|underline|vec|hat|bar|textbf|textit|textsl|emph|textmd|textup|texttt|textsf|textcolor|color|normalcolor|colorbox|fcolorbox)\b/;

// Display-math environments eligible for delimiter-less ("bare") rendering in
// prose. Deliberately excludes text-mode table/list/float environments
// (`tabular`, `itemize`, `verbatim`, `document`, …) so ordinary LaTeX quoted in
// prose or fenced code stays verbatim instead of being mangled. Shared by the
// bare-math text scanner here and the markdown bare-env block tokenizer.
const BARE_MATH_ENVIRONMENTS = new Set([
	"matrix",
	"smallmatrix",
	"pmatrix",
	"bmatrix",
	"Bmatrix",
	"vmatrix",
	"Vmatrix",
	"cases",
	"dcases",
	"rcases",
	"drcases",
	"aligned",
	"alignedat",
	"align",
	"alignat",
	"split",
	"gathered",
	"gatheredat",
	"gather",
	"multline",
	"equation",
	"eqnarray",
	"array",
	"subarray",
]);

/**
 * True when `env` is a math environment safe to auto-render without `$`/`\[`
 * delimiters. The trailing `*` of starred variants (`align*`, `equation*`) is
 * ignored; text-mode environments (`tabular`, `itemize`, …) return false.
 */
export function isBareMathEnvironment(env: string): boolean {
	return BARE_MATH_ENVIRONMENTS.has(env.endsWith("*") ? env.slice(0, -1) : env);
}

// Convert delimiter-less math in prose: whole `\begin{env}…\end{env}` math
// blocks (optionally pulling in a preceding `lhs =` line) plus standalone
// math-shaped lines. A non-math environment is emitted verbatim — wrappers *and*
// body — so a quoted `\begin{verbatim}…\frac…\end{verbatim}` is never touched.
function renderBareMathInText(text: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const begin = text.indexOf("\\begin{", i);
		if (begin === -1) return out + renderBareMathLines(text.slice(i));
		const envStart = begin + "\\begin{".length;
		const envEnd = text.indexOf("}", envStart);
		if (envEnd === -1) return out + renderBareMathLines(text.slice(i));
		const env = text.slice(envStart, envEnd);
		const closeToken = `\\end{${env}}`;
		const close = text.indexOf(closeToken, envEnd + 1);
		if (close === -1) {
			// Unterminated `\begin`: convert lines up to it, then rescan past it.
			out += renderBareMathLines(text.slice(i, envEnd + 1));
			i = envEnd + 1;
			continue;
		}
		const blockEnd = close + closeToken.length;
		if (!isBareMathEnvironment(env)) {
			// Non-math env: convert preceding lines, emit the whole block verbatim.
			out += renderBareMathLines(text.slice(i, begin)) + text.slice(begin, blockEnd);
			i = blockEnd;
			continue;
		}
		const lineStart = text.lastIndexOf("\n", begin - 1) + 1;
		const prefix = text.slice(lineStart, begin);
		let start = prefix.includes("\\") || prefix.includes("=") ? lineStart : begin;
		if (start === begin && prefix.trim() === "" && lineStart > 0) {
			const previousLineEnd = lineStart - 1;
			const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
			const previousLine = text.slice(previousLineStart, previousLineEnd);
			if (/[=([{]\s*$/.test(previousLine)) start = previousLineStart;
		}
		out += renderBareMathLines(text.slice(i, start));
		out += latexToUnicode(text.slice(start, blockEnd)).replace(NEWLINES, " ");
		i = blockEnd;
	}
}

function renderBareMathLines(text: string): string {
	let out = "";
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		out += shouldRenderBareMathLine(line) ? latexToUnicode(line).replace(NEWLINES, " ") : line;
		if (i !== text.length) out += "\n";
		lineStart = i + 1;
	}
	return out;
}

function shouldRenderBareMathLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || !trimmed.includes("\\")) return false;
	// A lone `\begin{X}`/`\end{X}` line for a non-math environment never converts.
	const env = /\\(?:begin|end)\{([^}]*)\}/.exec(trimmed);
	if (env && !isBareMathEnvironment(env[1])) return false;
	if (!BARE_MATH_LINE_COMMAND.test(trimmed)) return false;
	return trimmed.startsWith("\\") || /[=<>^_{}&]/.test(trimmed);
}

/**
 * Scan prose for math spans — `$$…$$`, `\[…\]` (display) and `$…$`, `\(…\)`
 * (inline) — and replace each with its Unicode rendering, leaving everything
 * else verbatim. Newlines inside a span collapse to spaces so the result stays
 * single-line-safe.
 *
 * Inline `$…$` uses pandoc's anti-currency heuristics: the opener must not be
 * followed by whitespace, the closer must not be preceded by whitespace nor
 * followed by a digit, and `\$` is treated as a literal dollar — so "$5 and
 * $10" is left untouched.
 */
export function renderMathInText(text: string): string {
	if (typeof text !== "string" || text.length === 0) return text;
	if (
		!text.includes("$") &&
		!text.includes("\\(") &&
		!text.includes("\\[") &&
		!text.includes("\\begin") &&
		!BARE_MATH_LINE_COMMAND.test(text)
	) {
		return text;
	}

	const conv = (inner: string): string => latexToUnicode(inner).replace(NEWLINES, " ");
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\\") {
			const d = text[i + 1];
			if (d === "\\") {
				// Escaped backslash: emit verbatim so a following `(`/`[` is plain text.
				out += "\\\\";
				i += 2;
				continue;
			}
			if (d === "$") {
				out += "$";
				i += 2;
				continue;
			}
			// `i` as the escape bound: the walk above already consumed `\\` and `\$`.
			const span = mathSpanAt(text, i, i);
			if (span) {
				out += conv(span.body);
				i = span.end;
				continue;
			}
			out += c;
			i++;
			continue;
		}
		if (c === "$") {
			const span = mathSpanAt(text, i, i);
			if (span) {
				out += conv(span.body);
				i = span.end;
				continue;
			}
			if (text[i + 1] === "$") {
				out += "$$";
				i += 2;
				continue;
			}
			out += "$";
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return renderBareMathInText(out);
}
