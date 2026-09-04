use omp_core::{Str, StrMut};
use smallvec::SmallVec;

#[cfg(test)]
use crate::rich::RichText;
use crate::{
	frame::{Color, Style},
	rich::RichSink,
};

pub(super) type Row = SmallVec<(Style, Str), 4>;

/// Unicode mathematical-alphanumeric style selected by a LaTeX font command.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MathFont {
	Bf,
	It,
	BfIt,
	Bb,
	Cal,
	Scr,
	Frak,
	BfFrak,
	Sf,
	SfBf,
	SfIt,
	SfBfIt,
	Tt,
}

struct LineBuilder {
	line:  Row,
	style: Option<Style>,
	text:  StrMut,
}

impl LineBuilder {
	fn new() -> Self {
		Self { line: Row::new(), style: None, text: StrMut::default() }
	}

	fn push(&mut self, style: Style, text: &str) {
		if text.is_empty() {
			return;
		}
		if self.style != Some(style) {
			self.flush();
			self.style = Some(style);
		}
		self.text.push_str(text);
	}

	fn append(&mut self, line: &Row) {
		for (style, text) in line {
			self.push(*style, text.as_str());
		}
	}

	fn flush(&mut self) {
		if let Some(style) = self.style.take() {
			let text = core::mem::take(&mut self.text).freeze();
			if !text.is_empty() {
				self.line.push((style, text));
			}
		}
	}

	fn finish(mut self) -> Row {
		self.flush();
		self.line
	}
}

fn one(style: Style, text: &str) -> Row {
	let mut line = Row::new();
	if !text.is_empty() {
		line.push((style, Str::new(text)));
	}
	line
}

fn text_of(line: &Row) -> String {
	line.iter().map(|(_, text)| text.as_str()).collect()
}

fn restyle(line: &mut Row, transform: impl Fn(Style) -> Style) {
	for (style, _) in line {
		*style = transform(*style);
	}
}

fn map_line(line: &Row, map: impl Fn(char) -> Option<&'static str>) -> Option<Row> {
	let mut out = LineBuilder::new();
	for (style, text) in line {
		let mut mapped = StrMut::with_capacity(text.len());
		for ch in text.chars() {
			mapped.push_str(map(ch)?);
		}
		out.push(*style, mapped.as_str());
	}
	Some(out.finish())
}

fn combine_line(line: &Row, mark: &str) -> Row {
	let mut out = LineBuilder::new();
	for (style, text) in line {
		let mut combined = StrMut::with_capacity(text.len().saturating_mul(2));
		for ch in text.chars() {
			combined.push(ch);
			if ch != ' ' {
				combined.push_str(mark);
			}
		}
		out.push(*style, combined.as_str());
	}
	out.finish()
}

const fn superscript_char(ch: char) -> Option<&'static str> {
	Some(match ch {
		'0' => "⁰",
		'1' => "¹",
		'2' => "²",
		'3' => "³",
		'4' => "⁴",
		'5' => "⁵",
		'6' => "⁶",
		'7' => "⁷",
		'8' => "⁸",
		'9' => "⁹",
		'+' => "⁺",
		'-' | '−' => "⁻",
		'=' => "⁼",
		'(' => "⁽",
		')' => "⁾",
		'.' => "·",
		' ' => " ",
		'a' => "ᵃ",
		'b' => "ᵇ",
		'c' => "ᶜ",
		'd' => "ᵈ",
		'e' => "ᵉ",
		'f' => "ᶠ",
		'g' => "ᵍ",
		'h' => "ʰ",
		'i' => "ⁱ",
		'j' => "ʲ",
		'k' => "ᵏ",
		'l' => "ˡ",
		'm' => "ᵐ",
		'n' => "ⁿ",
		'o' => "ᵒ",
		'p' => "ᵖ",
		'r' => "ʳ",
		's' => "ˢ",
		't' => "ᵗ",
		'u' => "ᵘ",
		'v' => "ᵛ",
		'w' => "ʷ",
		'x' => "ˣ",
		'y' => "ʸ",
		'z' => "ᶻ",
		'A' => "ᴬ",
		'B' => "ᴮ",
		'D' => "ᴰ",
		'E' => "ᴱ",
		'G' => "ᴳ",
		'H' => "ᴴ",
		'I' => "ᴵ",
		'J' => "ᴶ",
		'K' => "ᴷ",
		'L' => "ᴸ",
		'M' => "ᴹ",
		'N' => "ᴺ",
		'O' => "ᴼ",
		'P' => "ᴾ",
		'R' => "ᴿ",
		'T' => "ᵀ",
		'U' => "ᵁ",
		'V' => "ⱽ",
		'W' => "ᵂ",
		'α' => "ᵅ",
		'β' => "ᵝ",
		'γ' => "ᵞ",
		'δ' => "ᵟ",
		'ε' => "ᵋ",
		'θ' => "ᶿ",
		'ι' => "ᶥ",
		'φ' => "ᵠ",
		'χ' => "ᵡ",
		_ => return None,
	})
}

const fn subscript_char(ch: char) -> Option<&'static str> {
	Some(match ch {
		'0' => "₀",
		'1' => "₁",
		'2' => "₂",
		'3' => "₃",
		'4' => "₄",
		'5' => "₅",
		'6' => "₆",
		'7' => "₇",
		'8' => "₈",
		'9' => "₉",
		'+' => "₊",
		'-' | '−' => "₋",
		'=' => "₌",
		'(' => "₍",
		')' => "₎",
		' ' => " ",
		'a' => "ₐ",
		'e' => "ₑ",
		'h' => "ₕ",
		'i' => "ᵢ",
		'j' => "ⱼ",
		'k' => "ₖ",
		'l' => "ₗ",
		'm' => "ₘ",
		'n' => "ₙ",
		'o' => "ₒ",
		'p' => "ₚ",
		'r' => "ᵣ",
		's' => "ₛ",
		't' => "ₜ",
		'u' => "ᵤ",
		'v' => "ᵥ",
		'x' => "ₓ",
		'β' => "ᵦ",
		'γ' => "ᵧ",
		'ρ' => "ᵨ",
		'φ' => "ᵩ",
		'χ' => "ᵪ",
		_ => return None,
	})
}

/// Maps a complete string to Unicode superscript glyphs.
pub fn to_superscript(text: &str) -> Option<String> {
	let mut out = String::with_capacity(text.len());
	for ch in text.chars() {
		out.push_str(superscript_char(ch)?);
	}
	Some(out)
}

fn vulgar_fraction(num: &str, den: &str) -> Option<&'static str> {
	Some(match (num, den) {
		("1", "2") => "½",
		("1", "3") => "⅓",
		("2", "3") => "⅔",
		("1", "4") => "¼",
		("3", "4") => "¾",
		("1", "5") => "⅕",
		("2", "5") => "⅖",
		("3", "5") => "⅗",
		("4", "5") => "⅘",
		("1", "6") => "⅙",
		("5", "6") => "⅚",
		("1", "7") => "⅐",
		("1", "8") => "⅛",
		("3", "8") => "⅜",
		("5", "8") => "⅝",
		("7", "8") => "⅞",
		("1", "9") => "⅑",
		("1", "10") => "⅒",
		("0", "3") => "↉",
		_ => return None,
	})
}

fn accent(name: &str) -> Option<&'static str> {
	Some(match name {
		"hat" => "̂",
		"widehat" => "̂",
		"check" => "̌",
		"widecheck" => "̌",
		"tilde" => "̃",
		"widetilde" => "̃",
		"acute" => "́",
		"grave" => "̀",
		"dot" => "̇",
		"ddot" => "̈",
		"dddot" => "⃛",
		"ddddot" => "⃜",
		"breve" => "̆",
		"bar" => "̄",
		"vec" => "⃗",
		"overrightarrow" => "⃗",
		"overleftarrow" => "⃖",
		"mathring" => "̊",
		"overline" => "̅",
		"underline" => "̲",
		"underbar" => "̲",
		_ => return None,
	})
}

fn negated(text: &str) -> Option<&'static str> {
	Some(match text {
		"=" => "≠",
		"<" => "≮",
		">" => "≯",
		"∈" => "∉",
		"∋" => "∌",
		"⊂" => "⊄",
		"⊃" => "⊅",
		"⊆" => "⊈",
		"⊇" => "⊉",
		"≡" => "≢",
		"∃" => "∄",
		"≤" => "≰",
		"≥" => "≱",
		"≈" => "≉",
		"≅" => "≇",
		"∼" => "≁",
		"≃" => "≄",
		"∣" => "∤",
		"∥" => "∦",
		"≺" => "⊀",
		"≻" => "⊁",
		"⊑" => "⋢",
		"⊒" => "⋣",
		_ => return None,
	})
}

