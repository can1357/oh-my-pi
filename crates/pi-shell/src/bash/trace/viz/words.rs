//! Python-like word expressions over the engine's canonical syntax.
//! Quoting and substitutions preserve complete values; display folding belongs
//! to rows.
use super::{analysis::Analysis, model::Layers};
use crate::bash::syntax::*;

pub struct WordPrinter<'a> {
	pub layers:   &'a Layers,
	pub analysis: &'a Analysis,
	pub unit:     u32,
	pub source:   u32,
}
fn text(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
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
	pub fn word(&self, word: &Word) -> String {
		if word.parts.is_empty() {
			return quote("");
		}
		if word.parts.len() == 1 {
			return self.part(&word.parts[0]);
		}
		let parts: Vec<_> = word.parts.iter().map(|p| self.part(p)).collect();
		format!("concat({})", parts.join(", "))
	}

	fn part(&self, p: &WordPart) -> String {
		match p {
			WordPart::Lit(v) | WordPart::Escaped(v) | WordPart::SQuote(v) => quote(&text(v)),
			WordPart::AnsiC(v) => quote(&text(&crate::bash::syntax::ansi_decode_all(v))),
			WordPart::DQuote(v) | WordPart::Locale(v) => self.interpolation(v),
			WordPart::Param(p) => self.parameter(p),
			WordPart::Comsub(c) => format!(
				"{}⟨{}⟩",
				match c.kind {
					ComsubKind::ValueSub => "reply",
					ComsubKind::NoFork => "current",
					_ => "",
				},
				self.list_inline(&c.body)
			),
			WordPart::ProcSub(p) => format!(
				"{}⟨{}⟩",
				if p.output { "write_file" } else { "file" },
				self.list_inline(&p.body)
			),
			WordPart::Arith(a) => self.analysis.arithmetic(&a.src).map_or_else(
				|| {
					if a.bracket {
						format!("$[{}]", text(&a.src))
					} else {
						format!("$(({}))", text(&a.src))
					}
				},
				|value| value.to_string(),
			),
			WordPart::Compound(e) => self.elements(e),
			WordPart::BadSubst(v) | WordPart::Zsh(v) => text(v),
			WordPart::BadComsub(c) => text(&c.text),
			WordPart::DroppedQuote => "\"".into(),
		}
	}

	fn interpolation(&self, parts: &[WordPart]) -> String {
		let dynamic = parts.iter().any(|p| {
			!matches!(
				p,
				WordPart::Lit(_)
					| WordPart::Escaped(_)
					| WordPart::SQuote(_)
					| WordPart::AnsiC(_)
					| WordPart::DroppedQuote
			)
		});
		let mut content = String::new();
		for part in parts {
			let literal = match part {
				WordPart::Lit(v) | WordPart::Escaped(v) | WordPart::SQuote(v) => Some(text(v)),
				WordPart::AnsiC(v) => Some(text(&crate::bash::syntax::ansi_decode_all(v))),
				WordPart::DroppedQuote => Some("\"".into()),
				_ => None,
			};
			if let Some(literal) = literal {
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
			} else {
				content.push('{');
				content.push_str(&self.part(part));
				content.push('}');
			}
		}
		format!("{}\"{content}\"", if dynamic { "f" } else { "" })
	}

	fn elements(&self, e: &[ArrayElem]) -> String {
		format!(
			"[{}]",
			e.iter()
				.map(|e| {
					let value = self.word(&e.value);
					match &e.key {
						Some(k) => {
							format!("{} {} {}", self.word(k), if e.append { "+=" } else { ":" }, value)
						},
						None => value,
					}
				})
				.collect::<Vec<_>>()
				.join(", ")
		)
	}

	pub fn assignment(&self, a: &Assign) -> String {
		let mut name = text(&a.name);
		if let Some(i) = &a.index {
			name.push('[');
			name.push_str(&self.word(i));
			name.push(']');
		}
		format!("{name} {} {}", if a.append { "+=" } else { "=" }, match &a.value {
			AssignValue::Scalar(w) => self.word(w),
			AssignValue::Array(e) => self.elements(e),
		})
	}

	pub fn parameter(&self, p: &Param) -> String {
		if self.layers.inline
			&& matches!(p.op, ParamOp::None)
			&& p.index.is_none()
			&& !p.indirect
			&& let ParamName::Var(name) = &p.name
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
		let mut v = match &p.name {
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
		if matches!(p.op, ParamOp::Indirect)
			&& matches!(p.index, Some(Subscript::At | Subscript::Star))
		{
			return format!(
				"{}keys({v})",
				if matches!(p.index, Some(Subscript::Star)) {
					"joined_"
				} else {
					""
				}
			);
		}
		if p.indirect {
			v = format!("indirect({v})");
		}
		if let Some(index) = &p.index {
			v = format!("{v}[{}]", match index {
				Subscript::At => ":".into(),
				Subscript::Star => "*".into(),
				Subscript::Expr(w) => self.word(w),
			});
		}
		let presence = |colon: bool| format!("{}({v})", if colon { "nonempty" } else { "is_set" });
		match &p.op {
			ParamOp::None => v,
			ParamOp::Length => format!("len({v})"),
			ParamOp::Indirect => format!("indirect({v})"),
			ParamOp::PrefixNames { star } => {
				format!("variable_names({}, {})", quote(&v), quote(if *star { "*" } else { "@" }))
			},
			ParamOp::Default { colon, word } => {
				format!("({v} if {} else {})", presence(*colon), self.word(word))
			},
			ParamOp::Assign { colon, word } => {
				format!("default_assign({v}, {}, {})", self.word(word), presence(*colon))
			},
			ParamOp::Error { colon, word } => format!(
				"require({v}, {}, {})",
				word
					.as_ref()
					.map_or_else(|| quote("parameter null or not set"), |w| self.word(w)),
				presence(*colon)
			),
			ParamOp::Alt { colon, word } => {
				format!("({} if {} else \"\")", self.word(word), presence(*colon))
			},
			ParamOp::Substr { offset, len } => format!(
				"slice({v}, {}{})",
				text(&offset.src),
				len.as_ref()
					.map_or_default(|l| format!(", {}", text(&l.src)))
			),
			ParamOp::Trim { suffix, longest, pat } => format!(
				"strip_{}{}({v}, {})",
				if *longest { "longest_" } else { "" },
				if *suffix { "suffix" } else { "prefix" },
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
				rep.as_ref().map_or_else(|| quote(""), |w| self.word(w))
			),
			ParamOp::Case { mode, all, pat } => format!(
				"{}_{}({v}{})",
				match mode {
					CaseMode::Upper => "upper",
					CaseMode::Lower => "lower",
					CaseMode::Toggle => "toggle_case",
				},
				if *all { "all" } else { "first" },
				pat.as_ref()
					.map_or_default(|w| format!(", {}", self.word(w)))
			),
			ParamOp::Transform(op) => {
				format!("transform({v}, {})", quote(&char::from(*op).to_string()))
			},
		}
	}

	pub fn condition(&self, c: &CondExpr) -> String {
		match c {
			CondExpr::Word(w) => format!("nonempty({})", self.word(w)),
			CondExpr::Not(c) => format!("not ({})", self.condition(c)),
			CondExpr::Group(c) => format!("({})", self.condition(c)),
			CondExpr::And(a, b) => format!("({} and {})", self.condition(a), self.condition(b)),
			CondExpr::Or(a, b) => format!("({} or {})", self.condition(a), self.condition(b)),
			CondExpr::Unary { op, arg } => {
				let f = match op.as_slice() {
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
			CondExpr::Binary { op, lhs, rhs } => {
				let a = self.word(lhs);
				let b = self.word(rhs);
				match op.as_slice() {
					b"=~" => format!("regex({a}, {b})"),
					b"=" | b"==" => format!("matches({a}, {b})"),
					b"!=" => format!("not matches({a}, {b})"),
					b"-eq" | b"-ne" | b"-lt" | b"-le" | b"-gt" | b"-ge" => {
						format!("int({a}) {} int({b})", match op.as_slice() {
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

	pub fn list_inline(&self, list: &List) -> String {
		list.items.iter().map(|item| {
   let pipeline=|p:&Pipeline| {
    let mut value=p.stages.iter().enumerate().map(|(i,s)| {
     let command=if s.cmd.redirs.is_empty() {match &s.cmd.kind {
      CommandKind::Simple(c)=>{
       if c.assigns.is_empty() && matches!(c.words.first().map(|w|w.parts.as_slice()),Some([WordPart::Lit(name)]) if name==b"echo") && !matches!(c.words.get(1).map(|w|w.parts.as_slice()),Some([WordPart::Lit(arg)]) if arg.starts_with(b"-")) {
        format!("print({})",c.words[1..].iter().map(|w|self.word(w)).collect::<Vec<_>>().join(", "))
       } else {
        let mut parts:Vec<String>=c.assigns.iter().map(|a|self.assignment(a)).collect();
        parts.extend(c.words.iter().enumerate().map(|(i,w)|if i==0 {match w.parts.as_slice(){[WordPart::Lit(v)]=>text(v),_=>self.word(w)}}else{self.word(w)}));
        parts.join(" ")
       }
      },
      CommandKind::Cond(c)=>self.condition(c),
      CommandKind::Arith(a)=>self.analysis.arithmetic(&a.src).map_or_else(||format!("(({}))",text(&a.src)), |value|value.to_string()),
      CommandKind::Brace(l)=>format!("{{ {} }}",self.list_inline(l)),
      CommandKind::Subshell(l)=>format!("subshell({})",self.list_inline(l)),
      _=>text(&print(&s.cmd,PrintStyle::Compact)),
     }}else{text(&print(&s.cmd,PrintStyle::Compact))};
     if i==0{command}else{format!("{} {command}",if p.stages[i-1].pipe_stderr{"|&"}else{"|"})}
    }).collect::<Vec<_>>().join(" ");
    if p.bang {value=format!("not ({value})");}
    if let Some(time)=&p.time {value=format!("time{}({value})",if time.posix{"_posix"}else{""});}
    value
   };
   let mut value=pipeline(&item.and_or.first);
   for (op,p) in &item.and_or.rest {value.push_str(match op{AndOrOp::And=>" and ",AndOrOp::Or=>" or "});value.push_str(&pipeline(p));}
   match item.sep{Sep::Amp=>format!("background({value})"),Sep::Disown=>format!("disown({value})"),_=>value}
  }).collect::<Vec<_>>().join("; ")
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn render(source: &[u8]) -> String {
		let program = parse_all(source, Features::NONE).expect("canonical bash parse");
		let analysis = Analysis::default();
		let layers = Layers::default();
		let printer =
			WordPrinter { layers: &layers, analysis: &analysis, unit: 0, source: 0 };
		program
			.commands
			.iter()
			.map(|c| printer.list_inline(&c.list))
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
