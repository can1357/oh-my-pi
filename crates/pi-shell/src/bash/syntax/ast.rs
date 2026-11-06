//! The bash 5.3 abstract syntax tree.
//!
//! Byte strings are `Vec<u8>`: bash words are bytes, not UTF-8. Every node an
//! event can point at (and-or lists, pipelines, commands, assignments, words)
//! carries a [`NodeId`], assigned in preorder while parsing, and a [`Span`].
//!
//! The tree covers the whole bash 5.3 grammar; the engine lowers it to IR and
//! the printer turns it back into `declare -f` text.

use alloc::{boxed::Box, vec::Vec};

use serde::{Deserialize, Serialize};

use crate::bash::syntax::span::{NodeId, Span};

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
	/// The commands.
	pub list:                 List,
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

/// A sequence of and-or lists with their terminators.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct List {
	/// Items in order.
	pub items: Vec<ListItem>,
}

/// One and-or list and the separator that followed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListItem {
	/// The and-or list.
	pub and_or: AndOr,
	/// What terminated it.
	pub sep:    Sep,
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

/// `p1 && p2 || p3`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AndOr {
	/// Preorder id.
	pub id:    NodeId,
	/// Source span.
	pub span:  Span,
	/// First pipeline.
	pub first: Pipeline,
	/// Following pipelines with their connectors.
	pub rest:  Vec<(AndOrOp, Pipeline)>,
}

/// Connector inside an and-or list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AndOrOp {
	/// `&&`
	And,
	/// `||`
	Or,
}

/// `[time [-p]] [!] cmd1 | cmd2 |& cmd3`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pipeline {
	/// Preorder id.
	pub id:     NodeId,
	/// Source span.
	pub span:   Span,
	/// Leading `!`: invert the status.
	pub bang:   bool,
	/// Leading `time` keyword.
	pub time:   Option<Time>,
	/// The stages, at least one.
	pub stages: Vec<Stage>,
}

/// The `time` keyword on a pipeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Time {
	/// `time -p`: POSIX output format.
	pub posix: bool,
}

/// One pipeline stage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stage {
	/// The command.
	pub cmd:         Command,
	/// Connected to the next stage with `|&` (stderr joins the pipe).
	pub pipe_stderr: bool,
}

/// A command with its trailing redirections.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
	/// Preorder id.
	pub id:     NodeId,
	/// Source span, redirections included.
	pub span:   Span,
	/// Offset of the token that closes this compound command (`)`, `}`,
	/// `done`, `esac`, `fi`, `))`, `]]`), as the parser read it. `None` when
	/// the command has no closing token (a simple command) or the parser
	/// synthesized it rather than reading it (zsh's implicit groups). The
	/// text an alias expands to has no bytes in the source, so this offset
	/// cannot be derived from the span's end.
	pub close:  Option<u32>,
	/// What kind of command.
	pub kind:   CommandKind,
	/// Redirections in source order.
	pub redirs: Vec<Redir>,
}

/// Every bash command form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandKind {
	/// `a=1 cmd args`
	Simple(Simple),
	/// `{ list; }`
	Brace(List),
	/// `( list )`
	Subshell(List),
	/// `if …; then …; [elif …; then …;] [else …;] fi`
	If(If),
	/// `while …; do …; done` / `until …`
	While(While),
	/// `for name [in words]; do …; done`
	For(For),
	/// `for ((init; cond; step)); do …; done`
	ArithFor(ArithFor),
	/// `select name [in words]; do …; done`
	Select(For),
	/// `case word in pat) …;; esac`
	Case(Case),
	/// `(( expr ))`
	Arith(ArithText),
	/// `[[ expr ]]`
	Cond(CondExpr),
	/// `name () cmd` / `function name [()] cmd`
	FuncDef(FuncDef),
	/// `coproc [NAME] cmd`
	Coproc(Coproc),
	/// zsh `repeat word do …; done` (and its short forms).
	Repeat(Repeat),
	/// zsh `{ list } always { list }`.
	Try(Try),
	/// zsh anonymous function `() cmd [args]` / `function cmd [args]`:
	/// defined and called at once, with its own positional parameters.
	AnonFunc(AnonFunc),
}

/// zsh `repeat word do …; done`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repeat {
	/// The count, evaluated arithmetically once at the start.
	pub count:  Word,
	/// Loop body.
	pub body:   List,
	/// Offset of `do` (or of the `{` of a brace body), as the parser read
	/// it. `None` for a short form that writes neither.
	pub do_pos: Option<u32>,
}