/// Resolves a LaTeX symbol command to its Unicode glyph.
pub fn command_symbol(name: &str) -> Option<&'static str> {
	Some(match name {
		"alpha" => "α",
		"beta" => "β",
		"gamma" => "γ",
		"delta" => "δ",
		"epsilon" => "ϵ",
		"varepsilon" => "ε",
		"zeta" => "ζ",
		"eta" => "η",
		"theta" => "θ",
		"vartheta" => "ϑ",
		"iota" => "ι",
		"kappa" => "κ",
		"varkappa" => "ϰ",
		"lambda" => "λ",
		"mu" => "μ",
		"nu" => "ν",
		"xi" => "ξ",
		"omicron" => "ο",
		"pi" => "π",
		"varpi" => "ϖ",
		"rho" => "ρ",
		"varrho" => "ϱ",
		"sigma" => "σ",
		"varsigma" => "ς",
		"tau" => "τ",
		"upsilon" => "υ",
		"phi" => "ϕ",
		"varphi" => "φ",
		"chi" => "χ",
		"psi" => "ψ",
		"omega" => "ω",
		"digamma" => "ϝ",
		"Gamma" => "Γ",
		"Delta" => "Δ",
		"Theta" => "Θ",
		"Lambda" => "Λ",
		"Xi" => "Ξ",
		"Pi" => "Π",
		"Sigma" => "Σ",
		"Upsilon" => "Υ",
		"Phi" => "Φ",
		"Psi" => "Ψ",
		"Omega" => "Ω",
		"sum" => "∑",
		"prod" => "∏",
		"coprod" => "∐",
		"int" => "∫",
		"iint" => "∬",
		"iiint" => "∭",
		"iiiint" => "⨌",
		"oint" => "∮",
		"oiint" => "∯",
		"oiiint" => "∰",
		"bigcap" => "⋂",
		"bigcup" => "⋃",
		"bigsqcup" => "⨆",
		"bigvee" => "⋁",
		"bigwedge" => "⋀",
		"bigodot" => "⨀",
		"bigoplus" => "⨁",
		"bigotimes" => "⨂",
		"biguplus" => "⨄",
		"Cap" => "⋒",
		"Cup" => "⋓",
		"bigstar" => "★",
		"pm" => "±",
		"mp" => "∓",
		"times" => "×",
		"div" => "÷",
		"ast" => "∗",
		"star" => "⋆",
		"circ" => "∘",
		"bullet" => "∙",
		"cdot" => "⋅",
		"cdotp" => "·",
		"centerdot" => "·",
		"cap" => "∩",
		"cup" => "∪",
		"uplus" => "⊎",
		"sqcap" => "⊓",
		"sqcup" => "⊔",
		"vee" => "∨",
		"wedge" => "∧",
		"land" => "∧",
		"lor" => "∨",
		"setminus" => "∖",
		"smallsetminus" => "∖",
		"wr" => "≀",
		"amalg" => "⨿",
		"diamond" => "⋄",
		"Diamond" => "◇",
		"bigtriangleup" => "△",
		"bigtriangledown" => "▽",
		"triangleleft" => "◁",
		"triangleright" => "▷",
		"lhd" => "⊲",
		"rhd" => "⊳",
		"unlhd" => "⊴",
		"unrhd" => "⊵",
		"oplus" => "⊕",
		"ominus" => "⊖",
		"otimes" => "⊗",
		"oslash" => "⊘",
		"odot" => "⊙",
		"dagger" => "†",
		"ddagger" => "‡",
		"boxplus" => "⊞",
		"boxtimes" => "⊠",
		"boxdot" => "⊡",
		"boxminus" => "⊟",
		"ltimes" => "⋉",
		"rtimes" => "⋊",
		"leftthreetimes" => "⋋",
		"rightthreetimes" => "⋌",
		"curlyvee" => "⋎",
		"curlywedge" => "⋏",
		"barwedge" => "⊼",
		"veebar" => "⊻",
		"doublebarwedge" => "⩞",
		"circledast" => "⊛",
		"circledcirc" => "⊚",
		"circleddash" => "⊝",
		"divideontimes" => "⋇",
		"dotplus" => "∔",
		"leq" => "≤",
		"le" => "≤",
		"geq" => "≥",
		"ge" => "≥",
		"ll" => "≪",
		"gg" => "≫",
		"neq" => "≠",
		"ne" => "≠",
		"equiv" => "≡",
		"doteq" => "≐",
		"sim" => "∼",
		"simeq" => "≃",
		"approx" => "≈",
		"approxeq" => "≊",
		"cong" => "≅",
		"propto" => "∝",
		"asymp" => "≍",
		"prec" => "≺",
		"succ" => "≻",
		"preceq" => "⪯",
		"succeq" => "⪰",
		"subset" => "⊂",
		"supset" => "⊃",
		"subseteq" => "⊆",
		"supseteq" => "⊇",
		"subsetneq" => "⊊",
		"supsetneq" => "⊋",
		"sqsubset" => "⊏",
		"sqsupset" => "⊐",
		"sqsubseteq" => "⊑",
		"sqsupseteq" => "⊒",
		"in" => "∈",
		"ni" => "∋",
		"owns" => "∋",
		"notin" => "∉",
		"mid" => "∣",
		"nmid" => "∤",
		"parallel" => "∥",
		"nparallel" => "∦",
		"perp" => "⊥",
		"vdash" => "⊢",
		"dashv" => "⊣",
		"models" => "⊨",
		"vDash" => "⊨",
		"Vdash" => "⊩",
		"bowtie" => "⋈",
		"smile" => "⌣",
		"frown" => "⌢",
		"between" => "≬",
		"lessgtr" => "≶",
		"gtrless" => "≷",
		"leqslant" => "⩽",
		"geqslant" => "⩾",
		"lesssim" => "≲",
		"gtrsim" => "≳",
		"lessapprox" => "⪅",
		"gtrapprox" => "⪆",
		"leqq" => "≦",
		"geqq" => "≧",
		"lneq" => "⪇",
		"gneq" => "⪈",
		"lneqq" => "≨",
		"gneqq" => "≩",
		"nleq" => "≰",
		"ngeq" => "≱",
		"nless" => "≮",
		"ngtr" => "≯",
		"nsubseteq" => "⊈",
		"nsupseteq" => "⊉",
		"nsim" => "≁",
		"ncong" => "≇",
		"triangleq" => "≜",
		"coloneqq" => "≔",
		"eqqcolon" => "≕",
		"risingdotseq" => "≓",
		"fallingdotseq" => "≒",
		"circeq" => "≗",
		"eqcirc" => "≖",
		"precsim" => "≾",
		"succsim" => "≿",
		"precapprox" => "⪷",
		"succapprox" => "⪸",
		"curlyeqprec" => "⋞",
		"curlyeqsucc" => "⋟",
		"Subset" => "⋐",
		"Supset" => "⋑",
		"subseteqq" => "⫅",
		"supseteqq" => "⫆",
		"subsetneqq" => "⫋",
		"supsetneqq" => "⫌",
		"Vvdash" => "⊪",
		"shortmid" => "∣",
		"shortparallel" => "∥",
		"pitchfork" => "⋔",
		"leftarrow" => "←",
		"gets" => "←",
		"rightarrow" => "→",
		"to" => "→",
		"leftrightarrow" => "↔",
		"Leftarrow" => "⇐",
		"Rightarrow" => "⇒",
		"Leftrightarrow" => "⇔",
		"uparrow" => "↑",
		"downarrow" => "↓",
		"updownarrow" => "↕",
		"Uparrow" => "⇑",
		"Downarrow" => "⇓",
		"Updownarrow" => "⇕",
		"mapsto" => "↦",
		"longmapsto" => "⟼",
		"hookleftarrow" => "↩",
		"hookrightarrow" => "↪",
		"leftharpoonup" => "↼",
		"rightharpoonup" => "⇀",
		"leftharpoondown" => "↽",
		"rightharpoondown" => "⇁",
		"rightleftharpoons" => "⇌",
		"longleftarrow" => "⟵",
		"longrightarrow" => "⟶",
		"longleftrightarrow" => "⟷",
		"Longleftarrow" => "⟸",
		"Longrightarrow" => "⟹",
		"Longleftrightarrow" => "⟺",
		"implies" => "⟹",
		"impliedby" => "⟸",
		"iff" => "⟺",
		"nearrow" => "↗",
		"searrow" => "↘",
		"swarrow" => "↙",
		"nwarrow" => "↖",
		"nleftarrow" => "↚",
		"nrightarrow" => "↛",
		"leadsto" => "⇝",
		"rightsquigarrow" => "⇝",
		"leftrightsquigarrow" => "↭",
		"twoheadrightarrow" => "↠",
		"twoheadleftarrow" => "↞",
		"leftrightharpoons" => "⇋",
		"rightleftarrows" => "⇄",
		"leftrightarrows" => "⇆",
		"leftleftarrows" => "⇇",
		"rightrightarrows" => "⇉",
		"upuparrows" => "⇈",
		"downdownarrows" => "⇊",
		"circlearrowleft" => "↺",
		"circlearrowright" => "↻",
		"curvearrowleft" => "↶",
		"curvearrowright" => "↷",
		"dashleftarrow" => "⇠",
		"dashrightarrow" => "⇢",
		"Lleftarrow" => "⇚",
		"Rrightarrow" => "⇛",
		"leftarrowtail" => "↢",
		"rightarrowtail" => "↣",
		"looparrowleft" => "↫",
		"looparrowright" => "↬",
		"multimap" => "⊸",
		"infty" => "∞",
		"partial" => "∂",
		"nabla" => "∇",
		"forall" => "∀",
		"exists" => "∃",
		"nexists" => "∄",
		"emptyset" => "∅",
		"varnothing" => "∅",
		"neg" => "¬",
		"lnot" => "¬",
		"top" => "⊤",
		"bot" => "⊥",
		"angle" => "∠",
		"measuredangle" => "∡",
		"sphericalangle" => "∢",
		"aleph" => "ℵ",
		"beth" => "ℶ",
		"gimel" => "ℷ",
		"daleth" => "ℸ",
		"hbar" => "ℏ",
		"hslash" => "ℏ",
		"ell" => "ℓ",
		"imath" => "ı",
		"jmath" => "ȷ",
		"wp" => "℘",
		"Re" => "ℜ",
		"Im" => "ℑ",
		"mho" => "℧",
		"complement" => "∁",
		"surd" => "√",
		"flat" => "♭",
		"natural" => "♮",
		"sharp" => "♯",
		"clubsuit" => "♣",
		"diamondsuit" => "♦",
		"heartsuit" => "♥",
		"spadesuit" => "♠",
		"clubs" => "♣",
		"diamonds" => "♦",
		"hearts" => "♥",
		"spades" => "♠",
		"therefore" => "∴",
		"because" => "∵",
		"checkmark" => "✓",
		"maltese" => "✠",
		"dag" => "†",
		"ddag" => "‡",
		"S" => "§",
		"P" => "¶",
		"copyright" => "©",
		"circledR" => "®",
		"pounds" => "£",
		"yen" => "¥",
		"euro" => "€",
		"degree" => "°",
		"prime" => "′",
		"backprime" => "‵",
		"colon" => ":",
		"semicolon" => ";",
		"neper" => "₪",
		"square" => "□",
		"Box" => "□",
		"blacksquare" => "■",
		"lozenge" => "◊",
		"blacklozenge" => "⧫",
		"triangle" => "△",
		"blacktriangle" => "▴",
		"blacktriangledown" => "▾",
		"blacktriangleleft" => "◂",
		"blacktriangleright" => "▸",
		"diagup" => "╱",
		"diagdown" => "╲",
		"backepsilon" => "϶",
		"Game" => "⅁",
		"eth" => "ð",
		"ldots" => "…",
		"dots" => "…",
		"cdots" => "⋯",
		"vdots" => "⋮",
		"ddots" => "⋱",
		"hdots" => "…",
		"mathellipsis" => "…",
		"dotsc" => "…",
		"dotsb" => "⋯",
		"dotsm" => "⋯",
		"dotsi" => "⋯",
		"langle" => "⟨",
		"rangle" => "⟩",
		"lceil" => "⌈",
		"rceil" => "⌉",
		"lfloor" => "⌊",
		"rfloor" => "⌋",
		"lbrace" => "{",
		"rbrace" => "}",
		"lbrack" => "[",
		"rbrack" => "]",
		"vert" => "|",
		"Vert" => "‖",
		"lvert" => "|",
		"rvert" => "|",
		"lVert" => "‖",
		"rVert" => "‖",
		"backslash" => "\\",
		"slash" => "/",
		"ulcorner" => "⌜",
		"urcorner" => "⌝",
		"llcorner" => "⌞",
		"lrcorner" => "⌟",
		"lmoustache" => "⎰",
		"rmoustache" => "⎱",
		"lgroup" => "⟮",
		"rgroup" => "⟯",
		"bracevert" => "⎪",
		"Reals" => "ℝ",
		"Complex" => "ℂ",
		"Natural" => "ℕ",
		"Integer" => "ℤ",
		"Rational" => "ℚ",
		_ => return None,
	})
}

