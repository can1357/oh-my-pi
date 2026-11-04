//! The mid-level IR: one [`Unit`] per top-level command (and per function
//! body, `eval` string, sourced command or run-time parsed text).
//!
//! # Spec (IR version [`IR_VERSION`])
//!
//! A unit is a flat op array plus side tables. Control flow and dispatch are
//! ops; words stay structured operands ([`Word`]) evaluated by the expansion
//! engine. Every op is a safepoint: the VM checks the control word before it
//! dispatches one.
//!
//! Runtime function definitions retain their validated source, or serialized
//! alias-expanded syntax when source replay is not possible. Their IR is
//! lowered on first call. Autoload reuses its validated single definition and
//! also defers nested functions in files loaded as bodies. This input and its
//! original source positions survive snapshots; materialization retains the
//! same unit id.
//! `obash --ir` continues to lower all bodies eagerly.
//! Canonical function text is retained as source spans or validated syntax and
//! printed only for text readers or serialized state records, not definitions.
//! Source-replayable commands are addressed by their source context, without
//! serializing deterministic IR tables. Alias-buffer commands and synthetic
//! units also hash their code, since their source spans need not identify them.
//!
//! Every [`Op`] is 16 bytes: `code` (u8), `flags` (u8: [`Op::COND`] marks code
//! whose failure does not trigger `set -e`), `ev` (u16: the [`EventKind`]s,
//! as [`EventMask`] bits 0–15, the op may emit; the dispatch loop ANDs it
//! with the shell's mask), operands `a` and `b` (u32 indexes into the unit
//! tables or jump targets) and `node` (u32 [`AstNodeId`] of the syntax node,
//! the key of `nodes`).
//!
//! | Op | a | b | Semantics |
//! |---|---|---|---|
//! | `Nop` | – | – | nothing |
//! | `Exec` | `cmds` index | – | simple command: expand, redirect, resolve, dispatch (staged, may park or call) |
//! | `Jmp` | target | – | jump |
//! | `BrOk` | target | [`Construct`](crate::bash::event::Construct) | jump when `$?` = 0; emits `Branch` |
//! | `BrFail` | target | [`Construct`](crate::bash::event::Construct) | jump when `$?` ≠ 0; emits `Branch` |
//! | `Not` | – | – | `$?` = (`$?` = 0 ? 1 : 0) |
//! | `SetStatus` | status | – | `$?` = a |
//! | `Enter` | – | – | compound command starts: `CmdStart` |
//! | `Leave` | – | – | compound command ends: `CmdEnd` |
//! | `LoopEnter` | exit pc | continue pc | push a `while`/`until`/arith-`for` loop record |
//! | `ForIn` | `lists` index or [`Op::POSITIONAL`] | `names` index | expand the words, push a `for` (flag [`Op::SELECT`]: `select`; flag [`Op::MULTI`]: zsh `for a b … in`, `names[b]` holds the variables separated by newlines) loop record; continue = pc+1, exit = `a` of the next op |
//! | `ForNext` | exit pc | – | next item (`select`: print the menu, read a choice): assign the variable(s), emit `IterStart`; zsh `repeat`: count a pass; none left: jump to exit |
//! | `LoopNote` | – | – | record `$?` as the loop status, count an iteration |
//! | `LoopBack` | target | – | `LoopNote`, then jump |
//! | `LoopExit` | – | – | pop the loop record, `$?` = its status, emit `LoopEnd` |
//! | `Redir` | `redirs` index | pc after the matching `PopRedir` | apply a compound command's redirections (staged), saving the previous fds; on failure `$?` = 1 and jump to `b` |
//! | `PopRedir` | – | – | restore the fds saved by the matching `Redir` |
//! | `Spawn` | `spawns` index | – | subshell, pipeline or background job (flag [`Op::DISOWN`]: zsh `&!`/`&|`, not in the job table): start child vprocs at the stage entries; `Subshell`/`Pipeline` wait and set `$?`/`PIPESTATUS`; then jump to the entry's `end` |
//! | `SubExit` | – | – | end of a child's code: the vproc exits with `$?` |
//! | `CaseWord` | `words` index | – | expand the `case` subject (no splitting) and push it |
//! | `CaseArm` | `pats` index | next-arm pc | match the subject against the patterns; no match: jump to `b` |
//! | `CaseEnd` | – | – | pop the `case` subject |
//! | `Arith` | `ariths` index | [`Op::LITERAL`] or 0 | expand and evaluate arithmetic text; `$?` = 0 when non-zero (an empty text is true) |
//! | `CondTest` | `conds` index | – | one `[[ ]]` primary (staged: file probes are pollable) |
//! | `FuncDef` | `funcs` index | – | define a function |
//! | `TimeStart` | – | – | push the `time` start |
//! | `TimeEnd` | – | `1` for `time -p` | pop the start, print the timing to stderr |
//! | `Warn` | `strs` index | line | print a parser warning (flag [`Op::SYNTAX`]: a syntax-error detail line; with [`Op::CONTEXT`] then `strs[a+1]`, the offending line: a syntax error bash recovers from) |
//! | `Abort` | `strs` index | status | print the diagnostic(s) and abandon the script; `node` holds the line; flag [`Op::SYNTAX`]: a syntax error (else `strs[a]` names an unsupported construct), [`Op::CONTEXT`]: `strs[a+1]` is the offending source line |
//! | `End` | – | – | end of unit |
//! | `Repeat` | `words` index | – | zsh `repeat WORD`: expand the word, evaluate it arithmetically, `$?` = 0, push a `repeat` loop record; continue = pc+1, exit = `a` of the next op (`ForNext`) |
//! | `TryEnter` | always-list pc | pc after `AlwaysEnd` | zsh `{ … } always { … }`: push a try record; `return`, `break`, `continue`, `exit` in a function and errors leaving the try-list run the always-list first |
//! | `AlwaysEnter` | – | – | the always-list starts: record the try-list's status |
//! | `AlwaysEnd` | – | – | pop the try record, `$?` = the try-list's status, resume what ended the try-list early |
//! | `CallAnon` | `funcs` index | `lists` index | zsh anonymous function: expand the arguments and call the body as function `(anon)` |
//!
//! [`IR_VERSION`] changes with every addition, and restore rejects frames of
//! another version.
//!
//! The text form ([`asm`]) is what `obash --ir` prints and what back-end tests
//! are written in.

