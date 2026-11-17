//! AST → IR lowering.

use bstr::{BString, ByteSlice};

use super::{
	AssignOp, AssignVal, CaseIr, Cmd, ComsubForm, CondIr, ElemIr, FuncDefinition, FuncIr, NodeInfo,
	Op, OpIr, Opcode, ParamIr, ParamRef, Part, RedirFdIr, RedirIr, RedirTargetIr, ReplaceIr,
	SpawnIr, SpawnKind, StageIr, SubIr, Unit, Word, WordKind,
};
use crate::bash::{
	event::{NodeKind, RedirKind},
	ids::ModeId,
	syntax::{self as syn, tree as st},
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
	lower_command(cc, src, mode, features, false, None)
}

/// Lower a command while retaining parsed function bodies for their first call.
pub(crate) fn lower_deferred(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	lower_command(cc, src, mode, features, true, None)
}

/// [`lower_deferred`] with the command's source-context hasher
/// ([`replay_hasher`]) and the id it names the command by ([`replay_id`])
/// already computed.
pub(crate) fn lower_deferred_hashed(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
	source_hash: blake3::Hasher,
	id: super::UnitId,
) -> Result<Unit, &'static str> {
	lower_command(cc, src, mode, features, true, Some((source_hash, Some(id))))
}