/// Resolves a LaTeX math font command.
pub fn math_font(command: &str) -> Option<MathFont> {
	Some(match command {
		"mathbf" | "pmb" => MathFont::Bf,
		"mathit" => MathFont::It,
		"boldsymbol" | "bm" | "mathbfit" => MathFont::BfIt,
		"mathbb" | "Bbb" | "mathds" | "mathbbm" => MathFont::Bb,
		"mathcal" => MathFont::Cal,
		"mathscr" | "mathbfscr" | "mathbfcal" => MathFont::Scr,
		"mathfrak" => MathFont::Frak,
		"mathbffrak" | "mathfrakbold" => MathFont::BfFrak,
		"mathsf" => MathFont::Sf,
		"mathsfbf" | "mathbfsf" => MathFont::SfBf,
		"mathsfit" => MathFont::SfIt,
		"mathsfbfit" | "mathbfsfit" => MathFont::SfBfIt,
		"mathtt" => MathFont::Tt,
		_ => return None,
	})
}
/// Applies a text-mode LaTeX command to terminal style attributes.
pub(super) fn terminal_text_style(mut style: Style, command: &str) -> Option<Style> {
	match command {
		"textbf" => style.bold = true,
		"textit" | "textsl" | "emph" => style.italic = true,
		"textmd" => style.bold = false,
		"textup" => style.italic = false,
		"texttt" | "textsf" => {},
		_ => return None,
	}
	Some(style)
}

const fn plane(font: MathFont) -> (u32, u32, Option<u32>, &'static str) {
	match font {
		MathFont::Bf => (0x1d400, 0x1d41a, Some(0x1d7ce), "bold"),
		MathFont::It => (0x1d434, 0x1d44e, None, "italic"),
		MathFont::BfIt => (0x1d468, 0x1d482, None, "bolditalic"),
		MathFont::Cal => (0x1d49c, 0x1d4b6, None, "script"),
		MathFont::Scr => (0x1d4d0, 0x1d4ea, None, "boldscript"),
		MathFont::Frak => (0x1d504, 0x1d51e, None, "fraktur"),
		MathFont::Bb => (0x1d538, 0x1d552, Some(0x1d7d8), "doublestruck"),
		MathFont::BfFrak => (0x1d56c, 0x1d586, None, "boldfraktur"),
		MathFont::Sf => (0x1d5a0, 0x1d5ba, Some(0x1d7e2), "sans"),
		MathFont::SfBf => (0x1d5d4, 0x1d5ee, Some(0x1d7ec), "sansbold"),
		MathFont::SfIt => (0x1d608, 0x1d622, None, "sansitalic"),
		MathFont::SfBfIt => (0x1d63c, 0x1d656, None, "sansbolditalic"),
		MathFont::Tt => (0x1d670, 0x1d68a, Some(0x1d7f6), "mono"),
	}
}

fn alpha_hole(style: &str, ch: char) -> Option<char> {
	Some(match (style, ch) {
		("italic", 'h') => 'ℎ',
		("script", 'B') => 'ℬ',
		("script", 'E') => 'ℰ',
		("script", 'F') => 'ℱ',
		("script", 'H') => 'ℋ',
		("script", 'I') => 'ℐ',
		("script", 'L') => 'ℒ',
		("script", 'M') => 'ℳ',
		("script", 'R') => 'ℛ',
		("script", 'e') => 'ℯ',
		("script", 'g') => 'ℊ',
		("script", 'o') => 'ℴ',
		("fraktur", 'C') => 'ℭ',
		("fraktur", 'H') => 'ℌ',
		("fraktur", 'I') => 'ℑ',
		("fraktur", 'R') => 'ℜ',
		("fraktur", 'Z') => 'ℨ',
		("doublestruck", 'C') => 'ℂ',
		("doublestruck", 'H') => 'ℍ',
		("doublestruck", 'N') => 'ℕ',
		("doublestruck", 'P') => 'ℙ',
		("doublestruck", 'Q') => 'ℚ',
		("doublestruck", 'R') => 'ℝ',
		("doublestruck", 'Z') => 'ℤ',
		_ => return None,
	})
}

fn font_char(font: MathFont, ch: char) -> char {
	let (upper, lower, digit, name) = plane(font);
	if let Some(hole) = alpha_hole(name, ch) {
		return hole;
	}
	let code = ch as u32;
	let mapped = if ch.is_ascii_uppercase() {
		Some(upper + code - u32::from(b'A'))
	} else if ch.is_ascii_lowercase() {
		Some(lower + code - u32::from(b'a'))
	} else if ch.is_ascii_digit() {
		digit.map(|base| base + code - u32::from(b'0'))
	} else {
		None
	};
	mapped.and_then(char::from_u32).unwrap_or(ch)
}

/// Applies a Unicode mathematical-alphanumeric font to ASCII alphanumerics.
pub fn apply_math_font(font: MathFont, text: &str) -> String {
	text.chars().map(|ch| font_char(font, ch)).collect()
}