/// zsh `{ try-list } always { always-list }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Try {
	/// The try list.
	pub body:       List,
	/// Runs after the try list however it ended (error, `return`, `break`,
	/// `exit` in a subshell), then that ending resumes.
	pub always:     List,
	/// Offset of the `}` that closes the try list, as the parser read it.
	pub rbrace:     u32,
	/// Offset of `always`, as the parser read it.
	pub always_pos: u32,
}

/// zsh anonymous function.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnonFunc {
	/// Body (a compound command).
	pub body:   Box<Command>,
	/// Arguments: its `$1`…
	pub args:   Vec<Word>,
	/// zsh `function -T { … }`: traced (`PM_TAGGED_LOCAL`).
	pub traced: bool,
}

/// A simple command: assignments, then words.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Simple {
	/// Leading `NAME=value` assignments.
	pub assigns: Vec<Assign>,
	/// Command name and arguments.
	pub words:   Vec<Word>,
	/// zsh: the command word is a reserved word of the `typeset` family
	/// (the lexer's `TYPESET`), which runs its builtin whether or not the
	/// builtin is disabled or a function has its name.
	#[serde(default)]
	pub typeset: bool,
}

/// `if` with its `elif` arms.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct If {
	/// The `if` arm, then each `elif` arm.
	pub arms:      Vec<IfArm>,
	/// The `else` body.
	pub else_body: Option<List>,
	/// Offset of `else`, as the parser read it.
	pub else_pos:  Option<u32>,
}

/// One `if`/`elif` condition with its body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IfArm {
	/// Condition list.
	pub cond:     List,
	/// `then` body.
	pub body:     List,
	/// Offset of the `if` or `elif` that opens this arm, as the parser read
	/// it.
	pub kw_pos:   Option<u32>,
	/// Offset of this arm's `then`, as the parser read it.
	pub then_pos: Option<u32>,
}

/// `while` or `until`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct While {
	/// `until`: loop while the condition fails.
	pub until:  bool,
	/// Condition list.
	pub cond:   List,
	/// Loop body.
	pub body:   List,
	/// Offset of `do` (or of the `{` of zsh's brace body), as the parser
	/// read it.
	pub do_pos: Option<u32>,
}

/// `for`/`select` over words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct For {
	/// Loop variable as written (validated at run time, as bash does).
	pub var:        Vec<u8>,
	/// zsh `for a b c in …`: the loop variables after [`For::var`], each
	/// pass taking that many words (empty in bash grammar).
	pub extra_vars: Vec<Name>,
	/// Span of the variable word.
	pub var_span:   Span,
	/// `in` words; `None` means `"$@"`.
	pub words:      Option<Vec<Word>>,
	/// Loop body.
	pub body:       List,
	/// Offset of `in`, as the parser read it.
	pub in_pos:     Option<u32>,
	/// Offset of `do` (or of the `{` of zsh's brace body), as the parser
	/// read it.
	pub do_pos:     Option<u32>,
	/// The body is a `{ … }` group (zsh's `for x { … }`) rather than
	/// `do … done`.
	pub braces:     bool,
}

/// Arithmetic `for ((init; cond; step))`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArithFor {
	/// Initializer expression.
	pub init:   ArithText,
	/// Condition expression (empty = true).
	pub cond:   ArithText,
	/// Step expression.
	pub step:   ArithText,
	/// Loop body.
	pub body:   List,
	/// Span of the `((init; cond; step))` header, as the parser read it.
	pub header: Span,
	/// Offset of the header's closing `))`, as the parser read it.
	pub rparen: u32,
	/// Offset of `do` (or of the `{` of zsh's brace body), as the parser
	/// read it.
	pub do_pos: Option<u32>,
	/// The body is a `{ … }` group rather than `do … done`.
	pub braces: bool,
}

/// `case word in … esac`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Case {
	/// Subject word.
	pub word:   Word,
	/// Arms in order.
	pub arms:   Vec<CaseArm>,
	/// Offset of `in` (or of the `{` of zsh's brace body), as the parser
	/// read it.
	pub in_pos: Option<u32>,
}

/// One `pat | pat) body ;;` arm.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseArm {
	/// Alternative patterns.
	pub patterns:  Vec<Word>,
	/// Arm body (may be empty).
	pub body:      List,
	/// Span of the `)` that closes the patterns, as the parser read it. An
	/// arm with neither a body nor a terminator ends there, and the text an
	/// alias expands to has no byte after the last pattern to end it at.
	pub rparen:    Option<Span>,
	/// Arm terminator.
	pub term:      CaseTerm,
	/// Span of the terminator as the parser read it. `None` when the arm
	/// ends at `esac` with no terminator written: [`CaseArm::term`] is then
	/// the default, and the source holds no `;;` to point at.
	pub term_span: Option<Span>,
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

