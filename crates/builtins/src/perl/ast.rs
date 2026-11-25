//! Syntax tree for perlsyn, perldata, perlop, perlsub, perlref, perlobj, perlmod and perlform.

use std::rc::Rc;

use super::value::PStr;

/// Source file or string eval. Locations in its nodes are one-based logical lines.
#[derive(Clone, Debug)]
pub struct Program {
	/// Logical file of the entry point. `#line` directives can change it for subsequent nodes.
	pub file: Rc<str>,
	/// Package in effect on entry (`main` for a file).
	pub package: Rc<str>,
	/// Top-level executable statements and declarations, in source order.
	pub body: Block,
	/// Raw bytes following a `__DATA__` or `__END__` line, if present.
	pub data: Option<DataSection>,
}

/// Source location retained for diagnostics and for `caller`.
#[derive(Clone, Debug)]
pub struct Location {
	/// Logical file, accounting for `#line` directives.
	pub file: Rc<str>,
	/// One-based logical line.
	pub line: u32,
}

/// Raw tail of a file, made visible as a `DATA` handle by the interpreter.
#[derive(Clone, Debug)]
pub struct DataSection {
	/// Package owning the DATA handle (`main` for `__END__`).
	pub package: Rc<str>,
	/// True for `__END__`, whose DATA handle is only installed for the main script.
	pub end: bool,
	/// Uninterpreted bytes, after the marker's newline.
	pub bytes: Vec<u8>,
}

/// A brace-delimited lexical scope (or the top-level scope).
#[derive(Clone, Debug)]
pub struct Block {
	/// Opening brace or start of compilation unit.
	pub location: Location,
	/// Statements in execution order.
	pub stmts: Vec<Stmt>,
}

/// One statement with its logical source location.
#[derive(Clone, Debug)]
pub struct Stmt {
	/// Start of the statement, or its label if present.
	pub location: Location,
	/// Label for loop control and goto, if present.
	pub label: Option<Rc<str>>,
	/// Statement payload.
	pub kind: StmtKind,
}

/// Executable statements and declarations. Expression statements determine block result.
#[derive(Clone, Debug)]
pub enum StmtKind {
	/// Empty `;`.
	Empty,
	/// Evaluate an expression (including variable declarations).
	Expr(Expr),
	/// Bare block, treated as a one-shot loop for loop control.
	Block(Block, Option<Block>),
	/// Conditional branches. A branch's bool negates its condition (`unless`).
	If(Vec<(Expr, bool, Block)>, Option<Block>),
	/// Pre-test while/until; bool negates the test for `until`.
	While(Expr, bool, Block, Option<Block>),
	/// C-style `for(init; condition; step) BLOCK`.
	For(Option<Expr>, Option<Expr>, Option<Expr>, Block, Option<Block>),
	/// `foreach VAR (LIST) BLOCK`; absent variable means `$_`, and elements are aliased.
	/// A target wrapped by `Unary::Reference` aliases the referent of each element.
	Foreach(Option<Expr>, Expr, Block, Option<Block>),
	/// Postfix statement control; a `do BLOCK` under while/until is post-tested.
	Modifier(Box<Stmt>, Modifier, Expr),
	/// Named sub declaration or definition.
	Sub(Subroutine),
	/// Lexical package change (or a package-scoped block).
	Package(Package),
	/// Compile-time use/no, shared with its parse hook to retain source-site identity.
	Use(Rc<Use>),
	/// Special phase block, already reported to the compile-time parse hooks.
	Phase(Phase, Rc<Block>),
	/// Format declaration (perlform); its picture lines went to the compile-time parse hooks.
	Format,
	/// Experimental switch: localize topic and execute body.
	Given(Expr, Block),
	/// Experimental switch arm (`None` for `default`).
	When(Option<Expr>, Block),
	/// Experimental 5.34 `try BLOCK catch ($error) BLOCK`, with a lexical exception variable.
	Try(Block, Expr, Block),
}