pub mod asm;
mod brace;
mod lower;

use std::{
	ops::Deref,
	sync::{Arc, OnceLock},
};

use bstr::BString;
use serde::{Deserialize, Serialize};

use self::lower::lower;
pub(crate) use self::lower::{
	ANON, abort_unit, ansi_c, ansi_c_with, function_from_parsed, function_from_source,
	function_from_source_at, lower_compound, lower_deferred, lower_text, materialize, syntax_unit,
};
use crate::bash::{
	event::{EventKind, EventMask, NodeKind, RedirKind},
	ids::{AstNodeId, ModeId, UnitId},
};

/// IR version; part of the frames header.
pub const IR_VERSION: u32 = 15;

/// Opcodes.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
)]
#[repr(u8)]
#[expect(missing_docs, reason = "specified in the module table")]
pub enum Opcode {
	Nop,
	Exec,
	Jmp,
	BrOk,
	BrFail,
	Not,
	SetStatus,
	Enter,
	Leave,
	LoopEnter,
	ForIn,
	ForNext,
	LoopNote,
	LoopBack,
	LoopExit,
	Redir,
	PopRedir,
	Spawn,
	SubExit,
	CaseWord,
	CaseArm,
	CaseEnd,
	Arith,
	CondTest,
	FuncDef,
	TimeStart,
	TimeEnd,
	Warn,
	Abort,
	End,
	Repeat,
	TryEnter,
	AlwaysEnter,
	AlwaysEnd,
	CallAnon,
}

crate::bash::packed_names::packed_names!(Opcode, Display);

impl Opcode {
	/// Event kinds this opcode may emit, as op `ev` bits.
	pub const fn ev_bits(self) -> u16 {
		const fn bit(k: EventKind) -> u16 {
			EventMask::of(k).bits() as u16
		}
		match self {
			Self::Exec | Self::CallAnon => {
				bit(EventKind::CmdStart)
					| bit(EventKind::CmdExpanded)
					| bit(EventKind::CmdEnd)
					| bit(EventKind::Assign)
					| bit(EventKind::FuncEnter)
					| bit(EventKind::FuncExit)
			},
			Self::Enter => bit(EventKind::CmdStart),
			Self::Leave => bit(EventKind::CmdEnd),
			Self::BrOk | Self::BrFail => bit(EventKind::Branch),
			Self::ForNext => bit(EventKind::IterStart) | bit(EventKind::Assign),
			Self::LoopExit => bit(EventKind::LoopEnd),
			Self::Redir => bit(EventKind::Redirect),
			Self::Spawn => {
				bit(EventKind::Subshell) | bit(EventKind::Pipeline) | bit(EventKind::Background)
			},
			_ => 0,
		}
	}
}

/// One instruction (16 bytes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Op {
	/// Opcode.
	pub code:  Opcode,
	/// [`Op::COND`], [`Op::CONTEXT`], [`Op::SYNTAX`], [`Op::SELECT`],
	/// [`Op::CAT`].
	pub flags: u8,
	/// Event bits (see the module docs).
	pub ev:    u16,
	/// First operand.
	pub a:     u32,
	/// Second operand.
	pub b:     u32,
	/// Syntax node ([`AstNodeId`]), or the line for `Abort`/`Warn`.
	pub node:  u32,
}

const _: () = assert!(size_of::<Op>() == 16);