/// Arithmetic expression text, evaluated by the engine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArithText {
	/// Span of the expression text.
	pub span:    Span,
	/// Expression bytes as written.
	pub src:     Vec<u8>,
	/// Written as bash's obsolete `$[…]` (printed back that way).
	pub bracket: bool,
}

/// `[[ … ]]` expression.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CondExpr {
	/// `-op word` (`-f file`, `-n str`, …).
	Unary {
		/// Operator, e.g. `-f`.
		op:    Vec<u8>,
		/// Offset of the operator's first byte. The operator's bytes need
		/// not be contiguous there (`-\<newline>z`), so it cannot be found
		/// by searching the source for them.
		op_lo: u32,
		/// Operand.
		arg:   Word,
	},
	/// `lhs op rhs` (`==`, `=~`, `-lt`, `-nt`, …).
	Binary {
		/// Operator.
		op:    Vec<u8>,
		/// Offset of the operator's first byte, as for [`Self::Unary`].
		op_lo: u32,
		/// Left operand.
		lhs:   Word,
		/// Right operand (a pattern for `==`/`!=`, a regex for `=~`).
		rhs:   Word,
	},
	/// A lone word: true when non-empty.
	Word(Word),
	/// `! ! … expr`: a run of `!`s, at least one, kept as one node so its
	/// length sets no recursion depth. The operand is never itself `Not`.
	/// The run holds `1 + rest.len()` of them.
	Not {
		/// Offset of the first `!`.
		lo:   u32,
		/// Offsets of the `!`s after the first, in source order. Empty for
		/// a lone `!`, which allocates nothing.
		rest: Box<[u32]>,
		/// What the run negates.
		expr: Box<Self>,
	},
	/// `a && b && …`: at least two operands in source order, and the
	/// offset of each `&&` between them.
	And(Vec<Self>, Box<[u32]>),
	/// `a || b || …`: at least two operands in source order, and the
	/// offset of each `||` between them.
	Or(Vec<Self>, Box<[u32]>),
	/// `( expr )`, with the offsets of both parentheses.
	Group {
		/// Offset of `(`.
		lparen:    u32,
		/// Offset of `)`.
		rparen:    u32,
		/// Offset after the `)`, as the parser read it. In source text that
		/// is `rparen + 1`; in text an alias expanded it is `rparen`, since
		/// that text has no bytes in the source and every token in it
		/// reports the one position of the aliased word. A consumer must
		/// not add the byte itself: a range that invents it leaves its
		/// parent's.
		rparen_hi: u32,
		/// What they enclose.
		expr:      Box<Self>,
	},
}

/// A name the parser read, with the span it read it at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Name {
	/// The name as written.
	pub text: Vec<u8>,
	/// Where it was read.
	pub span: Span,
}

/// Function definition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FuncDef {
	/// Function name.
	pub name:        Vec<u8>,
	/// Span of the name, as the parser read it.
	pub name_span:   Span,
	/// zsh `f g () { … }` / `function f g { … }`: further names defined
	/// with the same body (empty in bash grammar).
	pub extra_names: Vec<Name>,
	/// Defined with the `function` keyword.
	pub keyword:     bool,
	/// Written with `()` after the names.
	pub parens:      bool,
	/// zsh `function -T name { … }`: defined traced (`PM_TAGGED_LOCAL`).
	pub traced:      bool,
	/// Body (a compound command).
	pub body:        Box<Command>,
}

/// `coproc [NAME] cmd`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coproc {
	/// Explicit name (default `COPROC`), with the span the parser read it
	/// at.
	pub name: Option<Name>,
	/// The coprocess command.
	pub body: Box<Command>,
}

/// `NAME=value`, `NAME+=value`, `NAME[i]=value`, `NAME=(…)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assign {
	/// Preorder id.
	pub id:     NodeId,
	/// Source span.
	pub span:   Span,
	/// Variable name.
	pub name:   Vec<u8>,
	/// Subscript of `NAME[i]=`.
	pub index:  Option<Word>,
	/// `+=`.
	pub append: bool,
	/// Assigned value.
	pub value:  AssignValue,
}