/// Postfix statement control keyword.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier {
	/// Conditional on truth.
	If,
	/// Conditional on falsehood.
	Unless,
	/// Pre-test loop, or post-test with `do BLOCK`.
	While,
	/// Negated while.
	Until,
	/// Iterate with the default topic.
	For,
	/// Experimental switch arm.
	When,
}

/// Special `perlmod` phase names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
	/// Run as soon as the block is compiled.
	Begin,
	/// LIFO after compiling the current compilation unit.
	Unitcheck,
	/// LIFO after finishing compilation.
	Check,
	/// FIFO before main execution.
	Init,
	/// LIFO on exit.
	End,
}

/// `package NAME [VERSION] [BLOCK]`.
#[derive(Clone, Debug)]
pub struct Package {
	/// Package name with normalized `::` separators.
	pub name: Rc<str>,
	/// Optional version, retaining the source spelling.
	pub version: Option<PStr>,
	/// Present for lexically bounded package declarations.
	pub block: Option<Block>,
}

/// `use` or `no`: module/version and optional import or unimport list.
#[derive(Clone, Debug)]
pub struct Use {
	/// True for `no`.
	pub negated: bool,
	/// Module name; absent for a standalone minimum Perl version.
	pub module: Option<Rc<str>>,
	/// Version as written, prior to numeric/v-string conversion.
	pub version: Option<PStr>,
	/// Import arguments. `None` means default import; an empty list suppresses import.
	pub args: Option<Expr>,
}

/// Perl `format NAME =` declaration.
#[derive(Clone, Debug)]
pub struct Format {
	/// Format name; defaults to `STDOUT`.
	pub name: Rc<str>,
	/// Unparsed picture/argument lines, ending before the lone dot.
	pub lines: PStr,
}

/// Named or anonymous sub, or a forward declaration with no body.
#[derive(Clone, Debug)]
pub struct Subroutine {
	/// Declared name, unqualified unless explicitly qualified. `None` for anonymous subs.
	pub name: Option<Rc<str>>,
	/// Style of declaration for lexical subs (`my`, `state`, `our`).
	pub scope: Option<DeclKind>,
	/// Prototype payload, not the surrounding parentheses; `None` differs from `Some("")`.
	pub prototype: Option<PStr>,
	/// Signature, if enabled and supplied.
	pub signature: Option<Rc<[Parameter]>>,
	/// Attributes, including `lvalue` and `prototype`.
	pub attributes: Vec<Attribute>,
	/// Definition, or `None` for a forward declaration.
	pub body: Option<Rc<Block>>,
}

impl Subroutine {
	/// Whether the declaration carries Perl's `:lvalue` attribute.
	pub fn is_lvalue(&self) -> bool {
		self.attributes.iter().any(|attr| attr.name.as_ref() == "lvalue")
	}
}

/// One named or unnamed signature parameter.
#[derive(Clone, Debug)]
pub struct Parameter {
	/// `$`, `@` (slurpy) or `%` (slurpy).
	pub sigil: Sigil,
	/// Parameter name, absent when the parameter is deliberately ignored.
	pub name: Option<Rc<str>>,
	/// Default evaluated when its positional argument is omitted.
	pub default: Option<Expr>,
}

/// Perl code or variable attribute.
#[derive(Clone, Debug)]
pub struct Attribute {
	/// Name (e.g. `lvalue`).
	pub name: Rc<str>,
	/// Unparsed parameter text inside the optional parentheses.
	pub args: Option<PStr>,
}

/// An expression with its source location; evaluation context is supplied by its parent.
#[derive(Clone, Debug)]
pub struct Expr {
	/// Source location of the operation or term.
	pub location: Location,
	/// Interpreter-owned resolution cache for this node; the parser always leaves it empty.
	pub cache: NodeCache,
	/// Expression payload.
	pub kind: ExprKind,
}