impl Op {
	/// Flag on `Exec`: the whole body of a `$( )` is `< file`, which
	/// outputs the file (bash's `$(< file)`).
	pub const CAT: u8 = 1 << 4;
	/// Flag: inside a condition (`if`/`while` test, left of `&&`/`||`, `!`).
	pub const COND: u8 = 1;
	/// Flag on `Abort`: `strs[a + 1]` is the offending source line.
	pub const CONTEXT: u8 = 1 << 1;
	/// Flag on a background `Spawn`: zsh `&!`/`&|`, the job is disowned at
	/// once (not in the job table).
	pub const DISOWN: u8 = 1 << 7;
	/// `Nop` operand `b` in a zsh unit: the end of a list (the DEBUG trap
	/// point after it).
	pub const LIST_END: u32 = 2;
	/// `Nop` operand `b` in a zsh unit: the start of a list (`execlist`'s
	/// DEBUG trap point before it); operand `a` is its [`Self::LIST_END`].
	pub const LIST_START: u32 = 1;
	/// `Arith` operand `b`: the text has nothing to expand (no `$`, `` ` ``,
	/// quote or backslash), so it is evaluated as written.
	pub const LITERAL: u32 = 1;
	/// Flag on `ForIn`: zsh `for a b … in`: `names[b]` holds the loop
	/// variables separated by newlines.
	pub const MULTI: u8 = 1 << 6;
	/// Flag on `CondTest`: an odd run of `!` applies to the primary
	/// itself, which `set -x` shows (`[[ ! -n x ]]`; not `! ( … )`).
	pub const NEGATED: u8 = 1 << 5;
	/// `ForIn` operand `a`: iterate over `"$@"`.
	pub const POSITIONAL: u32 = u32::MAX;
	/// Flag on `ForIn`: a `select` loop.
	pub const SELECT: u8 = 1 << 3;
	/// Flag on `Abort`: `strs[a]` is a syntax error (otherwise it names an
	/// unsupported construct).
	pub const SYNTAX: u8 = 1 << 2;
	/// Flag on `FuncDef` and `CallAnon`: zsh `function -T`, the function
	/// is defined traced (`PM_TAGGED_LOCAL`). Shares its bit with the
	/// `ForIn`-only [`Self::MULTI`].
	pub const TRACED: u8 = 1 << 6;
}

/// A compiled command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
	/// Content address.
	pub id:                  UnitId,
	/// Mode it was parsed in.
	pub mode:                ModeId,
	/// [`crate::bash::syntax::Features`] bits it was parsed with.
	pub features:            u32,
	/// Unit source bytes (node spans are relative to them).
	pub source:              BString,
	/// Alias substitutions applied while parsing.
	pub aliases:             Vec<(BString, BString)>,
	/// For a function body: the node id of the function definition in
	/// `source` (function units share their defining unit's source and ids).
	pub root:                Option<u32>,
	/// 1-based script line of the first byte of `source`.
	pub line:                u32,
	/// Deferred function input, retained in snapshots. An empty string means
	/// reparse `source`; otherwise this encodes `(source_offset, Command)` to
	/// preserve alias-expanded syntax that the source alone cannot reproduce.
	pub(crate) deferred:     Option<BString>,
	/// Canonical syntax shared only when a compilation is observed. Not
	/// executable state.
	#[serde(skip)]
	pub(crate) trace_syntax: std::sync::OnceLock<Arc<crate::bash::trace::syntax::UnitSyntax>>,
	/// Code.
	pub ops:                 Vec<Op>,
	/// Syntax nodes by [`AstNodeId`].
	pub nodes:               Vec<NodeInfo>,
	/// Word operands.
	pub words:               Vec<Word>,
	/// Word lists (indexes into `words`).
	pub lists:               Vec<Vec<u32>>,
	/// Simple commands.
	pub cmds:                Vec<Cmd>,
	/// Variable names.
	pub names:               Vec<BString>,
	/// Diagnostic texts.
	pub strs:                Vec<BString>,
	/// Redirection lists.
	pub redirs:              Vec<Vec<RedirIr>>,
	/// Subshells, pipelines and background jobs.
	pub spawns:              Vec<SpawnIr>,
	/// `case` arm pattern lists (indexes into `words`).
	pub pats:                Vec<Vec<u32>>,
	/// Arithmetic texts (`(( ))`, `for (( ))`).
	pub ariths:              Vec<BString>,
	/// `[[ ]]` primaries.
	pub conds:               Vec<CondIr>,
	/// Function definitions.
	pub funcs:               Vec<FuncIr>,
}

impl Unit {
	/// An empty unit for `mode`/`features` over `source`.
	pub(crate) fn empty(source: &[u8], mode: ModeId, features: u32) -> Self {
		Self {
			id: UnitId([0; 32]),
			mode,
			features,
			source: BString::from(source),
			aliases: Vec::new(),
			root: None,
			line: 1,
			deferred: None,
			trace_syntax: std::sync::OnceLock::new(),
			ops: Vec::new(),
			nodes: Vec::new(),
			words: Vec::new(),
			lists: Vec::new(),
			cmds: Vec::new(),
			names: Vec::new(),
			strs: Vec::new(),
			redirs: Vec::new(),
			spawns: Vec::new(),
			pats: Vec::new(),
			ariths: Vec::new(),
			conds: Vec::new(),
			funcs: Vec::new(),
		}
	}

	/// Recompute [`Unit::id`] from the content that defines the parse (and,
	/// for units without a syntax tree, from their code tables).
	pub(crate) fn seal(&mut self) {
		self.seal_from(self.source_hasher());
	}