fn named_color(name: &str) -> Option<(u8, u8, u8)> {
	Some(match name {
		"aliceblue" => (240, 248, 255),
		"antiquewhite" => (250, 235, 215),
		"aqua" => (0, 255, 255),
		"aquamarine" => (127, 255, 212),
		"azure" => (240, 255, 255),
		"beige" => (245, 245, 220),
		"bisque" => (255, 228, 196),
		"black" => (0, 0, 0),
		"blanchedalmond" => (255, 235, 205),
		"blue" => (0, 0, 255),
		"blueviolet" => (138, 43, 226),
		"brown" => (165, 42, 42),
		"burlywood" => (222, 184, 135),
		"cadetblue" => (95, 158, 160),
		"chartreuse" => (127, 255, 0),
		"chocolate" => (210, 105, 30),
		"coral" => (255, 127, 80),
		"cornflowerblue" => (100, 149, 237),
		"cornsilk" => (255, 248, 220),
		"crimson" => (220, 20, 60),
		"cyan" => (0, 255, 255),
		"darkblue" => (0, 0, 139),
		"darkcyan" => (0, 139, 139),
		"darkgoldenrod" => (184, 134, 11),
		"darkgray" => (64, 64, 64),
		"darkgreen" => (0, 100, 0),
		"darkgrey" => (64, 64, 64),
		"darkkhaki" => (189, 183, 107),
		"darkmagenta" => (139, 0, 139),
		"darkolivegreen" => (85, 107, 47),
		"darkorange" => (255, 140, 0),
		"darkorchid" => (153, 50, 204),
		"darkred" => (139, 0, 0),
		"darksalmon" => (233, 150, 122),
		"darkseagreen" => (143, 188, 143),
		"darkslateblue" => (72, 61, 139),
		"darkslategray" => (47, 79, 79),
		"darkslategrey" => (47, 79, 79),
		"darkturquoise" => (0, 206, 209),
		"darkviolet" => (148, 0, 211),
		"deeppink" => (255, 20, 147),
		"deepskyblue" => (0, 191, 255),
		"dimgray" => (105, 105, 105),
		"dimgrey" => (105, 105, 105),
		"dodgerblue" => (30, 144, 255),
		"firebrick" => (178, 34, 34),
		"floralwhite" => (255, 250, 240),
		"forestgreen" => (34, 139, 34),
		"fuchsia" => (255, 0, 255),
		"gainsboro" => (220, 220, 220),
		"ghostwhite" => (248, 248, 255),
		"gold" => (255, 215, 0),
		"goldenrod" => (218, 165, 32),
		"gray" => (128, 128, 128),
		"green" => (0, 255, 0),
		"greenyellow" => (173, 255, 47),
		"grey" => (128, 128, 128),
		"honeydew" => (240, 255, 240),
		"hotpink" => (255, 105, 180),
		"indianred" => (205, 92, 92),
		"indigo" => (75, 0, 130),
		"ivory" => (255, 255, 240),
		"khaki" => (240, 230, 140),
		"lavender" => (230, 230, 250),
		"lavenderblush" => (255, 240, 245),
		"lawngreen" => (124, 252, 0),
		"lemonchiffon" => (255, 250, 205),
		"lightblue" => (173, 216, 230),
		"lightcoral" => (240, 128, 128),
		"lightcyan" => (224, 255, 255),
		"lightgoldenrodyellow" => (250, 250, 210),
		"lightgray" => (192, 192, 192),
		"lightgreen" => (144, 238, 144),
		"lightgrey" => (192, 192, 192),
		"lightpink" => (255, 182, 193),
		"lightsalmon" => (255, 160, 122),
		"lightseagreen" => (32, 178, 170),
		"lightskyblue" => (135, 206, 250),
		"lightslategray" => (119, 136, 153),
		"lightslategrey" => (119, 136, 153),
		"lightsteelblue" => (176, 196, 222),
		"lightyellow" => (255, 255, 224),
		"lime" => (0, 255, 0),
		"limegreen" => (50, 205, 50),
		"linen" => (250, 240, 230),
		"magenta" => (255, 0, 255),
		"maroon" => (128, 0, 0),
		"mediumaquamarine" => (102, 205, 170),
		"mediumblue" => (0, 0, 205),
		"mediumorchid" => (186, 85, 211),
		"mediumpurple" => (147, 112, 219),
		"mediumseagreen" => (60, 179, 113),
		"mediumslateblue" => (123, 104, 238),
		"mediumspringgreen" => (0, 250, 154),
		"mediumturquoise" => (72, 209, 204),
		"mediumvioletred" => (199, 21, 133),
		"midnightblue" => (25, 25, 112),
		"mintcream" => (245, 255, 250),
		"mistyrose" => (255, 228, 225),
		"moccasin" => (255, 228, 181),
		"navajowhite" => (255, 222, 173),
		"navy" => (0, 0, 128),
		"oldlace" => (253, 245, 230),
		"olive" => (128, 128, 0),
		"olivedrab" => (107, 142, 35),
		"orange" => (255, 165, 0),
		"orangered" => (255, 69, 0),
		"orchid" => (218, 112, 214),
		"palegoldenrod" => (238, 232, 170),
		"palegreen" => (152, 251, 152),
		"paleturquoise" => (175, 238, 238),
		"palevioletred" => (219, 112, 147),
		"papayawhip" => (255, 239, 213),
		"peachpuff" => (255, 218, 185),
		"peru" => (205, 133, 63),
		"pink" => (255, 192, 203),
		"plum" => (221, 160, 221),
		"powderblue" => (176, 224, 230),
		"purple" => (128, 0, 128),
		"rebeccapurple" => (102, 51, 153),
		"red" => (255, 0, 0),
		"rosybrown" => (188, 143, 143),
		"royalblue" => (65, 105, 225),
		"saddlebrown" => (139, 69, 19),
		"salmon" => (250, 128, 114),
		"sandybrown" => (244, 164, 96),
		"seagreen" => (46, 139, 87),
		"seashell" => (255, 245, 238),
		"sienna" => (160, 82, 45),
		"silver" => (192, 192, 192),
		"skyblue" => (135, 206, 235),
		"slateblue" => (106, 90, 205),
		"slategray" => (112, 128, 144),
		"slategrey" => (112, 128, 144),
		"snow" => (255, 250, 250),
		"springgreen" => (0, 255, 127),
		"steelblue" => (70, 130, 180),
		"tan" => (210, 180, 140),
		"teal" => (0, 128, 128),
		"thistle" => (216, 191, 216),
		"tomato" => (255, 99, 71),
		"turquoise" => (64, 224, 208),
		"violet" => (238, 130, 238),
		"wheat" => (245, 222, 179),
		"white" => (255, 255, 255),
		"whitesmoke" => (245, 245, 245),
		"yellow" => (255, 255, 0),
		"yellowgreen" => (154, 205, 50),
		"Apricot" => (251, 185, 130),
		"Aquamarine" => (0, 181, 190),
		"Bittersweet" => (192, 79, 23),
		"BlueGreen" => (0, 179, 184),
		"BlueViolet" => (71, 57, 146),
		"BrickRed" => (182, 50, 28),
		"BurntOrange" => (247, 146, 29),
		"CadetBlue" => (116, 114, 154),
		"CarnationPink" => (242, 130, 180),
		"Cerulean" => (0, 162, 227),
		"CornflowerBlue" => (65, 176, 228),
		"Dandelion" => (253, 188, 66),
		"DarkOrchid" => (164, 83, 138),
		"Emerald" => (0, 169, 157),
		"ForestGreen" => (0, 155, 85),
		"Fuchsia" => (140, 54, 140),
		"Goldenrod" => (255, 223, 0),
		"GreenYellow" => (223, 230, 116),
		"JungleGreen" => (0, 169, 154),
		"Lavender" => (244, 158, 196),
		"LimeGreen" => (141, 199, 62),
		"Mahogany" => (169, 52, 31),
		"Maroon" => (175, 50, 53),
		"Melon" => (248, 158, 123),
		"MidnightBlue" => (0, 103, 149),
		"Mulberry" => (169, 60, 147),
		"NavyBlue" => (0, 110, 184),
		"OliveGreen" => (60, 128, 49),
		"OrangeRed" => (237, 19, 90),
		"Orchid" => (175, 114, 176),
		"Peach" => (247, 150, 90),
		"Periwinkle" => (121, 119, 184),
		"PineGreen" => (0, 139, 114),
		"Plum" => (146, 38, 143),
		"ProcessBlue" => (0, 176, 240),
		"RawSienna" => (151, 64, 6),
		"RedOrange" => (242, 96, 53),
		"RedViolet" => (161, 36, 107),
		"Rhodamine" => (239, 85, 159),
		"RoyalBlue" => (0, 113, 188),
		"RoyalPurple" => (97, 63, 153),
		"RubineRed" => (237, 1, 125),
		"Salmon" => (246, 146, 137),
		"SeaGreen" => (63, 188, 157),
		"Sepia" => (103, 24, 0),
		"SkyBlue" => (70, 197, 221),
		"SpringGreen" => (198, 220, 103),
		"Tan" => (218, 157, 118),
		"TealBlue" => (0, 174, 179),
		"Thistle" => (216, 131, 183),
		"Turquoise" => (0, 180, 206),
		"VioletRed" => (239, 88, 160),
		"WildStrawberry" => (238, 41, 103),
		"YellowGreen" => (152, 204, 112),
		"YellowOrange" => (250, 162, 26),
		_ => return None,
	})
}

const fn clamp01(value: f64) -> f64 {
	value.clamp(0.0, 1.0)
}

const fn byte(value: f64) -> u8 {
	value.clamp(0.0, 255.0).round() as u8
}