/// Per-node slots the interpreter fills on first evaluation so later evaluations skip name lookups.
/// Each holds an index plus one into an interpreter-side table; 0 means not resolved yet. Nodes are
/// never cloned during execution, so a slot always describes its own node.
#[derive(Clone, Debug, Default)]
pub struct NodeCache {
	/// Lexical register of a variable node (see `interp::vars::Lexicals`).
	pub lexical: std::cell::Cell<u32>,
	/// Entry in the interpreter's package-variable cache for a variable node.
	pub global: std::cell::Cell<u32>,
}

/// Expression forms. `List` denotes a comma expression; the interpreter supplies context.
#[derive(Clone, Debug)]
pub enum ExprKind {
	/// Signed integer literal.
	Int(i64),
	/// Unsigned integer literal above IV_MAX.
	UInt(u64),
	/// Floating-point literal.
	Float(f64),
	/// Noninterpolated constant string (also used for autoquoted barewords).
	String(PStr),
	/// Version literal: component values, not a decimal float.
	Version(Vec<u32>),
	/// Interpolated string, command substitution, or filename glob pattern.
	Quote(QuoteKind, Vec<QuotePart>),
	/// Match, qr, substitution or transliteration; an unbound op uses the topic.
	Regex(RegexExpr),
	/// Qualified or unqualified bareword, resolved using lexical hints and symbol table.
	Bareword(Rc<str>),
	/// Literal `__FILE__`, `__LINE__`, `__PACKAGE__`, or `__SUB__`.
	Special(Special),
	/// A variable; the sigil specifies the slot, not the spelling of its name.
	Variable(Sigil, Rc<str>),
	/// Dereference an expression as the given slot type.
	Deref(Sigil, Box<Expr>),
	/// Element or slice; `Select` describes how to obtain the aggregate.
	Select(Box<Expr>, Select, Box<Expr>),
	/// Anonymous array reference `[LIST]`.
	Array(Box<Expr>),
	/// Anonymous hash reference `{LIST}`.
	Hash(Box<Expr>),
	/// Comma/fat-comma list; empty for `()`.
	List(Vec<Expr>),
	/// Parenthesized expression, preserving list context in lvalues/repetition.
	Group(Box<Expr>),
	/// `my`, `our`, `state`, `local`, optionally with a type and attributes.
	Declare(DeclKind, Option<Rc<str>>, Box<Expr>, Vec<Attribute>),
	/// Prefix or suffix operator.
	Unary(Unary, Box<Expr>),
	/// Binary operator, including assignments and regex binding.
	Binary(Binary, Box<Expr>, Box<Expr>),
	/// Chained comparisons; each middle operand is computed only once.
	CompareChain(Box<Expr>, Vec<(Binary, Expr)>),
	/// Ternary `COND ? YES : NO`.
	Conditional(Box<Expr>, Box<Expr>, Box<Expr>),
	/// Function/builtin/method invocation; consult `Call` for special argument slots.
	Call(Call),
	/// Anonymous subroutine expression.
	Sub(Box<Subroutine>),
	/// `do BLOCK` / `eval BLOCK` (bool indicates eval).
	Block(Block, bool),
	/// `<>`/`<<>>`, literal `<FH>`, or scalar `<$fh>`.
	Readline(Readline),
	/// File test, e.g. `-f $file`. `None` selects the implicit operand.
	/// Directly nested tests share the inner operand rather than testing an intermediate boolean.
	FileTest(u8, Option<Box<Expr>>),
	/// Yada-yada statement `...`, which throws “Unimplemented” if executed.
	Yada,
}

/// Sigil or postfix dereference slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Sigil {
	/// Scalar `$`.
	Scalar,
	/// Array `@`.
	Array,
	/// Hash `%`.
	Hash,
	/// Code `&`.
	Code,
	/// Typeglob `*`.
	Glob,
	/// Last array index `$#`.
	LastIndex,
}