	/// Hash the source context shared by a command and its function bodies.
	pub(crate) fn source_hasher(&self) -> blake3::Hasher {
		let mut h = blake3::Hasher::new();
		h.update(&IR_VERSION.to_le_bytes());
		h.update(<&'static str>::from(self.mode).as_bytes());
		h.update(&self.features.to_le_bytes());
		h.update(&(self.source.len() as u64).to_le_bytes());
		h.update(&self.source);
		for (name, value) in &self.aliases {
			h.update(&(name.len() as u64).to_le_bytes());
			h.update(name);
			h.update(&(value.len() as u64).to_le_bytes());
			h.update(value);
		}
		h.update(&self.line.to_le_bytes());
		h
	}

	/// Seal a source-replayable command from lowering without serializing its
	/// deterministic tables.
	pub(crate) fn seal_source_from(&mut self, mut h: blake3::Hasher) {
		for word in &mut self.words {
			word.classify();
		}
		h.update(b"syntax");
		if let Some(root) = self.root {
			h.update(&root.to_le_bytes());
		}
		self.id = UnitId(*h.finalize().as_bytes());
	}

	/// Seal using the hash of this unit's source context.
	pub(crate) fn seal_from(&mut self, mut h: blake3::Hasher) {
		for word in &mut self.words {
			word.classify();
		}
		match self.root {
			Some(root) => {
				h.update(b"fn");
				h.update(&root.to_le_bytes());
			},
			None => {
				h.update(b"top");
			},
		}
		if let Some(tree) = &self.deferred {
			h.update(b"deferred");
			h.update(tree);
			self.id = UnitId(*h.finalize().as_bytes());
			return;
		}
		// The code itself: commands read from alias text left over by the
		// previous command share their source span (the bytes after the
		// aliased word), so the bytes alone do not identify the unit.
		let code = (
			&self.ops,
			&self.words,
			&self.lists,
			&self.cmds,
			&self.names,
			&self.strs,
			&self.redirs,
			&self.spawns,
			&self.pats,
			&self.ariths,
			&self.conds,
		);
		let bytes = postcard::to_stdvec(&code).expect("IR tables serialize");
		h.update(&(bytes.len() as u64).to_le_bytes());
		h.update(&bytes);
		// A body is already content-addressed. Hash its identity rather than
		// serializing all of its tables again in every enclosing definition.
		h.update(&(self.funcs.len() as u64).to_le_bytes());
		for function in &self.funcs {
			h.update(&(function.name.len() as u64).to_le_bytes());
			h.update(&function.name);
			h.update(&function.body.id.0);
		}
		self.id = UnitId(*h.finalize().as_bytes());
	}

	/// The node record of `id`, if any.
	pub fn node(&self, id: AstNodeId) -> Option<&NodeInfo> {
		self.nodes.get(id.0 as usize)
	}

	/// Approximate heap size, for the engine's unit cache budget.
	pub(crate) fn weight(&self) -> usize {
		self.source.len()
			+ self.deferred.as_ref().map_or(0, |tree| tree.len())
			+ self.ops.len() * size_of::<Op>()
			+ self.nodes.len() * size_of::<NodeInfo>()
			+ self.words.len() * 64
			+ self.cmds.len() * 48
			+ self
				.funcs
				.iter()
				.map(|f| f.body.weight() + f.definition.as_ref().map_or(0, FuncDefinition::weight))
				.sum::<usize>()
	}
}

/// A syntax node's location.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeInfo {
	/// Node kind.
	pub kind: NodeKind,
	/// First byte (unit-relative).
	pub lo:   u32,
	/// One past the last byte.
	pub hi:   u32,
	/// 0-based line within the unit.
	pub line: u32,
	/// 1-based byte column.
	pub col:  u32,
}

/// A word operand.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Word {
	/// Parts in order.
	pub parts:  Vec<Part>,
	/// Expanding it may run commands (command or process substitution, also
	/// inside arithmetic or operator words) or wait (`$!` while its job
	/// decides on its pid): the expander records a replay log.
	pub parks:  bool,
	/// Syntax node of the word (its source text is quoted in diagnostics).
	pub node:   u32,
	/// Brace expansion: the `words` indices of the alternatives (in order),
	/// used instead of the word while `braceexpand` is on.
	pub braces: Option<Box<[u32]>>,
	/// Expansion class (where tilde-prefixes expand, splitting, globbing).
	pub kind:   WordKind,
	/// Set by [`Unit::seal`]: only `Lit`/`Quoted` parts, no `~` in the
	/// unquoted text and no brace alternatives. Such a word expands to its
	/// parts' text in every context and option state (literal text is
	/// never split; tilde-prefixes and brace expansion cannot apply), so
	/// the expander copies the text instead of walking the parts. Pathname
	/// expansion still applies unless [`Self::noglob`].
	pub fixed:  bool,
	/// Set by [`Unit::seal`]: no field of the word can hold an active glob
	/// character (every expansion is quoted and the unquoted text has none,
	/// `extglob` operators counted), so pathname expansion never applies
	/// and the expander keeps no pattern side for it.
	pub noglob: bool,
}

impl Word {
	/// Work out [`Self::fixed`] and [`Self::noglob`] from the parts.
	fn classify(&mut self) {
		let plain = self.braces.is_none();
		self.fixed = plain
			&& self.parts.iter().all(|p| match p {
				Part::Lit(b) => !b.contains(&b'~'),
				Part::Quoted(_) => true,
				_ => false,
			});
		self.noglob = plain && glob_free(&self.parts);
	}
}

