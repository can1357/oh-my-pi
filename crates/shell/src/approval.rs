//! Structural AST analysis of Bash 5.3 and Zsh 5.9 commands for `bash` tool
//! approval.

use alloc::{string::String, vec::Vec};

use crate::bash::{
	decode_zsh_dollar_quote,
	syntax::{
		AndOrOp, Assign, AssignValue, Command, CommandKind, Features, List, ListItem, Param, ParamOp,
		Part, Pipeline, Program, Redir, RedirFd, RedirTarget, Sep, Simple, Span, Word, WordPart,
		ansi_decode_all, parse_all, tree::Seq, zsh::tok,
	},
};
const MAX_ZSH_COMSUB_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDialect {
	Bash,
	Zsh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalSimpleCommand {
	/// Trimmed source text of the simple command (excluding trailing comments).
	pub text:                 String,
	/// Source text starting at the first command word (leading env assigns
	/// stripped).
	pub without_assigns_text: String,
	/// Names of leading `NAME=value` environment assignments.
	pub assign_names:         Vec<String>,
	/// Quote-decoded command words (`argv[0]` is the executable).
	pub argv:                 Vec<String>,
	/// Indices into `argv` whose source word contained an unquoted glob
	/// metacharacter.
	pub glob_word_indices:    Vec<u32>,
	/// True when no expansions, brace expansions, NUL bytes, or `argv[0]` globs
	/// occur (unquoted non-`argv[0]` globs still keep this true).
	pub expansion_free:       bool,
	/// True when `expansion_free` and every word/assignment is strictly literal
	/// (no globs, tildes, ANSI-C control chars, or `typeset`).
	pub strictly_literal:     bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalAndClause {
	pub text:                   String,
	pub simple:                 Option<ApprovalSimpleCommand>,
	/// True when the clause's stages could not be proven free of shell-state
	/// mutations.
	pub syntactically_stateful: bool,
	pub stage_commands:         Vec<Vec<String>>,
	/// Candidate command strings extracted from this clause for `deny`/`prompt`
	/// matching.
	pub restriction_segments:   Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashApprovalAnalysis {
	/// False when the shell parser rejected the command as a syntax error.
	pub valid:                  bool,
	pub has_control_chars:      bool,
	pub has_comment:            bool,
	pub single:                 Option<ApprovalSimpleCommand>,
	pub and_chain:              Option<Vec<ApprovalAndClause>>,
	pub restriction_segments:   Vec<String>,
	/// True when nested substitution scanning hit its depth limit or an unparsed
	/// body; callers must merge fallback segments.
	pub restriction_incomplete: bool,
}

struct DecodedWord {
	text:              String,
	expansion_free:    bool,
	strictly_literal:  bool,
	has_unquoted_cr:   bool,
	has_unquoted_glob: bool,
}

const fn dialect_features(dialect: ApprovalDialect) -> Features {
	match dialect {
		ApprovalDialect::Bash => Features::NONE,
		ApprovalDialect::Zsh => Features::from_bits(
			Features::ZSH.bits()
				| Features::ZSH_SHORT_LOOPS.bits()
				| Features::ZSH_SHORT_REPEAT.bits()
				| Features::ZSH_MULTI_FUNC_DEF.bits()
				| Features::ZSH_INTERACTIVE_COMMENTS.bits(),
		),
	}
}

const fn is_control_byte(b: u8) -> bool {
	(b < 0x20 && b != b'\t') || b == 0x7f
}

fn span_text(src: &str, span: Span) -> &str {
	core::str::from_utf8(span.slice(src.as_bytes())).unwrap_or_default()
}

fn slice_has_comment(src: &[u8], lo: usize, hi: usize) -> bool {
	src.get(lo..hi).is_some_and(|s| s.contains(&b'#'))
}

fn has_newline_outside_span(src: &str, span: Span) -> bool {
	let bytes = src.as_bytes();
	let lo = (span.lo as usize).min(bytes.len());
	let hi = (span.hi as usize).min(bytes.len());
	bytes[..lo].contains(&b'\n') || bytes[hi..].contains(&b'\n')
}

fn detect_comment(program: &Program, src: &str) -> bool {
	let bytes = src.as_bytes();
	let mut cursor = 0usize;
	for cc in &program.commands {
		let lo = (cc.span.lo as usize).min(bytes.len());
		let hi = (cc.span.hi as usize).min(bytes.len());
		if slice_has_comment(bytes, cursor, lo) {
			return true;
		}
		if cc.list().items().len() == 1
			&& let Some(item) = cc.list().items().first()
		{
			let mut prev_hi = lo;
			for pipe in item.and_or().pipelines() {
				let p_lo = (pipe.span().lo as usize).min(bytes.len());
				let p_hi = (pipe.span().hi as usize).min(bytes.len());
				if slice_has_comment(bytes, prev_hi, p_lo) {
					return true;
				}
				prev_hi = prev_hi.max(p_hi);
			}
			if slice_has_comment(bytes, prev_hi, hi) {
				return true;
			}
		}
		cursor = cursor.max(hi);
	}
	slice_has_comment(bytes, cursor, bytes.len())
}

struct WordDecoder {
	out:                 Vec<u8>,
	is_assign_rhs:       bool,
	expansion_free:      bool,
	strictly_literal:    bool,
	has_unquoted_cr:     bool,
	has_unquoted_glob:   bool,
	has_nul:             bool,
	brace_depth:         usize,
	brace_sep_at_depth:  bool,
	has_brace_expansion: bool,
}

impl WordDecoder {
	fn decode(word: Word<'_>, src: &str, is_assign_rhs: bool) -> DecodedWord {
		let mut dec = Self {
			out: Vec::new(),
			is_assign_rhs,
			expansion_free: true,
			strictly_literal: true,
			has_unquoted_cr: false,
			has_unquoted_glob: false,
			has_nul: false,
			brace_depth: 0,
			brace_sep_at_depth: false,
			has_brace_expansion: false,
		};
		dec.decode_parts(word.parts(), false);
		if dec.has_brace_expansion {
			dec.expansion_free = false;
			dec.strictly_literal = false;
		}
		let text = if dec.expansion_free || dec.has_nul {
			String::from_utf8_lossy(&dec.out).into_owned()
		} else {
			dec.strictly_literal = false;
			span_text(src, word.span()).trim().into()
		};
		DecodedWord {
			text,
			expansion_free: dec.expansion_free,
			strictly_literal: dec.strictly_literal,
			has_unquoted_cr: dec.has_unquoted_cr,
			has_unquoted_glob: dec.has_unquoted_glob,
		}
	}

	fn push_unquoted_brace(&mut self, b: u8, next: Option<u8>) {
		match b {
			b'{' => {
				self.brace_depth += 1;
				self.strictly_literal = false;
			},
			b'}' => {
				if self.brace_depth > 0 {
					if self.brace_sep_at_depth {
						self.has_brace_expansion = true;
					}
					self.brace_depth -= 1;
					if self.brace_depth == 0 {
						self.brace_sep_at_depth = false;
					}
				}
				self.strictly_literal = false;
			},
			b',' if self.brace_depth > 0 => self.brace_sep_at_depth = true,
			b'.' if self.brace_depth > 0 && next == Some(b'.') => self.brace_sep_at_depth = true,
			_ => {},
		}
	}

	fn decode_parts(&mut self, parts: Seq<'_, WordPart<'_>>, in_dquote: bool) {
		for (part_idx, part) in parts.iter().enumerate() {
			if self.has_nul {
				return;
			}
			match part.get() {
				Part::Lit(bytes) => {
					if !in_dquote {
						for (idx, &b) in bytes.iter().enumerate() {
							if b == b'\r' {
								self.has_unquoted_cr = true;
							}
							if matches!(b, b'*' | b'?' | b'[' | b']') {
								self.has_unquoted_glob = true;
								self.strictly_literal = false;
							}
							self.push_unquoted_brace(b, bytes.get(idx + 1).copied());
						}
						if (part_idx == 0 && bytes.starts_with(b"~"))
							|| (self.is_assign_rhs && bytes.contains(&b'~'))
						{
							self.strictly_literal = false;
						}
					}
					self.out.extend_from_slice(bytes);
				},
				Part::Escaped(bytes) | Part::SQuote(bytes) => self.out.extend_from_slice(bytes),
				Part::DQuote(inner) => self.decode_parts(inner, true),
				Part::AnsiC(bytes) => {
					let decoded = ansi_decode_all(bytes);
					self.append_dollar_quote(&decoded);
				},
				Part::Zsh(bytes) => self.decode_zsh_bytes(bytes),
				Part::Locale(_)
				| Part::Param(_)
				| Part::Comsub(_)
				| Part::Arith(_)
				| Part::ProcSub(_)
				| Part::Compound(_)
				| Part::BadSubst(_)
				| Part::BadComsub(_)
				| Part::DroppedQuote => {
					self.expansion_free = false;
					self.strictly_literal = false;
				},
			}
		}
	}

	fn append_dollar_quote(&mut self, decoded: &[u8]) {
		if let Some(nul_pos) = decoded.iter().position(|&b| b == 0) {
			self.has_nul = true;
			self.expansion_free = false;
			self.strictly_literal = false;
			self.out.extend_from_slice(&decoded[..nul_pos]);
			return;
		}
		if decoded.iter().any(|&b| is_control_byte(b)) {
			self.strictly_literal = false;
		}
		self.out.extend_from_slice(decoded);
	}

	fn decode_zsh_bytes(&mut self, bytes: &[u8]) {
		let mut i = 0usize;
		let mut in_squote = false;
		let mut in_dquote = false;
		let mut prev_bnull = false;

		while i < bytes.len() {
			let c = bytes[i];
			if c == tok::META {
				if i + 1 < bytes.len() {
					let b = bytes[i + 1] ^ 32;
					if b == b'\r' && !in_squote && !in_dquote && !prev_bnull {
						self.has_unquoted_cr = true;
					}
					self.out.push(b);
					i += 2;
				} else {
					i += 1;
				}
				prev_bnull = false;
				continue;
			}
			if c == tok::STRING && bytes.get(i + 1) == Some(&tok::SNULL) {
				let (text, consumed) = decode_zsh_dollar_quote(&bytes[i + 2..]);
				let decoded = tok::unmetafy(&text);
				self.append_dollar_quote(&decoded);
				if self.has_nul {
					return;
				}
				i += 2 + consumed;
				prev_bnull = false;
				continue;
			}

			match c {
				tok::BNULLKEEP => self.out.push(b'\\'),
				tok::SNULL => in_squote = !in_squote,
				tok::DNULL => in_dquote = !in_dquote,
				tok::BNULL => {
					prev_bnull = true;
					i += 1;
					continue;
				},
				tok::NULARG => {},
				tok::STRING
				| tok::QSTRING
				| tok::TICK
				| tok::QTICK
				| tok::INPAR
				| tok::OUTPAR
				| tok::INPARMATH
				| tok::OUTPARMATH
				| tok::INANG
				| tok::OUTANG
				| tok::OUTANGPROC
				| tok::MARKER => {
					self.expansion_free = false;
					self.strictly_literal = false;
					return;
				},
				tok::EQUALS => {
					if (i == 0 && bytes.len() > 1) || bytes.get(i + 1) == Some(&tok::INPAR) {
						self.expansion_free = false;
						self.strictly_literal = false;
						return;
					}
					self.out.push(b'=');
				},
				tok::TILDE => {
					if i == 0 || self.is_assign_rhs {
						self.strictly_literal = false;
					}
					self.out.push(b'~');
				},
				tok::INBRACE => {
					self.push_unquoted_brace(b'{', None);
					self.out.push(b'{');
				},
				tok::OUTBRACE => {
					self.push_unquoted_brace(b'}', None);
					self.out.push(b'}');
				},
				tok::STAR | tok::QUEST | tok::INBRACK | tok::OUTBRACK => {
					self.has_unquoted_glob = true;
					self.strictly_literal = false;
					if let Some(ch) = tok::tok_char(c) {
						self.out.push(ch);
					}
				},
				tok::BANG => {
					self.strictly_literal = false;
					self.out.push(b'!');
				},
				tok::DASH | tok::BAR | tok::POUND | tok::HAT => {
					if let Some(ch) = tok::tok_char(c) {
						self.out.push(ch);
					}
				},
				tok::COMMA => {
					self.push_unquoted_brace(b',', None);
					self.out.push(b',');
				},
				_ => {
					if !in_squote && !in_dquote && !prev_bnull {
						if c == b'.' {
							self.push_unquoted_brace(b'.', bytes.get(i + 1).copied());
						} else if c == b'\r' {
							self.has_unquoted_cr = true;
						}
					}
					self.out.push(c);
				},
			}
			prev_bnull = false;
			i += 1;
		}
	}
}

enum SimpleArg<'t> {
	Word(Word<'t>),
	Assign(Assign<'t>),
}

fn partition_simple_args<'t>(simple: Simple<'t>) -> (Vec<Assign<'t>>, Vec<SimpleArg<'t>>) {
	let first_word_lo = simple.words().first().map(|w| w.span().lo);
	let mut leading = Vec::new();
	let mut post = Vec::new();
	for assign in simple.assigns() {
		if first_word_lo.is_none_or(|lo| assign.span().lo < lo) {
			leading.push(assign);
		} else {
			post.push(assign);
		}
	}
	if post.is_empty() {
		let args = simple.words().iter().map(SimpleArg::Word).collect();
		return (leading, args);
	}
	let mut ordered: Vec<(u32, SimpleArg<'t>)> = simple
		.words()
		.iter()
		.map(|w| (w.span().lo, SimpleArg::Word(w)))
		.chain(
			post
				.into_iter()
				.map(|a| (a.span().lo, SimpleArg::Assign(a))),
		)
		.collect();
	ordered.sort_by_key(|(lo, _)| *lo);
	(leading, ordered.into_iter().map(|(_, item)| item).collect())
}

fn decode_assign_word(assign: Assign<'_>, src: &str) -> DecodedWord {
	if assign.index().is_some() {
		return DecodedWord {
			text:              span_text(src, assign.span()).trim().into(),
			expansion_free:    false,
			strictly_literal:  false,
			has_unquoted_cr:   false,
			has_unquoted_glob: false,
		};
	}
	let name = String::from_utf8_lossy(assign.name());
	let op = if assign.append() { "+=" } else { "=" };
	match assign.value() {
		AssignValue::Scalar(word) => {
			let d = WordDecoder::decode(word, src, true);
			DecodedWord { text: alloc::format!("{name}{op}{}", d.text), ..d }
		},
		AssignValue::Array(_) => DecodedWord {
			text:              span_text(src, assign.span()).trim().into(),
			expansion_free:    false,
			strictly_literal:  false,
			has_unquoted_cr:   false,
			has_unquoted_glob: false,
		},
	}
}

fn analyze_simple_parts(
	pipeline_span: Span,
	simple: Simple<'_>,
	src: &str,
) -> ApprovalSimpleCommand {
	let first_word_lo = simple.words().first().map(|w| w.span().lo);
	let (leading, ordered) = partition_simple_args(simple);

	let mut assign_names = Vec::with_capacity(leading.len());
	let mut assigns_expansion_free = true;
	let mut assigns_strictly_literal = true;
	for assign in leading {
		assign_names.push(String::from_utf8_lossy(assign.name()).into_owned());
		let d = decode_assign_word(assign, src);
		if !d.expansion_free || d.has_unquoted_cr {
			assigns_expansion_free = false;
		}
		if !d.expansion_free || d.has_unquoted_cr || !d.strictly_literal {
			assigns_strictly_literal = false;
		}
	}

	let mut argv = Vec::with_capacity(ordered.len());
	let mut glob_word_indices = Vec::new();
	let mut words_expansion_free = true;
	let mut words_strictly_literal = true;

	for (idx, item) in ordered.into_iter().enumerate() {
		let d = match item {
			SimpleArg::Word(word) => WordDecoder::decode(word, src, false),
			SimpleArg::Assign(assign) => decode_assign_word(assign, src),
		};
		if !d.expansion_free || d.has_unquoted_cr {
			words_expansion_free = false;
		}
		if !d.strictly_literal {
			words_strictly_literal = false;
		}
		if d.has_unquoted_glob {
			if idx == 0 {
				words_expansion_free = false;
			}
			if let Ok(u) = u32::try_from(idx) {
				glob_word_indices.push(u);
			}
		}
		argv.push(d.text);
	}

	let expansion_free = words_expansion_free && assigns_expansion_free;
	let strictly_literal = expansion_free
		&& !simple.typeset()
		&& words_strictly_literal
		&& assigns_strictly_literal
		&& !argv.is_empty()
		&& !argv[0].is_empty();

	let text = span_text(src, pipeline_span).trim().into();
	let without_assigns_text = match first_word_lo {
		Some(lo) => span_text(src, Span::new(lo, pipeline_span.hi))
			.trim()
			.into(),
		None => String::new(),
	};

	ApprovalSimpleCommand {
		text,
		without_assigns_text,
		assign_names,
		argv,
		glob_word_indices,
		expansion_free,
		strictly_literal,
	}
}

fn analyze_simple(
	pipeline: Pipeline<'_>,
	cmd: Command<'_>,
	simple: Simple<'_>,
	src: &str,
) -> Option<ApprovalSimpleCommand> {
	if pipeline.bang() || pipeline.time().is_some() || !cmd.redirs().is_empty() {
		return None;
	}
	Some(analyze_simple_parts(pipeline.span(), simple, src))
}

fn analyze_and_clause(
	pipeline: Pipeline<'_>,
	src: &str,
	features: Features,
	incomplete: &mut bool,
) -> ApprovalAndClause {
	let text: String = span_text(src, pipeline.span()).trim().into();
	let mut clause_collector = SegmentCollector::new(features);
	for cmd in pipeline.stages() {
		clause_collector.collect_command(cmd, src, 0);
	}
	if clause_collector.incomplete {
		*incomplete = true;
	}
	let restriction_segments = clause_collector.out;

	let single_stage = pipeline.stages().one();
	let simple = single_stage.and_then(|cmd| match cmd.kind() {
		CommandKind::Simple(s) => analyze_simple(pipeline, cmd, s, src),
		_ => None,
	});

	if let Some(s) = &simple {
		if s.strictly_literal {
			let stage_commands = alloc::vec![s.argv.clone()];
			return ApprovalAndClause {
				text,
				simple,
				syntactically_stateful: false,
				stage_commands,
				restriction_segments,
			};
		}
		let stage_is_typeset = single_stage
			.is_some_and(|cmd| matches!(cmd.kind(), CommandKind::Simple(simp) if simp.typeset()));
		let stage_commands = if s.expansion_free && !s.argv.is_empty() && !stage_is_typeset {
			alloc::vec![s.argv.clone()]
		} else {
			Vec::new()
		};
		return ApprovalAndClause {
			text,
			simple,
			syntactically_stateful: stage_commands.is_empty(),
			stage_commands,
			restriction_segments,
		};
	}

	let mut stage_commands = Vec::new();
	if !pipeline.bang() && pipeline.time().is_none() {
		for stage in pipeline.stages() {
			let CommandKind::Simple(s) = stage.kind() else {
				stage_commands.clear();
				break;
			};
			if s.words().is_empty() || s.typeset() {
				stage_commands.clear();
				break;
			}
			let parsed = analyze_simple_parts(stage.span(), s, src);
			let redirs_safe = stage.redirs().iter().all(|redir| {
				!matches!(redir.fd(), Some(RedirFd::Var(_)))
					&& match redir.target() {
						RedirTarget::Word(w) => {
							let d = WordDecoder::decode(w, src, false);
							d.expansion_free && !d.has_unquoted_cr
						},
						RedirTarget::HereDoc(_) => false,
					}
			});
			if !parsed.expansion_free || !redirs_safe {
				stage_commands.clear();
				break;
			}
			stage_commands.push(parsed.argv);
		}
	}

	ApprovalAndClause {
		text,
		simple,
		syntactically_stateful: stage_commands.is_empty(),
		stage_commands,
		restriction_segments,
	}
}

struct SegmentCollector {
	features:   Features,
	out:        Vec<String>,
	incomplete: bool,
}

impl SegmentCollector {
	const fn new(features: Features) -> Self {
		Self { features, out: Vec::new(), incomplete: false }
	}

	fn collect_program(&mut self, program: &Program, src: &str, depth: usize) {
		for cc in &program.commands {
			self.collect_list(cc.list(), src, depth);
		}
	}

	fn collect_list(&mut self, list: List<'_>, src: &str, depth: usize) {
		for item in list.items() {
			self.collect_item(item, src, depth);
		}
	}

	fn collect_item(&mut self, item: ListItem<'_>, src: &str, depth: usize) {
		for pipeline in item.and_or().pipelines() {
			for cmd in pipeline.stages() {
				self.collect_command(cmd, src, depth);
			}
		}
	}

	fn collect_command(&mut self, cmd: Command<'_>, src: &str, depth: usize) {
		match cmd.kind() {
			CommandKind::Simple(simple) => {
				let (leading, ordered) = partition_simple_args(simple);
				let mut raw_assigns = Vec::new();
				let mut decoded_assigns = Vec::new();
				for assign in leading {
					let raw = span_text(src, assign.span()).trim();
					if !raw.is_empty() {
						raw_assigns.push(String::from(raw));
					}
					let d = decode_assign_word(assign, src);
					if !d.text.is_empty() {
						decoded_assigns.push(d.text);
					}
					self.collect_assign_nested(assign, src, depth);
				}
				let mut word_tokens = Vec::new();
				for item in ordered {
					match item {
						SimpleArg::Word(word) => {
							let d = WordDecoder::decode(word, src, false);
							if !d.text.is_empty() {
								word_tokens.push(d.text);
							}
							self.collect_word_nested(word, src, depth);
						},
						SimpleArg::Assign(assign) => {
							let d = decode_assign_word(assign, src);
							if !d.text.is_empty() {
								word_tokens.push(d.text);
							}
							self.collect_assign_nested(assign, src, depth);
						},
					}
				}
				if !cmd.redirs().is_empty() {
					let raw_cmd = span_text(src, cmd.span()).trim();
					if !raw_cmd.is_empty() {
						self.out.push(String::from(raw_cmd));
					}
				}
				if raw_assigns.is_empty() {
					if !word_tokens.is_empty() {
						self.out.push(word_tokens.join(" "));
					}
				} else {
					let words_joined = word_tokens.join(" ");
					let join_with = |assigns: &[String]| -> String {
						if words_joined.is_empty() {
							assigns.join(" ")
						} else {
							alloc::format!("{} {words_joined}", assigns.join(" "))
						}
					};
					let decoded_combined = join_with(&decoded_assigns);
					let raw_combined = join_with(&raw_assigns);
					if !decoded_combined.is_empty() {
						self.out.push(decoded_combined.clone());
					}
					if !raw_combined.is_empty() && raw_combined != decoded_combined {
						self.out.push(raw_combined);
					}
					if !words_joined.is_empty() {
						self.out.push(words_joined);
					}
				}
			},
			CommandKind::Brace(list) | CommandKind::Subshell(list) => {
				self.collect_list(list, src, depth);
			},
			CommandKind::If(if_cmd) => {
				for arm in if_cmd.arms() {
					self.collect_list(arm.cond, src, depth);
					self.collect_list(arm.body, src, depth);
				}
				if let Some(else_body) = if_cmd.else_body() {
					self.collect_list(else_body, src, depth);
				}
			},
			CommandKind::While(while_cmd) => {
				self.collect_list(while_cmd.cond(), src, depth);
				self.collect_list(while_cmd.body(), src, depth);
			},
			CommandKind::For(for_cmd) => {
				if let Some(words) = for_cmd.words() {
					for word in words {
						self.collect_word_nested(word, src, depth);
					}
				}
				self.collect_list(for_cmd.body(), src, depth);
			},
			CommandKind::ArithFor(arith_for) => {
				for expr in [arith_for.init(), arith_for.cond(), arith_for.step()] {
					self.collect_arith_bytes(expr.src(), depth);
				}
				self.collect_list(arith_for.body(), src, depth);
			},
			CommandKind::Select(sel) => {
				if let Some(words) = sel.words() {
					for word in words {
						self.collect_word_nested(word, src, depth);
					}
				}
				self.collect_list(sel.body(), src, depth);
			},
			CommandKind::Case(case_cmd) => {
				self.collect_word_nested(case_cmd.word(), src, depth);
				for arm in case_cmd.arms() {
					for pat in arm.patterns() {
						self.collect_word_nested(pat, src, depth);
					}
					self.collect_list(arm.body(), src, depth);
				}
			},
			CommandKind::FuncDef(func) => self.collect_command(func.body(), src, depth),
			CommandKind::Coproc(coproc) => self.collect_command(coproc.body(), src, depth),
			CommandKind::Repeat(repeat) => {
				self.collect_word_nested(repeat.count(), src, depth);
				self.collect_list(repeat.body(), src, depth);
			},
			CommandKind::Try(try_cmd) => {
				self.collect_list(try_cmd.body(), src, depth);
				self.collect_list(try_cmd.always(), src, depth);
			},
			CommandKind::AnonFunc(anon) => {
				for arg in anon.args() {
					self.collect_word_nested(arg, src, depth);
				}
				self.collect_command(anon.body(), src, depth);
			},
			CommandKind::Cond(cond) => self.collect_cond_nested(cond, src, depth),
			CommandKind::Arith(arith) => self.collect_arith_bytes(arith.src(), depth),
		}

		for redir in cmd.redirs() {
			self.collect_redir_nested(redir, src, depth);
		}
	}

	fn collect_arith_bytes(&mut self, bytes: &[u8], depth: usize) {
		if self.features.contains(Features::ZSH) {
			let mut buf = bytes.to_vec();
			tok::untokenize(&mut buf);
			let raw = tok::unmetafy(&buf);
			if let Ok(text) = core::str::from_utf8(&raw) {
				self.collect_nested_subs(text, depth + 1, false);
			} else {
				self.incomplete = true;
			}
			return;
		}
		if let Ok(text) = core::str::from_utf8(bytes) {
			self.collect_nested_subs(text, depth + 1, false);
		} else {
			self.incomplete = true;
		}
	}

	fn collect_assign_nested(&mut self, assign: Assign<'_>, src: &str, depth: usize) {
		if let Some(idx) = assign.index() {
			self.collect_word_nested(idx, src, depth);
		} else if let Ok(name) = core::str::from_utf8(assign.name())
			&& (name.contains("$(") || name.contains('`'))
		{
			self.collect_nested_subs(name, depth + 1, false);
		}
		match assign.value() {
			AssignValue::Scalar(word) => self.collect_word_nested(word, src, depth),
			AssignValue::Array(elems) => {
				for elem in elems {
					if let Some(key) = elem.key() {
						self.collect_word_nested(key, src, depth);
					}
					self.collect_word_nested(elem.value(), src, depth);
				}
			},
		}
	}

	fn collect_redir_nested(&mut self, redir: Redir<'_>, src: &str, depth: usize) {
		match redir.target() {
			RedirTarget::Word(word) => self.collect_word_nested(word, src, depth),
			RedirTarget::HereDoc(hd) if !hd.quoted() => {
				if let Ok(text) = core::str::from_utf8(hd.text()) {
					self.collect_nested_subs(text, depth + 1, true);
				} else {
					self.incomplete = true;
				}
			},
			RedirTarget::HereDoc(_) => {},
		}
	}

	fn collect_cond_nested(
		&mut self,
		cond: crate::bash::syntax::CondExpr<'_>,
		src: &str,
		depth: usize,
	) {
		use crate::bash::syntax::Cond;
		match cond.get() {
			Cond::Unary { arg, .. } | Cond::Word(arg) => self.collect_word_nested(arg, src, depth),
			Cond::Binary { lhs, rhs, .. } => {
				self.collect_word_nested(lhs, src, depth);
				self.collect_word_nested(rhs, src, depth);
			},
			Cond::Not(inner) | Cond::Group(inner) => self.collect_cond_nested(inner, src, depth),
			Cond::And(lhs, rhs) | Cond::Or(lhs, rhs) => {
				self.collect_cond_nested(lhs, src, depth);
				self.collect_cond_nested(rhs, src, depth);
			},
		}
	}

	fn collect_word_nested(&mut self, word: Word<'_>, src: &str, depth: usize) {
		self.collect_parts_nested(word.parts(), word.span(), src, depth);
	}

	fn collect_parts_nested(
		&mut self,
		parts: Seq<'_, WordPart<'_>>,
		word_span: Span,
		src: &str,
		depth: usize,
	) {
		for part in parts {
			match part.get() {
				Part::DQuote(inner) | Part::Locale(inner) => {
					self.collect_parts_nested(inner, word_span, src, depth);
				},
				Part::Comsub(comsub) => self.collect_list(comsub.body(), src, depth),
				Part::ProcSub(proc_sub) => self.collect_list(proc_sub.body(), src, depth),
				Part::Param(param) => self.collect_param_nested(param, src, depth),
				Part::Compound(elems) => {
					for elem in elems {
						if let Some(key) = elem.key() {
							self.collect_word_nested(key, src, depth);
						}
						self.collect_word_nested(elem.value(), src, depth);
					}
				},
				Part::Arith(arith) => self.collect_arith_bytes(arith.src(), depth),
				Part::Zsh(bytes) if zsh_has_nested_sub(bytes) => {
					self.collect_nested_subs(span_text(src, word_span), depth + 1, false);
				},
				_ => {},
			}
		}
	}

	fn collect_param_nested(&mut self, param: Param<'_>, src: &str, depth: usize) {
		for (_, word) in param.words().into_iter().flatten() {
			self.collect_word_nested(word, src, depth);
		}
		if let ParamOp::Substr { offset, len } = param.op() {
			self.collect_arith_bytes(offset.src(), depth);
			if let Some(len) = len {
				self.collect_arith_bytes(len.src(), depth);
			}
		}
	}

	fn collect_nested_subs(&mut self, word_src: &str, depth: usize, in_heredoc: bool) {
		if depth > MAX_ZSH_COMSUB_DEPTH {
			self.incomplete = true;
			return;
		}
		let bytes = word_src.as_bytes();
		let mut i = 0usize;
		let mut quotes = QuoteState::new(in_heredoc);

		while i < bytes.len() {
			if quotes.advance(bytes, &mut i) {
				continue;
			}
			let b = bytes[i];
			if b == b'`' {
				let start = i + 1;
				let mut j = start;
				while j < bytes.len() {
					if bytes[j] == b'\\' && j + 1 < bytes.len() {
						j += 2;
						continue;
					}
					if bytes[j] == b'`' {
						break;
					}
					j += 1;
				}
				if j < bytes.len() {
					let unescaped = unescape_backtick(&bytes[start..j], quotes.in_dquote);
					if let Ok(inner) = core::str::from_utf8(&unescaped) {
						self.parse_nested_sub(inner, depth);
					} else {
						self.incomplete = true;
					}
					i = j + 1;
					continue;
				}
				self.incomplete = true;
				return;
			}
			let is_paren_sub = bytes.get(i + 1) == Some(&b'(')
				&& (b == b'$' || (!in_heredoc && !quotes.in_dquote && matches!(b, b'<' | b'>' | b'=')));
			if is_paren_sub {
				let start = i + 2;
				let Some(mut end) = find_matching_delim(bytes, start, b'(', b')') else {
					self.incomplete = true;
					return;
				};
				if b == b'$'
					&& bytes.get(start) == Some(&b'(')
					&& end > start + 1
					&& bytes.get(end - 1) == Some(&b')')
					&& find_matching_delim(bytes, start + 1, b'(', b')') == Some(end - 1)
				{
					if let Ok(inner_arith) = core::str::from_utf8(&bytes[start + 1..end - 1]) {
						self.collect_nested_subs(inner_arith, depth + 1, false);
					}
					i = end + 1;
					continue;
				}
				let mut parsed = false;
				for _ in 0..8 {
					if let Ok(inner) = core::str::from_utf8(&bytes[start..end])
						&& let Ok(sub_prog) = parse_all(inner.as_bytes(), self.features)
					{
						self.collect_program(&sub_prog, inner, depth);
						parsed = true;
						break;
					}
					let Some(next_end) = find_matching_delim(bytes, end + 1, b'(', b')') else {
						break;
					};
					end = next_end;
				}
				if !parsed {
					self.record_unparsed(&bytes[start..end]);
				}
				i = end + 1;
				continue;
			}
			if b == b'$'
				&& bytes.get(i + 1) == Some(&b'{')
				&& bytes.get(i + 2).is_some_and(u8::is_ascii_whitespace)
			{
				let start = i + 3;
				if let Some(end) = find_matching_delim(bytes, start, b'{', b'}') {
					if let Ok(inner) = core::str::from_utf8(&bytes[start..end]) {
						self.parse_nested_sub(inner, depth);
					}
					i = end + 1;
					continue;
				}
				self.incomplete = true;
				return;
			}
			i += 1;
		}
	}

	fn parse_nested_sub(&mut self, inner: &str, depth: usize) {
		if let Ok(sub_prog) = parse_all(inner.as_bytes(), self.features) {
			self.collect_program(&sub_prog, inner, depth);
		} else {
			self.record_unparsed(inner.as_bytes());
		}
	}

	fn record_unparsed(&mut self, bytes: &[u8]) {
		self.incomplete = true;
		if let Ok(inner) = core::str::from_utf8(bytes) {
			let trimmed = inner.trim();
			if !trimmed.is_empty() {
				self.out.push(String::from(trimmed));
			}
		}
	}
}

fn unescape_backtick(bytes: &[u8], in_dquote: bool) -> Vec<u8> {
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0usize;
	while i < bytes.len() {
		if bytes[i] == b'\\'
			&& let Some(&next) = bytes.get(i + 1)
			&& (matches!(next, b'$' | b'`' | b'\\') || (in_dquote && next == b'"'))
		{
			out.push(next);
			i += 2;
			continue;
		}
		out.push(bytes[i]);
		i += 1;
	}
	out
}

struct QuoteState {
	in_heredoc: bool,
	in_squote:  bool,
	in_dquote:  bool,
	in_dollar:  bool,
}

impl QuoteState {
	const fn new(in_heredoc: bool) -> Self {
		Self { in_heredoc, in_squote: false, in_dquote: false, in_dollar: false }
	}

	const fn advance(&mut self, bytes: &[u8], i: &mut usize) -> bool {
		let b = bytes[*i];
		if self.in_dollar {
			if b == b'\\' {
				*i += 2;
			} else {
				if b == b'\'' {
					self.in_dollar = false;
				}
				*i += 1;
			}
			return true;
		}
		if b == b'\\' && !self.in_squote {
			*i += 2;
			return true;
		}
		if !self.in_heredoc {
			if !self.in_squote
				&& !self.in_dquote
				&& b == b'$'
				&& *i + 1 < bytes.len()
				&& bytes[*i + 1] == b'\''
			{
				self.in_dollar = true;
				*i += 2;
				return true;
			}
			if b == b'\'' && !self.in_dquote {
				self.in_squote = !self.in_squote;
				*i += 1;
				return true;
			}
			if b == b'"' && !self.in_squote {
				self.in_dquote = !self.in_dquote;
				*i += 1;
				return true;
			}
			if self.in_squote {
				*i += 1;
				return true;
			}
		}
		false
	}
}

const fn zsh_has_nested_sub(bytes: &[u8]) -> bool {
	let mut i = 0usize;
	while i < bytes.len() {
		let c = bytes[i];
		if c == tok::META {
			i += 2;
			continue;
		}
		if matches!(
			c,
			tok::STRING
				| tok::QSTRING
				| tok::TICK
				| tok::QTICK
				| tok::INANG
				| tok::OUTANGPROC
				| tok::EQUALS
		) {
			return true;
		}
		i += 1;
	}
	false
}

const fn find_matching_delim(bytes: &[u8], mut i: usize, open: u8, close: u8) -> Option<usize> {
	let mut depth = 1usize;
	let mut quotes = QuoteState::new(false);
	while i < bytes.len() {
		if quotes.advance(bytes, &mut i) {
			continue;
		}
		if !quotes.in_dquote {
			if bytes[i] == open {
				depth += 1;
			} else if bytes[i] == close {
				depth -= 1;
				if depth == 0 {
					return Some(i);
				}
			}
		}
		i += 1;
	}
	None
}

#[must_use]
pub fn analyze_approval(command: &str, dialect: ApprovalDialect) -> BashApprovalAnalysis {
	let has_control_chars = command.bytes().any(is_control_byte);
	let features = dialect_features(dialect);
	let Ok(program) = parse_all(command.as_bytes(), features) else {
		return BashApprovalAnalysis {
			valid: false,
			has_control_chars,
			has_comment: false,
			single: None,
			and_chain: None,
			restriction_segments: Vec::new(),
			restriction_incomplete: false,
		};
	};

	let has_comment = detect_comment(&program, command);
	let mut single = None;
	let mut and_chain = None;
	let mut chain_incomplete = false;

	if let [complete] = program.commands.as_slice()
		&& let Some(item) = complete.list().items().one()
		&& matches!(item.sep(), Sep::None | Sep::Newline)
		&& !has_newline_outside_span(command, complete.span)
	{
		let and_or = item.and_or();
		if and_or.rest().len() == 0 {
			let pipeline = and_or.first();
			if let Some(cmd) = pipeline.stages().one()
				&& let CommandKind::Simple(s) = cmd.kind()
			{
				single = analyze_simple(pipeline, cmd, s, command);
			}
		} else if !has_control_chars && and_or.rest().all(|(op, _)| op == AndOrOp::And) {
			and_chain = Some(
				and_or
					.pipelines()
					.iter()
					.map(|pipe| analyze_and_clause(pipe, command, features, &mut chain_incomplete))
					.collect(),
			);
		}
	}

	let mut collector = SegmentCollector::new(features);
	collector.collect_program(&program, command, 0);

	BashApprovalAnalysis {
		valid: true,
		has_control_chars,
		has_comment,
		single,
		and_chain,
		restriction_segments: collector.out,
		restriction_incomplete: collector.incomplete || chain_incomplete,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn simple_commands_and_quoted_metachars() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let res = analyze_approval(r#"go test -race -run "Test(A|B)""#, dialect);
			assert!(res.valid);
			assert!(!res.has_control_chars);
			assert!(!res.has_comment);
			let single = res.single.expect("single");
			assert!(single.expansion_free);
			assert!(single.strictly_literal);
			assert_eq!(single.argv, ["go", "test", "-race", "-run", "Test(A|B)"]);

			let msg = analyze_approval(r#"git commit -m "fix -e flag (see foo; bar)""#, dialect);
			let s = msg.single.expect("single");
			assert!(s.expansion_free);
			assert!(s.strictly_literal);
			assert_eq!(s.argv, ["git", "commit", "-m", "fix -e flag (see foo; bar)"]);
		}
	}

	#[test]
	fn ansi_c_quoting_in_bash_and_zsh() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let res = analyze_approval(r"git commit -m $'line 1\nline 2'", dialect);
			assert!(res.valid);
			let single = res.single.expect("single");
			assert!(single.expansion_free);
			assert!(!single.strictly_literal);
			assert_eq!(single.argv, ["git", "commit", "-m", "line 1\nline 2"]);
		}
	}

	#[test]
	fn backslash_newline_continuation_joins_tokens() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let res = analyze_approval("git -\\\nc alias.x='!id' x", dialect);
			assert!(res.valid);
			let single = res.single.expect("single");
			assert_eq!(single.argv, ["git", "-c", "alias.x=!id", "x"]);
		}
	}

	#[test]
	fn leading_vs_post_word_assignments_and_subscripted_arrays() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let env_cmd = analyze_approval("GOOS=linux go test ./...", dialect);
			let s = env_cmd.single.expect("single");
			assert!(s.expansion_free);
			assert!(s.strictly_literal);
			assert_eq!(s.assign_names, ["GOOS"]);
			assert_eq!(s.without_assigns_text, "go test ./...");
			assert_eq!(s.argv, ["go", "test", "./..."]);

			let export_cmd = analyze_approval("export FOO=1 BAR=2", dialect);
			let s = export_cmd.single.expect("single");
			assert!(s.assign_names.is_empty());
			if dialect == ApprovalDialect::Zsh {
				assert!(!s.strictly_literal);
			}
			assert_eq!(s.argv, ["export", "FOO=1", "BAR=2"]);

			let arr_cmd = analyze_approval("ARR=(a b) git status", dialect);
			let s = arr_cmd.single.expect("single");
			assert!(!s.expansion_free);
			assert!(!s.strictly_literal);
			assert_eq!(s.assign_names, ["ARR"]);

			let sub_cmd = analyze_approval("BASH_CMDS[go]=/tmp/evil go test", dialect);
			let s = sub_cmd.single.expect("single");
			assert!(!s.expansion_free);
			assert!(!s.strictly_literal);
			assert_eq!(s.assign_names.len(), 1);
		}
	}

	#[test]
	fn syntax_errors_and_comments() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let bad = analyze_approval("git status 'unterminated", dialect);
			assert!(!bad.valid);
			assert!(bad.single.is_none());
			assert!(bad.and_chain.is_none());

			let commented = analyze_approval("git status && git diff # trailing", dialect);
			assert!(commented.valid);
			assert!(commented.has_comment);

			let mid_comment = analyze_approval("git status && # mid\ngit diff", dialect);
			assert!(mid_comment.valid);
			assert!(mid_comment.has_comment);

			let hash_arg = analyze_approval("git show foo#1 && git status", dialect);
			assert!(hash_arg.valid);
			assert!(!hash_arg.has_comment);
		}
	}

	#[test]
	fn compound_and_chains_and_non_simple_clauses() {
		let bash_cond = analyze_approval("[[ a && b ]] && git status", ApprovalDialect::Bash);
		let chain = bash_cond.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].simple.is_none());
		assert!(chain[0].syntactically_stateful);
		assert!(chain[1].simple.as_ref().is_some_and(|s| s.strictly_literal));

		let param_and = analyze_approval("echo ${x:-a&&b} && git status", ApprovalDialect::Bash);
		let chain = param_and.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].syntactically_stateful);
		assert!(!chain[0].simple.as_ref().expect("simple").expansion_free);

		let brace_and = analyze_approval("{ true && cd /tmp; } && git status", ApprovalDialect::Bash);
		let chain = brace_and.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].syntactically_stateful);

		let redir_cd = analyze_approval(">/dev/null cd /tmp && git status", ApprovalDialect::Bash);
		let chain = redir_cd.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].simple.is_none());
		assert!(!chain[0].syntactically_stateful);
		assert_eq!(chain[0].stage_commands, [vec!["cd", "/tmp"]]);

		let redir_echo = analyze_approval("echo hi > /tmp/out && git status", ApprovalDialect::Bash);
		let chain = redir_echo.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].simple.is_none());
		assert!(!chain[0].syntactically_stateful);
		assert_eq!(chain[0].stage_commands, [vec!["echo", "hi"]]);
	}

	#[test]
	fn zsh_specific_syntax_and_glob_qualifiers() {
		let escaped_sq = analyze_approval(r"echo 'safe\' && rm -rf /", ApprovalDialect::Zsh);
		assert!(escaped_sq.valid);
		let chain = escaped_sq.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert_eq!(chain[0].simple.as_ref().expect("simple").argv, ["echo", r"safe\"]);
		assert_eq!(chain[1].simple.as_ref().expect("simple").argv, ["rm", "-rf", "/"]);

		let short_repeat =
			analyze_approval("repeat 1 export PATH=/tmp && git status", ApprovalDialect::Zsh);
		assert!(short_repeat.single.is_none());
		assert!(short_repeat.and_chain.is_none());

		let repeat_cmd =
			analyze_approval("repeat 1 do export PATH=/tmp; done && git status", ApprovalDialect::Zsh);
		let chain = repeat_cmd.and_chain.expect("chain");
		assert_eq!(chain.len(), 2);
		assert!(chain[0].simple.is_none());
		assert!(chain[0].syntactically_stateful);

		let glob_qual = analyze_approval("echo *(e:'rm -rf /':)", ApprovalDialect::Zsh);
		assert!(glob_qual.valid);
		let s = glob_qual.single.expect("single");
		assert!(!s.expansion_free);
		assert!(!s.strictly_literal);

		let cover = analyze_approval(
			r#"go test -coverprofile=cov.out -run "Test(A|B)""#,
			ApprovalDialect::Zsh,
		);
		let s = cover.single.expect("single");
		assert!(s.expansion_free);
		assert!(s.strictly_literal);
		assert_eq!(s.argv, ["go", "test", "-coverprofile=cov.out", "-run", "Test(A|B)"]);
	}

	#[test]
	fn restriction_segments_extract_nested_commands() {
		let bash = analyze_approval(
			"echo $(rm -rf /tmp/a) && if true; then (rm -rf /tmp/b); fi | { rm -rf /tmp/c; }",
			ApprovalDialect::Bash,
		);
		assert!(
			bash
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/a")
		);
		assert!(
			bash
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/b")
		);
		assert!(
			bash
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/c")
		);

		let zsh =
			analyze_approval("echo $(rm -rf /tmp/za) && cat <(rm -rf /tmp/zb)", ApprovalDialect::Zsh);
		assert!(
			zsh.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/za")
		);
		assert!(
			zsh.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/zb")
		);

		let env_cmd = analyze_approval("FOO=1 rm -rf /tmp/env", ApprovalDialect::Bash);
		assert!(
			env_cmd
				.restriction_segments
				.iter()
				.any(|s| s == "FOO=1 rm -rf /tmp/env")
		);
		assert!(
			env_cmd
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/env")
		);
	}
	#[test]
	fn restriction_segments_extract_arithmetic_substitutions() {
		let bash = analyze_approval(
			"echo $(( $(rm -rf /tmp/arith1) )) && (( $(rm -rf /tmp/arith2) ))",
			ApprovalDialect::Bash,
		);
		assert!(
			bash
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/arith1")
		);
		assert!(
			bash
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/arith2")
		);
	}

	#[test]
	fn brace_expansion_and_heredoc_and_substr_and_zsh_case() {
		for dialect in [ApprovalDialect::Bash, ApprovalDialect::Zsh] {
			let braced = analyze_approval("git {-c,core.sshCommand=/tmp/evil} fetch", dialect);
			assert!(!braced.single.expect("single").expansion_free);
			let reflog = analyze_approval("git diff HEAD@{1}..HEAD@{0}", dialect);
			assert!(reflog.single.expect("single").expansion_free);
			let cmd_glob = analyze_approval("/bin/s[h] -c 'id'", dialect);
			assert!(!cmd_glob.single.expect("single").expansion_free);
			let opt_glob = analyze_approval("git -[c] alias.x='!id' x", dialect);
			assert_eq!(opt_glob.single.expect("single").glob_word_indices, [1]);
			let quoted_opt_glob = analyze_approval("rg --glob='*.ts' foo src/*.rs", dialect);
			let s = quoted_opt_glob.single.expect("single");
			assert!(s.expansion_free);
			assert_eq!(s.glob_word_indices, [3]);
			let nul_cmd = analyze_approval(r#"rm$'\0'x -rf /tmp/victim"#, dialect);
			assert!(!nul_cmd.single.expect("single").expansion_free);
			assert!(
				nul_cmd
					.restriction_segments
					.iter()
					.any(|seg| seg == "rm -rf /tmp/victim")
			);
			let heredoc_paren =
				analyze_approval("cat <<EOF\n$(echo '('; rm -rf /tmp/hdp)\nEOF", dialect);
			assert!(
				heredoc_paren
					.restriction_segments
					.iter()
					.any(|seg| seg == "rm -rf /tmp/hdp")
			);
			let redir_chain = analyze_approval("true && echo hi > report", dialect);
			assert!(
				redir_chain
					.restriction_segments
					.iter()
					.any(|seg| seg == "echo hi > report")
			);
			let var_fd = analyze_approval("echo hi {PATH}>/dev/null && git status", dialect);
			assert!(var_fd.and_chain.expect("chain")[0].syntactically_stateful);
			let heredoc = analyze_approval("cat <<EOF\n'$(rm -rf /tmp/hd)'\nEOF", dialect);
			assert!(
				heredoc
					.restriction_segments
					.iter()
					.any(|s| s == "rm -rf /tmp/hd")
			);

			let quoted_heredoc = analyze_approval("cat <<'EOF'\n$(rm -rf /tmp/hd)\nEOF", dialect);
			assert!(
				!quoted_heredoc
					.restriction_segments
					.iter()
					.any(|s| s == "rm -rf /tmp/hd")
			);
		}

		let substr = analyze_approval("echo ${x:$(rm -rf /tmp/sub):1}", ApprovalDialect::Bash);
		assert!(
			substr
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/sub")
		);

		let zsh_case =
			analyze_approval("echo $(case a in a) rm -rf /tmp/zcase;; esac)", ApprovalDialect::Zsh);
		assert!(
			zsh_case
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/zcase")
		);

		let zsh_subsh = analyze_approval("echo $((rm -rf /tmp/zsub); true)", ApprovalDialect::Zsh);
		assert!(
			zsh_subsh
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/zsub")
		);
		let zsh_arith = analyze_approval("(( $(rm -rf /tmp/zarith) ))", ApprovalDialect::Zsh);
		assert!(
			zsh_arith
				.restriction_segments
				.iter()
				.any(|s| s == "rm -rf /tmp/zarith")
		);

		let zsh_nofork =
			analyze_approval("echo ${ git push --force origin main; }", ApprovalDialect::Zsh);
		assert!(
			zsh_nofork
				.restriction_segments
				.iter()
				.any(|s| s == "git push --force origin main")
		);
	}
}