/// Indexed access type. The base is stored as spelled (`$a` for `$a[0]`).
/// Non-arrow selection resolves the named slot indicated by this selector (array for `$a[0]`),
/// or uses the referent directly when the base is a prefix dereference (`$$ref[0]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Select {
	/// `$a[n]` or `$ref->[n]` (arrow/implicit chained dereference if true).
	ArrayElement(bool),
	/// `$h{k}` or `$ref->{k}` (arrow/implicit chained dereference if true).
	HashElement(bool),
	/// `@a[@idx]` or `$ref->@[...]`; bool selects arrow dereference.
	ArraySlice(bool),
	/// `@h{@keys}` or `$ref->@{...}`; bool selects arrow dereference.
	HashSlice(bool),
	/// `%a[@idx]` or `$ref->%[...]`; bool selects arrow dereference.
	ArrayPairs(bool),
	/// `%h{@keys}` or `$ref->%{...}`; bool selects arrow dereference.
	HashPairs(bool),
	/// `(LIST)[LIST]` (not an lvalue array variable).
	ListSlice,
	/// `*glob{SLOT}`.
	GlobSlot,
}

/// Declaration operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeclKind {
	/// Lexical, initialized for each entry into its scope.
	My,
	/// Lexical alias to a package variable.
	Our,
	/// Persistent lexical with one-time initializer.
	State,
	/// Temporarily change a dynamically scoped value.
	Local,
}

/// Literal keyword with compilation metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Special {
	/// The node's logical file.
	File,
	/// The node's logical line.
	Line,
	/// The package in effect at this point in the source.
	Package(Rc<str>),
	/// Reference to the currently executing subroutine, or undef.
	Sub,
}

/// Angle-bracket input source.
#[derive(Clone, Debug)]
pub enum Readline {
	/// Magical ARGV stream (`true` for safe `<<>>`, which opens only filenames).
	Argv(bool),
	/// Bare named handle (`STDIN`, `FH`, etc.).
	Handle(Rc<str>),
	/// Scalar handle or filename used as a handle name.
	Scalar(Box<Expr>),
}

/// Quote-like expression, distinguishing stringification, shell execution and globbing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteKind {
	/// `"..."`, `qq`, or interpolated here-doc.
	String,
	/// Backticks, `qx`, or backtick-quoted here-doc.
	Command,
	/// Filename expansion via `<pattern>`.
	Glob,
}

/// A part of an interpolated value, in evaluation order.
#[derive(Clone, Debug)]
pub enum QuotePart {
	/// Literal text; string escapes have already been processed, regex escapes have not.
	Literal(PStr),
	/// Embedded expression. True means list context and join with `$"`; false means scalar.
	Expr(Expr, bool),
	/// A case change or `quotemeta` escape.
	Case(CaseChange),
	/// Regex action `(?{ BLOCK })` or dynamic subpattern `(??{ BLOCK })` (true for dynamic),
	/// with the full group spelling retained for diagnostics and stringification.
	RegexCode(Rc<Block>, bool, PStr),
}

/// Transliteration source, before range and escape expansion.
#[derive(Clone, Debug)]
pub struct Transliteration {
	/// Search list, with delimiter-escape processing only.
	pub search: PStr,
	/// Replacement list, with delimiter-escape processing only.
	pub replacement: PStr,
	/// True for a single-quoted search list, whose ranges and escapes are literal.
	pub literal_search: bool,
	/// True for a single-quoted replacement list.
	pub literal_replacement: bool,
}

/// Case/quoting escape controlling subsequent interpolated text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseChange {
	/// `\U`: uppercase until terminated.
	Upper,
	/// `\L`: lowercase until terminated.
	Lower,
	/// `\u`: uppercase the next character.
	UpperNext,
	/// `\l`: lowercase the next character.
	LowerNext,
	/// `\Q`: quotemeta until terminated.
	Quote,
	/// `\F`: Unicode foldcase until terminated.
	Fold,
	/// `\E`: end active long-running change.
	End,
}

