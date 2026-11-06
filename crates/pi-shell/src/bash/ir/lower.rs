//! AST → IR lowering.

use bstr::BString;

use super::{
	AssignOp, AssignVal, CaseIr, Cmd, ComsubForm, CondIr, ElemIr, FuncDefinition, FuncIr, NodeInfo,
	Op, OpIr, Opcode, ParamIr, ParamRef, Part, RedirFdIr, RedirIr, RedirTargetIr, ReplaceIr,
	SpawnIr, SpawnKind, StageIr, SubIr, Unit, Word, WordKind,
};
use crate::bash::{
	event::{NodeKind, RedirKind},
	ids::ModeId,
	syntax as syn,
};

/// The name of a zsh anonymous function (`$0`, `$funcstack`, the
/// diagnostic prefix): zsh's `ANONYMOUS_FUNCTION_NAME`.
pub const ANON: &str = "(anon)";

/// Construct operand encoding of `BrOk`/`BrFail` (see `Construct::from_u32`).
mod construct {
	pub const IF: u32 = 0;
	pub const ELIF: u32 = 1;
	pub const WHILE: u32 = 2;
	pub const UNTIL: u32 = 3;
	pub const AND: u32 = 4;
	pub const OR: u32 = 5;
}

/// Lower one parsed top-level command.
///
/// `src` is the whole script; the unit keeps only the command's bytes, and
/// node spans are re-based to them. Constructs this engine does not run yet
/// come back as `Err(what)`; the caller turns that into an [`abort_unit`].
pub fn lower(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	lower_command(cc, src, mode, features, false)
}

/// Lower a command while retaining parsed function bodies for their first call.
pub(crate) fn lower_deferred(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	lower_command(cc, src, mode, features, true)
}

fn lower_command(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
	deferred: bool,
) -> Result<Unit, &'static str> {
	let bytes = cc.span.slice(src);
	let mut unit = Unit::empty(bytes, mode, features.bits());
	unit.line = cc.line;
	unit.aliases = cc
		.aliases
		.iter()
		.map(|a| (a.name.as_slice().into(), a.value.as_slice().into()))
		.collect();
	if !deferred {
		unit.nodes = vec![
			NodeInfo { kind: NodeKind::Word, lo: 0, hi: 0, line: 0, col: 1 };
			cc.node_count as usize
		];
	}
	let mut l = Lower::new(unit, cc.span.lo, features);
	l.deferred = deferred;
	l.source_replay = cc.source_replay;
	for w in &cc.warnings {
		let idx = l.str(&w.bash_msg);
		l.emit(Opcode::Warn, idx, w.line, w.line);
	}
	l.list(&cc.list)?;
	l.emit(Opcode::End, 0, 0, 0);
	if deferred && cc.source_replay {
		l.unit.seal_source_from(l.source_hash);
	} else {
		l.unit.seal_from(l.source_hash);
	}
	Ok(l.unit)
}

/// Lower a word parsed at run time (`parse_text`: here-document bodies,
/// arithmetic text) into a unit whose last word is the text's word (nested
/// operator words precede it) and whose code holds the word's
/// command-substitution bodies.
pub fn lower_text(
	word: &syn::Word,
	text: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	let mut l = Lower::new(Unit::empty(text, mode, features.bits()), 0, features);
	l.text = true;
	l.emit(Opcode::End, 0, 0, 0);
	l.word(word)?;
	// Substitution bodies are blocks skipped by a jump to the code after
	// them: give that jump a target, or a restored unit fails validation.
	l.emit(Opcode::End, 0, 0, 0);
	l.unit.seal_from(l.source_hash);
	Ok(l.unit)
}

/// Lower the compound value of a declaration argument given as a string
/// (`declare -a d='($a)'`), parsed at run time as the one command
/// `declare __=(…)` in `src`: a unit whose last word is a single
/// [`Part::Compound`] with the elements, and whose code holds their
/// command-substitution bodies. `Err` when `cc` is not exactly that
/// command (the text closed the list early or held an operator).
pub fn lower_compound(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	const NOT_A_LIST: &str = "a compound array value that is not one word list";
	let [item] = cc.list.items.as_slice() else {
		return Err(NOT_A_LIST);
	};
	let and_or = &item.and_or;
	let [stage] = and_or.first.stages.as_slice() else {
		return Err(NOT_A_LIST);
	};
	let (syn::CommandKind::Simple(simple), [], [], None, false) = (
		&stage.cmd.kind,
		and_or.rest.as_slice(),
		stage.cmd.redirs.as_slice(),
		and_or.first.time,
		and_or.first.bang,
	) else {
		return Err(NOT_A_LIST);
	};
	let elems = match (simple.assigns.as_slice(), simple.words.as_slice()) {
		([], [_, arg]) => match arg.parts.as_slice() {
			[syn::WordPart::Lit(_), syn::WordPart::Compound(elems)] => elems,
			_ => return Err(NOT_A_LIST),
		},
		_ => return Err(NOT_A_LIST),
	};
	let mut unit = Unit::empty(cc.span.slice(src), mode, features.bits());
	unit.nodes = vec![
		NodeInfo { kind: NodeKind::Word, lo: 0, hi: 0, line: 0, col: 1 };
		cc.node_count as usize
	];
	let mut l = Lower::new(unit, cc.span.lo, features);
	l.emit(Opcode::End, 0, 0, 0);
	let elems = l.elems(elems)?;
	// Substitution bodies are blocks skipped by a jump to the code after
	// them: give that jump a target.
	l.emit(Opcode::End, 0, 0, 0);
	let parts = vec![Part::Compound(elems)];
	let parks = parts.iter().any(|p| l.part_parks(p));
	l.unit
		.words
		.push(Word { parts, parks, node: 0, kind: WordKind::Plain, ..Word::default() });
	l.unit.seal_from(l.source_hash);
	Ok(l.unit)
}

/// A unit that only prints a diagnostic and abandons the script with
/// `status`; used for syntax errors and unsupported constructs.
///
/// `flags` are `Abort` op flags: with [`Op::SYNTAX`], `msgs[0]` is a syntax
/// error body (and with [`Op::CONTEXT`] `msgs[1]` the offending source line);
/// without it, `msgs[0]` names an unsupported construct.
pub fn abort_unit(
	source: &[u8],
	mode: ModeId,
	features: syn::Features,
	line: u32,
	msgs: Vec<BString>,
	flags: u8,
	status: i32,
) -> Unit {
	let mut unit = Unit::empty(source, mode, features.bits());
	unit.line = line;
	unit.ops = vec![Op { code: Opcode::Abort, flags, ev: 0, a: 0, b: status as u32, node: line }];
	unit.strs = msgs;
	unit.seal();
	unit
}

/// A unit that prints a syntax error the way bash does and abandons the
/// script: the warnings printed before the error, the error's detail line,
/// the message, and the offending source line for token errors.
pub fn syntax_unit(e: &syn::ParseError, src: &[u8], mode: ModeId, feat: syn::Features) -> Unit {
	let mut unit = Unit::empty(b"", mode, feat.bits());
	unit.line = e.line;
	let detail = e.detail();
	for (w, flags) in e
		.warnings
		.iter()
		.map(|w| (w, 0))
		.chain(detail.iter().map(|d| (d, Op::SYNTAX)))
	{
		unit.strs.push(BString::from(w.bash_msg.as_slice()));
		let a = unit.strs.len() as u32 - 1;
		unit
			.ops
			.push(Op { code: Opcode::Warn, flags, ev: 0, a, b: w.line, node: w.line });
	}
	let a = unit.strs.len() as u32;
	unit.strs.push(BString::from(e.bash_msg()));
	let mut flags = Op::SYNTAX;
	if e.echoes_line() {
		let at = (e.span.lo as usize).min(src.len());
		let start = src[..at]
			.iter()
			.rposition(|&c| c == b'\n')
			.map_or(0, |i| i + 1);
		let end = src[at..]
			.iter()
			.position(|&c| c == b'\n')
			.map_or(src.len(), |i| at + i);
		unit.strs.push(BString::from(&src[start..end]));
		flags |= Op::CONTEXT;
	}
	if e.recovered {
		// bash's DISCARD: the messages, `$?` = 1, and on with the next
		// command.
		unit
			.ops
			.push(Op { code: Opcode::Warn, flags, ev: 0, a, b: e.line, node: e.line });
		unit.ops.push(Op {
			code:  Opcode::SetStatus,
			flags: 0,
			ev:    0,
			a:     1,
			b:     0,
			node:  0,
		});
		unit
			.ops
			.push(Op { code: Opcode::End, flags: 0, ev: 0, a: 0, b: 0, node: 0 });
	} else {
		unit
			.ops
			.push(Op { code: Opcode::Abort, flags, ev: 0, a, b: 2, node: e.line });
	}
	unit.seal();
	unit
}

/// The function `src` defines (an imported `BASH_FUNC_name%%` definition),
/// compiled; `None` unless `src` is exactly one function definition (bash
/// `SEVAL_FUNCDEF | SEVAL_ONECMD`: `() { …; }; cmd` is rejected).
pub fn function_from_source(src: &[u8], mode: ModeId, features: syn::Features) -> Option<FuncIr> {
	lone_function(syn::Parser::new(src, features, syn::NO_ALIASES), src, mode, features)
}

