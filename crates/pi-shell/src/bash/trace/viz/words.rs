//! Python-like word expressions over the engine's canonical syntax.
//! Quoting and substitutions preserve complete values; display folding belongs
//! to rows.
use super::{analysis::Analysis, model::Layers};
use crate::bash::syntax::{
	AndOrOp, CaseMode, ComsubKind, PrintStyle, ReplaceMode, Sep, Special, print,
	tree::{
		ArrayElem, Assign, AssignValue, CommandKind, Cond, CondExpr, List, Param, ParamName, ParamOp,
		Part, Pipeline, Seq, Subscript, Word, WordPart,
	},
};

pub struct WordPrinter<'a> {
	pub layers:   &'a Layers,
	pub analysis: &'a Analysis,
	pub unit:     u32,
	pub source:   u32,
}
fn text(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
}
/// Whether any part substitutes a value, looking through nested double quotes.
fn expands(parts: Seq<'_, WordPart<'_>>) -> bool {
	parts.iter().any(|p| match p.get() {
		Part::DQuote(v) | Part::Locale(v) => expands(v),
		Part::Lit(_) | Part::Escaped(_) | Part::SQuote(_) | Part::AnsiC(_) | Part::DroppedQuote => {
			false
		},
		_ => true,
	})
}
/// Python string syntax, including controls that must not create physical rows.
pub fn quote(value: &str) -> String {
	let mut out = String::from("\"");
	for c in value.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if c.is_control() => {
				use std::fmt::Write;
				let _ = write!(out, "\\u{:04x}", c as u32);
			},
			c => out.push(c),
		}
	}
	out.push('"');
	out
}
impl WordPrinter<'_> {
	pub fn word(&self, word: Word<'_>) -> String {
		let parts = word.parts();
		if let Some(p) = parts.one() {
			return self.part(p);
		}
		self.interpolation(parts)
	}

	fn part(&self, p: WordPart<'_>) -> String {
		match p.get() {
			Part::Lit(v) | Part::Escaped(v) | Part::SQuote(v) => quote(&text(v)),
			Part::AnsiC(v) => quote(&text(&crate::bash::syntax::ansi_decode_all(v))),
			Part::DQuote(v) | Part::Locale(v) => self.interpolation(v),
			Part::Param(p) => self.parameter(p),
			Part::Comsub(c) => format!(
				"{}⟨{}⟩",
				match c.kind() {
					ComsubKind::ValueSub => "reply",
					ComsubKind::NoFork => "current",
					_ => "",
				},
				self.list_inline(c.body())
			),
			Part::ProcSub(p) => format!(
				"{}⟨{}⟩",
				if p.output() { "write_file" } else { "file" },
				self.list_inline(p.body())
			),
			Part::Arith(a) => self.analysis.arithmetic(a.src()).map_or_else(
				|| {
					if a.bracket() {
						format!("$[{}]", text(a.src()))
					} else {
						format!("$(({}))", text(a.src()))
					}
				},
				|value| value.to_string(),
			),
			Part::Compound(e) => self.elements(e),
			Part::BadSubst(v) | Part::Zsh(v) => text(v),
			Part::BadComsub(c) => text(c.text()),
			Part::DroppedQuote => "\"".into(),
		}
	}

	/// Adjacent parts as one Python string: `f"…{expr}…"` when any part expands,
	/// a plain literal otherwise. Nested double quotes merge into the same
	/// string.
	fn interpolation(&self, parts: Seq<'_, WordPart<'_>>) -> String {
		let dynamic = expands(parts);
		let mut content = String::new();
		self.interpolate(parts, dynamic, &mut content);
		format!("{}\"{content}\"", if dynamic { "f" } else { "" })
	}

	fn interpolate(&self, parts: Seq<'_, WordPart<'_>>, dynamic: bool, content: &mut String) {
		for part in parts {
			let literal = match part.get() {
				Part::DQuote(v) | Part::Locale(v) => {
					self.interpolate(v, dynamic, content);
					continue;
				},
				Part::Lit(v) | Part::Escaped(v) | Part::SQuote(v) => text(v),
				Part::AnsiC(v) => text(&crate::bash::syntax::ansi_decode_all(v)),
				Part::DroppedQuote => "\"".into(),
				_ => {
					content.push('{');
					content.push_str(&self.part(part));
					content.push('}');
					continue;
				},
			};
			let escaped = quote(&literal);
			let escaped = &escaped[1..escaped.len() - 1];
			if dynamic {
				for c in escaped.chars() {
					content.push(c);
					if matches!(c, '{' | '}') {
						content.push(c);
					}
				}
			} else {
				content.push_str(escaped);
			}
		}
	}

	fn elements(&self, e: Seq<'_, ArrayElem<'_>>) -> String {
		format!(
			"[{}]",
			e.iter()
				.map(|e| {
					let value = self.word(e.value());
					match e.key() {
						Some(k) => {
							format!("{} {} {}", self.word(k), if e.append() { "+=" } else { ":" }, value)
						},
						None => value,
					}
				})
				.collect::<Vec<_>>()
				.join(", ")
		)
	}

	pub fn assignment(&self, a: Assign<'_>) -> String {
		let mut name = text(a.name());
		if let Some(i) = a.index() {
			name.push('[');
			name.push_str(&self.word(i));
			name.push(']');
		}
		format!("{name} {} {}", if a.append() { "+=" } else { "=" }, match a.value() {
			AssignValue::Scalar(w) => self.word(w),
			AssignValue::Array(e) => self.elements(e),
		})
	}

	pub fn parameter(&self, p: Param<'_>) -> String {
		let (op, index) = (p.op(), p.index());
		if self.layers.inline
			&& matches!(op, ParamOp::None)
			&& index.is_none()
			&& !p.indirect()
			&& let ParamName::Var(name) = p.name()
			&& let Some(value) = self
				.analysis
				.variables
				.get(String::from_utf8_lossy(name).as_ref())
				.filter(|v| {
					v.inline
						&& v.setter.is_none_or(|key| {
							key.unit <= self.unit && (self.source == 0 || key.source <= self.source)
						})
				})
				.and_then(|v| v.value.as_deref())
		{
			return format!("‹{value}›");
		}
		let mut v = match p.name() {
			ParamName::Var(n) => text(n),
			ParamName::Positional(n) => format!("arg{n}"),
			ParamName::Special(s) => match s {
				Special::At => "args",
				Special::Star => "joined_args",
				Special::Count => "argc",
				Special::Status => "status",
				Special::Flags => "shell_flags",
				Special::ShellPid => "shell_pid",
				Special::LastBg => "last_pid",
			}
			.into(),
		};
		if matches!(op, ParamOp::Indirect) && matches!(index, Some(Subscript::At | Subscript::Star)) {
			return format!(
				"{}keys({v})",
				if matches!(index, Some(Subscript::Star)) {
					"joined_"
				} else {
					""
				}
			);
		}
		if p.indirect() {
			v = format!("indirect({v})");
		}
		if let Some(index) = index {
			v = format!("{v}[{}]", match index {
				Subscript::At => ":".into(),
				Subscript::Star => "*".into(),
				Subscript::Expr(w) => self.word(w),
			});
		}
		let presence = |colon: bool| format!("{}({v})", if colon { "nonempty" } else { "is_set" });
		match op {
			ParamOp::None => v,
			ParamOp::Length => format!("len({v})"),
			ParamOp::Indirect => format!("indirect({v})"),
			ParamOp::PrefixNames { star } => {
				format!("variable_names({}, {})", quote(&v), quote(if star { "*" } else { "@" }))
			},
			ParamOp::Default { colon, word } => {
				format!("({v} if {} else {})", presence(colon), self.word(word))
			},
			ParamOp::Assign { colon, word } => {
				format!("default_assign({v}, {}, {})", self.word(word), presence(colon))
			},
			ParamOp::Error { colon, word } => format!(
				"require({v}, {}, {})",
				word.map_or_else(|| quote("parameter null or not set"), |w| self.word(w)),
				presence(colon)
			),
			ParamOp::Alt { colon, word } => {
				format!("({} if {} else \"\")", self.word(word), presence(colon))
			},
			ParamOp::Substr { offset, len } => format!(
				"slice({v}, {}{})",
				text(offset.src()),
				len.map_or_default(|l| format!(", {}", text(l.src())))
			),
			ParamOp::Trim { suffix, longest, pat } => format!(
				"strip_{}{}({v}, {})",
				if longest { "longest_" } else { "" },
				if suffix { "suffix" } else { "prefix" },
				self.word(pat)
			),
			ParamOp::Replace { mode, pat, rep } => format!(
				"replace_{}({v}, {}, {})",
				match mode {
					ReplaceMode::First => "first",
					ReplaceMode::All => "all",
					ReplaceMode::Prefix => "prefix",
					ReplaceMode::Suffix => "suffix",
				},
				self.word(pat),
				rep.map_or_else(|| quote(""), |w| self.word(w))
			),
			ParamOp::Case { mode, all, pat } => format!(
				"{}_{}({v}{})",
				match mode {
					CaseMode::Upper => "upper",
					CaseMode::Lower => "lower",
					CaseMode::Toggle => "toggle_case",
				},
				if all { "all" } else { "first" },
				pat.map_or_default(|w| format!(", {}", self.word(w)))
			),
			ParamOp::Transform(op) => {
				format!("transform({v}, {})", quote(&char::from(op).to_string()))
			},
		}
	}

	pub fn condition(&self, c: CondExpr<'_>) -> String {
		match c.get() {
			Cond::Word(w) => format!("nonempty({})", self.word(w)),
			Cond::Not(c) => format!("not ({})", self.condition(c)),
			Cond::Group(c) => format!("({})", self.condition(c)),
			Cond::And(a, b) => format!("({} and {})", self.condition(a), self.condition(b)),
			Cond::Or(a, b) => format!("({} or {})", self.condition(a), self.condition(b)),
			Cond::Unary { op, arg } => {
				let f = match op {
					b"-f" => "is_file",
					b"-d" => "is_dir",
					b"-e" => "exists",
					b"-n" => "nonempty",
					b"-z" => "empty",
					b"-r" => "readable",
					b"-w" => "writable",
					b"-x" => "executable",
					b"-s" => "has_size",
					b"-L" | b"-h" => "is_symlink",
					b"-v" => "is_set",
					_ => return format!("test({}, {})", quote(&text(op)), self.word(arg)),
				};
				format!("{f}({})", self.word(arg))
			},
			Cond::Binary { op, lhs, rhs } => {
				let a = self.word(lhs);
				let b = self.word(rhs);
				match op {
					b"=~" => format!("regex({a}, {b})"),
					b"=" | b"==" => format!("matches({a}, {b})"),
					b"!=" => format!("not matches({a}, {b})"),
					b"-eq" | b"-ne" | b"-lt" | b"-le" | b"-gt" | b"-ge" => {
						format!("int({a}) {} int({b})", match op {
							b"-eq" => "==",
							b"-ne" => "!=",
							b"-lt" => "<",
							b"-le" => "<=",
							b"-gt" => ">",
							_ => ">=",
						})
					},
					b"<" | b">" => format!("{a} {} {b}", text(op)),
					_ => format!("test({}, {a}, {b})", quote(&text(op))),
				}
			},
		}
	}

	pub fn list_inline(&self, list: List<'_>) -> String {
		list
			.items()
			.iter()
			.map(|item| {
				let ao = item.and_or();
				let mut value = self.pipeline_inline(ao.first());
				for (op, p) in ao.rest() {
					value.push_str(match op {
						AndOrOp::And => " and ",
						AndOrOp::Or => " or ",
					});
					value.push_str(&self.pipeline_inline(p));
				}
				match item.sep() {
					Sep::Amp => format!("background({value})"),
					Sep::Disown => format!("disown({value})"),
					_ => value,
				}
			})
			.collect::<Vec<_>>()
			.join("; ")
	}

	fn pipeline_inline(&self, p: Pipeline<'_>) -> String {
		fn lit(w: Option<Word<'_>>) -> Option<&[u8]> {
			match w.and_then(|w| w.parts().one()).map(WordPart::get) {
				Some(Part::Lit(v)) => Some(v),
				_ => None,
			}
		}
		let mut prev_stderr = false;
		let mut value = p
			.stages()
			.iter()
			.enumerate()
			.map(|(i, cmd)| {
				let compact = || text(&print(cmd, PrintStyle::Compact));
				let command = if cmd.redirs().is_empty() {
					match cmd.kind() {
						CommandKind::Simple(c) => {
							let words = c.words();
							if c.assigns().is_empty()
								&& lit(words.first()) == Some(b"echo")
								&& !lit(words.get(1)).is_some_and(|arg| arg.starts_with(b"-"))
							{
								format!(
									"print({})",
									words
										.skip(1)
										.iter()
										.map(|w| self.word(w))
										.collect::<Vec<_>>()
										.join(", ")
								)
							} else {
								let mut parts: Vec<String> =
									c.assigns().iter().map(|a| self.assignment(a)).collect();
								parts.extend(words.iter().enumerate().map(|(i, w)| match lit(Some(w)) {
									Some(v) if i == 0 => text(v),
									_ => self.word(w),
								}));
								parts.join(" ")
							}
						},
						CommandKind::Cond(c) => self.condition(c),
						CommandKind::Arith(a) => self
							.analysis
							.arithmetic(a.src())
							.map_or_else(|| format!("(({}))", text(a.src())), |value| value.to_string()),
						CommandKind::Brace(l) => format!("{{ {} }}", self.list_inline(l)),
						CommandKind::Subshell(l) => format!("subshell({})", self.list_inline(l)),
						_ => compact(),
					}
				} else {
					compact()
				};
				let pipe = if prev_stderr { "|&" } else { "|" };
				prev_stderr = cmd.pipe_stderr();
				if i == 0 {
					command
				} else {
					format!("{pipe} {command}")
				}
			})
			.collect::<Vec<_>>()
			.join(" ");
		if p.bang() {
			value = format!("not ({value})");
		}
		if let Some(time) = p.time() {
			value = format!("time{}({value})", if time.posix { "_posix" } else { "" });
		}
		value
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::syntax::{Features, parse_all};
	fn render(source: &[u8]) -> String {
		let program = parse_all(source, Features::NONE).expect("canonical bash parse");
		let analysis = Analysis::default();
		let layers = Layers::default();
		let printer =
			WordPrinter { layers: &layers, analysis: &analysis, unit: 0, source: 0 };
		program
			.commands
			.iter()
			.map(|c| printer.list_inline(c.list()))
			.collect::<Vec<_>>()
			.join("; ")
	}
	#[test]
	fn quotes_preserve_controls_and_unicode() {
		assert_eq!(quote("λ\n\"\\\t"), "\"λ\\n\\\"\\\\\\t\"");
		assert_eq!(render(b"printf '%s' $'a\\nb'"), "printf \"%s\" \"a\\nb\"");
	}
	#[test]
	fn canonical_arrays_keep_indices_and_append() {
		let output = render(b"a=([key]=one [other]+=two); a[3]+=tail");
		assert!(output.contains("[\"key\" : \"one\", \"other\" += \"two\"]"));
		assert!(output.contains("a[\"3\"] += \"tail\""));
	}
	#[test]
	fn arithmetic_uses_native_precedence_and_preserves_dynamic_source() {
		assert_eq!(render(b"echo $((1 + 2 * 3))"), "print((1 + (2 * 3)))");
		assert_eq!(render(b"echo $((a[$i] + 1))"), "print($((a[$i] + 1)))");
		assert_eq!(render(b"((a[$i]++))"), "((a[$i]++))");
	}
	#[test]
	fn quoted_interpolation_keeps_expression_and_literal_braces() {
		assert_eq!(render(br#"echo "$ROOT/path{literal}""#), "print(f\"{ROOT}/path{{literal}}\")");
		assert_eq!(render(br#"echo "plain{literal}""#), "print(\"plain{literal}\")");
	}
	#[test]
	fn adjacent_parts_merge_into_one_string() {
		assert_eq!(render(br#"echo repos/org/$r/"x y"'{z}'"#), "print(f\"repos/org/{r}/x y{{z}}\")");
		assert_eq!(render(b"echo 'a'\"b\"c"), "print(\"abc\")");
	}
	#[test]
	fn canonical_expansions_preserve_operator_distinctions() {
		let output =
			render(b"echo ${v-word} ${v:-word} ${v//x/y} ${v:1:2} ${v^^} <(printf x) $((1+2))");
		for expected in [
			"is_set(v)",
			"nonempty(v)",
			"replace_all(v, \"x\", \"y\")",
			"slice(v, 1, 2)",
			"upper_all(v)",
			"file⟨printf \"x\"⟩",
			"(1 + 2)",
		] {
			assert!(output.contains(expected), "{expected}: {output}");
		}
	}
	#[test]
	fn canonical_conditions_keep_boolean_grouping() {
		let output = render(b"[[ -f file && ( $n -ge 2 || $s =~ ^ok ) ]]");
		assert!(output.contains("is_file(\"file\")"));
		assert!(output.contains("int(n) >= int(\"2\")"));
		assert!(output.contains("regex(s, \"^ok\")"));
		assert!(output.contains(" and "));
		assert!(output.contains(" or "));
	}
}