/// Pattern operation, with its original modifiers and interpolation template.
#[derive(Clone, Debug)]
pub struct RegexExpr {
	/// Flavor determines value, mutation and default subject behavior.
	pub kind: RegexKind,
	/// Regex template. Unused for transliteration.
	pub pattern: Vec<QuotePart>,
	/// Suffix modifiers, excluding delimiter punctuation.
	pub modifiers: Vec<u8>,
}

/// Match, pattern constructor, substitution, or transliteration.
#[derive(Clone, Debug)]
pub enum RegexKind {
	/// `m//` or `//`; true for once-per-reset `m??`.
	Match(bool),
	/// `qr//` constructs a regex value.
	Compile,
	/// `s///` with an interpolated replacement.
	Substitute(Vec<QuotePart>),
	/// `s///e`; execute the replacement block, then string-eval `count - 1` times.
	SubstituteEval(Block, usize),
	/// `tr///` or `y///`: raw lists for the transliteration compiler.
	Transliterate(Transliteration),
}

/// Unary operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unary {
	/// Prefix plus.
	Plus,
	/// Prefix minus.
	Minus,
	/// `!` or low-precedence `not`.
	Not,
	/// `~`.
	Complement,
	/// `~.` when the bitwise feature is active.
	StringComplement,
	/// Reference constructor `\`.
	Reference,
	/// Prefix increment.
	PreInc,
	/// Prefix decrement.
	PreDec,
	/// Postfix increment.
	PostInc,
	/// Postfix decrement.
	PostDec,
}

/// Binary operator. Logical, range, assignment, and match binding require evaluator context.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binary {
	/// Arithmetic `+`.
	Add,
	/// Arithmetic `-`.
	Sub,
	/// Arithmetic `*`.
	Mul,
	/// Arithmetic `/`.
	Div,
	/// Arithmetic `%`.
	Mod,
	/// Exponentiation `**`.
	Pow,
	/// Concatenation `.`.
	Concat,
	/// String or list repetition `x`.
	Repeat,
	/// Left shift.
	Shl,
	/// Right shift.
	Shr,
	/// Numeric/legacy bitwise and.
	BitAnd,
	/// Numeric/legacy bitwise or.
	BitOr,
	/// Numeric/legacy bitwise xor.
	BitXor,
	/// String bitwise and.
	StrAnd,
	/// String bitwise or.
	StrOr,
	/// String bitwise xor.
	StrXor,
	/// Numeric equality.
	Eq,
	/// Numeric inequality.
	Ne,
	/// Numeric less than.
	Lt,
	/// Numeric less than or equal.
	Le,
	/// Numeric greater than.
	Gt,
	/// Numeric greater than or equal.
	Ge,
	/// Numeric three-way compare.
	Cmp,
	/// String equality.
	StrEq,
	/// String inequality.
	StrNe,
	/// String less than.
	StrLt,
	/// String less than or equal.
	StrLe,
	/// String greater than.
	StrGt,
	/// String greater than or equal.
	StrGe,
	/// String three-way compare.
	StrCmp,
	/// `isa` class test.
	Isa,
	/// Experimental smartmatch.
	SmartMatch,
	/// Short-circuit and (`&&`/`and`).
	And,
	/// Short-circuit or (`||`/`or`).
	Or,
	/// Logical exclusive or.
	Xor,
	/// Short-circuit defined-or `//`.
	DefinedOr,
	/// List range or scalar flip-flop; true for `...`.
	Range(bool),
	/// Bind a subject to regex operation; true for `!~`.
	Bind(bool),
	/// Simple assignment.
	Assign,
	/// Compound assignment; its payload is one of `Compound`.
	AssignOp(Compound),
}