fn number(raw: &str) -> Option<f64> {
	let raw = raw.trim();
	if let Some(percent) = raw.strip_suffix('%') {
		return percent
			.trim()
			.parse::<f64>()
			.ok()
			.filter(|n| n.is_finite())
			.map(|n| n / 100.0);
	}
	raw.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn components<const N: usize>(spec: &str) -> Option<[f64; N]> {
	let mut values = [0.0; N];
	let mut parts = spec
		.split(|ch: char| ch == ',' || ch.is_whitespace())
		.filter(|part| !part.is_empty());
	for value in &mut values {
		*value = number(parts.next()?)?;
	}
	parts.next().is_none().then_some(values)
}

fn parse_hex(spec: &str) -> Option<(u8, u8, u8)> {
	let trimmed = spec.trim();
	let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
	match hex.len() {
		3 | 4 if hex.bytes().all(|ch| ch.is_ascii_hexdigit()) => {
			let mut chars = hex.bytes();
			let nibble = |ch: u8| (ch as char).to_digit(16).map(|n| n as u8 * 17);
			Some((nibble(chars.next()?)?, nibble(chars.next()?)?, nibble(chars.next()?)?))
		},
		6 | 8 if hex.bytes().all(|ch| ch.is_ascii_hexdigit()) => Some((
			u8::from_str_radix(&hex[0..2], 16).ok()?,
			u8::from_str_radix(&hex[2..4], 16).ok()?,
			u8::from_str_radix(&hex[4..6], 16).ok()?,
		)),
		_ => None,
	}
}

fn hsv(values: [f64; 3], hue_scale: f64) -> (u8, u8, u8) {
	let hue = ((values[0] * hue_scale).rem_euclid(360.0)) / 60.0;
	let saturation = clamp01(values[1]);
	let value = clamp01(values[2]);
	let chroma = value * saturation;
	let intermediate = chroma * (1.0 - ((hue % 2.0) - 1.0).abs());
	let match_val = value - chroma;
	let (red, green, blue) = if hue < 1.0 {
		(chroma, intermediate, 0.0)
	} else if hue < 2.0 {
		(intermediate, chroma, 0.0)
	} else if hue < 3.0 {
		(0.0, chroma, intermediate)
	} else if hue < 4.0 {
		(0.0, intermediate, chroma)
	} else if hue < 5.0 {
		(intermediate, 0.0, chroma)
	} else {
		(chroma, 0.0, intermediate)
	};
	(
		byte((red + match_val) * 255.0),
		byte((green + match_val) * 255.0),
		byte((blue + match_val) * 255.0),
	)
}

fn modeled_color(model: &str, spec: &str) -> Option<(u8, u8, u8)> {
	let model = model.trim();
	if model.is_empty() || model == "named" {
		return color_rgb(spec);
	}
	if matches!(model, "HTML" | "Html" | "html") {
		return parse_hex(spec);
	}
	if model == "RGB" {
		let [r, g, b] = components::<3>(spec)?;
		return Some((byte(r), byte(g), byte(b)));
	}
	let lower = model.to_ascii_lowercase();
	match lower.as_str() {
		"rgb" => {
			let [r, g, b] = components::<3>(spec)?;
			Some((byte(clamp01(r) * 255.0), byte(clamp01(g) * 255.0), byte(clamp01(b) * 255.0)))
		},
		"cmyk" => {
			let [c, m, y, k] = components::<4>(spec)?.map(clamp01);
			Some((
				byte(255.0 * (1.0 - c) * (1.0 - k)),
				byte(255.0 * (1.0 - m) * (1.0 - k)),
				byte(255.0 * (1.0 - y) * (1.0 - k)),
			))
		},
		"gray" | "grey" => {
			let [mut value] = components::<1>(spec)?;
			if matches!(model, "Gray" | "Grey") {
				value /= 15.0;
			}
			let gray = byte(clamp01(value) * 255.0);
			Some((gray, gray, gray))
		},
		"hsb" | "hsv" => Some(hsv(
			components::<3>(spec)?,
			if matches!(model, "Hsb" | "HSV") {
				1.0
			} else {
				360.0
			},
		)),
		"wave" => wavelength(number(spec)?),
		_ => color_rgb(spec),
	}
}

fn wavelength(wave: f64) -> Option<(u8, u8, u8)> {
	if !(380.0..=780.0).contains(&wave) {
		return None;
	}
	let (r, g, b) = if wave < 440.0 {
		(-(wave - 440.0) / 60.0, 0.0, 1.0)
	} else if wave < 490.0 {
		(0.0, (wave - 440.0) / 50.0, 1.0)
	} else if wave < 510.0 {
		(0.0, 1.0, -(wave - 510.0) / 20.0)
	} else if wave < 580.0 {
		((wave - 510.0) / 70.0, 1.0, 0.0)
	} else if wave < 645.0 {
		(1.0, -(wave - 645.0) / 65.0, 0.0)
	} else {
		(1.0, 0.0, 0.0)
	};
	let factor = if wave < 420.0 {
		0.3 + 0.7 * (wave - 380.0) / 40.0
	} else if wave > 700.0 {
		0.3 + 0.7 * (780.0 - wave) / 80.0
	} else {
		1.0
	};
	Some((byte(r * factor * 255.0), byte(g * factor * 255.0), byte(b * factor * 255.0)))
}

fn functional_rgb(spec: &str) -> Option<(u8, u8, u8)> {
	let lower = spec.to_ascii_lowercase();
	let body = lower.strip_prefix("rgb(")?.strip_suffix(')')?;
	let [r, g, b] = components::<3>(body)?;
	let percent = body.contains('%');
	Some(if percent {
		(byte(clamp01(r) * 255.0), byte(clamp01(g) * 255.0), byte(clamp01(b) * 255.0))
	} else {
		(byte(r), byte(g), byte(b))
	})
}

fn plain_color(spec: &str) -> Option<(u8, u8, u8)> {
	let trimmed = spec.trim();
	if trimmed.starts_with('#') {
		return parse_hex(trimmed);
	}
	functional_rgb(trimmed)
		.or_else(|| named_color(&trimmed.to_ascii_lowercase()))
		.or_else(|| named_color(trimmed))
}

fn mixed_color(spec: &str) -> Option<(u8, u8, u8)> {
	let parts: SmallVec<&str, 8> = spec.split('!').collect();
	if parts.len() < 2 {
		return None;
	}
	let first = plain_color(parts[0])?;
	let mut current = (f64::from(first.0), f64::from(first.1), f64::from(first.2));
	let mut index = 1;
	while index < parts.len() {
		let amount = clamp01(number(parts[index])? / 100.0);
		let next = plain_color(parts.get(index + 1).copied().unwrap_or("white"))?;
		current = (
			f64::mul_add(f64::from(next.0), 1.0 - amount, current.0 * amount),
			f64::mul_add(f64::from(next.1), 1.0 - amount, current.1 * amount),
			f64::mul_add(f64::from(next.2), 1.0 - amount, current.2 * amount),
		);
		index += 2;
	}
	Some((byte(current.0), byte(current.1), byte(current.2)))
}

fn color_rgb(spec: &str) -> Option<(u8, u8, u8)> {
	let spec = spec.trim();
	if spec.contains('!')
		&& let Some(color) = mixed_color(spec)
	{
		return Some(color);
	}
	plain_color(spec)
}

/// Resolves an xcolor/CSS color specification to a terminal color.
pub fn resolve_color(spec: &str) -> Option<Color> {
	let spec = spec.trim();
	let rgb = if let Some(rest) = spec.strip_prefix('[') {
		let end = rest.find(']')?;
		let model = &rest[..end];
		let value = rest[end + 1..].trim();
		let value = value
			.strip_prefix('{')
			.and_then(|s| s.strip_suffix('}'))
			.unwrap_or(value);
		modeled_color(model, value)
	} else if let Some((model, value)) = spec.split_once(':') {
		if matches!(
			model,
			"named"
				| "HTML" | "Html"
				| "html" | "RGB"
				| "rgb" | "cmyk"
				| "gray" | "grey"
				| "Gray" | "Grey"
				| "hsb" | "hsv"
				| "Hsb" | "HSV"
				| "wave"
		) {
			modeled_color(model, value)
		} else {
			color_rgb(spec)
		}
	} else {
		color_rgb(spec)
	}?;
	Some(Color::Rgb(rgb.0, rgb.1, rgb.2))
}

pub(super) fn resolve_latex_color(model: Option<&str>, spec: &str) -> Option<Color> {
	let unescaped = unescape_text(spec);
	let spec = unescaped.trim();
	if spec.is_empty() {
		return None;
	}
	model.map_or_else(
		|| resolve_color(spec),
		|model| modeled_color(model, spec).map(|(r, g, b)| Color::Rgb(r, g, b)),
	)
}

#[derive(Default)]
struct Argument {
	line:  Row,
	group: bool,
}

struct Parser<'a> {
	source:  &'a str,
	pos:     usize,
	base:    Style,
	current: Style,
}

impl<'a> Parser<'a> {
	const fn new(source: &'a str, base: Style) -> Self {
		Self { source, pos: 0, base, current: base }
	}

	fn peek(&self) -> Option<char> {
		self.source.get(self.pos..)?.chars().next()
	}

	fn starts_with(&self, text: &str) -> bool {
		self.source[self.pos..].starts_with(text)
	}

	fn bump(&mut self) -> Option<char> {
		let ch = self.peek()?;
		self.pos += ch.len_utf8();
		Some(ch)
	}

	fn parse(&mut self, font: Option<MathFont>, stop_at_brace: bool) -> Row {
		let mut out = LineBuilder::new();
		while let Some(ch) = self.peek() {
			if ch == '}' {
				if stop_at_brace {
					break;
				}
				self.bump();
				continue;
			}
			out.append(&self.node(font));
		}
		out.finish()
	}

	fn node(&mut self, font: Option<MathFont>) -> Row {
		match self.peek() {
			Some('\\') => self.command(font),
			Some('{') => self.group(font),
			Some('^') => {
				self.bump();
				self.script(font, true)
			},
			Some('_') => {
				self.bump();
				self.script(font, false)
			},
			Some('$') => {
				self.bump();
				Row::new()
			},
			Some('~') => {
				self.bump();
				one(self.current, " ")
			},
			Some('&') => {
				self.bump();
				one(self.current, "  ")
			},
			Some('\'') => {
				let mut count = 0;
				while self.peek() == Some('\'') {
					self.bump();
					count += 1;
				}
				let primes = match count {
					1 => "′",
					2 => "″",
					3 => "‴",
					4 => "⁗",
					_ => "",
				};
				if count <= 4 {
					one(self.current, primes)
				} else {
					one(self.current, &"′".repeat(count))
				}
			},
			Some('%') => {
				while self.peek().is_some_and(|ch| ch != '\n') {
					self.bump();
				}
				if self.peek() == Some('\n') {
					self.bump();
				}
				Row::new()
			},
			Some(ch) => {
				self.bump();
				let rendered = font.map_or(ch, |font| font_char(font, ch));
				one(self.current, rendered.encode_utf8(&mut [0; 4]))
			},
			None => Row::new(),
		}
	}

	fn command(&mut self, font: Option<MathFont>) -> Row {
		self.bump();
		let Some(ch) = self.peek() else {
			return Row::new();
		};
		if !ch.is_ascii_alphabetic() {
			self.bump();
			return match ch {
				'\\' => one(self.current, "\n"),
				'{' | '}' | '$' | '%' | '&' | '#' | '_' | ' ' | '.' => {
					one(self.current, ch.encode_utf8(&mut [0; 4]))
				},
				',' | ':' | ';' | '>' => one(self.current, " "),
				'!' | '/' | '(' | ')' | '[' | ']' => Row::new(),
				'|' => one(self.current, "‖"),
				_ => one(self.current, ch.encode_utf8(&mut [0; 4])),
			};
		}
		let start = self.pos;
		while self.peek().is_some_and(|ch| ch.is_ascii_alphabetic()) {
			self.bump();
		}
		let source = self.source;
		let name = &source[start..self.pos];
		if self.peek() == Some('*') {
			self.bump();
		}
		self.apply_command(name, font)
	}