/// The source-context hasher of a source-replayable command, whose unit
/// [`lower_deferred`] names by that context alone
/// ([`Unit::seal_source_from`]); `None` for other commands.
pub(crate) fn replay_hasher(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Option<blake3::Hasher> {
	if !cc.source_replay {
		return None;
	}
	let aliases: Vec<(BString, BString)> = cc
		.aliases
		.iter()
		.map(|a| (a.name.as_slice().into(), a.value.as_slice().into()))
		.collect();
	Some(super::source_hasher(mode, features.bits(), cc.span.slice(src), &aliases, cc.line))
}

/// The id [`lower_deferred`] gives the source-replayable command whose
/// source-context hasher is `h`, known without lowering it.
pub(crate) fn replay_id(h: &blake3::Hasher) -> super::UnitId {
	let mut h = h.clone();
	h.update(b"syntax");
	super::UnitId(*h.finalize().as_bytes())
}

/// Lower `cc`. `source_hash`: its source-context hasher, with the id it
/// names a source-replayable command by, when the caller has them.
fn lower_command(
	cc: &syn::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: syn::Features,
	deferred: bool,
	source_hash: Option<(blake3::Hasher, Option<super::UnitId>)>,
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
	let (source_hash, replay_id) = source_hash.map_or((None, None), |(h, id)| (Some(h), id));
	let mut l = Lower::new(unit, cc.span.lo, features, source_hash);
	l.deferred = deferred;
	l.source_replay = cc.source_replay;
	for w in &cc.warnings {
		let idx = l.str(&w.bash_msg);
		l.emit(Opcode::Warn, idx, w.line, w.line);
	}
	l.list(cc.list())?;
	l.emit(Opcode::End, 0, 0, 0);
	match replay_id {
		Some(id) if deferred && cc.source_replay => l.unit.seal_source_as(id),
		_ if deferred && cc.source_replay => l.unit.seal_source_from(l.source_hash),
		_ => l.unit.seal_from(l.source_hash),
	}
	Ok(l.unit)
}

/// Lower a word parsed at run time (`parse_text`: here-document bodies,
/// arithmetic text) into a unit whose last word is the text's word (nested
/// operator words precede it) and whose code holds the word's
/// command-substitution bodies.
pub fn lower_text(
	word: st::Word<'_>,
	text: &[u8],
	mode: ModeId,
	features: syn::Features,
) -> Result<Unit, &'static str> {
	let mut l = Lower::new(Unit::empty(text, mode, features.bits()), 0, features, None);
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
	let item = cc.list().items().one().ok_or(NOT_A_LIST)?;
	let and_or = item.and_or();
	let first = and_or.first();
	let stage = first.stages().one().ok_or(NOT_A_LIST)?;
	let st::CommandKind::Simple(simple) = stage.kind() else {
		return Err(NOT_A_LIST);
	};
	if and_or.rest().len() != 0
		|| !stage.redirs().is_empty()
		|| first.time().is_some()
		|| first.bang()
	{
		return Err(NOT_A_LIST);
	}
	let words = simple.words();
	if !simple.assigns().is_empty() || words.len() != 2 {
		return Err(NOT_A_LIST);
	}
	let arg = words.get(1).ok_or(NOT_A_LIST)?.parts();
	let (2, Some(st::Part::Lit(_)), Some(st::Part::Compound(elems))) =
		(arg.len(), arg.first().map(st::WordPart::get), arg.get(1).map(st::WordPart::get))
	else {
		return Err(NOT_A_LIST);
	};
	let mut unit = Unit::empty(cc.span.slice(src), mode, features.bits());
	unit.nodes = vec![
		NodeInfo { kind: NodeKind::Word, lo: 0, hi: 0, line: 0, col: 1 };
		cc.node_count as usize
	];
	let mut l = Lower::new(unit, cc.span.lo, features, None);
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
	let (base, tree, root): (u32, st::Tree, u32) = postcard::from_bytes(bytes).ok()?;
	let mut body = unit.clone();
	body.deferred = None;
	let features = syn::Features::from_bits(body.features);
	let unit_root = body.root?;
	let mut lower = Lower::new(body, base, features, None);
	lower.deferred = true;
	lower.command(st::Command::at(&tree, root)).ok()?;
	lower.emit(Opcode::End, 0, 0, unit_root);
	for word in &mut lower.unit.words {
		word.classify();
	}
	if observed && lower.unit.trace_syntax.get().is_none() {
		let syntax = crate::bash::trace::syntax::UnitSyntax::new(
			base,
			crate::bash::trace::syntax::SyntaxTree::new(
				tree,
				root,
				crate::bash::trace::syntax::RootKind::Command,
			),
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
	/// Line starts of the unit's source, found as nodes ask for them.
	lines:         Lines,
	/// Depth of condition contexts.
	cond:          u32,
	features:      syn::Features,
	/// Lowering run-time parsed text (`lower_text`) outside any command
	/// substitution body: its words are [`WordKind::Text`] (no tilde
	/// expansion).
	text:          bool,
}

/// The line starts of a unit's source (unit-relative offsets), scanned on
/// demand: a node's line needs only the text before it, and a definition
/// whose body is deferred records nodes at its start alone.
#[derive(Clone)]
struct Lines {
	/// Offsets of the line starts found so far; the first line starts at 0.
	starts:  Vec<u32>,
	/// The source before this offset has been scanned.
	scanned: usize,
}

impl Default for Lines {
	fn default() -> Self {
		Self { starts: vec![0], scanned: 0 }
	}
}

impl Lines {
	/// The 0-based line and 1-based column of offset `lo` in `src`.
	fn line_col(&mut self, src: &[u8], lo: u32) -> (u32, u32) {
		// A line starting at or before `lo` follows a newline before it.
		let end = (lo as usize).min(src.len());
		while self.scanned < end {
			match src[self.scanned..end].find_byte(b'\n') {
				Some(i) => {
					let nl = self.scanned + i;
					self.starts.push(nl as u32 + 1);
					self.scanned = nl + 1;
				},
				None => self.scanned = end,
			}
		}
		let line = self.starts.partition_point(|&s| s <= lo).saturating_sub(1);
		(line as u32, lo - self.starts[line] + 1)
	}
}

type R = Result<(), &'static str>;
type Idx = Result<u32, &'static str>;

impl Lower {
	fn new(
		unit: Unit,
		base: u32,
		features: syn::Features,
		source_hash: Option<blake3::Hasher>,
	) -> Self {
		// A supplied hasher was built from the command (`replay_hasher`),
		// not from this unit: the two must hash one context, or the cache
		// key and every id sealed from it name the wrong source.
		debug_assert!(
			source_hash
				.as_ref()
				.is_none_or(|h| h.finalize() == unit.source_hasher().finalize()),
			"a precomputed source context matches the unit's"
		);
		let source_hash = source_hash.unwrap_or_else(|| unit.source_hasher());
		Self {
			unit,
			source_hash,
			deferred: false,
			source_replay: false,
			base,
			lines: Lines::default(),
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
		let (line, col) = self.lines.line_col(&self.unit.source, span.lo);
		if self.unit.nodes.len() <= id.0 as usize {
			self.unit.nodes.resize(id.0 as usize + 1, NodeInfo {
				kind: NodeKind::Word,
				lo:   0,
				hi:   0,
				line: 0,
				col:  1,
			});
		}
		self.unit.nodes[id.0 as usize] = NodeInfo { kind, lo: span.lo, hi: span.hi, line, col };
	}

	fn list(&mut self, list: st::List<'_>) -> R {
		// zsh `execlist`: an empty list (`do done`, `{ }`) returns status 0.
		if list.items().is_empty() && self.unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			self.emit(Opcode::SetStatus, 0, 0, 0);
			return Ok(());
		}
		let zsh = self.unit.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		for item in list.items() {
			let ao = item.and_or();
			let ao_id = ao.id().0;
			let sep = item.sep();
			// zsh `execlist` runs the DEBUG trap before (`DEBUG_BEFORE_CMD`)
			// or after each list: a `Nop` with `b` 1 marks its start (`a` the
			// end marker, where a skipped list goes), one with `b` 2 its end.
			let start = zsh.then(|| self.emit(Opcode::Nop, 0, Op::LIST_START, ao_id));
			if matches!(sep, syn::Sep::Amp | syn::Sep::Disown) {
				let spawn = self.unit.spawns.len() as u32;
				self.unit.spawns.push(SpawnIr {
					kind:   SpawnKind::Background,
					stages: Vec::new(),
					end:    0,
				});
				let at = self.emit(Opcode::Spawn, spawn, 0, ao_id);
				// zsh `&|` / `&!`: disowned at once.
				if sep == syn::Sep::Disown {
					self.unit.ops[at as usize].flags |= Op::DISOWN;
				}
				let entry = self.here();
				self.and_or(ao)?;
				self.emit(Opcode::SubExit, 0, 0, ao_id);
				let end = self.here();
				let s = &mut self.unit.spawns[spawn as usize];
				s.stages.push(StageIr { entry, pipe_stderr: false });
				s.end = end;
			} else {
				self.and_or(ao)?;
			}
			if let Some(start) = start {
				let end = self.emit(Opcode::Nop, 0, Op::LIST_END, ao_id);
				self.patch_a(start, end);
			}
		}
		Ok(())
	}

	fn and_or(&mut self, ao: st::AndOr<'_>) -> R {
		self.node(ao.id(), NodeKind::AndOr, ao.span());
		let rest = ao.rest();
		let n = rest.len();
		if n > 0 {
			self.cond += 1;
		}
		self.pipeline(ao.first())?;
		for (i, (op, p)) in rest.enumerate() {
			let (code, c) = match op {
				syn::AndOrOp::And => (Opcode::BrFail, construct::AND),
				syn::AndOrOp::Or => (Opcode::BrOk, construct::OR),
			};
			let br = self.emit(code, 0, c, p.id().0);
			if i + 1 == n {
				self.cond -= 1;
			}
			self.pipeline(p)?;
			let end = self.here();
			self.patch_a(br, end);
		}
		Ok(())
	}

	fn pipeline(&mut self, p: st::Pipeline<'_>) -> R {
		let pid = p.id().0;
		self.node(p.id(), NodeKind::Pipeline, p.span());
		let time = p.time();
		if time.is_some() {
			self.emit(Opcode::TimeStart, 0, 0, pid);
		}
		if p.bang() {
			self.cond += 1;
		}
		let stages = p.stages();
		if let Some(stage) = stages.one() {
			self.command(stage)?;
		} else {
			let spawn = self.unit.spawns.len() as u32;
			self.unit.spawns.push(SpawnIr {
				kind:   SpawnKind::Pipeline,
				stages: Vec::new(),
				end:    0,
			});
			self.emit(Opcode::Spawn, spawn, 0, pid);
			let mut irs = Vec::with_capacity(stages.len());
			for stage in stages {
				irs.push(StageIr { entry: self.here(), pipe_stderr: stage.pipe_stderr() });
				self.command(stage)?;
				self.emit(Opcode::SubExit, 0, 0, stage.id().0);
			}
			let end = self.here();
			let s = &mut self.unit.spawns[spawn as usize];
			s.stages = irs;
			s.end = end;
		}
		if p.bang() {
			self.cond -= 1;
			self.emit(Opcode::Not, 0, 0, pid);
		}
		if let Some(t) = time {
			self.emit(Opcode::TimeEnd, 0, u32::from(t.posix), pid);
		}
		Ok(())
	}

	fn cond_list(&mut self, list: st::List<'_>) -> R {
		self.cond += 1;
		let res = self.list(list);
		self.cond -= 1;
		res
	}

	fn command(&mut self, cmd: st::Command<'_>) -> R {
		let id = cmd.id().0;
		let redirs = cmd.redirs();
		if let st::CommandKind::Simple(s) = cmd.kind() {
			self.node(cmd.id(), NodeKind::Simple, cmd.span());
			let redirs = if redirs.is_empty() {
				None
			} else {
				Some(self.redir_list(redirs)?)
			};
			let c = self.simple(s, redirs)?;
			self.emit(Opcode::Exec, c, 0, id);
			return Ok(());
		}
		let redir = if redirs.is_empty() {
			None
		} else {
			let r = self.redir_list(redirs)?;
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

	fn compound(&mut self, cmd: st::Command<'_>) -> R {
		let id = cmd.id().0;
		let (cid, cspan) = (cmd.id(), cmd.span());
		match cmd.kind() {
			st::CommandKind::Simple(_) => unreachable!("handled by command()"),
			st::CommandKind::Brace(body) => {
				self.node(cid, NodeKind::Brace, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				self.list(body)?;
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::Subshell(body) => {
				self.node(cid, NodeKind::Subshell, cspan);
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
			st::CommandKind::If(i) => {
				self.node(cid, NodeKind::If, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let mut ends = Vec::new();
				for (k, arm) in i.arms().enumerate() {
					self.cond_list(arm.cond)?;
					let c = if k == 0 {
						construct::IF
					} else {
						construct::ELIF
					};
					let br = self.emit(Opcode::BrFail, 0, c, id);
					self.list(arm.body)?;
					ends.push(self.emit(Opcode::Jmp, 0, 0, id));
					let next = self.here();
					self.patch_a(br, next);
				}
				match i.else_body() {
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
			st::CommandKind::While(w) => {
				let kind = if w.until() {
					NodeKind::Until
				} else {
					NodeKind::While
				};
				self.node(cid, kind, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let enter = self.emit(Opcode::LoopEnter, 0, 0, id);
				let cond = self.here();
				self.patch_b(enter, cond);
				self.cond_list(w.cond())?;
				let (code, c) = if w.until() {
					(Opcode::BrOk, construct::UNTIL)
				} else {
					(Opcode::BrFail, construct::WHILE)
				};
				let br = self.emit(code, 0, c, id);
				self.list(w.body())?;
				self.emit(Opcode::LoopBack, cond, 0, id);
				let exit = self.here();
				self.patch_a(br, exit);
				self.patch_a(enter, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			kind @ (st::CommandKind::For(f) | st::CommandKind::Select(f)) => {
				let select = matches!(kind, st::CommandKind::Select(_));
				self.node(
					cid,
					if select {
						NodeKind::Select
					} else {
						NodeKind::For
					},
					cspan,
				);
				self.emit(Opcode::Enter, 0, 0, id);
				let list = match f.words() {
					Some(words) => self.word_list(words)?,
					None => Op::POSITIONAL,
				};
				let name = self.unit.names.len() as u32;
				// zsh `for a b … in`: the variables in one entry, newline
				// separated (no name holds a newline).
				let mut var = BString::from(f.var());
				let mut multi = false;
				for extra in f.extra_vars() {
					var.push(b'\n');
					var.extend_from_slice(extra);
					multi = true;
				}
				self.unit.names.push(var);
				let at = self.emit(Opcode::ForIn, list, name, id);
				if select {
					self.unit.ops[at as usize].flags |= Op::SELECT;
				}
				if multi {
					self.unit.ops[at as usize].flags |= Op::MULTI;
				}
				let next = self.emit(Opcode::ForNext, 0, 0, id);
				self.list(f.body())?;
				self.emit(Opcode::LoopBack, next, 0, id);
				let exit = self.here();
				self.patch_a(next, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::ArithFor(f) => {
				self.node(cid, NodeKind::ArithFor, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				// The header's expressions are not commands: a zero value
				// neither runs the ERR trap nor exits under `set -e`.
				self.cond += 1;
				let (init, test, step) = (f.init().src(), f.cond().src(), f.step().src());
				if !init.trim_ascii().is_empty() {
					let (a, b) = self.arith(init);
					self.emit(Opcode::Arith, a, b, id);
				}
				let enter = self.emit(Opcode::LoopEnter, 0, 0, id);
				let cond = self.here();
				if test.trim_ascii().is_empty() {
					self.emit(Opcode::SetStatus, 0, 0, id);
				} else {
					let (a, b) = self.arith(test);
					self.emit(Opcode::Arith, a, b, id);
				}
				let br = self.emit(Opcode::BrFail, 0, construct::WHILE, id);
				self.cond -= 1;
				self.list(f.body())?;
				let step_pc = self.emit(Opcode::LoopNote, 0, 0, id);
				self.patch_b(enter, step_pc);
				if !step.trim_ascii().is_empty() {
					let (a, b) = self.arith(step);
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
			st::CommandKind::Case(c) => {
				self.node(cid, NodeKind::Case, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let subject = self.word(c.word())?;
				self.emit(Opcode::CaseWord, subject, 0, id);
				// Per arm: the test, then the body; terminators jump to the
				// end (`;;`), into the next body (`;&`) or to the next test
				// (`;;&`).
				let arms = c.arms();
				let mut tests = Vec::with_capacity(arms.len());
				let mut bodies = Vec::with_capacity(arms.len());
				let mut jumps: Vec<(u32, syn::CaseTerm, usize)> = Vec::new();
				for (k, arm) in arms.iter().enumerate() {
					let pats = arm
						.patterns()
						.iter()
						.map(|p| self.word(p))
						.collect::<Result<Vec<_>, _>>()?;
					let pi = self.unit.pats.len() as u32;
					self.unit.pats.push(pats);
					tests.push(self.emit(Opcode::CaseArm, pi, 0, id));
					bodies.push(self.here());
					self.list(arm.body())?;
					jumps.push((self.emit(Opcode::Jmp, 0, 0, id), arm.term(), k));
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
			st::CommandKind::Arith(a) => {
				self.node(cid, NodeKind::Arith, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let (i, b) = self.arith(a.src());
				self.emit(Opcode::Arith, i, b, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::Cond(e) => {
				self.node(cid, NodeKind::Cond, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				self.cond_expr(e, id)?;
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::Repeat(r) => {
				// zsh `execrepeat`: the count once, then a counted loop.
				self.node(cid, NodeKind::While, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let count = self.word(r.count())?;
				self.emit(Opcode::Repeat, count, 0, id);
				let next = self.emit(Opcode::ForNext, 0, 0, id);
				self.list(r.body())?;
				self.emit(Opcode::LoopBack, next, 0, id);
				let exit = self.here();
				self.patch_a(next, exit);
				self.emit(Opcode::LoopExit, 0, 0, id);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::Try(t) => {
				// zsh `exectry`: the try-list, then the always-list however
				// the try-list ended.
				self.node(cid, NodeKind::Brace, cspan);
				self.emit(Opcode::Enter, 0, 0, id);
				let enter = self.emit(Opcode::TryEnter, 0, 0, id);
				self.list(t.body())?;
				let always = self.emit(Opcode::AlwaysEnter, 0, 0, id);
				self.list(t.always())?;
				self.emit(Opcode::AlwaysEnd, 0, 0, id);
				let end = self.here();
				self.patch_a(enter, always);
				self.patch_b(enter, end);
				self.emit(Opcode::Leave, 0, 0, id);
			},
			st::CommandKind::AnonFunc(a) => {
				self.node(cid, NodeKind::FuncDef, cspan);
				let body = self.func_body(id, a.body())?;
				self.unit.funcs.push(FuncIr {
					name:       BString::from(ANON),
					definition: None,
					body:       std::sync::Arc::new(body),
				});
				let func = self.unit.funcs.len() as u32 - 1;
				let args = self.word_list(a.args())?;
				let at = self.emit(Opcode::CallAnon, func, args, id);
				if a.traced() {
					self.unit.ops[at as usize].flags |= Op::TRACED;
				}
			},
			st::CommandKind::FuncDef(f) => {
				self.node(cid, NodeKind::FuncDef, cspan);
				let func = self.funcdef(cmd, f)?;
				let traced = if f.traced() { Op::TRACED } else { 0 };
				// zsh `execfuncdef`: names with expansions (`function f$$`)
				// are expanded when the definition runs; `b` is their word
				// list plus one, and that one op defines every name.
				if let Some((t, root)) = zsh_funcdef_words(cspan, f, self.unit.mode) {
					let list = self.word_list(st::At::new(&t, root).seq(0))?;
					let pc = self.emit(Opcode::FuncDef, func, list + 1, id);
					self.unit.ops[pc as usize].flags |= traced;
					return Ok(());
				}
				let pc = self.emit(Opcode::FuncDef, func, 0, id);
				self.unit.ops[pc as usize].flags |= traced;
				// zsh `f g () { … }`: every name gets the body.
				for name in f.extra_names() {
					let mut more = self.unit.funcs[func as usize].clone();
					more.name = func_name(name, self.unit.mode);
					self.unit.funcs.push(more);
					let at = self.unit.funcs.len() as u32 - 1;
					let pc = self.emit(Opcode::FuncDef, at, 0, id);
					self.unit.ops[pc as usize].flags |= traced;
				}
			},
			st::CommandKind::Coproc(c) => {
				self.node(cid, NodeKind::Coproc, cspan);
				let name = self.unit.names.len() as u32;
				self.unit.names.push(c.name().unwrap_or(b"COPROC").into());
				let spawn = self.unit.spawns.len() as u32;
				self.unit.spawns.push(SpawnIr {
					kind:   SpawnKind::Coproc { name },
					stages: Vec::new(),
					end:    0,
				});
				self.emit(Opcode::Spawn, spawn, 0, id);
				let entry = self.here();
				self.command(c.body())?;
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
	fn func_body(&mut self, root: u32, cmd: st::Command<'_>) -> Result<Unit, &'static str> {
		let mut body = Unit::empty(&self.unit.source, self.unit.mode, self.unit.features);
		body.aliases.clone_from(&self.unit.aliases);
		body.nodes.clone_from(&self.unit.nodes);
		body.root = Some(root);
		body.line = self.unit.line;
		if self.deferred {
			body.deferred = Some(if self.source_replay {
				BString::default()
			} else {
				let (tree, at) = cmd.tree().subtree(cmd.node());
				postcard::to_stdvec(&(self.base, &tree, at))
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
			lines:         self.lines.clone(),
			cond:          0,
			features:      self.features,
			text:          false,
		};
		sub.command(cmd)?;
		sub.emit(Opcode::End, 0, 0, root);
		let mut body = sub.unit;
		// Node records filled while lowering the body belong to both units.
		// The body's table may have grown past this one: a unit of run-time
		// parsed text (a here-document body) records its nodes as it meets
		// them rather than sizing the table from a parse.
		let nodes = &mut self.unit.nodes;
		if body.nodes.len() > nodes.len() {
			nodes.extend_from_slice(&body.nodes[nodes.len()..]);
		}
		for (i, n) in body.nodes.iter().enumerate() {
			if n.hi > 0 {
				nodes[i] = *n;
			}
		}
		body.seal_from(self.source_hash.clone());
		Ok(body)
	}

	fn funcdef(&mut self, cmd: st::Command<'_>, f: st::FuncDef<'_>) -> Idx {
		let body = self.func_body(cmd.id().0, f.body())?;
		let definition = if self.source_replay
			&& !cmd
				.redirs()
				.iter()
				.chain(f.body().redirs())
				.any(|r| matches!(r.target(), st::RedirTarget::HereDoc(_)))
		{
			FuncDefinition::Source(cmd.span().rebase(self.base))
		} else {
			let (tree, at) = cmd.tree().subtree(cmd.node());
			FuncDefinition::Parsed(
				postcard::to_stdvec(&(&tree, at))
					.expect("validated function definition serializes")
					.into(),
			)
		};
		self.unit.funcs.push(FuncIr {
			name:       func_name(f.name(), self.unit.mode),
			definition: Some(definition),
			body:       std::sync::Arc::new(body),
		});
		Ok(self.unit.funcs.len() as u32 - 1)
	}

	fn cond_expr(&mut self, e: st::CondExpr<'_>, id: u32) -> R {
		match e.get() {
			st::Cond::Unary { op, arg } => {
				let arg = self.word(arg)?;
				let c = self.cond_ir(CondIr::Unary { op: op.into(), arg });
				self.emit(Opcode::CondTest, c, 0, id);
			},
			st::Cond::Binary { op, lhs, rhs } => {
				let lhs = self.word(lhs)?;
				let rhs = self.word(rhs)?;
				let c = self.cond_ir(CondIr::Binary { op: op.into(), lhs, rhs });
				self.emit(Opcode::CondTest, c, 0, id);
			},
			st::Cond::Word(w) => {
				let w = self.word(w)?;
				let c = self.cond_ir(CondIr::Word(w));
				self.emit(Opcode::CondTest, c, 0, id);
			},
			st::Cond::Not(inner) => {
				// A run of `!`s, lowered at once: bash's trace shows one `!`
				// on a primary under an odd number of them.
				let mut nots = 1;
				let mut leaf = inner;
				while let st::Cond::Not(i) = leaf.get() {
					nots += 1;
					leaf = i;
				}
				let primary = matches!(
					leaf.get(),
					st::Cond::Unary { .. } | st::Cond::Binary { .. } | st::Cond::Word(_)
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
			c @ (st::Cond::And(a, b) | st::Cond::Or(a, b)) => {
				let (code, k) = if matches!(c, st::Cond::And(..)) {
					(Opcode::BrFail, construct::AND)
				} else {
					(Opcode::BrOk, construct::OR)
				};
				self.cond += 1;
				self.cond_expr(a, id)?;
				self.cond -= 1;
				let br = self.emit(code, 0, k, id);
				self.cond_expr(b, id)?;
				let end = self.here();
				self.patch_a(br, end);
			},
			st::Cond::Group(inner) => self.cond_expr(inner, id)?,
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

	fn simple(&mut self, s: st::Simple<'_>, redirs: Option<u32>) -> Idx {
		let mut assigns = Vec::with_capacity(s.assigns().len());
		for a in s.assigns() {
			self.node(a.id(), NodeKind::Assign, a.span());
			let index = a.index().map(|i| self.word(i)).transpose()?;
			let value = match a.value() {
				st::AssignValue::Scalar(w) => AssignVal::Scalar(self.word_as(w, WordKind::Assign)?),
				st::AssignValue::Array(elems) => AssignVal::Array(self.elems(elems)?),
			};
			assigns.push(AssignOp {
				name: a.name().into(),
				index,
				append: a.append(),
				value,
				node: a.id().0,
			});
		}
		let words = self.command_words(s.words())?;
		let idx = self.unit.cmds.len() as u32;
		self
			.unit
			.cmds
			.push(Cmd { assigns, words, redirs, typeset: s.typeset() });
		Ok(idx)
	}

	fn elems(&mut self, elems: st::Seq<'_, st::ArrayElem<'_>>) -> Result<Vec<ElemIr>, &'static str> {
		elems
			.iter()
			.map(|e| {
				let key = e.key().map(|k| self.word(k)).transpose()?;
				// bash expands a keyed value like an assignment (tilde-prefixes
				// after `:` too: `[0]=~/a:~/b`); an unkeyed one like a word.
				let kind = if key.is_some() {
					WordKind::Assign
				} else {
					WordKind::Plain
				};
				Ok(ElemIr { key, append: e.append(), value: self.word_as(e.value(), kind)? })
			})
			.collect()
	}

	fn redir_list(&mut self, redirs: st::Seq<'_, st::Redir<'_>>) -> Idx {
		let mut out = Vec::with_capacity(redirs.len());
		for r in redirs {
			let fd = match r.fd() {
				None => RedirFdIr::Default,
				Some(st::RedirFd::Num(n)) => RedirFdIr::Num(n),
				Some(st::RedirFd::Var(v)) => RedirFdIr::Var(v.into()),
			};
			let (op, clobber) = match r.op() {
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
			let target = match r.target() {
				st::RedirTarget::Word(w) => RedirTargetIr::Word(self.word(w)?),
				st::RedirTarget::HereDoc(d) => {
					RedirTargetIr::HereDoc { text: d.text().into(), quoted: d.quoted() }
				},
			};
			out.push(RedirIr { fd, op, target, clobber });
		}
		self.unit.redirs.push(out);
		Ok(self.unit.redirs.len() as u32 - 1)
	}

	fn word_list(&mut self, words: st::Seq<'_, st::Word<'_>>) -> Idx {
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
	fn command_words(&mut self, words: st::Seq<'_, st::Word<'_>>) -> Idx {
		let decl = words
			.first()
			.is_some_and(|w| match w.parts().one().map(st::WordPart::get) {
				Some(st::Part::Lit(n)) => {
					matches!(n, b"declare" | b"typeset" | b"export" | b"readonly" | b"local")
				},
				// `private`: the reserved word zsh/param/private adds.
				Some(st::Part::Zsh(n)) => matches!(
					n,
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
			let parts = w.parts();
			let mut it = parts.iter().map(st::WordPart::get);
			let kind = match (it.next(), it.next(), it.next()) {
				(Some(st::Part::Zsh(_)), Some(st::Part::Compound(_)), None) if decl => {
					WordKind::DeclArg
				},
				(Some(st::Part::Zsh(t)), None, _) if decl && zsh_envstring(t) => WordKind::DeclArg,
				_ => match (assignment_like(parts), decl) {
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

	fn word(&mut self, w: st::Word<'_>) -> Idx {
		self.word_as(w, WordKind::Plain)
	}

	/// Lower `w` (and its brace-expansion alternatives) as a `kind` word.
	fn word_as(&mut self, w: st::Word<'_>, kind: WordKind) -> Idx {
		let idx = self.plain_word(w, kind)?;
		// Run-time parsed text (here-document bodies, arithmetic) gets no
		// brace expansion; its unit's last word must stay the text itself.
		if self.text {
			return Ok(idx);
		}
		match super::brace::expand(w) {
			Ok(Some((t, alts))) => {
				let mut indices = Vec::with_capacity(alts.len());
				for alt in alts {
					indices.push(self.plain_word(st::Word::at(&t, alt), kind)?);
				}
				let parks = indices.iter().any(|&i| self.unit.words[i as usize].parks);
				let word = &mut self.unit.words[idx as usize];
				word.parks |= parks;
				word.braces = Some(indices.into_boxed_slice());
			},
			Ok(None) => {},
			Err(count) => self.brace_limit(w, count),
		}
		Ok(idx)
	}

	/// bash has no limit on a brace expansion's words; this engine refuses
	/// one over [`super::brace::MAX_WORDS`] rather than run the word as
	/// written or cut short. The refusal is a syntax error where the word
	/// runs, before the command using it: a branch that does not run, or a
	/// function never called, is no error.
	fn brace_limit(&mut self, w: st::Word<'_>, count: u128) {
		let span = w.span().rebase(self.base);
		let mut msg = BString::from("brace expansion: `");
		for &byte in span.slice(&self.unit.source) {
			match byte {
				b'\n' => msg.extend_from_slice(b"\\n"),
				b'\r' => msg.extend_from_slice(b"\\r"),
				_ => msg.push(byte),
			}
		}
		msg.extend_from_slice(
			format!(
				"' would make at least {count} words, over the limit of {}",
				super::brace::MAX_WORDS
			)
			.as_bytes(),
		);
		let a = self.str(&msg);
		let (line, _) = self.lines.line_col(&self.unit.source, span.lo);
		let pc = self.emit(Opcode::Abort, a, 2, self.unit.line + line);
		self.unit.ops[pc as usize].flags |= Op::SYNTAX;
	}

	/// Lower a word without brace expansion.
	fn plain_word(&mut self, w: st::Word<'_>, kind: WordKind) -> Idx {
		let kind = if self.text { WordKind::Text } else { kind };
		self.node(w.id(), NodeKind::Word, w.span());
		let mut parts = Vec::with_capacity(w.parts().len());
		for part in w.parts() {
			self.part(part, false, &mut parts)?;
		}
		let parks = parts.iter().any(|p| self.part_parks(p));
		let idx = self.unit.words.len() as u32;
		self
			.unit
			.words
			.push(Word { parts, parks, node: w.id().0, kind, ..Word::default() });
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
	fn block(&mut self, body: st::List<'_>) -> Idx {
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

	fn part(&mut self, part: st::WordPart<'_>, quoted: bool, out: &mut Vec<Part>) -> R {
		match part.get() {
			st::Part::Lit(b) if quoted => out.push(Part::Quoted(b.into())),
			st::Part::Lit(b) => out.push(Part::Lit(b.into())),
			st::Part::Escaped(b) | st::Part::SQuote(b) => {
				out.push(Part::Quoted(b.into()));
			},
			// `\u`/`\U` depend on the locale in effect when the word expands.
			st::Part::AnsiC(raw) if raw.windows(2).any(|w| matches!(w, b"\\u" | b"\\U")) => {
				out.push(Part::AnsiC(raw.into()));
			},
			st::Part::AnsiC(raw) => out.push(Part::Quoted(ansi_c(raw))),
			st::Part::DQuote(inner) | st::Part::Locale(inner) => {
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
			st::Part::Param(p) => out.push(Part::Param(Box::new(self.param(p, quoted)?))),
			st::Part::Comsub(c) => {
				let entry = self.block(c.body())?;
				let ck = c.kind();
				let kind = match ck {
					syn::ComsubKind::Dollar | syn::ComsubKind::Backtick => ComsubForm::Fork,
					syn::ComsubKind::NoFork => ComsubForm::NoFork,
					syn::ComsubKind::ValueSub => ComsubForm::Value,
				};
				// `$( )`, `${ ;}` and `${| ;}` are re-parsed from their text when
				// they run.
				let text = (ck != syn::ComsubKind::Backtick).then(|| self.str(c.text()));
				if kind == ComsubForm::Fork {
					self.mark_cat(entry);
				}
				out.push(Part::Comsub { entry, kind, quoted, text });
			},
			st::Part::Arith(a) => out.push(Part::Arith { text: a.src().into(), quoted }),
			st::Part::ProcSub(p) => {
				let entry = self.block(p.body())?;
				out.push(Part::ProcSub { entry, output: p.output() });
			},
			st::Part::Compound(elems) => out.push(Part::Compound(self.elems(elems)?)),
			st::Part::BadSubst(text) => out.push(Part::BadSubst(text.into())),
			st::Part::DroppedQuote => {},
			st::Part::BadComsub(b) => {
				out.push(Part::ComsubSyntax { line: b.line(), msg: b.msg().into() });
			},
			st::Part::Zsh(text) => out.push(Part::Zsh(text.into())),
		}
		Ok(())
	}

	fn param(&mut self, p: st::Param<'_>, quoted: bool) -> Result<ParamIr, &'static str> {
		let param = match p.name() {
			st::ParamName::Var(n) => ParamRef::Var(n.into()),
			st::ParamName::Positional(n) => ParamRef::Positional(n),
			st::ParamName::Special(s) => match s {
				syn::Special::At => ParamRef::At,
				syn::Special::Star => ParamRef::Star,
				syn::Special::Count => ParamRef::Count,
				syn::Special::Status => ParamRef::Status,
				syn::Special::Flags => ParamRef::Flags,
				syn::Special::ShellPid => ParamRef::ShellPid,
				syn::Special::LastBg => ParamRef::LastBg,
			},
		};
		let index = match p.index() {
			None => None,
			Some(st::Subscript::At) => Some(SubIr::At),
			Some(st::Subscript::Star) => Some(SubIr::Star),
			Some(st::Subscript::Expr(w)) => Some(SubIr::Expr(self.word(w)?)),
		};
		let op = match p.op() {
			st::ParamOp::None => OpIr::None,
			st::ParamOp::Length => OpIr::Length,
			st::ParamOp::Indirect => OpIr::Indirect,
			st::ParamOp::PrefixNames { star } => OpIr::PrefixNames { star },
			st::ParamOp::Default { colon, word } => OpIr::Default { colon, word: self.word(word)? },
			st::ParamOp::Assign { colon, word } => OpIr::Assign { colon, word: self.word(word)? },
			st::ParamOp::Error { colon, word } => {
				OpIr::Error { colon, word: word.map(|w| self.word(w)).transpose()? }
			},
			st::ParamOp::Alt { colon, word } => OpIr::Alt { colon, word: self.word(word)? },
			st::ParamOp::Substr { offset, len } => {
				OpIr::Substr { offset: offset.src().into(), len: len.map(|l| l.src().into()) }
			},
			st::ParamOp::Trim { suffix, longest, pat } => {
				OpIr::Trim { suffix, longest, pat: self.word(pat)? }
			},
			st::ParamOp::Replace { mode, pat, rep } => OpIr::Replace {
				mode: match mode {
					syn::ReplaceMode::First => ReplaceIr::First,
					syn::ReplaceMode::All => ReplaceIr::All,
					syn::ReplaceMode::Prefix => ReplaceIr::Prefix,
					syn::ReplaceMode::Suffix => ReplaceIr::Suffix,
				},
				pat:  self.word(pat)?,
				rep:  rep.map(|r| self.word(r)).transpose()?,
			},
			st::ParamOp::Case { mode, all, pat } => OpIr::Case {
				mode: match mode {
					syn::CaseMode::Upper => CaseIr::Upper,
					syn::CaseMode::Lower => CaseIr::Lower,
					syn::CaseMode::Toggle => CaseIr::Toggle,
				},
				all,
				pat: pat.map(|w| self.word(w)).transpose()?,
			},
			st::ParamOp::Transform(c) => OpIr::Transform(c),
		};
		Ok(ParamIr { param, index, op, indirect: p.indirect(), quoted, braced: p.braced() })
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
/// beyond quoting); `None` keeps the names as written. The words are the
/// children of the returned root, spanning `span`.
fn zsh_funcdef_words(span: syn::Span, f: st::FuncDef<'_>, mode: ModeId) -> Option<(st::Tree, u32)> {
	use syn::zsh::tok;
	if mode.dialect() != crate::bash::ids::Dialect::Zsh {
		return None;
	}
	let toks = std::iter::once(f.name())
		.chain(f.extra_names())
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
	let mut t = st::Tree::default();
	let mark = t.open();
	for text in &toks {
		let w = t.zword(text, span);
		t.kid(mark, w);
	}
	let root = t.words_at(mark);
	Some((t, root.index()))
}

/// Materialize validated function input for a record's first text reader.
pub(super) fn definition_text(name: &[u8], definition: &FuncDefinition, body: &Unit) -> BString {
	let (tree, root) = match definition {
		FuncDefinition::Parsed(bytes) => postcard::from_bytes::<(st::Tree, u32)>(bytes)
			.expect("validated function definition decodes"),
		FuncDefinition::Source(span) => {
			let source = span.slice(&body.source);
			let features = syn::Features::from_bits(body.features);
			let command = syn::Parser::new(source, features, syn::NO_ALIASES)
				.next_command()
				.expect("validated function source contains a command")
				.expect("validated function source replays");
			let cmd = command
				.list()
				.items()
				.first()
				.and_then(|item| item.and_or().first().stages().first())
				.expect("validated function definition")
				.node();
			(command.tree, cmd)
		},
	};
	func_source(st::Command::at(&tree, root), name, body.mode)
}

/// The canonical text of function `name` defined by `cmd`: zsh's function
/// text (`functions name`, zsh `text.c`) for zsh code, else `declare -f`'s;
/// a zsh definition of several names (`f g () { … }`) prints each name
/// alone.
fn func_source(cmd: st::Command<'_>, name: &[u8], mode: ModeId) -> BString {
	match cmd.kind() {
		st::CommandKind::FuncDef(f) if mode.dialect() == crate::bash::ids::Dialect::Zsh => {
			BString::from(syn::zsh::function_text(name, f))
		},
		st::CommandKind::FuncDef(f) if f.extra_names().len() > 0 => {
			BString::from(syn::print_function_as(cmd, name))
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
fn assignment_like(parts: st::Seq<'_, st::WordPart<'_>>) -> bool {
	let Some(st::Part::Lit(first)) = parts.first().map(st::WordPart::get) else {
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
fn subscript_then_assign(parts: st::Seq<'_, st::WordPart<'_>>, open: usize) -> bool {
	let mut depth = 0u32;
	for (pi, part) in parts.iter().enumerate() {
		let st::Part::Lit(b) = part.get() else {
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

	/// A test word part: a literal, or single-quoted text.
	enum P {
		L(&'static str),
		Q(&'static str),
	}

	fn lit(s: &'static str) -> P {
		P::L(s)
	}

	fn like(parts: &[P]) -> bool {
		let mut t = syn::tree::Tree::default();
		let ids: Vec<_> = parts
			.iter()
			.map(|p| match *p {
				P::L(s) => t.text_part(syn::tree::TextPk::Lit, s.as_bytes()),
				P::Q(s) => t.text_part(syn::tree::TextPk::SQuote, s.as_bytes()),
			})
			.collect();
		let w = t.word(syn::Span::default(), &ids);
		assignment_like(syn::tree::Word::of(&t, w).parts())
	}

	// bash `assignment()`: what `echo NAME=~` tilde-expands outside posix
	// mode.
	#[test]
	fn assignment_like_words() {
		assert!(like(&[lit("a=~")]));
		assert!(like(&[lit("a+=x")]));
		assert!(like(&[lit("a[1]=~")]));
		assert!(like(&[lit("a["), P::Q("k"), lit("]=v")]));
		assert!(!like(&[lit("./x=~")]));
		assert!(!like(&[lit("=~")]));
		assert!(!like(&[lit("1a=b")]));
		assert!(!like(&[P::Q("a"), lit("=b")]));
		assert!(!like(&[lit("a[1]")]));
	}
}