/// Operation applied in a compound assignment (`OP=`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compound {
	/// `+=`.
	Add,
	/// `-=`.
	Sub,
	/// `*=`.
	Mul,
	/// `/=`.
	Div,
	/// `%=`.
	Mod,
	/// `**=`.
	Pow,
	/// `.=`.
	Concat,
	/// `x=`.
	Repeat,
	/// `<<=`.
	Shl,
	/// `>>=`.
	Shr,
	/// `&=`.
	BitAnd,
	/// `|=`.
	BitOr,
	/// `^=`.
	BitXor,
	/// `&.=`.
	StrAnd,
	/// `|.=`.
	StrOr,
	/// `^.=`.
	StrXor,
	/// `&&=`.
	And,
	/// `||=`.
	Or,
	/// `//=`.
	DefinedOr,
}

/// An invocation including syntax-specific arguments outside the ordinary argument list.
#[derive(Clone, Debug)]
pub struct Call {
	/// Named function, builtin, code reference or method target.
	pub target: CallTarget,
	/// Ordinary arguments, evaluated in the callee's specified context; `None` means omitted.
	pub args: Option<Box<Expr>>,
	/// Special slot (print handle, explicit program, sort comparator, or map/grep body).
	pub slot: Option<CallSlot>,
	/// Effective prototype at the call site, if applied. Ampersand syntax suppresses it.
	pub prototype: Option<PStr>,
}

/// Callee identity and dispatch type.
#[derive(Clone, Debug)]
pub enum CallTarget {
	/// Intrinsic, retaining the distinction between explicit core and global override namespaces.
	Builtin(Builtin, BuiltinOrigin),
	/// Named subroutine. Bool means `&` syntax (including inherited `@_` without an arg list).
	Named(Rc<str>, bool),
	/// Code reference. Bool means `&` syntax (including inherited `@_` without an arg list).
	Code(Box<Expr>, bool),
	/// Method invocation, with invocant and a static or computed method name.
	Method(Box<Expr>, Method),
}

/// Qualification of an intrinsic name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinOrigin {
	/// Ordinary unqualified builtin name, which may use a global override.
	Implicit,
	/// `CORE::name`, bypassing overrides.
	Core,
	/// `CORE::GLOBAL::name`, explicitly naming the global override slot.
	Global,
}

/// Method name or code reference expression.
#[derive(Clone, Debug)]
pub enum Method {
	/// May include a package, `SUPER::`, or an explicit `Package::SUPER::` prefix.
	Name(Rc<str>),
	/// `->$method` (scalar name or code reference).
	Dynamic(Box<Expr>),
}

/// Non-list argument with special evaluation rules.
#[derive(Clone, Debug)]
pub enum CallSlot {
	/// `print/printf/say FH LIST` or `{$fh}`/`$fh` forms.
	Handle(Box<Expr>),
	/// `system/exec {program} ARGV`.
	Program(Box<Expr>),
	/// `sort SUBNAME LIST` (symbolic comparator).
	Comparator(Box<Expr>),
	/// Bare block for sort/map/grep or an anonymous code argument from a prototype.
	Block(Rc<Block>),
	/// `map EXPR, LIST` / `grep EXPR, LIST`.
	Expression(Box<Expr>),
}

/// How an unparenthesized builtin takes its arguments (perlop / perlfunc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinClass {
	/// Bare nullary term; never consumes a following expression.
	Nullary,
	/// Named unary operator; right operand ends at a comparison or lower-precedence operator.
	Unary,
	/// Named unary operator with a default for an omitted operand.
	OptionalUnary,
	/// List operator extending through comma but not through `and`/`or`/`not`.
	List,
	/// List operator with an optional leading filehandle slot.
	Print,
	/// List operator with optional separate program expression in braces.
	Exec,
	/// List operator with optional named/block comparison routine.
	Sort,
	/// List operator with a mandatory leading block or comma-delimited expression.
	Transform,
	/// Named unary or block form (`eval`, `do`).
	BlockUnary,
	/// Control transfer with optional label; `goto` also accepts `&NAME` and an expression.
	Control,
	/// Dedicated syntax handled outside ordinary builtin-call parsing.
	Syntax,
}