/// Whether no field of a word made of `parts` can need pathname expansion.
/// Quoted text and quoted expansions come back with every glob character
/// backslash-escaped (an escaped pair never changes the answer), so only
/// the unquoted literal text counts; a field is a substring of it, which
/// has no glob character when the whole has none. Unquoted expansions, a
/// backslash in unquoted text and compound values are not decided here.
fn glob_free(parts: &[Part]) -> bool {
	let mut text = Vec::new();
	for part in parts {
		match part {
			Part::Lit(b) if b.contains(&b'\\') => return false,
			Part::Lit(b) => text.extend_from_slice(b),
			Part::Quoted(_)
			| Part::AnsiC(_)
			| Part::ProcSub { .. }
			| Part::Comsub { quoted: true, .. }
			| Part::Arith { quoted: true, .. } => {},
			Part::Param(p) if p.quoted => {},
			_ => return false,
		}
	}
	// `glob_pattern_p` never resets a `[` at a `/`: it says "glob" at least
	// as often as the pathname-expansion check does.
	!crate::bash::pattern::glob::glob_pattern_p(&text)
}

/// How the compiler classified a word (bash's `W_ASSIGNMENT`,
/// `W_ASSIGNRHS`, `W_TILDEEXP`, `W_NOSPLIT` and `W_NOGLOB` word flags):
/// where tilde-prefixes expand and whether the word is split and globbed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WordKind {
	/// An ordinary word: only a leading tilde-prefix expands.
	#[default]
	Plain,
	/// Text parsed at run time (here-document body, arithmetic): no tilde
	/// expansion.
	Text,
	/// The value of an assignment statement: tilde-prefixes also expand
	/// after each unquoted `:`.
	Assign,
	/// A command argument written as an assignment (`name=value`): outside
	/// posix mode, tilde-prefixes also expand after the first `=` and after
	/// each unquoted `:`.
	AssignArg,
	/// An assignment-like argument of a declaration builtin (`declare`,
	/// `typeset`, `export`, `readonly`, `local` as the literal command
	/// name): tilde-prefixes as for [`Self::AssignArg`] also in posix mode;
	/// no field splitting and no pathname expansion.
	DeclArg,
}

/// One part of a word operand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Part {
	/// Unquoted literal (subject to tilde expansion when leading, splitting
	/// of nothing, and pattern meaning).
	Lit(BString),
	/// Quoted literal (`'…'`, `\c`, `$'…'` decoded, literal text in `"…"`).
	Quoted(BString),
	/// Parameter expansion.
	Param(Box<ParamIr>),
	/// Command substitution; its body is the code block at `entry` (it ends
	/// with `SubExit`, or `End` for nofork forms).
	Comsub {
		/// Entry pc of the body.
		entry:  u32,
		/// Syntax form.
		kind:   ComsubForm,
		/// Inside double quotes.
		quoted: bool,
		/// `$( )`: `strs` index of the body's source text, re-parsed with
		/// the aliases in effect when it runs (outside posix mode).
		text:   Option<u32>,
	},
	/// `$((…))`: arithmetic text, expanded then evaluated.
	Arith {
		/// Expression text.
		text:   BString,
		/// Inside double quotes.
		quoted: bool,
	},
	/// `<(…)` / `>(…)`.
	ProcSub {
		/// Entry pc of the body.
		entry:  u32,
		/// `>(…)`.
		output: bool,
	},
	/// `(…)` of a declaration-builtin argument (`declare -a a=(1 2)`).
	Compound(Vec<ElemIr>),
	/// A `${…}` bash accepts at parse time and rejects when expanding:
	/// the whole text, for the `bad substitution` message.
	BadSubst(BString),
	/// A `$(` bash parses only when it expands the word, and that fails:
	/// ``command substitution: line N: MSG`` with N the expansion line plus
	/// `line`.
	ComsubSyntax {
		/// Error line relative to the expansion line.
		line: u32,
		/// The parser's message.
		msg:  BString,
	},
	/// The raw body of a `$'…'` with `\u`/`\U` escapes: decoded when it is
	/// expanded, so the code points convert to the locale's charset.
	AnsiC(BString),
	/// zsh dialect: a whole word in zsh's tokenized, metafied form
	/// ([`crate::bash::syntax::WordPart::Zsh`]), expanded at run time by the zsh
	/// expander (zsh `subst.c`), which also runs its substitutions.
	Zsh(BString),
}

/// Form of a command substitution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ComsubForm {
	/// `$(…)` and `` `…` ``: a subshell.
	Fork,
	/// `${ …;}`: in the current shell, capturing stdout.
	NoFork,
	/// `${| …;}`: in the current shell, value is `$REPLY`.
	Value,
}

/// A parameter expansion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParamIr {
	/// Which parameter.
	pub param:    ParamRef,
	/// Subscript.
	pub index:    Option<SubIr>,
	/// Operator.
	pub op:       OpIr,
	/// `${!x<op>}`: the operator applies to the parameter named by the
	/// value of `x`.
	pub indirect: bool,
	/// Inside double quotes.
	pub quoted:   bool,
	/// Written `${…}` (bash names an unset unbraced positional `$9` in
	/// `set -u` errors, a braced one `9`).
	pub braced:   bool,
}