	fn apply_command(&mut self, name: &str, font: Option<MathFont>) -> Row {
		if let Some(style) = terminal_text_style(self.current, name) {
			let outer = self.current;
			self.current = style;
			let line = self.argument(font).line;
			self.current = outer;
			return line;
		}
		if let Some(requested) = math_font(name) {
			return self.argument(Some(requested)).line;
		}
		if is_text_command(name) {
			let style = self.current;
			let raw = self.raw_argument();
			return one(style, &unescape_text(raw));
		}
		if name == "operatorname" {
			let style = self.current;
			let raw = self.raw_argument();
			let mut text = unescape_text(raw);
			if self.space_before_arg() {
				text.push(' ');
			}
			return one(style, &text);
		}
		if name == "underline" {
			let mut line = self.argument(font).line;
			restyle(&mut line, Style::underline);
			return line;
		}
		if let Some(mark) = accent(name) {
			let arg = self.argument(font);
			return combine_line(&arg.line, mark);
		}
		if matches!(name, "frac" | "dfrac" | "tfrac" | "cfrac") {
			let num = self.argument(font);
			let den = self.argument(font);
			return self.fraction(&num, &den);
		}
		if name == "genfrac" {
			let left = self.argument(font);
			let right = self.argument(font);
			self.raw_argument();
			self.raw_argument();
			let num = self.argument(font);
			let den = self.argument(font);
			let mut out = LineBuilder::new();
			out.append(&left.line);
			out.append(&self.fraction(&num, &den));
			out.append(&right.line);
			return out.finish();
		}
		if matches!(name, "binom" | "dbinom" | "tbinom") {
			let n = self.argument(font);
			let k = self.argument(font);
			let mut out = LineBuilder::new();
			out.push(self.current, "C(");
			out.append(&n.line);
			out.push(self.current, ", ");
			out.append(&k.line);
			out.push(self.current, ")");
			return out.finish();
		}
		if name == "sqrt" {
			return self.sqrt(font);
		}
		if name == "not" {
			let arg = self.argument(font);
			return negated(&text_of(&arg.line))
				.map_or_else(|| combine_line(&arg.line, "\u{0338}"), |glyph| one(self.current, glyph));
		}
		if matches!(name, "overset" | "stackrel") {
			return self.scripted(font, true);
		}
		if name == "underset" {
			return self.scripted(font, false);
		}
		if name == "prescript" {
			return self.prescript(font);
		}
		if let Some(arrow) = extensible_arrow(name) {
			return self.extensible_arrow(font, arrow);
		}
		if matches!(name, "boxed" | "fbox") {
			let arg = self.argument(font);
			let mut out = LineBuilder::new();
			out.push(self.current, "[");
			out.append(&arg.line);
			out.push(self.current, "]");
			return out.finish();
		}
		let wrapper = match name {
			"overbrace" => Some(("⏞(", ")")),
			"underbrace" => Some(("⏟(", ")")),
			"overbracket" => Some(("⎴(", ")")),
			"underbracket" => Some(("⎵(", ")")),
			"overparen" => Some(("⏜(", ")")),
			"underparen" => Some(("⏝(", ")")),
			_ => None,
		};
		if let Some((left, right)) = wrapper {
			let arg = self.argument(font);
			let mut out = LineBuilder::new();
			out.push(self.current, left);
			out.append(&arg.line);
			out.push(self.current, right);
			return out.finish();
		}
		if matches!(name, "cancel" | "sout") {
			let mut line = self.argument(font).line;
			restyle(&mut line, Style::strikethrough);
			return line;
		}
		if name == "bcancel" {
			return combine_line(&self.argument(font).line, "\u{20e5}");
		}
		if name == "xcancel" {
			return combine_line(&combine_line(&self.argument(font).line, "\u{0338}"), "\u{20e5}");
		}
		if name == "substack" {
			return one(self.current, &collapse_newlines(&text_of(&self.argument(font).line), ","));
		}
		if matches!(name, "left" | "right" | "middle") || is_big_delim(name) {
			return self.delimiter(font);
		}
		if name == "begin" {
			return self.environment(font);
		}
		if name == "end" {
			self.raw_argument();
			return Row::new();
		}
		match name {
			"bmod" => return one(self.current, " mod "),
			"pmod" => {
				let arg = self.argument(font);
				let mut out = LineBuilder::new();
				out.push(self.current, "(mod ");
				out.append(&arg.line);
				out.push(self.current, ")");
				return out.finish();
			},
			"pod" | "tag" => {
				let arg = self.argument(font);
				let mut out = LineBuilder::new();
				out.push(self.current, "(");
				out.append(&arg.line);
				out.push(self.current, ")");
				return out.finish();
			},
			"label" => {
				self.raw_argument();
				return Row::new();
			},
			"ref" | "eqref" => {
				let style = self.current;
				let raw = self.raw_argument();
				return one(style, &format!("({})", unescape_text(raw)));
			},
			"url" => {
				let style = self.current;
				let raw = self.raw_argument();
				return one(style, &unescape_text(raw));
			},
			"href" => {
				self.raw_argument();
				return self.argument(font).line;
			},
			"textcolor" => return self.scoped_color(font, true),
			"colorbox" => return self.scoped_color(font, false),
			"fcolorbox" => return self.fcolorbox(font),
			"color" => {
				self.set_foreground();
				return Row::new();
			},
			"normalcolor" => {
				self.current = self.current.fg(self.base.foreground_color());
				return Row::new();
			},
			"phantom" | "hphantom" => {
				let count = text_of(&self.argument(font).line).chars().count();
				return one(self.current, &" ".repeat(count));
			},
			"vphantom" => {
				self.argument(font);
				return Row::new();
			},
			_ => {},
		}
		if is_function(name) {
			let mut text = name.to_owned();
			if self.space_before_arg() {
				text.push(' ');
			}
			return one(self.current, &text);
		}
		if let Some(symbol) = command_symbol(name) {
			return one(self.current, symbol);
		}
		match name {
			"displaystyle" | "textstyle" | "scriptstyle" | "scriptscriptstyle" | "limits"
			| "nolimits" | "nonumber" | "notag" => Row::new(),
			"quad" => one(self.current, "  "),
			"qquad" => one(self.current, "    "),
			"thinspace" | "enspace" | "medspace" | "thickspace" | "space" => one(self.current, " "),
			"negthinspace" | "negmedspace" | "negthickspace" => Row::new(),
			_ => one(self.current, name),
		}
	}

	fn group(&mut self, font: Option<MathFont>) -> Row {
		self.bump();
		let outer = self.current;
		let inner = self.parse(font, true);
		if self.peek() == Some('}') {
			self.bump();
		}
		self.current = outer;
		inner
	}

	fn argument(&mut self, font: Option<MathFont>) -> Argument {
		while self.peek() == Some(' ') {
			self.bump();
		}
		match self.peek() {
			None => Argument::default(),
			Some('{') => {
				self.bump();
				let line = self.parse(font, true);
				if self.peek() == Some('}') {
					self.bump();
				}
				Argument { line, group: true }
			},
			Some('\\') => Argument { line: self.command(font), group: false },
			Some('^' | '_') => {
				let sup = self.bump() == Some('^');
				Argument { line: self.script(font, sup), group: false }
			},
			Some(ch) => {
				self.bump();
				let rendered = font.map_or(ch, |font| font_char(font, ch));
				Argument { line: one(self.current, rendered.encode_utf8(&mut [0; 4])), group: false }
			},
		}
	}