/// Right-hand side of an assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssignValue {
	/// `NAME=word`
	Scalar(Word),
	/// `NAME=(elem …)`
	Array(Vec<ArrayElem>),
}

/// One element of a compound array assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArrayElem {
	/// `[key]=` prefix.
	pub key:    Option<Word>,
	/// `[key]+=value`: append to the element instead of replacing it.
	pub append: bool,
	/// Element value.
	pub value:  Word,
}

/// A redirection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Redir {
	/// Source span.
	pub span:   Span,
	/// Explicit fd (`2>`) or fd variable (`{var}>`); `None` uses the operator
	/// default.
	pub fd:     Option<RedirFd>,
	/// Operator.
	pub op:     RedirOp,
	/// Target word or here-document.
	pub target: RedirTarget,
}

/// Explicit redirection source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RedirFd {
	/// `N>`
	Num(u32),
	/// `{var}>`: allocate an fd ≥ 10 and store it in `var`.
	Var(Vec<u8>),
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

/// What a redirection points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RedirTarget {
	/// A word (file name, fd number, here-string).
	Word(Word),
	/// A here-document body.
	HereDoc(HereDoc),
}

/// A here-document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HereDoc {
	/// Delimiter after quote removal (what ends the document).
	pub delim:     Vec<u8>,
	/// Delimiter word as written (`'EOF'`, `E\OF`), for printing.
	pub delim_raw: Vec<u8>,
	/// The delimiter was quoted: the body is not expanded.
	pub quoted:    bool,
	/// Document text as bash stores it (leading tabs already stripped for
	/// `<<-`), each line with its newline; printed verbatim by `declare -f`.
	///
	/// Unquoted documents are parsed for expansion only when they are
	/// expanded (`parse_text(text, TextMode::HereDoc)`), as bash does, so a
	/// malformed `$(` in a body is a run-time error, not a syntax error.
	pub text:      Vec<u8>,
}

/// A shell word: a sequence of literal, quoted and expansion parts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Word {
	/// Preorder id.
	pub id:    NodeId,
	/// Source span.
	pub span:  Span,
	/// Parts in order; empty for an empty word (`x=`).
	pub parts: Vec<WordPart>,
}

/// One piece of a word.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WordPart {
	/// Unquoted bytes (glob characters, `~` and braces stay active).
	Lit(Vec<u8>),
	/// `\c`: one backslash-quoted character (its bytes, without the backslash).
	Escaped(Vec<u8>),
	/// `'…'`
	SQuote(Vec<u8>),
	/// `"…"`
	DQuote(Vec<Self>),
	/// `$'…'`, raw bytes between the quotes (escapes decoded by the engine).
	AnsiC(Vec<u8>),
	/// `$"…"`
	Locale(Vec<Self>),
	/// `$x`, `${x…}`
	Param(Box<Param>),
	/// `$(…)`, `` `…` ``, `${ …;}`, `${| …;}`
	Comsub(Box<Comsub>),
	/// `$((…))`
	Arith(ArithText),
	/// `<(…)`, `>(…)`
	ProcSub(Box<ProcSub>),
	/// `(elem …)` of a compound array assignment written as an argument of a
	/// declaration builtin (`declare -a a=(1 2)`, `local x=(…)`): the word
	/// is `[Lit("a="), Compound(…)]`.
	Compound(Vec<ArrayElem>),
	/// `${…}` that bash accepts at parse time but rejects when it is
	/// expanded (`${a b}`, `${(f)x}`, `${x@}`): the whole `${…}` text as
	/// bash stores it. Expanding it is the `bad substitution` error.
	BadSubst(Vec<u8>),
	/// A `$(` between the literal single quotes of a `${…}` word inside
	/// `"…"` (`"${a+'$('\'}"`) whose text up to the end of the word does
	/// not parse. bash parses it only when it expands the word; expanding
	/// it is the error.
	BadComsub(Box<BadComsub>),
	/// A `"` between the literal single quotes of a `${…}` word inside
	/// `"…"` (`"${x-'"'y}"`): bash removes it when it expands the word
	/// (`''y`); it prints as written.
	DroppedQuote,
	/// zsh grammar: a whole word as zsh's lexer leaves it (`lex.c`
	/// `gettokstr`): metafied, with zsh's token bytes
	/// ([`crate::bash::syntax::zsh::tok`]) marking unquoted specials and quotes.
	/// The zsh expander (zsh 5.9 `subst.c`) parses `${…}`, `$(…)`, `=(…)`,
	/// globs and quotes from it at run time, as zsh does. In zsh grammar
	/// every word is `[Zsh(bytes)]`, or `[Zsh(b"name="), Compound(…)]` for an
	/// array assignment argument of a `typeset`-family reserved word.
	Zsh(Vec<u8>),
}