impl ParamIr {
	/// Whether the expansion yields one word per element, like `"$@"`:
	/// `$@`, `${a[@]}`, `${!a[@]}` and `${!prefix@}`, also under a
	/// substring, trim, replace, case or transform operator.
	#[must_use]
	pub fn is_at_list(&self) -> bool {
		match &self.op {
			OpIr::PrefixNames { star } => !star,
			OpIr::None
			| OpIr::Indirect
			| OpIr::Substr { .. }
			| OpIr::Trim { .. }
			| OpIr::Replace { .. }
			| OpIr::Case { .. }
			| OpIr::Transform(_) => {
				matches!((&self.param, &self.index), (ParamRef::At, None) | (_, Some(SubIr::At)))
			},
			OpIr::Length
			| OpIr::Default { .. }
			| OpIr::Assign { .. }
			| OpIr::Error { .. }
			| OpIr::Alt { .. } => false,
		}
	}
}

/// A parameter reference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamRef {
	/// Named variable.
	Var(BString),
	/// `$0`…`$N`.
	Positional(u32),
	/// `$@`
	At,
	/// `$*`
	Star,
	/// `$#`
	Count,
	/// `$?`
	Status,
	/// `$-`
	Flags,
	/// `$$`
	ShellPid,
	/// `$!`
	LastBg,
}

/// Array subscript.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubIr {
	/// `[@]`
	At,
	/// `[*]`
	Star,
	/// `[expr]` (`words` index; arithmetic for indexed arrays, a string for
	/// associative ones).
	Expr(u32),
}

/// `${…}` operator; words are `words` indexes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[expect(missing_docs, reason = "mirrors crate::bash::syntax::ParamOp")]
pub enum OpIr {
	None,
	Length,
	Indirect,
	PrefixNames { star: bool },
	Default { colon: bool, word: u32 },
	Assign { colon: bool, word: u32 },
	Error { colon: bool, word: Option<u32> },
	Alt { colon: bool, word: u32 },
	Substr { offset: BString, len: Option<BString> },
	Trim { suffix: bool, longest: bool, pat: u32 },
	Replace { mode: ReplaceIr, pat: u32, rep: Option<u32> },
	Case { mode: CaseIr, all: bool, pat: Option<u32> },
	Transform(u8),
}

/// `${x/…}` selector.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[expect(missing_docs, reason = "mirrors crate::bash::syntax::ReplaceMode")]
pub enum ReplaceIr {
	First,
	All,
	Prefix,
	Suffix,
}

/// `${x^…}` conversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[expect(missing_docs, reason = "mirrors crate::bash::syntax::CaseMode")]
pub enum CaseIr {
	Upper,
	Lower,
	Toggle,
}

/// A simple command operand.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cmd {
	/// Prefix assignments.
	pub assigns: Vec<AssignOp>,
	/// Word list (`lists` index).
	pub words:   u32,
	/// Redirections (`redirs` index).
	pub redirs:  Option<u32>,
	/// zsh: the command word is a reserved word of the `typeset` family
	/// ([`crate::bash::syntax::Simple::typeset`]).
	#[serde(default)]
	pub typeset: bool,
}

/// One prefix assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignOp {
	/// Variable name.
	pub name:   BString,
	/// `NAME[i]=` subscript (`words` index).
	pub index:  Option<u32>,
	/// `+=`.
	pub append: bool,
	/// Value.
	pub value:  AssignVal,
	/// Syntax node.
	pub node:   u32,
}

/// Right-hand side of an assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssignVal {
	/// `NAME=word` (`words` index).
	Scalar(u32),
	/// `NAME=(…)`.
	Array(Vec<ElemIr>),
}

/// One element of a compound array assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElemIr {
	/// `[key]=` (`words` index).
	pub key:    Option<u32>,
	/// `[key]+=`.
	pub append: bool,
	/// Value (`words` index).
	pub value:  u32,
}

/// One redirection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedirIr {
	/// Explicit fd (`2>`) or fd variable (`{v}>`).
	pub fd:      RedirFdIr,
	/// Operator.
	pub op:      RedirKind,
	/// Target.
	pub target:  RedirTargetIr,
	/// zsh `>|`, `>>|`, `&>|`, `&>>|` (and their `!` spellings): the file
	/// is written whatever `clobber` and `appendcreate` say.
	pub clobber: bool,
}

/// Explicit redirection source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RedirFdIr {
	/// The operator's default fd.
	Default,
	/// `N>`
	Num(u32),
	/// `{var}>`
	Var(BString),
}

/// Redirection target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RedirTargetIr {
	/// A word (`words` index).
	Word(u32),
	/// A here-document: its stored text, expanded at run time unless quoted.
	HereDoc {
		/// Document text.
		text:   BString,
		/// The delimiter was quoted.
		quoted: bool,
	},
}

/// A subshell, pipeline or background job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnIr {
	/// What it is.
	pub kind:   SpawnKind,
	/// Stage entry pcs, in pipeline order.
	pub stages: Vec<StageIr>,
	/// pc after the stage code.
	pub end:    u32,
}

/// Kind of [`SpawnIr`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SpawnKind {
	/// `( list )`: one child, waited for.
	Subshell,
	/// `a | b | …`: one child per stage, connected by pipes, waited for.
	Pipeline,
	/// `cmd &`: one child, not waited for; `$!` is its vpid.
	Background,
	/// `coproc [NAME] cmd`: one background child joined to the shell by two
	/// pipes; `name` indexes `names` (`COPROC` when none is written).
	Coproc {
		/// `names` index of `NAME`.
		name: u32,
	},
}

