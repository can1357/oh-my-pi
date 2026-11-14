//! Parse results ([`Program`], [`CompleteCommand`]) and the small value
//! types the syntax tree ([`crate::bash::syntax::tree`]) shares: separators,
//! connectors, redirection operators and the parameter-expansion modes.

use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::bash::syntax::span::Span;

/// A whole source parsed without aliases
/// ([`parse_all`](crate::bash::syntax::parse_all)).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
	/// Top-level commands in source order.
	pub commands: Vec<CompleteCommand>,
}

/// One top-level command: the unit the engine compiles and runs before it
/// parses the next one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompleteCommand {
	/// Source bytes of the command, without the terminating newline.
	pub span:                 Span,
	/// 1-based line of `span.lo`.
	pub line:                 u32,
	/// The commands: node `root` (a `List`) of `tree`.
	pub tree:                 crate::bash::syntax::tree::Tree,
	pub root:                 crate::bash::syntax::tree::Id<crate::bash::syntax::tree::shape::List>,
	/// Number of [`NodeId`]s assigned in this unit (ids are `0..node_count`).
	pub node_count:           u32,
	/// Alias substitutions applied while parsing, in order; replaying them
	/// reproduces the same tree and ids.
	pub aliases:              Vec<AliasUse>,
	/// Source bytes reproduce this tree without an alias input buffer.
	pub(crate) source_replay: bool,
	/// Non-fatal diagnostics bash prints while parsing this command (e.g.
	/// ``warning: here-document at line 2 delimited by end-of-file (wanted
	/// `EOF')``).
	pub warnings:             Vec<ParseWarning>,
}

impl CompleteCommand {
	/// The commands.
	pub const fn list(&self) -> crate::bash::syntax::tree::List<'_> {
		crate::bash::syntax::tree::List::of(&self.tree, self.root)
	}
}

/// A non-fatal parser diagnostic, printed by the engine as
/// `NAME: line N: <bash_msg>` before the command runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseWarning {
	/// 1-based line bash reports.
	pub line:     u32,
	/// Message body as bash 5.3 prints it.
	pub bash_msg: Vec<u8>,
}

/// One alias substitution performed by the parser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AliasUse {
	/// Alias name.
	pub name:  Vec<u8>,
	/// Replacement text at the time of parsing.
	pub value: Vec<u8>,
}

/// Terminator of a list item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Sep {
	/// `;`
	Semi,
	/// `&`: run asynchronously.
	Amp,
	/// A newline.
	Newline,
	/// Nothing: the last item before a closing keyword or end of input.
	None,
	/// zsh `&|` / `&!`: run asynchronously and disown at once.
	Disown,
}

/// Connector inside an and-or list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AndOrOp {
	/// `&&`
	And,
	/// `||`
	Or,
}

/// The `time` keyword on a pipeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Time {
	/// `time -p`: POSIX output format.
	pub posix: bool,
}

/// Terminator of a `case` arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaseTerm {
	/// `;;`: leave the `case`.
	Break,
	/// `;&`: run the next arm's body unconditionally.
	FallThrough,
	/// `;;&`: test the next arm's patterns.
	Continue,
}

/// Redirection operators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RedirOp {
	/// `<`
	In,
	/// `>`
	Out,
	/// `>>`
	Append,
	/// `>|`
	Clobber,
	/// `<>`
	ReadWrite,
	/// `<&`
	DupIn,
	/// `>&`
	DupOut,
	/// `&>`
	OutErr,
	/// `&>>`
	AppendErr,
	/// `<<` or `<<-` (`strip_tabs`).
	HereDoc {
		/// `<<-`: strip leading tabs.
		strip_tabs: bool,
	},
	/// `<<<`
	HereString,
	/// zsh `>>|` / `>>!`: append, creating the file even under `noclobber`.
	AppendClobber,
	/// zsh `&>|` / `>&|` / `&>!` / `>&!`.
	OutErrClobber,
	/// zsh `&>>|` / `>>&|` / `&>>!` / `>>&!`.
	AppendErrClobber,
}

/// Special parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Special {
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

/// Occurrence selector of `${x/p/r}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReplaceMode {
	/// `/`: first match.
	First,
	/// `//`: every match.
	All,
	/// `/#`: anchored at the start.
	Prefix,
	/// `/%`: anchored at the end.
	Suffix,
}

/// Conversion of `${x^…}` and relatives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaseMode {
	/// `^`
	Upper,
	/// `,`
	Lower,
	/// `~`
	Toggle,
}

/// The four command-substitution forms of bash 5.3.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ComsubKind {
	/// `$(…)`
	Dollar,
	/// `` `…` ``
	Backtick,
	/// `${ …;}`: runs in the current shell, captures stdout.
	NoFork,
	/// `${| …;}`: runs in the current shell, value is `$REPLY`.
	ValueSub,
}