	fn raw_argument(&mut self) -> &'a str {
		while self.peek() == Some(' ') {
			self.bump();
		}
		if self.peek() != Some('{') {
			let start = self.pos;
			if self.peek() == Some('\\') {
				self.bump();
				if self.peek().is_some_and(|ch| ch.is_ascii_alphabetic()) {
					while self.peek().is_some_and(|ch| ch.is_ascii_alphabetic()) {
						self.bump();
					}
				} else {
					self.bump();
				}
			} else {
				self.bump();
			}
			return &self.source[start..self.pos];
		}
		self.bump();
		let start = self.pos;
		let mut depth = 1usize;
		while let Some(ch) = self.bump() {
			if ch == '\\' {
				self.bump();
				continue;
			}
			if ch == '{' {
				depth += 1;
			} else if ch == '}' {
				depth -= 1;
				if depth == 0 {
					return &self.source[start..self.pos - 1];
				}
			}
		}
		&self.source[start..]
	}

	fn optional_raw_argument(&mut self) -> Option<&'a str> {
		while self.peek() == Some(' ') {
			self.bump();
		}
		if self.peek() != Some('[') {
			return None;
		}
		self.bump();
		let start = self.pos;
		let mut brackets = 1usize;
		let mut braces = 0usize;
		while let Some(ch) = self.bump() {
			if ch == '\\' {
				self.bump();
				continue;
			}
			match ch {
				'{' => braces += 1,
				'}' => braces = braces.saturating_sub(1),
				'[' if braces == 0 => brackets += 1,
				']' if braces == 0 => {
					brackets -= 1;
					if brackets == 0 {
						return Some(&self.source[start..self.pos - 1]);
					}
				},
				_ => {},
			}
		}
		Some(&self.source[start..])
	}

	fn optional_argument(&mut self, font: Option<MathFont>) -> Option<Argument> {
		let raw = self.optional_raw_argument()?;
		let mut parser = Parser::new(raw, self.current);
		Some(Argument { line: parser.parse(font, false), group: true })
	}

	fn script(&mut self, font: Option<MathFont>, superscript: bool) -> Row {
		let arg = self.argument(font);
		let mapped = if superscript {
			map_line(&arg.line, superscript_char)
		} else {
			map_line(&arg.line, subscript_char)
		};
		if let Some(line) = mapped {
			return line;
		}
		let mut out = LineBuilder::new();
		out.push(self.current, if superscript { "^" } else { "_" });
		if arg.group {
			out.push(self.current, "(");
		}
		out.append(&arg.line);
		if arg.group {
			out.push(self.current, ")");
		}
		out.finish()
	}

	fn fraction(&self, num: &Argument, den: &Argument) -> Row {
		let nt = text_of(&num.line);
		let dt = text_of(&den.line);
		if let Some(vulgar) = vulgar_fraction(&nt, &dt) {
			return one(self.current, vulgar);
		}
		let mut out = LineBuilder::new();
		if num.group && nt.chars().count() > 1 {
			out.push(self.current, "(");
			out.append(&num.line);
			out.push(self.current, ")");
		} else {
			out.append(&num.line);
		}
		out.push(self.current, "/");
		if den.group && dt.chars().count() > 1 {
			out.push(self.current, "(");
			out.append(&den.line);
			out.push(self.current, ")");
		} else {
			out.append(&den.line);
		}
		out.finish()
	}

	fn scripted(&mut self, font: Option<MathFont>, above: bool) -> Row {
		let script = self.argument(font);
		let base = self.argument(font);
		let mut out = LineBuilder::new();
		out.append(&base.line);
		let mapped = if above {
			map_line(&script.line, superscript_char)
		} else {
			map_line(&script.line, subscript_char)
		};
		if let Some(mapped) = mapped {
			out.append(&mapped);
		} else {
			out.push(self.current, if above { "^(" } else { "_(" });
			out.append(&script.line);
			out.push(self.current, ")");
		}
		out.finish()
	}

	fn prescript(&mut self, font: Option<MathFont>) -> Row {
		let sup = self.argument(font);
		let sub = self.argument(font);
		let base = self.argument(font);
		let mut out = LineBuilder::new();
		out.append(&script_or_fallback(&sup.line, true, self.current, true));
		out.append(&script_or_fallback(&sub.line, false, self.current, true));
		out.append(&base.line);
		out.finish()
	}

	fn extensible_arrow(&mut self, font: Option<MathFont>, arrow: &str) -> Row {
		let below = self.optional_argument(font);
		let above = self.argument(font);
		let mut out = LineBuilder::new();
		out.push(self.current, arrow);
		out.append(&script_or_fallback(&above.line, true, self.current, true));
		if let Some(below) = below {
			out.append(&script_or_fallback(&below.line, false, self.current, true));
		}
		out.finish()
	}

	fn delimiter(&mut self, font: Option<MathFont>) -> Row {
		while self.peek() == Some(' ') {
			self.bump();
		}
		match self.peek() {
			None => Row::new(),
			Some('.') => {
				self.bump();
				Row::new()
			},
			Some('\\') => {
				self.bump();
				let Some(ch) = self.peek() else {
					return Row::new();
				};
				if !ch.is_ascii_alphabetic() {
					self.bump();
					return match ch {
						'.' => Row::new(),
						'{' => one(self.current, "{"),
						'}' => one(self.current, "}"),
						'|' => one(self.current, "‖"),
						_ => one(self.current, ch.encode_utf8(&mut [0; 4])),
					};
				}
				let start = self.pos;
				while self.peek().is_some_and(|ch| ch.is_ascii_alphabetic()) {
					self.bump();
				}
				let source = self.source;
				let name = &source[start..self.pos];
				one(self.current, command_symbol(name).unwrap_or(name))
			},
			Some(ch) => {
				self.bump();
				let rendered = font.map_or(ch, |font| font_char(font, ch));
				one(self.current, rendered.encode_utf8(&mut [0; 4]))
			},
		}
	}

	fn sqrt(&mut self, font: Option<MathFont>) -> Row {
		while self.peek() == Some(' ') {
			self.bump();
		}
		let index = self.optional_argument(font).map(|arg| text_of(&arg.line));
		let radical = match index.as_deref() {
			None | Some("2") => "√".to_owned(),
			Some("3") => "∛".to_owned(),
			Some("4") => "∜".to_owned(),
			Some(index) => {
				to_superscript(index).map_or_else(|| format!("^({index})√"), |value| value + "√")
			},
		};
		let arg = self.argument(font);
		let text = text_of(&arg.line);
		let mut out = LineBuilder::new();
		out.push(self.current, &radical);
		if text.chars().count() > 1 {
			out.push(self.current, "(");
			out.append(&arg.line);
			out.push(self.current, ")");
		} else {
			out.append(&arg.line);
		}
		out.finish()
	}

	fn environment(&mut self, font: Option<MathFont>) -> Row {
		let env = self.raw_argument().trim();
		if matches!(
			env,
			"array"
				| "tabular"
				| "array*"
				| "tabular*"
				| "alignedat"
				| "alignedat*"
				| "alignat"
				| "alignat*"
				| "gatheredat"
		) {
			self.optional_raw_argument();
			if self.peek() == Some('{') {
				self.raw_argument();
			}
		}
		let mut body = LineBuilder::new();
		while self.pos < self.source.len() {
			if self.starts_with("\\end") {
				self.pos += 4;
				self.raw_argument();
				break;
			}
			body.append(&self.node(font));
		}
		let text = text_of(&body.finish());
		let mut text = text.trim().to_owned();
		if matches!(env, "cases" | "cases*" | "dcases" | "dcases*" | "rcases" | "drcases") {
			text = collapse_case_body(&text);
		}
		let (left, right) = environment_delimiters(env).unwrap_or(("", ""));
		one(self.current, &format!("{left}{text}{right}"))
	}

	fn read_color(&mut self) -> Option<Color> {
		let model = self.optional_raw_argument();
		let spec = self.raw_argument();
		resolve_latex_color(model, spec)
	}

	fn set_foreground(&mut self) {
		if let Some(color) = self.read_color() {
			self.current = self.current.fg(color);
		}
	}

	fn scoped_color(&mut self, font: Option<MathFont>, foreground: bool) -> Row {
		let color = self.read_color();
		let outer = self.current;
		if let Some(color) = color {
			self.current = if foreground {
				self.current.fg(color)
			} else {
				self.current.bg(color)
			};
		}
		let line = self.argument(font).line;
		self.current = outer;
		line
	}

	fn fcolorbox(&mut self, font: Option<MathFont>) -> Row {
		let frame_model = self.optional_raw_argument();
		self.raw_argument();
		let background_model = self.optional_raw_argument().or(frame_model);
		let background_spec = self.raw_argument();
		let background = resolve_latex_color(background_model, background_spec);
		let outer = self.current;
		if let Some(color) = background {
			self.current = self.current.bg(color);
		}
		let body = self.argument(font).line;
		self.current = outer;
		let mut out = LineBuilder::new();
		out.push(outer, "[");
		out.append(&body);
		out.push(outer, "]");
		out.finish()
	}

	fn space_before_arg(&self) -> bool {
		self
			.peek()
			.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '\\')
	}
}

fn script_or_fallback(line: &Row, sup: bool, style: Style, group: bool) -> Row {
	let mapped = if sup {
		map_line(line, superscript_char)
	} else {
		map_line(line, subscript_char)
	};
	if let Some(line) = mapped {
		return line;
	}
	let mut out = LineBuilder::new();
	out.push(style, if sup { "^" } else { "_" });
	if group {
		out.push(style, "(");
	}
	out.append(line);
	if group {
		out.push(style, ")");
	}
	out.finish()
}

fn is_text_command(name: &str) -> bool {
	matches!(
		name,
		"text" | "textrm" | "textnormal" | "textsc" | "mathrm" | "mathnormal" | "mbox" | "hbox"
	)
}
fn is_function(name: &str) -> bool {
	matches!(
		name,
		"sin"
			| "cos"
			| "tan"
			| "cot"
			| "sec"
			| "csc"
			| "sinh"
			| "cosh"
			| "tanh"
			| "coth"
			| "arcsin"
			| "arccos"
			| "arctan"
			| "arccot"
			| "arcsec"
			| "arccsc"
			| "sech"
			| "csch"
			| "ln" | "log"
			| "lg" | "exp"
			| "lim"
			| "limsup"
			| "liminf"
			| "max"
			| "min"
			| "sup"
			| "inf"
			| "det"
			| "dim"
			| "ker"
			| "hom"
			| "arg"
			| "deg"
			| "gcd"
			| "lcm"
			| "Pr" | "argmax"
			| "argmin"
			| "sgn"
			| "tr" | "rank"
			| "diag"
			| "var"
			| "cov"
			| "median"
			| "mod"
	)
}
fn is_big_delim(name: &str) -> bool {
	matches!(
		name,
		"big"
			| "Big"
			| "bigg"
			| "Bigg"
			| "bigl"
			| "bigr"
			| "bigm"
			| "Bigl"
			| "Bigr"
			| "Bigm"
			| "biggl"
			| "biggr"
			| "biggm"
			| "Biggl"
			| "Biggr"
			| "Biggm"
	)
}
fn extensible_arrow(name: &str) -> Option<&'static str> {
	Some(match name {
		"xleftarrow" => "←",
		"xrightarrow" => "→",
		"xleftrightarrow" => "↔",
		"xLeftarrow" => "⇐",
		"xRightarrow" => "⇒",
		"xLeftrightarrow" => "⇔",
		"xhookleftarrow" => "↩",
		"xhookrightarrow" => "↪",
		"xtwoheadleftarrow" => "↞",
		"xtwoheadrightarrow" => "↠",
		"xmapsto" => "↦",
		"xrightharpoonup" => "⇀",
		"xrightharpoondown" => "⇁",
		"xleftharpoonup" => "↼",
		"xleftharpoondown" => "↽",
		"xrightleftharpoons" => "⇌",
		"xleftrightharpoons" => "⇋",
		_ => return None,
	})
}
fn environment_delimiters(env: &str) -> Option<(&'static str, &'static str)> {
	Some(match env {
		"matrix" | "smallmatrix" | "array" | "tabular" | "aligned" | "aligned*" | "alignedat"
		| "alignedat*" | "align" | "align*" | "alignat" | "alignat*" | "split" | "gathered"
		| "equation" | "equation*" => ("", ""),
		"pmatrix" => ("(", ")"),
		"bmatrix" => ("[", "]"),
		"Bmatrix" => ("{", "}"),
		"vmatrix" => ("|", "|"),
		"Vmatrix" => ("‖", "‖"),
		"cases" | "cases*" | "dcases" | "dcases*" => ("{", ""),
		"rcases" | "drcases" => ("", "}"),
		_ => return None,
	})
}
fn collapse_newlines(text: &str, separator: &str) -> String {
	text
		.split('\n')
		.filter(|part| !part.is_empty())
		.collect::<SmallVec<&str, 8>>()
		.join(separator)
}
fn collapse_case_body(text: &str) -> String {
	let mut out = text
		.lines()
		.map(str::trim)
		.collect::<SmallVec<&str, 8>>()
		.join("; ");
	while out.contains("   ") {
		out = out.replace("   ", "  ");
	}
	out
}
fn unescape_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut chars = text.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\\'
			&& chars.peek().is_some_and(|next| {
				matches!(*next, '&' | '%' | '$' | '#' | '_' | '{' | '}') || next.is_whitespace()
			}) {
			out.push(chars.next().unwrap_or_default());
		} else if ch == '~' {
			out.push(' ');
		} else {
			out.push(ch);
		}
	}
	out
}