/// A function definition with `src`'s first line numbered `line`, retaining
/// its parsed body until first call. An autoloaded file wrapped in a
/// definition on line 0 keeps the file's line numbers.
pub fn function_from_source_at(
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
	line: u32,
) -> Option<FuncIr> {
	let mut parser =
		syn::Parser::new(src, features, syn::NO_ALIASES).with_pos(syn::Pos { offset: 0, line });
	let cc = parser.next_command()?.ok()?;
	if parser.next_command().is_some() {
		return None;
	}
	function_from_parsed(&cc, src, mode, features)
}

/// A validated single-command function definition, retaining its parsed body
/// until first call. Autoload uses the command from its syntax-checking pass.
pub(crate) fn function_from_parsed(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Option<FuncIr> {
	lone_definition(lower_deferred(cc, src, mode, features).ok()?)
}

/// The function `parser` reads from `src` when it is the lone command.
fn lone_function(
	mut parser: syn::Parser<'_>,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Option<FuncIr> {
	let cc = parser.next_command()?.ok()?;
	if parser.next_command().is_some() {
		return None;
	}
	lone_definition(lower(&cc, src, mode, features).ok()?)
}

/// Extract the function when the unit does nothing but define it.
fn lone_definition(mut unit: Unit) -> Option<FuncIr> {
	// A lone definition lowers to `FuncDef`, `End`.
	// zsh's list markers (`Nop`s) aside.
	let mut ops = unit.ops.iter().filter(|op| op.code != Opcode::Nop);
	let lone = matches!((ops.next(), ops.next(), ops.next()), (Some(def), Some(end), None)
		if def.code == Opcode::FuncDef && end.code == Opcode::End);
	if lone && unit.funcs.len() == 1 {
		unit.funcs.pop()
	} else {
		None
	}
}

/// Lower an already-parsed function without changing its persistent identity.
pub(crate) fn materialize(unit: &Unit, observed: bool) -> Option<Unit> {
	let bytes = unit.deferred.as_ref()?;
	if bytes.is_empty() {
		let features = syn::Features::from_bits(unit.features);
		let mut parser = syn::Parser::new(&unit.source, features, syn::NO_ALIASES)
			.with_pos(syn::Pos { offset: 0, line: unit.line });
		let cc = parser.next_command()?.ok()?;
		let compiled = lower(&cc, &unit.source, unit.mode, features).ok()?;
		let mut body = take_body(compiled, unit.root?)?;
		body.id = unit.id;
		if observed && body.trace_syntax.get().is_none() {
			let _ = body.trace_syntax.set(std::sync::Arc::new(
				crate::bash::trace::syntax::UnitSyntax::list(cc).with_context(unit.mode, unit.features),
			));
		}
		return Some(body);
	}
	let (base, cmd): (u32, syn::Command) = postcard::from_bytes(bytes).ok()?;
	let mut body = unit.clone();
	body.deferred = None;
	let features = syn::Features::from_bits(body.features);
	let root = body.root?;
	let mut lower = Lower::new(body, base, features);
	lower.deferred = true;
	lower.command(&cmd).ok()?;
	lower.emit(Opcode::End, 0, 0, root);
	for word in &mut lower.unit.words {
		word.classify();
	}
	if observed && lower.unit.trace_syntax.get().is_none() {
		let syntax = crate::bash::trace::syntax::UnitSyntax::new(
			base,
			crate::bash::trace::syntax::SyntaxTree::Command(std::sync::Arc::new(cmd)),
		)
		.with_context(unit.mode, unit.features)
		.with_aliases(&unit.aliases);
		let _ = lower.unit.trace_syntax.set(std::sync::Arc::new(syntax));
	}
	Some(lower.unit)
}

fn take_body(unit: Unit, root: u32) -> Option<Unit> {
	if unit.root == Some(root) {
		return Some(unit);
	}
	for function in unit.funcs {
		if let Some(body) = take_body(std::sync::Arc::unwrap_or_clone(function.body), root) {
			return Some(body);
		}
	}
	None
}

struct Lower {
	unit:          Unit,
	source_hash:   blake3::Hasher,
	/// Retain function syntax instead of lowering uncalled bodies.
	deferred:      bool,
	/// The defining command can be reconstructed from its source alone.
	source_replay: bool,
	/// Absolute offset of the unit's first byte.
	base:          u32,
	/// Unit-relative offsets of line starts.
	line_starts:   Vec<u32>,
	/// Depth of condition contexts.
	cond:          u32,
	features:      syn::Features,
	/// Lowering run-time parsed text (`lower_text`) outside any command
	/// substitution body: its words are [`WordKind::Text`] (no tilde
	/// expansion).
	text:          bool,
}

type R = Result<(), &'static str>;
type Idx = Result<u32, &'static str>;

impl Lower {
	fn new(unit: Unit, base: u32, features: syn::Features) -> Self {
		let mut line_starts = vec![0u32];
		line_starts.extend(
			unit
				.source
				.iter()
				.enumerate()
				.filter(|&(_, &c)| c == b'\n')
				.map(|(i, _)| i as u32 + 1),
		);
		let source_hash = unit.source_hasher();
		Self {
			unit,
			source_hash,
			deferred: false,
			source_replay: false,
			base,
			line_starts,
			cond: 0,
			features,
			text: false,
		}
	}

	const fn here(&self) -> u32 {
		self.unit.ops.len() as u32
	}

	fn emit(&mut self, code: Opcode, a: u32, b: u32, node: u32) -> u32 {
		let pc = self.here();
		let flags = if self.cond > 0 { Op::COND } else { 0 };
		self
			.unit
			.ops
			.push(Op { code, flags, ev: code.ev_bits(), a, b, node });
		pc
	}

	fn patch_a(&mut self, pc: u32, target: u32) {
		self.unit.ops[pc as usize].a = target;
	}

	fn patch_b(&mut self, pc: u32, target: u32) {
		self.unit.ops[pc as usize].b = target;
	}

	fn str(&mut self, s: &[u8]) -> u32 {
		self.unit.strs.push(BString::from(s));
		self.unit.strs.len() as u32 - 1
	}

	fn node(&mut self, id: syn::NodeId, kind: NodeKind, span: syn::Span) {
		let span = span.rebase(self.base);
		let line = self
			.line_starts
			.partition_point(|&s| s <= span.lo)
			.saturating_sub(1);
		let col = span.lo - self.line_starts[line] + 1;
		if self.unit.nodes.len() <= id.0 as usize {
			self.unit.nodes.resize(id.0 as usize + 1, NodeInfo {
				kind: NodeKind::Word,
				lo:   0,
				hi:   0,
				line: 0,
				col:  1,
			});
		}
		self.unit.nodes[id.0 as usize] =
			NodeInfo { kind, lo: span.lo, hi: span.hi, line: line as u32, col };
	}

	fn list(&mut self, list: &syn::List) -> R {
		// zsh `execlist`: an empty list (`do done`, `{ }`) returns status 0.
		if list.items.is_empty() && self.unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			self.emit(Opcode::SetStatus, 0, 0, 0);
			return Ok(());
		}
		let zsh = self.unit.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		for item in &list.items {
			// zsh `execlist` runs the DEBUG trap before (`DEBUG_BEFORE_CMD`)
			// or after each list: a `Nop` with `b` 1 marks its start (`a` the
			// end marker, where a skipped list goes), one with `b` 2 its end.
			let start = zsh.then(|| self.emit(Opcode::Nop, 0, Op::LIST_START, item.and_or.id.0));
			if matches!(item.sep, syn::Sep::Amp | syn::Sep::Disown) {
				let spawn = self.unit.spawns.len() as u32;
				self.unit.spawns.push(SpawnIr {
					kind:   SpawnKind::Background,
					stages: Vec::new(),
					end:    0,
				});
				let at = self.emit(Opcode::Spawn, spawn, 0, item.and_or.id.0);
				// zsh `&|` / `&!`: disowned at once.
				if item.sep == syn::Sep::Disown {
					self.unit.ops[at as usize].flags |= Op::DISOWN;
				}
				let entry = self.here();
				self.and_or(&item.and_or)?;
				self.emit(Opcode::SubExit, 0, 0, item.and_or.id.0);
				let end = self.here();
				let s = &mut self.unit.spawns[spawn as usize];
				s.stages.push(StageIr { entry, pipe_stderr: false });
				s.end = end;
			} else {
				self.and_or(&item.and_or)?;
			}
			if let Some(start) = start {
				let end = self.emit(Opcode::Nop, 0, Op::LIST_END, item.and_or.id.0);
				self.patch_a(start, end);
			}
		}
		Ok(())
	}

	fn and_or(&mut self, ao: &syn::AndOr) -> R {
		self.node(ao.id, NodeKind::AndOr, ao.span);
		let in_cond = !ao.rest.is_empty();
		if in_cond {
			self.cond += 1;
		}
		self.pipeline(&ao.first)?;
		for (i, (op, p)) in ao.rest.iter().enumerate() {
			let (code, c) = match op {
				syn::AndOrOp::And => (Opcode::BrFail, construct::AND),
				syn::AndOrOp::Or => (Opcode::BrOk, construct::OR),
			};
			let br = self.emit(code, 0, c, p.id.0);
			if i + 1 == ao.rest.len() {
				self.cond -= 1;
			}
			self.pipeline(p)?;
			let end = self.here();
			self.patch_a(br, end);
		}
		Ok(())
	}

	fn pipeline(&mut self, p: &syn::Pipeline) -> R {
		self.node(p.id, NodeKind::Pipeline, p.span);
		if p.time.is_some() {
			self.emit(Opcode::TimeStart, 0, 0, p.id.0);
		}
		if p.bang {
			self.cond += 1;
		}
		if let [stage] = p.stages.as_slice() {
			self.command(&stage.cmd)?;
		} else {
			let spawn = self.unit.spawns.len() as u32;
			self.unit.spawns.push(SpawnIr {
				kind:   SpawnKind::Pipeline,
				stages: Vec::new(),
				end:    0,
			});
			self.emit(Opcode::Spawn, spawn, 0, p.id.0);
			let mut stages = Vec::with_capacity(p.stages.len());
			for stage in &p.stages {
				stages.push(StageIr { entry: self.here(), pipe_stderr: stage.pipe_stderr });
				self.command(&stage.cmd)?;
				self.emit(Opcode::SubExit, 0, 0, stage.cmd.id.0);
			}
			let end = self.here();
			let s = &mut self.unit.spawns[spawn as usize];
			s.stages = stages;
			s.end = end;
		}
		if p.bang {
			self.cond -= 1;
			self.emit(Opcode::Not, 0, 0, p.id.0);
		}
		if let Some(t) = p.time {
			self.emit(Opcode::TimeEnd, 0, u32::from(t.posix), p.id.0);
		}
		Ok(())
	}

	fn cond_list(&mut self, list: &syn::List) -> R {
		self.cond += 1;
		let res = self.list(list);
		self.cond -= 1;
		res
	}

	fn command(&mut self, cmd: &syn::Command) -> R {
		let id = cmd.id.0;
		if let syn::CommandKind::Simple(s) = &cmd.kind {
			self.node(cmd.id, NodeKind::Simple, cmd.span);
			let redirs = if cmd.redirs.is_empty() {
				None
			} else {
				Some(self.redir_list(&cmd.redirs)?)
			};
			let c = self.simple(s, redirs)?;
			self.emit(Opcode::Exec, c, 0, id);
			return Ok(());
		}
		let redir = if cmd.redirs.is_empty() {
			None
		} else {
			let r = self.redir_list(&cmd.redirs)?;
			Some(self.emit(Opcode::Redir, r, 0, id))
		};
		self.compound(cmd)?;
		if let Some(at) = redir {
			self.emit(Opcode::PopRedir, 0, 0, id);
			let after = self.here();
			self.patch_b(at, after);
		}
		Ok(())
	}

	fn compound(&mut self, cmd: &syn::Command) -> R {
		let id = cmd.id.0;
		match &cmd.kind {
			syn::CommandKind::Simple(_) => unreachable!("handled by command()"),
			syn::CommandKind::Brace(body) => {
				self.node(cmd.id, NodeKind::Brace, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				self.list(body)?;
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Subshell(body) => {
				self.node(cmd.id, NodeKind::Subshell, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let spawn = self.unit.spawns.len() as u32;
				self.unit.spawns.push(SpawnIr {
					kind:   SpawnKind::Subshell,
					stages: Vec::new(),
					end:    0,
				});
				self.emit(Opcode::Spawn, spawn, 0, id);
				let entry = self.here();
				self.list(body)?;
				self.emit(Opcode::SubExit, 0, 0, id);
				let end = self.here();
				let s = &mut self.unit.spawns[spawn as usize];
				s.stages.push(StageIr { entry, pipe_stderr: false });
				s.end = end;
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::If(i) => {
				self.node(cmd.id, NodeKind::If, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let mut ends = Vec::new();
				for (k, arm) in i.arms.iter().enumerate() {
					self.cond_list(&arm.cond)?;
					let c = if k == 0 {
						construct::IF
					} else {
						construct::ELIF
					};
					let br = self.emit(Opcode::BrFail, 0, c, id);
					self.list(&arm.body)?;
					ends.push(self.emit(Opcode::Jmp, 0, 0, id));
					let next = self.here();
					self.patch_a(br, next);
				}
				match &i.else_body {
					Some(e) => self.list(e)?,
					None => {
						self.emit(Opcode::SetStatus, 0, 0, id);
					},
				}
				let end = self.here();
				for pc in ends {
					self.patch_a(pc, end);
				}
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::While(w) => {
				let kind = if w.until {
					NodeKind::Until
				} else {
					NodeKind::While
				};
				self.node(cmd.id, kind, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let enter = self.emit(Opcode::LoopEnter, 0, 0, id);
				let cond = self.here();
				self.patch_b(enter, cond);
				self.cond_list(&w.cond)?;
				let (code, c) = if w.until {
					(Opcode::BrOk, construct::UNTIL)
				} else {
					(Opcode::BrFail, construct::WHILE)
				};
				let br = self.emit(code, 0, c, id);
				self.list(&w.body)?;
				self.emit(Opcode::LoopBack, cond, 0, id);
				let exit = self.here();
				self.patch_a(br, exit);
				self.patch_a(enter, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::For(f) | syn::CommandKind::Select(f) => {
				let select = matches!(cmd.kind, syn::CommandKind::Select(_));
				self.node(
					cmd.id,
					if select {
						NodeKind::Select
					} else {
						NodeKind::For
					},
					cmd.span,
				);
				self.emit(Opcode::Enter, 0, 0, id);
				let list = match &f.words {
					Some(words) => self.word_list(words)?,
					None => Op::POSITIONAL,
				};
				let name = self.unit.names.len() as u32;
				// zsh `for a b … in`: the variables in one entry, newline
				// separated (no name holds a newline).
				let mut var = BString::from(f.var.as_slice());
				for extra in &f.extra_vars {
					var.push(b'\n');
					var.extend_from_slice(extra);
				}
				self.unit.names.push(var);
				let at = self.emit(Opcode::ForIn, list, name, id);
				if select {
					self.unit.ops[at as usize].flags |= Op::SELECT;
				}
				if !f.extra_vars.is_empty() {
					self.unit.ops[at as usize].flags |= Op::MULTI;
				}
				let next = self.emit(Opcode::ForNext, 0, 0, id);
				self.list(&f.body)?;
				self.emit(Opcode::LoopBack, next, 0, id);
				let exit = self.here();
				self.patch_a(next, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::ArithFor(f) => {
				self.node(cmd.id, NodeKind::ArithFor, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				// The header's expressions are not commands: a zero value
				// neither runs the ERR trap nor exits under `set -e`.
				self.cond += 1;
				if !f.init.src.trim_ascii().is_empty() {
					let (a, b) = self.arith(&f.init.src);
					self.emit(Opcode::Arith, a, b, id);
				}
				let enter = self.emit(Opcode::LoopEnter, 0, 0, id);
				let cond = self.here();
				if f.cond.src.trim_ascii().is_empty() {
					self.emit(Opcode::SetStatus, 0, 0, id);
				} else {
					let (a, b) = self.arith(&f.cond.src);
					self.emit(Opcode::Arith, a, b, id);
				}
				let br = self.emit(Opcode::BrFail, 0, construct::WHILE, id);
				self.cond -= 1;
				self.list(&f.body)?;
				let step = self.emit(Opcode::LoopNote, 0, 0, id);
				self.patch_b(enter, step);
				if !f.step.src.trim_ascii().is_empty() {
					let (a, b) = self.arith(&f.step.src);
					self.cond += 1;
					self.emit(Opcode::Arith, a, b, id);
					self.cond -= 1;
				}
				self.emit(Opcode::Jmp, cond, 0, id);
				let exit = self.here();
				self.patch_a(br, exit);
				self.patch_a(enter, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Case(c) => {
				self.node(cmd.id, NodeKind::Case, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let subject = self.word(&c.word)?;
				self.emit(Opcode::CaseWord, subject, 0, id);
				// Per arm: the test, then the body; terminators jump to the
				// end (`;;`), into the next body (`;&`) or to the next test
				// (`;;&`).
				let mut tests = Vec::with_capacity(c.arms.len());
				let mut bodies = Vec::with_capacity(c.arms.len());
				let mut jumps: Vec<(u32, syn::CaseTerm, usize)> = Vec::new();
				for (k, arm) in c.arms.iter().enumerate() {
					let pats = arm
						.patterns
						.iter()
						.map(|p| self.word(p))
						.collect::<Result<Vec<_>, _>>()?;
					let pi = self.unit.pats.len() as u32;
					self.unit.pats.push(pats);
					tests.push(self.emit(Opcode::CaseArm, pi, 0, id));
					bodies.push(self.here());
					self.list(&arm.body)?;
					jumps.push((self.emit(Opcode::Jmp, 0, 0, id), arm.term, k));
				}
				let end = self.here();
				for (k, &t) in tests.iter().enumerate() {
					let next = tests.get(k + 1).copied().unwrap_or(end);
					self.patch_b(t, next);
				}
				for (pc, term, k) in jumps {
					let target = match term {
						syn::CaseTerm::Break => end,
						syn::CaseTerm::FallThrough => bodies.get(k + 1).copied().unwrap_or(end),
						syn::CaseTerm::Continue => tests.get(k + 1).copied().unwrap_or(end),
					};
					self.patch_a(pc, target);
				}
				self.emit(Opcode::CaseEnd, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Arith(a) => {
				self.node(cmd.id, NodeKind::Arith, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let (i, b) = self.arith(&a.src);
				self.emit(Opcode::Arith, i, b, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Cond(e) => {
				self.node(cmd.id, NodeKind::Cond, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				self.cond_expr(e, id)?;
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Repeat(r) => {
				// zsh `execrepeat`: the count once, then a counted loop.
				self.node(cmd.id, NodeKind::While, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let count = self.word(&r.count)?;
				self.emit(Opcode::Repeat, count, 0, id);
				let next = self.emit(Opcode::ForNext, 0, 0, id);
				self.list(&r.body)?;
				self.emit(Opcode::LoopBack, next, 0, id);
				let exit = self.here();
				self.patch_a(next, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::Try(t) => {
				// zsh `exectry`: the try-list, then the always-list however
				// the try-list ended.
				self.node(cmd.id, NodeKind::Brace, cmd.span);
				self.emit(Opcode::Enter, 0, 0, id);
				let enter = self.emit(Opcode::TryEnter, 0, 0, id);
				self.list(&t.body)?;
				let always = self.emit(Opcode::AlwaysEnter, 0, 0, id);
				self.list(&t.always)?;
				self.emit(Opcode::AlwaysEnd, 0, 0, id);
				let end = self.here();
				self.patch_a(enter, always);
				self.patch_b(enter, end);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			syn::CommandKind::AnonFunc(a) => {
				self.node(cmd.id, NodeKind::FuncDef, cmd.span);
				let body = self.func_body(cmd.id.0, &a.body)?;
				self.unit.funcs.push(FuncIr {
					name:       BString::from(ANON),
					definition: None,
					body:       std::sync::Arc::new(body),
				});
				let func = self.unit.funcs.len() as u32 - 1;
				let args = self.word_list(&a.args)?;
				let at = self.emit(Opcode::CallAnon, func, args, id);
				if a.traced {
					self.unit.ops[at as usize].flags |= Op::TRACED;
				}
			},
			syn::CommandKind::FuncDef(f) => {
				self.node(cmd.id, NodeKind::FuncDef, cmd.span);
				let func = self.funcdef(cmd, f)?;
				let traced = if f.traced { Op::TRACED } else { 0 };
				// zsh `execfuncdef`: names with expansions (`function f$$`)
				// are expanded when the definition runs; `b` is their word
				// list plus one, and that one op defines every name.
				if let Some(words) = zsh_funcdef_words(cmd, f, self.unit.mode) {
					let list = self.word_list(&words)?;
					let pc = self.emit(Opcode::FuncDef, func, list + 1, id);
					self.unit.ops[pc as usize].flags |= traced;
					return Ok(());
				}
				let pc = self.emit(Opcode::FuncDef, func, 0, id);
				self.unit.ops[pc as usize].flags |= traced;
				// zsh `f g () { … }`: every name gets the body.
				for name in &f.extra_names {
					let mut more = self.unit.funcs[func as usize].clone();
					more.name = func_name(name, self.unit.mode);
					self.unit.funcs.push(more);
					let at = self.unit.funcs.len() as u32 - 1;
					let pc = self.emit(Opcode::FuncDef, at, 0, id);
					self.unit.ops[pc as usize].flags |= traced;
				}
			},
			syn::CommandKind::Coproc(c) => {
				self.node(cmd.id, NodeKind::Coproc, cmd.span);
				let name = self.unit.names.len() as u32;
				self
					.unit
					.names
					.push(c.name.as_deref().unwrap_or(&b"COPROC"[..]).into());
				let spawn = self.unit.spawns.len() as u32;
				self.unit.spawns.push(SpawnIr {
					kind:   SpawnKind::Coproc { name },
					stages: Vec::new(),
					end:    0,
				});
				self.emit(Opcode::Spawn, spawn, 0, id);
				let entry = self.here();
				self.command(&c.body)?;
				self.emit(Opcode::SubExit, 0, 0, id);
				let end = self.here();
				let s = &mut self.unit.spawns[spawn as usize];
				s.stages.push(StageIr { entry, pipe_stderr: false });
				s.end = end;
			},
		}
		Ok(())
	}

	/// Compile a function body (a compound command) defined by the command
	/// with node `root`: a unit sharing this unit's source and node ids.
	fn func_body(&mut self, root: u32, cmd: &syn::Command) -> Result<Unit, &'static str> {
		let mut body = Unit::empty(&self.unit.source, self.unit.mode, self.unit.features);
		body.aliases.clone_from(&self.unit.aliases);
		body.nodes.clone_from(&self.unit.nodes);
		body.root = Some(root);
		body.line = self.unit.line;
		if self.deferred {
			body.deferred = Some(if self.source_replay {
				BString::default()
			} else {
				postcard::to_stdvec(&(self.base, cmd))
					.expect("parsed function body serializes")
					.into()
			});
			body.seal_from(self.source_hash.clone());
			return Ok(body);
		}
		let mut sub = Self {
			unit:          body,
			source_hash:   self.source_hash.clone(),
			deferred:      false,
			source_replay: false,
			base:          self.base,
			line_starts:   self.line_starts.clone(),
			cond:          0,
			features:      self.features,
			text:          false,
		};
		sub.command(cmd)?;
		sub.emit(Opcode::End, 0, 0, root);
		let mut body = sub.unit;
		// Node records filled while lowering the body belong to both units.
		for (i, n) in body.nodes.iter().enumerate() {
			if n.hi > 0 {
				self.unit.nodes[i] = *n;
			}
		}
		body.seal_from(self.source_hash.clone());
		Ok(body)
	}

	fn funcdef(&mut self, cmd: &syn::Command, f: &syn::FuncDef) -> Idx {
		let body = self.func_body(cmd.id.0, &f.body)?;
		let definition = if self.source_replay
			&& !cmd
				.redirs
				.iter()
				.chain(&f.body.redirs)
				.any(|r| matches!(r.target, syn::RedirTarget::HereDoc(_)))
		{
			FuncDefinition::Source(cmd.span.rebase(self.base))
		} else {
			FuncDefinition::Parsed(
				postcard::to_stdvec(cmd)
					.expect("validated function definition serializes")
					.into(),
			)
		};
		self.unit.funcs.push(FuncIr {
			name:       func_name(&f.name, self.unit.mode),
			definition: Some(definition),
			body:       std::sync::Arc::new(body),
		});
		Ok(self.unit.funcs.len() as u32 - 1)
	}

	fn cond_expr(&mut self, e: &syn::CondExpr, id: u32) -> R {
		match e {
			syn::CondExpr::Unary { op, arg } => {
				let arg = self.word(arg)?;
				let c = self.cond_ir(CondIr::Unary { op: op.as_slice().into(), arg });
				self.emit(Opcode::CondTest, c, 0, id);
			},
			syn::CondExpr::Binary { op, lhs, rhs } => {
				let lhs = self.word(lhs)?;
				let rhs = self.word(rhs)?;
				let c = self.cond_ir(CondIr::Binary { op: op.as_slice().into(), lhs, rhs });
				self.emit(Opcode::CondTest, c, 0, id);
			},
			syn::CondExpr::Word(w) => {
				let w = self.word(w)?;
				let c = self.cond_ir(CondIr::Word(w));
				self.emit(Opcode::CondTest, c, 0, id);
			},
			syn::CondExpr::Not(inner) => {
				// A run of `!`s, lowered at once: bash's trace shows one `!`
				// on a primary under an odd number of them.
				let mut nots = 1;
				let mut leaf = inner.as_ref();
				while let syn::CondExpr::Not(i) = leaf {
					nots += 1;
					leaf = i;
				}
				let primary = matches!(
					leaf,
					syn::CondExpr::Unary { .. } | syn::CondExpr::Binary { .. } | syn::CondExpr::Word(_)
				);
				let at = self.here();
				self.cond += 1;
				self.cond_expr(leaf, id)?;
				// The inner `!`s are conditions of the outer one.
				for _ in 1..nots {
					self.emit(Opcode::Not, 0, 0, id);
				}
				self.cond -= 1;
				if primary && nots % 2 == 1 {
					self.unit.ops[at as usize].flags |= Op::NEGATED;
				}
				self.emit(Opcode::Not, 0, 0, id);
			},
			syn::CondExpr::And(a, b) | syn::CondExpr::Or(a, b) => {
				let (code, c) = if matches!(e, syn::CondExpr::And(..)) {
					(Opcode::BrFail, construct::AND)
				} else {
					(Opcode::BrOk, construct::OR)
				};
				self.cond += 1;
				self.cond_expr(a, id)?;
				self.cond -= 1;
				let br = self.emit(code, 0, c, id);
				self.cond_expr(b, id)?;
				let end = self.here();
				self.patch_a(br, end);
			},
			syn::CondExpr::Group(inner) => self.cond_expr(inner, id)?,
		}
		Ok(())
	}

	fn cond_ir(&mut self, c: CondIr) -> u32 {
		self.unit.conds.push(c);
		self.unit.conds.len() as u32 - 1
	}

	/// The `ariths` index of `text` and the `Arith` operand `b` it takes.
	fn arith(&mut self, text: &[u8]) -> (u32, u32) {
		let literal = !text
			.iter()
			.any(|c| matches!(c, b'$' | b'`' | b'\\' | b'"' | b'\''));
		self.unit.ariths.push(BString::from(text));
		(self.unit.ariths.len() as u32 - 1, if literal { Op::LITERAL } else { 0 })
	}

	fn simple(&mut self, s: &syn::Simple, redirs: Option<u32>) -> Idx {
		let mut assigns = Vec::with_capacity(s.assigns.len());
		for a in &s.assigns {
			self.node(a.id, NodeKind::Assign, a.span);
			let index = a.index.as_ref().map(|i| self.word(i)).transpose()?;
			let value = match &a.value {
				syn::AssignValue::Scalar(w) => AssignVal::Scalar(self.word_as(w, WordKind::Assign)?),
				syn::AssignValue::Array(elems) => AssignVal::Array(self.elems(elems)?),
			};
			assigns.push(AssignOp {
				name: a.name.as_slice().into(),
				index,
				append: a.append,
				value,
				node: a.id.0,
			});
		}
		let words = self.command_words(&s.words)?;
		let idx = self.unit.cmds.len() as u32;
		self
			.unit
			.cmds
			.push(Cmd { assigns, words, redirs, typeset: s.typeset });
		Ok(idx)
	}

	fn elems(&mut self, elems: &[syn::ArrayElem]) -> Result<Vec<ElemIr>, &'static str> {
		elems
			.iter()
			.map(|e| {
				let key = e.key.as_ref().map(|k| self.word(k)).transpose()?;
				// bash expands a keyed value like an assignment (tilde-prefixes
				// after `:` too: `[0]=~/a:~/b`); an unkeyed one like a word.
				let kind = if key.is_some() {
					WordKind::Assign
				} else {
					WordKind::Plain
				};
				Ok(ElemIr { key, append: e.append, value: self.word_as(&e.value, kind)? })
			})
			.collect()
	}

	fn redir_list(&mut self, redirs: &[syn::Redir]) -> Idx {
		let mut out = Vec::with_capacity(redirs.len());
		for r in redirs {
			let fd = match &r.fd {
				None => RedirFdIr::Default,
				Some(syn::RedirFd::Num(n)) => RedirFdIr::Num(*n),
				Some(syn::RedirFd::Var(v)) => RedirFdIr::Var(v.as_slice().into()),
			};
			let (op, clobber) = match r.op {
				syn::RedirOp::In => (RedirKind::In, false),
				syn::RedirOp::Out => (RedirKind::Out, false),
				syn::RedirOp::Append => (RedirKind::Append, false),
				syn::RedirOp::Clobber => (RedirKind::Clobber, true),
				syn::RedirOp::ReadWrite => (RedirKind::ReadWrite, false),
				syn::RedirOp::DupIn => (RedirKind::DupIn, false),
				syn::RedirOp::DupOut => (RedirKind::DupOut, false),
				syn::RedirOp::OutErr => (RedirKind::OutErr, false),
				syn::RedirOp::AppendErr => (RedirKind::AppendErr, false),
				syn::RedirOp::HereDoc { .. } => (RedirKind::HereDoc, false),
				syn::RedirOp::HereString => (RedirKind::HereString, false),
				syn::RedirOp::AppendClobber => (RedirKind::Append, true),
				syn::RedirOp::OutErrClobber => (RedirKind::OutErr, true),
				syn::RedirOp::AppendErrClobber => (RedirKind::AppendErr, true),
			};
			let target = match &r.target {
				syn::RedirTarget::Word(w) => RedirTargetIr::Word(self.word(w)?),
				syn::RedirTarget::HereDoc(d) => {
					RedirTargetIr::HereDoc { text: d.text.as_slice().into(), quoted: d.quoted }
				},
			};
			out.push(RedirIr { fd, op, target, clobber });
		}
		self.unit.redirs.push(out);
		Ok(self.unit.redirs.len() as u32 - 1)
	}

	fn word_list(&mut self, words: &[syn::Word]) -> Idx {
		let mut list = Vec::with_capacity(words.len());
		for w in words {
			list.push(self.word(w)?);
		}
		let idx = self.unit.lists.len() as u32;
		self.unit.lists.push(list);
		Ok(idx)
	}

	/// The words of a simple command: arguments written as assignments are
	/// [`WordKind::AssignArg`], or [`WordKind::DeclArg`] when the command
	/// name is a literal declaration builtin (bash's `fix_assignment_words`;
	/// for zsh the reserved words its lexer reads as `TYPESET`, whose
	/// `name=…` and `name=(…)` arguments are assignments).
	fn command_words(&mut self, words: &[syn::Word]) -> Idx {
		let decl = words.first().is_some_and(|w| match &w.parts[..] {
			[syn::WordPart::Lit(n)] => {
				matches!(n.as_slice(), b"declare" | b"typeset" | b"export" | b"readonly" | b"local")
			},
			// `private`: the reserved word zsh/param/private adds.
			[syn::WordPart::Zsh(n)] => matches!(
				n.as_slice(),
				b"declare"
					| b"export"
					| b"float"
					| b"integer"
					| b"local"
					| b"private"
					| b"readonly"
					| b"typeset"
			),
			_ => false,
		});
		let mut list = Vec::with_capacity(words.len());
		for w in words {
			let kind = match &w.parts[..] {
				[syn::WordPart::Zsh(_), syn::WordPart::Compound(_)] if decl => WordKind::DeclArg,
				[syn::WordPart::Zsh(t)] if decl && zsh_envstring(t) => WordKind::DeclArg,
				parts => match (assignment_like(parts), decl) {
					(false, _) => WordKind::Plain,
					(true, false) => WordKind::AssignArg,
					(true, true) => WordKind::DeclArg,
				},
			};
			list.push(self.word_as(w, kind)?);
		}
		let idx = self.unit.lists.len() as u32;
		self.unit.lists.push(list);
		Ok(idx)
	}

	fn word(&mut self, w: &syn::Word) -> Idx {
		self.word_as(w, WordKind::Plain)
	}

	/// Lower `w` (and its brace-expansion alternatives) as a `kind` word.
	fn word_as(&mut self, w: &syn::Word, kind: WordKind) -> Idx {
		let idx = self.plain_word(w, kind)?;
		// Run-time parsed text (here-document bodies, arithmetic) gets no
		// brace expansion; its unit's last word must stay the text itself.
		if !self.text
			&& let Some(alts) = super::brace::expand(&w.parts)
		{
			let mut indices = Vec::with_capacity(alts.len());
			for parts in alts {
				let alt = syn::Word { id: w.id, span: w.span, parts };
				indices.push(self.plain_word(&alt, kind)?);
			}
			let parks = indices.iter().any(|&i| self.unit.words[i as usize].parks);
			let word = &mut self.unit.words[idx as usize];
			word.parks |= parks;
			word.braces = Some(indices.into_boxed_slice());
		}
		Ok(idx)
	}

	/// Lower a word without brace expansion.
	fn plain_word(&mut self, w: &syn::Word, kind: WordKind) -> Idx {
		let kind = if self.text { WordKind::Text } else { kind };
		self.node(w.id, NodeKind::Word, w.span);
		let mut parts = Vec::with_capacity(w.parts.len());
		for part in &w.parts {
			self.part(part, false, &mut parts)?;
		}
		let parks = parts.iter().any(|p| self.part_parks(p));
		let idx = self.unit.words.len() as u32;
		self
			.unit
			.words
			.push(Word { parts, parks, node: w.id.0, kind, ..Word::default() });
		Ok(idx)
	}

	fn part_parks(&self, p: &Part) -> bool {
		let word = |w: u32| self.unit.words[w as usize].parks;
		match p {
			Part::Lit(_)
			| Part::Quoted(_)
			| Part::AnsiC(_)
			| Part::BadSubst(_)
			| Part::ComsubSyntax { .. } => false,
			Part::Comsub { .. } | Part::ProcSub { .. } => true,
			// zsh words are parsed when they expand: any may substitute.
			Part::Zsh(text) => crate::bash::syntax::zsh::tok::has_token(text),
			Part::Arith { text, .. } => text.contains(&b'$') || text.contains(&b'`'),
			Part::Compound(elems) => elems
				.iter()
				.any(|e| e.key.is_some_and(word) || word(e.value)),
			Part::Param(p) => {
				let sub = matches!(p.index, Some(SubIr::Expr(w)) if word(w));
				let op = match &p.op {
					OpIr::Default { word: w, .. }
					| OpIr::Assign { word: w, .. }
					| OpIr::Alt { word: w, .. } => word(*w),
					OpIr::Error { word: w, .. } => w.is_some_and(word),
					OpIr::Substr { offset, len } => {
						let runs = |t: &BString| t.contains(&b'$') || t.contains(&b'`');
						runs(offset) || len.as_ref().is_some_and(runs)
					},
					OpIr::Trim { pat, .. } => word(*pat),
					OpIr::Replace { pat, rep, .. } => word(*pat) || rep.is_some_and(word),
					OpIr::Case { pat, .. } => pat.is_some_and(word),
					OpIr::None
					| OpIr::Length
					| OpIr::Indirect
					| OpIr::PrefixNames { .. }
					| OpIr::Transform(_) => false,
				};
				// `$!` waits while its job decides on its pid (`Stop::Wait`).
				let bang = p.param == ParamRef::LastBg;
				sub || op || bang
			},
		}
	}

	/// `$(< file)`: flag the body's lone `Exec` ([`Op::CAT`]) when it has
	/// no words, no assignments and one `<` on fd 0.
	fn mark_cat(&mut self, entry: u32) {
		let ops = &self.unit.ops;
		let (Some(op), Some(next)) = (ops.get(entry as usize), ops.get(entry as usize + 1)) else {
			return;
		};
		if op.code != Opcode::Exec || next.code != Opcode::SubExit {
			return;
		}
		let cmd = &self.unit.cmds[op.a as usize];
		let lone_input = cmd
			.redirs
			.and_then(|l| self.unit.redirs.get(l as usize))
			.is_some_and(
				|rs| matches!(rs.as_slice(), [r] if r.op == RedirKind::In && r.fd == RedirFdIr::Default),
			);
		let empty = self
			.unit
			.lists
			.get(cmd.words as usize)
			.is_none_or(Vec::is_empty);
		if lone_input && empty && cmd.assigns.is_empty() {
			self.unit.ops[entry as usize].flags |= Op::CAT;
		}
	}

	/// A command-substitution or process-substitution body: a block the
	/// main flow jumps over, ending in `SubExit`.
	fn block(&mut self, body: &syn::List) -> Idx {
		let skip = self.emit(Opcode::Jmp, 0, 0, 0);
		let entry = self.here();
		let saved = std::mem::take(&mut self.cond);
		let text = std::mem::take(&mut self.text);
		self.list(body)?;
		self.text = text;
		self.cond = saved;
		self.emit(Opcode::SubExit, 0, 0, 0);
		let after = self.here();
		self.patch_a(skip, after);
		Ok(entry)
	}

	fn part(&mut self, part: &syn::WordPart, quoted: bool, out: &mut Vec<Part>) -> R {
		match part {
			syn::WordPart::Lit(b) if quoted => out.push(Part::Quoted(b.as_slice().into())),
			syn::WordPart::Lit(b) => out.push(Part::Lit(b.as_slice().into())),
			syn::WordPart::Escaped(b) | syn::WordPart::SQuote(b) => {
				out.push(Part::Quoted(b.as_slice().into()));
			},
			// `\u`/`\U` depend on the locale in effect when the word expands.
			syn::WordPart::AnsiC(raw) if raw.windows(2).any(|w| matches!(w, b"\\u" | b"\\U")) => {
				out.push(Part::AnsiC(raw.as_slice().into()));
			},
			syn::WordPart::AnsiC(raw) => out.push(Part::Quoted(ansi_c(raw))),
			syn::WordPart::DQuote(inner) | syn::WordPart::Locale(inner) => {
				// A double-quoted group is a (possibly empty) field. The
				// expander treats an empty quoted expansion as no field, so a
				// group that may expand to nothing ends with an explicit
				// quoted null — unless it holds a `"$@"`-style list: bash
				// drops such a group when the list is empty and the rest is
				// empty too (`"$xxx$@"` is no word, `"$xxx""$@"` one).
				let start = out.len();
				for p in inner {
					self.part(p, true, out)?;
				}
				let group = &out[start..];
				let literal = group
					.iter()
					.all(|p| matches!(p, Part::Lit(b) | Part::Quoted(b) if !b.is_empty()));
				// `"${@+w}"` not taken is the (empty) list itself.
				let at = group.iter().any(|p| {
					matches!(p, Part::Param(p) if p.is_at_list()
						|| (matches!(p.op, OpIr::Alt { .. })
							&& matches!((&p.param, &p.index), (ParamRef::At, None) | (_, Some(SubIr::At)))))
				});
				if group.is_empty() || (!literal && !at) {
					out.push(Part::Quoted(BString::default()));
				}
			},
			syn::WordPart::Param(p) => out.push(Part::Param(Box::new(self.param(p, quoted)?))),
			syn::WordPart::Comsub(c) => {
				let entry = self.block(&c.body)?;
				let kind = match c.kind {
					syn::ComsubKind::Dollar | syn::ComsubKind::Backtick => ComsubForm::Fork,
					syn::ComsubKind::NoFork => ComsubForm::NoFork,
					syn::ComsubKind::ValueSub => ComsubForm::Value,
				};
				// `$( )`, `${ ;}` and `${| ;}` are re-parsed from their text when
				// they run.
				let text = (c.kind != syn::ComsubKind::Backtick).then(|| self.str(&c.text));
				if kind == ComsubForm::Fork {
					self.mark_cat(entry);
				}
				out.push(Part::Comsub { entry, kind, quoted, text });
			},
			syn::WordPart::Arith(a) => out.push(Part::Arith { text: a.src.as_slice().into(), quoted }),
			syn::WordPart::ProcSub(p) => {
				let entry = self.block(&p.body)?;
				out.push(Part::ProcSub { entry, output: p.output });
			},
			syn::WordPart::Compound(elems) => out.push(Part::Compound(self.elems(elems)?)),
			syn::WordPart::BadSubst(text) => out.push(Part::BadSubst(text.as_slice().into())),
			syn::WordPart::DroppedQuote => {},
			syn::WordPart::BadComsub(b) => {
				out.push(Part::ComsubSyntax { line: b.line, msg: b.msg.as_slice().into() });
			},
			syn::WordPart::Zsh(text) => out.push(Part::Zsh(text.as_slice().into())),
		}
		Ok(())
	}

	fn param(&mut self, p: &syn::Param, quoted: bool) -> Result<ParamIr, &'static str> {
		let param = match &p.name {
			syn::ParamName::Var(n) => ParamRef::Var(n.as_slice().into()),
			syn::ParamName::Positional(n) => ParamRef::Positional(*n),
			syn::ParamName::Special(s) => match s {
				syn::Special::At => ParamRef::At,
				syn::Special::Star => ParamRef::Star,
				syn::Special::Count => ParamRef::Count,
				syn::Special::Status => ParamRef::Status,
				syn::Special::Flags => ParamRef::Flags,
				syn::Special::ShellPid => ParamRef::ShellPid,
				syn::Special::LastBg => ParamRef::LastBg,
			},
		};
		let index = match &p.index {
			None => None,
			Some(syn::Subscript::At) => Some(SubIr::At),
			Some(syn::Subscript::Star) => Some(SubIr::Star),
			Some(syn::Subscript::Expr(w)) => Some(SubIr::Expr(self.word(w)?)),
		};
		let op = match &p.op {
			syn::ParamOp::None => OpIr::None,
			syn::ParamOp::Length => OpIr::Length,
			syn::ParamOp::Indirect => OpIr::Indirect,
			syn::ParamOp::PrefixNames { star } => OpIr::PrefixNames { star: *star },
			syn::ParamOp::Default { colon, word } => {
				OpIr::Default { colon: *colon, word: self.word(word)? }
			},
			syn::ParamOp::Assign { colon, word } => {
				OpIr::Assign { colon: *colon, word: self.word(word)? }
			},
			syn::ParamOp::Error { colon, word } => {
				OpIr::Error { colon: *colon, word: word.as_ref().map(|w| self.word(w)).transpose()? }
			},
			syn::ParamOp::Alt { colon, word } => OpIr::Alt { colon: *colon, word: self.word(word)? },
			syn::ParamOp::Substr { offset, len } => OpIr::Substr {
				offset: offset.src.as_slice().into(),
				len:    len.as_ref().map(|l| l.src.as_slice().into()),
			},
			syn::ParamOp::Trim { suffix, longest, pat } => {
				OpIr::Trim { suffix: *suffix, longest: *longest, pat: self.word(pat)? }
			},
			syn::ParamOp::Replace { mode, pat, rep } => OpIr::Replace {
				mode: match mode {
					syn::ReplaceMode::First => ReplaceIr::First,
					syn::ReplaceMode::All => ReplaceIr::All,
					syn::ReplaceMode::Prefix => ReplaceIr::Prefix,
					syn::ReplaceMode::Suffix => ReplaceIr::Suffix,
				},
				pat:  self.word(pat)?,
				rep:  rep.as_ref().map(|r| self.word(r)).transpose()?,
			},
			syn::ParamOp::Case { mode, all, pat } => OpIr::Case {
				mode: match mode {
					syn::CaseMode::Upper => CaseIr::Upper,
					syn::CaseMode::Lower => CaseIr::Lower,
					syn::CaseMode::Toggle => CaseIr::Toggle,
				},
				all:  *all,
				pat:  pat.as_ref().map(|w| self.word(w)).transpose()?,
			},
			syn::ParamOp::Transform(c) => OpIr::Transform(*c),
		};
		Ok(ParamIr { param, index, op, indirect: p.indirect, quoted, braced: p.braced })
	}
}

/// The name a definition gives function `name` as written: zsh substitutes
/// the names (`execfuncdef`), so `function 'a b' () …` defines `a b`; the
/// quoting is removed here (`$'…'` decoded, NULs kept), a name with an
/// expansion (`$`, `` ` ``) stays as written. bash takes the word as
/// written.
fn func_name(name: &[u8], mode: ModeId) -> BString {
	if mode.dialect() != crate::bash::ids::Dialect::Zsh
		|| !name.iter().any(|c| matches!(c, b'\'' | b'"' | b'\\'))
	{
		return BString::from(name);
	}
	let mut out = Vec::with_capacity(name.len());
	let mut i = 0;
	while let Some(&c) = name.get(i) {
		i += 1;
		match c {
			b'\'' => {
				let rest = name.get(i..).unwrap_or_default();
				let len = rest.iter().position(|&c| c == b'\'').unwrap_or(rest.len());
				out.extend_from_slice(rest.get(..len).unwrap_or_default());
				i += len + 1;
			},
			b'"' => {
				while let Some(&d) = name.get(i) {
					i += 1;
					match d {
						b'"' => break,
						b'$' | b'`' => return BString::from(name),
						b'\\' if let Some(&e @ (b'$' | b'`' | b'"' | b'\\')) = name.get(i) => {
							out.push(e);
							i += 1;
						},
						_ => out.push(d),
					}
				}
			},
			b'\\' => {
				if let Some(&d) = name.get(i) {
					out.push(d);
					i += 1;
				}
			},
			b'$' if name.get(i) == Some(&b'\'') => {
				let start = i + 1;
				let mut end = start;
				while let Some(&d) = name.get(end) {
					match d {
						b'\'' => break,
						b'\\' => end += 2,
						_ => end += 1,
					}
				}
				let end = end.min(name.len());
				out.extend_from_slice(&syn::ansi_decode_all(&name[start..end]));
				i = end + 1;
			},
			b'$' | b'`' => return BString::from(name),
			_ => out.push(c),
		}
	}
	BString::from(out)
}

/// The names of zsh definition `f` as words to expand when it runs, when
/// one of them has an expansion or a pattern (zsh `execfuncdef`'s `htok`
/// beyond quoting); `None` keeps the names as written.
fn zsh_funcdef_words(cmd: &syn::Command, f: &syn::FuncDef, mode: ModeId) -> Option<Vec<syn::Word>> {
	use syn::zsh::tok;
	if mode.dialect() != crate::bash::ids::Dialect::Zsh {
		return None;
	}
	let toks = std::iter::once(&f.name)
		.chain(&f.extra_names)
		.map(|n| syn::zsh::parse_subst_string(&tok::metafy(n)).ok())
		.collect::<Option<Vec<_>>>()?;
	let expands = |t: &Vec<u8>| {
		t.iter().any(|&c| {
			matches!(
				c,
				tok::POUND
					| tok::STRING
					| tok::HAT
					| tok::STAR
					| tok::INPAR
					| tok::QSTRING
					| tok::EQUALS
					| tok::BAR
					| tok::INBRACE
					| tok::INBRACK
					| tok::TICK
					| tok::INANG
					| tok::QUEST
					| tok::TILDE
					| tok::QTICK
			)
		})
	};
	if !toks.iter().any(expands) {
		return None;
	}
	Some(
		toks
			.into_iter()
			.map(|t| syn::Word {
				id:    syn::NodeId(0),
				span:  cmd.span,
				parts: vec![syn::WordPart::Zsh(t)],
			})
			.collect(),
	)
}

/// Materialize validated function input for a record's first text reader.
pub(super) fn definition_text(name: &[u8], definition: &FuncDefinition, body: &Unit) -> BString {
	let command = match definition {
		FuncDefinition::Parsed(bytes) => {
			postcard::from_bytes(bytes).expect("validated function definition decodes")
		},
		FuncDefinition::Source(span) => {
			let source = span.slice(&body.source);
			let features = syn::Features::from_bits(body.features);
			let command = syn::Parser::new(source, features, syn::NO_ALIASES)
				.next_command()
				.expect("validated function source contains a command")
				.expect("validated function source replays");
			let mut items = command.list.items.into_iter();
			let item = items.next().expect("validated function definition");
			let mut stages = item.and_or.first.stages.into_iter();
			stages.next().expect("validated function stage").cmd
		},
	};
	func_source(&command, name, body.mode)
}

/// The canonical text of function `name` defined by `cmd`: zsh's function
/// text (`functions name`, zsh `text.c`) for zsh code, else `declare -f`'s;
/// a zsh definition of several names (`f g () { … }`) prints each name
/// alone.
fn func_source(cmd: &syn::Command, name: &[u8], mode: ModeId) -> BString {
	if mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let syn::CommandKind::FuncDef(f) = &cmd.kind
	{
		return BString::from(syn::zsh::function_text(name, f));
	}
	match &cmd.kind {
		syn::CommandKind::FuncDef(f) if !f.extra_names.is_empty() => {
			let mut one = cmd.clone();
			if let syn::CommandKind::FuncDef(g) = &mut one.kind {
				g.name = name.to_vec();
				g.extra_names.clear();
			}
			BString::from(syn::print(&one, syn::PrintStyle::DeclareF))
		},
		_ => BString::from(syn::print(cmd, syn::PrintStyle::DeclareF)),
	}
}

/// bash's `u32toutf8` (lib/sh/unicode.c): UTF-8 without validity checks,
/// so surrogates encode in 3 bytes and values up to `0x7fffffff` in up to
/// 6; larger values produce nothing.
fn u32_to_utf8(v: u32, out: &mut Vec<u8>) {
	let (len, lead): (u32, u8) = match v {
		0..0x80 => (1, 0),
		0x80..0x800 => (2, 0xc0),
		0x800..0x1_0000 => (3, 0xe0),
		0x1_0000..0x20_0000 => (4, 0xf0),
		0x20_0000..0x400_0000 => (5, 0xf8),
		0x400_0000..0x8000_0000 => (6, 0xfc),
		_ => return,
	};
	if len == 1 {
		out.push(v as u8);
		return;
	}
	out.push(lead | (v >> (6 * (len - 1))) as u8);
	for k in (0..len - 1).rev() {
		out.push(0x80 | ((v >> (6 * k)) & 0x3f) as u8);
	}
}

/// Whether a zsh word (token string) was lexed as `ENVSTRING` in a
/// `TYPESET` command: a number, or a name with an optional subscript,
/// then an optional `+` and an unquoted `=` (zsh `gettok`, which leaves
/// that `=` untokenized).
fn zsh_envstring(t: &[u8]) -> bool {
	let mut end = if t.first().is_some_and(u8::is_ascii_digit) {
		t.iter().take_while(|c| c.is_ascii_digit()).count()
	} else {
		// The lexer already decided this word is an assignment.
		let mut e = syn::zsh::ident_end(t, 0, true);
		if e < t.len() {
			syn::zsh::skipparens(syn::zsh::tok::INBRACK, syn::zsh::tok::OUTBRACK, t, &mut e);
		}
		e
	};
	if t.get(end) == Some(&b'+') {
		end += 1;
	}
	t.get(end) == Some(&b'=')
}

/// Whether a word starts like an assignment (`name=`, `name+=`,
/// `name[subscript]=`): bash's `assignment()` on the word as written, so
/// only unquoted literal text counts.
fn assignment_like(parts: &[syn::WordPart]) -> bool {
	let Some(syn::WordPart::Lit(first)) = parts.first() else {
		return false;
	};
	let name = first
		.iter()
		.take_while(|&&c| c.is_ascii_alphanumeric() || c == b'_')
		.count();
	if name == 0 || first[0].is_ascii_digit() {
		return false;
	}
	match &first[name..] {
		[b'=', ..] | [b'+', b'=', ..] => true,
		[b'[', ..] => subscript_then_assign(parts, name),
		_ => false,
	}
}

/// Whether the subscript opening at byte `open` of the first part closes
/// and is followed by `=` or `+=` (in the same literal part); expansions
/// and quoted parts inside the subscript are opaque.
fn subscript_then_assign(parts: &[syn::WordPart], open: usize) -> bool {
	let mut depth = 0u32;
	for (pi, part) in parts.iter().enumerate() {
		let syn::WordPart::Lit(b) = part else {
			continue;
		};
		let from = if pi == 0 { open } else { 0 };
		for (i, &c) in b.iter().enumerate().skip(from) {
			match c {
				b'[' => depth += 1,
				b']' => {
					depth = depth.saturating_sub(1);
					if depth == 0 {
						return matches!(&b[i + 1..], [b'=', ..] | [b'+', b'=', ..]);
					}
				},
				_ => {},
			}
		}
	}
	false
}

/// Decode the body of `$'…'` (bash `ansicstr` as `ansiexpand` calls it),
/// with `\u`/`\U` code points above ASCII in UTF-8.
///
/// The result is a C string in bash, so a NUL byte (`\0`, `\x{}`, `\c@`)
/// ends it.
pub fn ansi_c(raw: &[u8]) -> BString {
	ansi_c_with(raw, &mut u32_to_utf8)
}

/// [`ansi_c`] with `code_point` appending the bytes of each `\u`/`\U`
/// code point above ASCII (the locale's charset, bash `u32cconv`).
pub fn ansi_c_with(raw: &[u8], code_point: &mut dyn FnMut(u32, &mut Vec<u8>)) -> BString {
	let mut out = Vec::with_capacity(raw.len());
	let mut i = 0;
	// Up to `max` digits of `radix` at `s`: (value mod 2^32, count).
	let digits = |s: &[u8], radix: u32, max: usize| -> (u32, usize) {
		let mut value = 0u32;
		let mut count = 0;
		for &b in s.iter().take(max) {
			let Some(d) = char::from(b).to_digit(radix) else {
				break;
			};
			value = value.wrapping_mul(radix).wrapping_add(d);
			count += 1;
		}
		(value, count)
	};
	while i < raw.len() {
		let c = raw[i];
		i += 1;
		if c != b'\\' || i == raw.len() {
			out.push(c);
			continue;
		}
		let esc = raw[i];
		i += 1;
		let byte = match esc {
			b'a' => 0x07,
			b'b' => 0x08,
			b'e' | b'E' => 0x1b,
			b'f' => 0x0c,
			b'n' => b'\n',
			b'r' => b'\r',
			b't' => b'\t',
			b'v' => 0x0b,
			b'\\' | b'\'' | b'"' | b'?' => esc,
			b'0'..=b'7' => {
				let (v, n) = digits(&raw[i - 1..], 8, 3);
				i += n - 1;
				v as u8
			},
			// `\x{HHH…}` takes every hex digit and an optional `}`.
			b'x' if raw.get(i) == Some(&b'{') => {
				let (v, n) = digits(&raw[i + 1..], 16, usize::MAX);
				i += 1 + n;
				if raw.get(i) == Some(&b'}') {
					i += 1;
				}
				v as u8
			},
			b'x' => match digits(&raw[i..], 16, 2) {
				(_, 0) => {
					out.push(b'\\');
					b'x'
				},
				(v, n) => {
					i += n;
					v as u8
				},
			},
			b'u' | b'U' => {
				let max = if esc == b'u' { 4 } else { 8 };
				match digits(&raw[i..], 16, max) {
					(_, 0) => {
						out.push(b'\\');
						esc
					},
					(v, n) if v > 0x7f => {
						i += n;
						code_point(v, &mut out);
						continue;
					},
					(v, n) => {
						i += n;
						v as u8
					},
				}
			},
			// `\cX` is a control character; `\c?` is DEL and `$'\c\\'` takes
			// the doubled backslash (POSIX).
			b'c' if i < raw.len() => {
				let x = raw[i];
				i += 1;
				if x == b'\\' && raw.get(i) == Some(&b'\\') {
					i += 1;
				}
				if x == b'?' {
					0x7f
				} else {
					x.to_ascii_uppercase() & 0x1f
				}
			},
			_ => {
				out.push(b'\\');
				esc
			},
		};
		if byte == 0 {
			break;
		}
		out.push(byte);
	}
	BString::from(out)
}

#[cfg(test)]
mod tests {
	use super::{
		ansi_c, assignment_like, function_from_source_at, lower, lower_deferred, materialize,
	};
	use crate::bash::{ids::ModeId, syntax as syn};

	#[test]
	fn deferred_bodies_survive_serialization_with_original_aliases_and_nodes() {
		struct Aliases;
		impl syn::AliasLookup for Aliases {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				(name == b"emit").then_some(b"echo frozen")
			}
		}
		for src in [
			b"f() { local x=${1:-default}; echo \"$x\"; }\n".as_slice(),
			b"f() { emit \"${1:-default}\"; }\n".as_slice(),
			b"f() { echo \"${x+'$(echo x'}\"; }\n".as_slice(),
		] {
			let mut parser = syn::Parser::new(src, syn::Features::NONE, &Aliases)
				.with_pos(syn::Pos { offset: 0, line: 17 });
			let cc = parser.next_command().unwrap().unwrap();
			let eager = lower(&cc, src, ModeId::Bash, syn::Features::NONE).unwrap();
			let lazy = lower_deferred(&cc, src, ModeId::Bash, syn::Features::NONE).unwrap();
			let body = &lazy.funcs[0].body;
			assert!(body.ops.is_empty());
			assert_eq!(body.deferred.as_ref().unwrap().is_empty(), cc.aliases.is_empty());
			let bytes = postcard::to_stdvec(body).unwrap();
			let saved = postcard::from_bytes(&bytes).unwrap();
			let compiled = materialize(&saved, false).unwrap();
			assert_eq!(compiled.id, body.id);
			assert_eq!(compiled.ops, eager.funcs[0].body.ops);
			assert_eq!(compiled.words, eager.funcs[0].body.words);
			assert_eq!(compiled.source, eager.funcs[0].body.source);
			assert_eq!(compiled.root, eager.funcs[0].body.root);
		}
	}

	#[test]
	fn autoload_defers_nested_functions_and_keeps_file_lines() {
		let src = b"loaded () {\nhelper () { echo nested; }\necho ready\n}\n";
		let function = function_from_source_at(src, ModeId::Zsh, syn::Features::ZSH, 0).unwrap();
		assert!(function.body.ops.is_empty());
		let bytes = postcard::to_stdvec(&function.body).unwrap();
		let saved = postcard::from_bytes(&bytes).unwrap();
		let compiled = materialize(&saved, false).unwrap();
		assert_eq!(compiled.id, function.body.id);
		assert_eq!(compiled.funcs.len(), 1);
		let helper = &compiled.funcs[0];
		assert_eq!(helper.name, "helper");
		assert!(helper.body.ops.is_empty());
		assert!(helper.body.deferred.is_some());
		let helper_body = materialize(&helper.body, false).unwrap();
		assert!(helper_body.nodes.iter().any(|n| n.line == 1));
	}

	// Goldens: bash 5.3 `printf '%q' $'…'` and upstream nquote3/nquote4.
	#[test]
	fn ansi_c_decodes_bash_escapes() {
		assert_eq!(ansi_c(b"no\\t"), "no\t");
		assert_eq!(ansi_c(b"\\x41\\101\\u00e9\\cA\\'"), "AA\u{e9}\x01'");
		assert_eq!(ansi_c(b"\\q\\x"), "\\q\\x");
		assert_eq!(ansi_c(b"\\x4cd"), "Ld");
	}

	#[test]
	fn ansi_c_nul_ends_the_string() {
		assert_eq!(ansi_c(b"\\0"), "");
		assert_eq!(ansi_c(b"a\\0b"), "a");
		assert_eq!(ansi_c(b"ab\\x{}cd"), "ab");
		assert_eq!(ansi_c(b"\\u0000x"), "");
	}

	#[test]
	fn ansi_c_braced_hex_takes_every_digit() {
		assert_eq!(ansi_c(b"ab\\x{41}cd"), "abAcd");
		assert_eq!(ansi_c(b"ab\\x{4}cd"), "ab\x04cd");
		assert_eq!(ansi_c(b"ab\\x{cde"), &b"ab\xde"[..]);
		assert_eq!(ansi_c(b"ab\\x{cd}e"), &b"ab\xcde"[..]);
		assert_eq!(ansi_c(b"\\x{01234567X"), "gX");
	}

	// Goldens: bash 5.3.20 `printf %s $'\ud800' | od -b` and upstream
	// unicode2.sub.
	#[test]
	fn ansi_c_encodes_any_code_point_like_bash() {
		assert_eq!(ansi_c(b"\\ud800"), &b"\xed\xa0\x80"[..]);
		assert_eq!(ansi_c(b"\\U110000"), &b"\xf4\x90\x80\x80"[..]);
		assert_eq!(ansi_c(b"\\U7FFFFFFF"), &b"\xfd\xbf\xbf\xbf\xbf\xbf"[..]);
		assert_eq!(ansi_c(b"\\Ufffffffe"), "");
		assert_eq!(ansi_c(b"\\uffff"), "\u{ffff}");
	}

	#[test]
	fn ansi_c_control_characters() {
		assert_eq!(ansi_c(b"\\c?"), "\x7f");
		assert_eq!(ansi_c(b"\\c[\\c\\\\\\c]\\c^\\c_\\c?"), "\x1b\x1c\x1d\x1e\x1f\x7f");
		assert_eq!(ansi_c(b"\\c"), "\\c");
	}

	fn lit(s: &str) -> syn::WordPart {
		syn::WordPart::Lit(s.as_bytes().to_vec())
	}

	// bash `assignment()`: what `echo NAME=~` tilde-expands outside posix
	// mode.
	#[test]
	fn assignment_like_words() {
		assert!(assignment_like(&[lit("a=~")]));
		assert!(assignment_like(&[lit("a+=x")]));
		assert!(assignment_like(&[lit("a[1]=~")]));
		assert!(assignment_like(&[lit("a["), syn::WordPart::SQuote(b"k".to_vec()), lit("]=v")]));
		assert!(!assignment_like(&[lit("./x=~")]));
		assert!(!assignment_like(&[lit("=~")]));
		assert!(!assignment_like(&[lit("1a=b")]));
		assert!(!assignment_like(&[syn::WordPart::SQuote(b"a".to_vec()), lit("=b")]));
		assert!(!assignment_like(&[lit("a[1]")]));
	}
}