/// One child of a [`SpawnIr`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageIr {
	/// Entry pc.
	pub entry:       u32,
	/// `|&`: stderr joins the pipe to the next stage.
	pub pipe_stderr: bool,
}

/// One `[[ ]]` primary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CondIr {
	/// `-op word`.
	Unary {
		/// Operator (`-f`, `-n`, …).
		op:  BString,
		/// Operand (`words` index).
		arg: u32,
	},
	/// `lhs op rhs`.
	Binary {
		/// Operator (`==`, `=~`, `-lt`, …).
		op:  BString,
		/// Left operand (`words` index).
		lhs: u32,
		/// Right operand (`words` index; a pattern for `==`/`!=`, a regex for
		/// `=~`).
		rhs: u32,
	},
	/// A lone word: true when non-empty.
	Word(u32),
}

/// Input for canonical function text, retained by lowering without printing the
/// body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FuncDefinition {
	/// Source-replayable definition span relative to its body unit's source.
	Source(crate::bash::syntax::Span),
	/// Serialized definition syntax when aliases or external here-documents
	/// prevent replay.
	Parsed(BString),
}

impl FuncDefinition {
	fn weight(&self) -> usize {
		match self {
			Self::Source(_) => 0,
			Self::Parsed(bytes) => bytes.len(),
		}
	}
}

/// Canonical function text shared by records, printed only when a reader needs
/// it.
#[derive(Clone)]
pub struct FuncText(Arc<FuncTextInner>);

struct FuncTextInner {
	text:  OnceLock<BString>,
	input: Option<(BString, FuncDefinition, Arc<Unit>)>,
}

impl FuncText {
	/// Retain a function's validated definition for record readers without
	/// printing it.
	pub(crate) fn of(function: &FuncIr) -> Self {
		Self(Arc::new(FuncTextInner {
			text:  OnceLock::new(),
			input: function.definition.as_ref().map(|definition| {
				(function.name.clone(), definition.clone(), Arc::clone(&function.body))
			}),
		}))
	}
}

impl Default for FuncText {
	fn default() -> Self {
		BString::default().into()
	}
}

impl From<BString> for FuncText {
	fn from(text: BString) -> Self {
		Self(Arc::new(FuncTextInner { text: OnceLock::from(text), input: None }))
	}
}

impl Deref for FuncText {
	type Target = BString;

	fn deref(&self) -> &BString {
		self.0.text.get_or_init(|| match &self.0.input {
			Some((name, definition, body)) => lower::definition_text(name, definition, body),
			None => BString::default(),
		})
	}
}

impl std::fmt::Debug for FuncText {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self.0.text.get() {
			Some(text) => text.fmt(f),
			None => f.write_str("FuncText(deferred)"),
		}
	}
}

impl PartialEq for FuncText {
	fn eq(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0) || **self == **other
	}
}

impl Eq for FuncText {}

impl Serialize for FuncText {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		(**self).serialize(serializer)
	}
}

impl<'de> Deserialize<'de> for FuncText {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		BString::deserialize(deserializer).map(Self::from)
	}
}

/// A function definition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FuncIr {
	/// Name.
	pub name:       BString,
	/// Input retained for the canonical function text consumed by record
	/// readers.
	pub definition: Option<FuncDefinition>,
	/// Compiled body (ends with `End`).
	#[serde(with = "function_body_serde")]
	pub body:       Arc<Unit>,
}

mod function_body_serde {
	use super::*;

	/// Serialize the shared body as its unit, preserving the internal wire
	/// layout.
	pub(super) fn serialize<S: serde::Serializer>(
		body: &Arc<Unit>,
		serializer: S,
	) -> Result<S::Ok, S::Error> {
		(**body).serialize(serializer)
	}

	/// Restore a shared function body from the serialized unit.
	pub(super) fn deserialize<'de, D: serde::Deserializer<'de>>(
		deserializer: D,
	) -> Result<Arc<Unit>, D::Error> {
		Unit::deserialize(deserializer).map(Arc::new)
	}
}

/// Parse and compile every top-level command of `src` without running it.
///
/// Used by `obash --ir` and IR goldens. A syntax error ends the list, as in
/// bash, and becomes an `Abort` unit.
pub fn compile_all(src: &[u8], mode: ModeId, features: crate::bash::syntax::Features) -> Vec<Unit> {
	let mut parser =
		crate::bash::syntax::Parser::new(src, features, crate::bash::syntax::NO_ALIASES);
	let mut units = Vec::new();
	while let Some(res) = parser.next_command() {
		units.push(match res {
			Ok(cc) => compile(&cc, src, mode, features),
			Err(e) => syntax_unit(&e, src, mode, features),
		});
	}
	units
}