/// Converts one-dimensional LaTeX math to a flat styled row. Total: degrades
/// gracefully, never fails.
pub(super) fn latex_superscript_row(expr: &str, base: Style) -> Row {
	let row = latex_row(expr, base);
	script_or_fallback(&row, true, base, true)
}

pub(super) fn latex_row(expr: &str, base: Style) -> Row {
	if expr.is_empty() {
		return Row::new();
	}
	Parser::new(expr, base).parse(None, false)
}

/// Emits one-dimensional LaTeX math as styled runs. Total: degrades
/// gracefully, never fails.
pub fn latex_inline(expr: &str, base: Style, sink: &mut dyn RichSink) {
	for (style, text) in latex_row(expr, base) {
		let mut parts = text.split("\n");
		if let Some(first) = parts.next()
			&& !first.is_empty()
		{
			sink.run(style, &first);
		}
		for part in parts {
			sink.newline();
			if !part.is_empty() {
				sink.run(style, &part);
			}
		}
	}
}

/// Plain-text projection of [`latex_inline`]. Total.
#[cfg(test)]
pub fn latex_to_unicode(expr: &str) -> String {
	let mut rich = RichText::default();
	latex_inline(expr, Style::new(), &mut rich);
	(0..rich.rows())
		.map(|row| rich.row_text(row))
		.collect::<Vec<_>>()
		.join("\n")
}

/// Returns whether a bare environment is safe to treat as display math.
pub fn is_bare_math_environment(name: &str) -> bool {
	let name = name.strip_suffix('*').unwrap_or(name);
	matches!(
		name,
		"matrix"
			| "smallmatrix"
			| "pmatrix"
			| "bmatrix"
			| "Bmatrix"
			| "vmatrix"
			| "Vmatrix"
			| "cases"
			| "dcases"
			| "rcases"
			| "drcases"
			| "aligned"
			| "alignedat"
			| "align"
			| "alignat"
			| "split"
			| "gathered"
			| "gatheredat"
			| "gather"
			| "multline"
			| "equation"
			| "eqnarray"
			| "array"
			| "subarray"
	)
}

/// Returns the math body and consumed bytes when `text` begins with a complete
/// `$…$`, `$$…$$`, `\(…\)`, or `\[…\]` span.
///
/// Every form closes at its first unescaped matching delimiter. The single
/// dollar form additionally follows Pandoc's anti-currency whitespace, digit,
/// and single-line rules.
pub fn math_span(text: &str) -> Option<(&str, usize)> {
	if text.starts_with("$$") {
		let close = delimiter_end(text, "$$", 2)?;
		let body = &text[2..close];
		return (!body.trim().is_empty()).then_some((body, close + 2));
	}
	if text.starts_with("\\(") {
		let close = delimiter_end(text, "\\)", 2)?;
		return Some((&text[2..close], close + 2));
	}
	if text.starts_with("\\[") {
		let close = delimiter_end(text, "\\]", 2)?;
		return Some((&text[2..close], close + 2));
	}
	if !text.starts_with('$') {
		return None;
	}
	let body_start = 1;
	let after = *text.as_bytes().get(body_start)?;
	if matches!(after, b' ' | b'\t' | b'\n' | b'$') {
		return None;
	}
	for (offset, byte) in text.as_bytes()[body_start..].iter().copied().enumerate() {
		let at = body_start + offset;
		if byte == b'\n' {
			return None;
		}
		if byte != b'$' || escaped_at(text, at, body_start) {
			continue;
		}
		if matches!(text.as_bytes().get(at - 1), Some(b' ' | b'\t')) {
			return None;
		}
		if text.as_bytes().get(at + 1).is_some_and(u8::is_ascii_digit) {
			continue;
		}
		let body = &text[body_start..at];
		return (!body.trim().is_empty()).then_some((body, at + 1));
	}
	None
}

fn delimiter_end(text: &str, delimiter: &str, from: usize) -> Option<usize> {
	let mut cursor = from;
	while let Some(relative) = text.get(cursor..)?.find(delimiter) {
		let at = cursor + relative;
		if !escaped_at(text, at, from) {
			return Some(at);
		}
		cursor = at + 1;
	}
	None
}

const fn escaped_at(text: &str, at: usize, from: usize) -> bool {
	let bytes = text.as_bytes();
	let mut cursor = at;
	while cursor > from && bytes[cursor - 1] == b'\\' {
		cursor -= 1;
	}
	(at - cursor) % 2 == 1
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fractions_scripts_and_radicals() {
		let vulgar = [
			("1", "2", "½"),
			("1", "3", "⅓"),
			("2", "3", "⅔"),
			("1", "4", "¼"),
			("3", "4", "¾"),
			("1", "5", "⅕"),
			("2", "5", "⅖"),
			("3", "5", "⅗"),
			("4", "5", "⅘"),
			("1", "6", "⅙"),
			("5", "6", "⅚"),
			("1", "7", "⅐"),
			("1", "8", "⅛"),
			("3", "8", "⅜"),
			("5", "8", "⅝"),
			("7", "8", "⅞"),
			("1", "9", "⅑"),
			("1", "10", "⅒"),
			("0", "3", "↉"),
		];
		for (num, den, expected) in vulgar {
			assert_eq!(latex_to_unicode(&format!(r"\frac{{{num}}}{{{den}}}")), expected);
		}
		assert_eq!(latex_to_unicode(r"\frac{a+b}{c}"), "(a+b)/c");
		assert_eq!(latex_to_unicode("x^T"), "xᵀ");
		assert_eq!(latex_to_unicode("x^{q+1}"), "x^(q+1)");
		assert_eq!(latex_to_unicode(r"\sqrt[3]{x}"), "∛x");
		assert_eq!(latex_to_unicode(r"\sqrt[n]{a+b}"), "ⁿ√(a+b)");
	}

	#[test]
	fn fonts_accents_not_and_symbols() {
		assert_eq!(latex_to_unicode(r"\mathbb{RNCZ}"), "ℝℕℂℤ");
		assert_eq!(latex_to_unicode(r"\mathcal{BEFHL}"), "ℬℰℱℋℒ");
		assert_eq!(latex_to_unicode(r"\mathbf{x2}"), "𝐱𝟐");
		assert_eq!(latex_to_unicode(r"\hat{x}+\vec{v}"), "x̂+v⃗");
		assert_eq!(latex_to_unicode(r"\not\in\;\not="), "∉ ≠");
		assert_eq!(latex_to_unicode(r"\subseteqq\supseteqq"), "⫅⫆");
	}

	#[test]
	fn styled_scopes() {
		let base = Style::new();
		let line = latex_row(r"{\color{red}x}y", base);
		assert_eq!(text_of(&line), "xy");
		assert_eq!(line[0].0, base.fg(Color::Rgb(255, 0, 0)));
		assert_eq!(line[1].0, base);
		let line = latex_row(r"\textcolor[RGB]{128,64,32}{x}", base);
		assert_eq!(line[0].0, base.fg(Color::Rgb(128, 64, 32)));
		let line = latex_row(r"\colorbox{yellow}{x}", base);
		assert_eq!(line[0].0, base.bg(Color::Rgb(255, 255, 0)));
		let line = latex_row(r"\cancel{x}\underline{y}", base);
		assert_eq!(line[0].0, base.strikethrough());
		assert_eq!(line[1].0, base.underline());
		let line = latex_row(r"\textbf{\frac{a}{b}}", base);
		assert_eq!(text_of(&line), "a/b");
		assert!(line.iter().all(|(style, _)| style.spec().bold));

		let line = latex_row(r"\textbf{A\textmd{B}C}", base);
		assert_eq!(text_of(&line), "ABC");
		assert!(line[0].0.spec().bold);
		assert!(!line[1].0.spec().bold);
		assert!(line[2].0.spec().bold);

		let line = latex_row(r"\boxed{\textcolor{red}{x}}", base);
		assert_eq!(text_of(&line), "[x]");
		assert_eq!(line[0].0, base);
		assert_eq!(line[1].0, base.fg(Color::Rgb(255, 0, 0)));
		assert_eq!(line[2].0, base);
		let line = latex_row(r"x_{\textit{word}}\pmod{\textbf{n}}", base);
		assert_eq!(text_of(&line), "x_(word)(mod n)");
		for (style, text) in &line {
			if text.as_str() == "word" {
				assert!(style.spec().italic);
			} else if text.as_str() == "n" {
				assert!(style.spec().bold);
			} else {
				assert_eq!(*style, base);
			}
		}
	}

	#[test]
	fn color_models_and_mixes() {
		assert_eq!(resolve_color("red"), Some(Color::Rgb(255, 0, 0)));
		assert_eq!(resolve_color("HTML:C5FFD6"), Some(Color::Rgb(197, 255, 214)));
		assert_eq!(resolve_color("RGB:128,64,32"), Some(Color::Rgb(128, 64, 32)));
		assert_eq!(resolve_color("rgb:1,0,0"), Some(Color::Rgb(255, 0, 0)));
		assert_eq!(resolve_color("cmyk:0,1,1,0"), Some(Color::Rgb(255, 0, 0)));
		assert_eq!(resolve_color("red!50!blue"), Some(Color::Rgb(128, 0, 128)));
	}

	#[test]
	fn span_and_environment_rules() {
		assert_eq!(math_span("$x$ rest"), Some(("x", 3)));
		assert_eq!(math_span("$5 and $10"), None);
		assert_eq!(math_span(r"$x\$y$ rest"), Some((r"x\$y", 6)));
		assert_eq!(math_span(r"\$x$"), None);
		assert_eq!(math_span(r"\(x \\) y\) end"), Some((r"x \\) y", 11)));
		assert_eq!(math_span(r"$$a \$$ b$$"), Some((r"a \$$ b", 11)));
		assert!(is_bare_math_environment("align*"));
		assert!(!is_bare_math_environment("tabular"));
	}
}