/// The deferred error of [`WordPart::BadComsub`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BadComsub {
	/// Source text from `$(` to the end of the `${…}` word.
	pub text: Vec<u8>,
	/// Line of the error counted from the line of the `$(` (1-based); bash
	/// reports ``command substitution: line N`` with N the line of the
	/// expansion plus this.
	pub line: u32,
	/// bash's message (``unexpected EOF while looking for matching `)'``).
	pub msg:  Vec<u8>,
}

/// A parameter expansion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Param {
	/// Which parameter.
	pub name:     ParamName,
	/// `[@]`, `[*]` or `[expr]`.
	pub index:    Option<Subscript>,
	/// Operator applied.
	pub op:       ParamOp,
	/// Written with braces.
	pub braced:   bool,
	/// `${!x<op>}`: the operator applies to the parameter named by the value
	/// of `x` (`${!x:-d}`, `${!x#p}`). Plain `${!x}` is
	/// [`ParamOp::Indirect`] with `indirect` false.
	pub indirect: bool,
}

/// The parameter being expanded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamName {
	/// A variable name.
	Var(Vec<u8>),
	/// `$0`, `$1`, `${10}`.
	Positional(u32),
	/// A special parameter.
	Special(Special),
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

/// Array subscript in a parameter expansion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Subscript {
	/// `[@]`
	At,
	/// `[*]`
	Star,
	/// `[expr]`
	Expr(Word),
}

/// Operator inside `${…}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamOp {
	/// Plain `$x` / `${x}`.
	None,
	/// `${#x}`
	Length,
	/// `${!x}` (or `${!a[@]}`: keys).
	Indirect,
	/// `${!prefix*}` / `${!prefix@}`.
	PrefixNames {
		/// `*` rather than `@`.
		star: bool,
	},
	/// `${x:-w}` / `${x-w}`.
	Default {
		/// With `:` (null counts as unset).
		colon: bool,
		/// Default word.
		word:  Word,
	},
	/// `${x:=w}` / `${x=w}`.
	Assign {
		/// With `:`.
		colon: bool,
		/// Assigned word.
		word:  Word,
	},
	/// `${x:?w}` / `${x?w}`.
	Error {
		/// With `:`.
		colon: bool,
		/// Message word.
		word:  Option<Word>,
	},
	/// `${x:+w}` / `${x+w}`.
	Alt {
		/// With `:`.
		colon: bool,
		/// Alternate word.
		word:  Word,
	},
	/// `${x:off}` / `${x:off:len}`.
	Substr {
		/// Offset expression.
		offset: ArithText,
		/// Length expression.
		len:    Option<ArithText>,
	},
	/// `${x#p}` `${x##p}` `${x%p}` `${x%%p}`.
	Trim {
		/// `%` forms.
		suffix:  bool,
		/// Doubled operator.
		longest: bool,
		/// Pattern.
		pat:     Word,
	},
	/// `${x/p/r}` and its anchored / global forms.
	Replace {
		/// Which occurrences.
		mode:   ReplaceMode,
		/// Offset of the `#` or `%` anchor, as the parser read it; `None`
		/// for the unanchored forms.
		anchor: Option<u32>,
		/// Pattern.
		pat:    Word,
		/// Replacement (`None` deletes).
		rep:    Option<Word>,
	},
	/// `${x^p}` `${x^^p}` `${x,p}` `${x,,p}` `${x~}` `${x~~}`.
	Case {
		/// Which conversion.
		mode: CaseMode,
		/// Doubled operator: every match, not just the first character.
		all:  bool,
		/// Character pattern.
		pat:  Option<Word>,
	},
	/// `${x@op}`: `Q E P A a K k U u L`, with the offset the parser read
	/// the operator letter at.
	Transform {
		/// The operator letter.
		op: u8,
		/// Where it was read.
		at: u32,
	},
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

/// A command substitution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comsub {
	/// Syntax used.
	pub kind: ComsubKind,
	/// Commands inside.
	pub body: List,
	/// Source text between the delimiters (backquoted text is printed
	/// verbatim; the other forms are re-printed from `body`).
	pub text: Vec<u8>,
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

/// A process substitution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcSub {
	/// `>(…)` rather than `<(…)`.
	pub output: bool,
	/// Commands inside.
	pub body:   List,
}