/// Lower one parsed command; a construct this engine cannot run yet becomes
/// an `Abort` unit that fails loudly when it runs.
pub(crate) fn compile(
	cc: &crate::bash::syntax::CompleteCommand,
	src: &[u8],
	mode: ModeId,
	features: crate::bash::syntax::Features,
) -> Unit {
	lower(cc, src, mode, features).unwrap_or_else(|what| {
		abort_unit(cc.span.slice(src), mode, features, cc.line, vec![what.into()], 0, 2)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	/// `(fixed, noglob)` of each word of the simple command `src`. A
	/// command substitution's body is lowered while the words are, so the
	/// outer command is the last one.
	fn flags(src: &[u8]) -> Vec<(bool, bool)> {
		let units = compile_all(src, ModeId::Bash, crate::bash::syntax::Features::NONE);
		let u = &units[0];
		let cmd = u.cmds.last().expect("a simple command");
		u.lists[cmd.words as usize]
			.iter()
			.map(|&w| (u.words[w as usize].fixed, u.words[w as usize].noglob))
			.collect()
	}

	#[test]
	fn lazy_function_text_keeps_a_body_redirections_external_heredoc() {
		use crate::bash::syntax::{Features, NO_ALIASES, Parser, PrintStyle};

		let source = b"f() { :; } <<EOF\npayload\nEOF\n";
		let command = Parser::new(source, Features::NONE, NO_ALIASES)
			.next_command()
			.unwrap()
			.unwrap();
		let expected = crate::bash::syntax::print(
			&command.list.items[0].and_or.first.stages[0].cmd,
			PrintStyle::DeclareF,
		);
		let unit = lower_deferred(&command, source, ModeId::Bash, Features::NONE).unwrap();
		assert_eq!(FuncText::of(&unit.funcs[0]).as_slice(), expected);
	}

	#[test]
	fn lazy_function_text_agrees_for_source_and_alias_expanded_syntax() {
		use crate::bash::syntax::{AliasLookup, Features, NO_ALIASES, Parser};

		struct Aliases;
		impl AliasLookup for Aliases {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				(name == b"a").then_some(b"echo x")
			}
		}

		let plain = b"f() { echo x; }\n";
		let expanded = b"f() { a; }\n";
		let plain_cc = Parser::new(plain, Features::NONE, NO_ALIASES)
			.next_command()
			.unwrap()
			.unwrap();
		let expanded_cc = Parser::new(expanded, Features::NONE, &Aliases)
			.next_command()
			.unwrap()
			.unwrap();
		assert!(plain_cc.source_replay);
		assert!(!expanded_cc.source_replay);
		let plain = lower_deferred(&plain_cc, plain, ModeId::Bash, Features::NONE).unwrap();
		let expanded = lower_deferred(&expanded_cc, expanded, ModeId::Bash, Features::NONE).unwrap();
		let plain_text = FuncText::of(&plain.funcs[0]);
		let expanded_text = FuncText::of(&expanded.funcs[0]);
		let clone = plain_text.clone();
		assert!(plain_text.0.text.get().is_none());
		assert!(expanded_text.0.text.get().is_none());
		// Persisting a unit must not force its function records' canonical text.
		let encoded_unit = postcard::to_stdvec(&plain).unwrap();
		let restored: Unit = postcard::from_bytes(&encoded_unit).unwrap();
		assert!(plain_text.0.text.get().is_none());
		let expected = BString::from("f () \n{ \n    echo x\n}");
		assert_eq!(&*plain_text, &expected);
		assert_eq!(&*expanded_text, &expected);
		assert_eq!(&*FuncText::of(&restored.funcs[0]), &expected);
		assert!(clone.0.text.get().is_some());
		let encoded_text = postcard::to_stdvec(&expanded_text).unwrap();
		assert_eq!(encoded_text, postcard::to_stdvec(&expected).unwrap());
		let restored_text: FuncText = postcard::from_bytes(&encoded_text).unwrap();
		assert_eq!(&*restored_text, &expected);
	}

	#[test]
	fn alias_buffer_commands_with_identical_spans_have_distinct_ids() {
		use crate::bash::syntax::{AliasLookup, Features, Parser};

		struct Aliases;
		impl AliasLookup for Aliases {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				(name == b"a").then_some(b":\necho one\necho two")
			}
		}

		let src = b"a\n";
		let mut parser = Parser::new(src, Features::NONE, &Aliases);
		parser.next_command().unwrap().unwrap();
		let first = parser.next_command().unwrap().unwrap();
		let second = parser.next_command().unwrap().unwrap();
		assert_eq!(first.span, second.span);
		assert!(!first.source_replay && !second.source_replay);
		let first = lower_deferred(&first, src, ModeId::Bash, Features::NONE).unwrap();
		let second = lower_deferred(&second, src, ModeId::Bash, Features::NONE).unwrap();
		assert_ne!(first.id, second.id);
	}

	#[test]
	fn literal_and_quoted_words_are_classified_at_lowering() {
		let got = flags(
			b"echo a'b' \"$x\" $y '*' x* ] [a] {a,b} ~/z \"${x}\"* a\\*b \"$(c)\" $((1)) \"a$*\"",
		);
		let want = [
			(true, true),   // echo
			(true, true),   // a'b'
			(false, true),  // "$x": quoted expansion
			(false, false), // $y: unquoted expansion
			(true, true),   // '*': quoted glob character
			(true, false),  // x*
			(true, true),   // ]: no `[`
			(true, false),  // [a]
			(false, false), // {a,b}: brace alternatives depend on `braceexpand`
			(false, true),  // ~/z: tilde-prefix, its result quoted
			(false, false), // "${x}"*
			(true, true),   // a\*b
			(false, true),  // "$(c)"
			(false, false), // $((1)): unquoted
			(false, true),  // "a$*"
		];
		assert_eq!(got, want);
	}
}