macro_rules! builtins {
	($($class:ident: $( $variant:ident = $name:literal ),+ $(,)? ;)+) => {
		/// Typed perlfunc intrinsic or syntax keyword, suitable for interpreter dispatch.
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
		pub enum Builtin {
			$($(
				#[doc = concat!("Perl `", $name, "`.")]
				$variant,
			)+)+
		}

		impl Builtin {
			/// Look up an unqualified intrinsic by its case-sensitive source name.
			pub fn from_name(name: &str) -> Option<Self> {
				match name { $($($name => Some(Self::$variant),)+)+ _ => None }
			}
			/// Unqualified Perl spelling of this intrinsic.
			pub fn name(self) -> &'static str {
				match self { $($(Self::$variant => $name,)+)+ }
			}
			/// Unparenthesized parse class, independent of runtime operand defaults.
			pub fn class(self) -> BuiltinClass {
				match self { $($(Self::$variant => BuiltinClass::$class,)+)+ }
			}
		}
	};
}

impl Builtin {
	/// Ordinary argument indices that accept a bare named handle or a handle expression.
	/// Output slots for `open`, `pipe`, `socket`, etc. may autovivify.
	/// The handle outside the list for print/printf/say is a `CallSlot::Handle` instead.
	pub fn filehandle_arguments(self, arity: usize) -> &'static [usize] {
		use Builtin as B;
		match self {
			B::Accept | B::Pipe | B::Socketpair => &[0, 1],
			B::Bind | B::Binmode | B::Close | B::Closedir | B::Connect | B::Eof | B::Fcntl |
			B::Fileno | B::Flock | B::Getc | B::Getpeername | B::Getsockname | B::Getsockopt |
			B::Ioctl | B::Listen | B::Lstat | B::Open | B::Opendir | B::Read | B::Readdir |
			B::Readline | B::Recv | B::Rewinddir | B::Seek | B::Seekdir | B::Send | B::Setsockopt |
			B::Shutdown | B::Socket | B::Stat | B::Sysopen | B::Sysread | B::Sysseek |
			B::Syswrite | B::Tell | B::Telldir | B::Truncate | B::Write => &[0],
			B::Select if arity == 1 => &[0],
			_ => &[],
		}
	}

	/// Whether the default for an omitted operand is the current topic (`$_`).
	pub fn defaults_to_topic(self) -> bool {
		use Builtin as B;
		matches!(self, B::Abs | B::Alarm | B::Chomp | B::Chop | B::Chr | B::Chroot | B::Cos |
			B::Defined | B::Eval | B::Evalbytes | B::Exp | B::Fc | B::Glob | B::Hex | B::Int |
			B::Lc | B::Lcfirst | B::Length | B::Log | B::Lstat | B::Mkdir | B::Oct | B::Ord |
			B::Pos | B::Print | B::Prototype | B::Quotemeta | B::Readlink | B::Readpipe | B::Ref |
			B::Require | B::Rmdir | B::Say | B::Sin | B::Split | B::Sqrt | B::Stat | B::Study |
			B::Uc | B::Ucfirst)
	}
}

builtins! {
	Nullary: Break="break", Continue="continue", Endgrent="endgrent", Endhostent="endhostent", Endnetent="endnetent", Endprotoent="endprotoent", Endpwent="endpwent", Endservent="endservent", Fork="fork", Getgrent="getgrent", Gethostent="gethostent", Getlogin="getlogin", Getnetent="getnetent", Getppid="getppid", Getprotoent="getprotoent", Getpwent="getpwent", Getservent="getservent", Time="time", Times="times", Wait="wait", Wantarray="wantarray", Setgrent="setgrent", Setpwent="setpwent";
	Unary: Dbmclose="dbmclose", Closedir="closedir", Delete="delete", Each="each", Exists="exists", Fileno="fileno", Getgrgid="getgrgid", Getgrnam="getgrnam", Gethostbyname="gethostbyname", Getnetbyname="getnetbyname", Getpeername="getpeername", Getprotobyname="getprotobyname", Getpwnam="getpwnam", Getpwuid="getpwuid", Getsockname="getsockname", Keys="keys", Lock="lock", Readdir="readdir", Rewinddir="rewinddir", Scalar="scalar", Sethostent="sethostent", Setnetent="setnetent", Setprotoent="setprotoent", Setservent="setservent", Telldir="telldir", Tied="tied", Untie="untie", Values="values";
	OptionalUnary: Alarm="alarm", Evalbytes="evalbytes", Readpipe="readpipe", Rmdir="rmdir", Umask="umask", Abs="abs", Caller="caller", Chdir="chdir", Chr="chr", Chroot="chroot", Close="close", Cos="cos", Defined="defined", Eof="eof", Exit="exit", Exp="exp", Fc="fc", Getc="getc", Getpgrp="getpgrp", Gmtime="gmtime", Hex="hex", Int="int", Lc="lc", Lcfirst="lcfirst", Length="length", Localtime="localtime", Log="log", Lstat="lstat", Oct="oct", Ord="ord", Pop="pop", Pos="pos", Prototype="prototype", Quotemeta="quotemeta", Rand="rand", Readline="readline", Readlink="readlink", Ref="ref", Require="require", Reset="reset", Shift="shift", Sin="sin", Sleep="sleep", Sqrt="sqrt", Srand="srand", Stat="stat", Study="study", Tell="tell", Uc="uc", Ucfirst="ucfirst", Undef="undef", Write="write";
	List: Getprotobynumber="getprotobynumber", Glob="glob", Accept="accept", Atan2="atan2", Bind="bind", Binmode="binmode", Bless="bless", Chmod="chmod", Chomp="chomp", Chop="chop", Chown="chown", Connect="connect", Crypt="crypt", Dbmopen="dbmopen", Die="die", Fcntl="fcntl", Flock="flock", Formline="formline", Gethostbyaddr="gethostbyaddr", Getnetbyaddr="getnetbyaddr", Getpriority="getpriority", Getservbyname="getservbyname", Getservbyport="getservbyport", Getsockopt="getsockopt", Import="import", Index="index", Ioctl="ioctl", Join="join", Kill="kill", Link="link", Listen="listen", Mkdir="mkdir", Msgctl="msgctl", Msgget="msgget", Msgrcv="msgrcv", Msgsnd="msgsnd", Open="open", Opendir="opendir", Pack="pack", Pipe="pipe", Push="push", Read="read", Recv="recv", Rename="rename", Return="return", Reverse="reverse", Rindex="rindex", Seek="seek", Seekdir="seekdir", Select="select", Semctl="semctl", Semget="semget", Semop="semop", Send="send", Setpgrp="setpgrp", Setpriority="setpriority", Setsockopt="setsockopt", Shmctl="shmctl", Shmget="shmget", Shmread="shmread", Shmwrite="shmwrite", Shutdown="shutdown", Socket="socket", Socketpair="socketpair", Splice="splice", Split="split", Sprintf="sprintf", Substr="substr", Symlink="symlink", Syscall="syscall", Sysopen="sysopen", Sysread="sysread", Sysseek="sysseek", Syswrite="syswrite", Tie="tie", Truncate="truncate", Unlink="unlink", Unpack="unpack", Unshift="unshift", Utime="utime", Vec="vec", Waitpid="waitpid", Warn="warn";
	Print: Print="print", Printf="printf", Say="say";
	Exec: Exec="exec", System="system";
	Sort: Sort="sort";
	Transform: Grep="grep", Map="map";
	BlockUnary: Do="do", Eval="eval";
	Control: Dump="dump", Goto="goto", Last="last", Next="next", Redo="redo";
	Syntax: File="__FILE__", Line="__LINE__", CurrentPackage="__PACKAGE__", CurrentSub="__SUB__", Format="format", Local="local", My="my", No="no", Our="our", Package="package", State="state", Sub="sub", Use="use", Q="q", Qq="qq", Qw="qw", Qx="qx", Qr="qr", Match="m", Substitute="s", Tr="tr", Y="y";
}
