//! Commands and their payloads.
//!
//! | kind       | children                                   | fields                            |
//! |------------|--------------------------------------------|-----------------------------------|
//! | `Command`  | `[payload, redirs…]`                       | span; `x`: [`Ck`]; flag `PIPE_STDERR` |
//! | `Simple`   | `[assigns…, words…]`                       | `c`: assignment count; flag `TYPESET` |
//! | `If`       | `[cond, body]` per arm, then `else` body   | flag `HAS_ELSE`                   |
//! | `While`    | `[cond, body]`                             | flag `UNTIL`                      |
//! | `For`      | `[var, body, words?, extra vars…]`         | span of the variable; flag `HAS_WORDS` |
//! | `Words`    | words                                      |                                   |
//! | `ArithFor` | `[init, cond, step, body]`                 |                                   |
//! | `Case`     | `[word, arms…]`                            |                                   |
//! | `CaseArm`  | `[body, patterns…]`                        | `x`: [`CaseTerm`] code            |
//! | `FuncDef`  | `[body, name, extra names…]`               | flags `KEYWORD`, `TRACED`         |
//! | `Coproc`   | `[body, name?]`                            |                                   |
//! | `Repeat`   | `[count, body]`                            |                                   |
//! | `Try`      | `[body, always]`                           |                                   |
//! | `AnonFunc` | `[body, args…]`                            | flag `TRACED`                     |
//! | `Arith`    | `[text]`                                   | span; flag `BRACKET`              |
//!
//! Names and variables are text nodes.

use super::{
	At, Code, CondExpr, Id, K, List, Mark, NONE, Node, Seq, Tree,
	code::code_enum,
	flag, opt,
	shape::{self, Arg, Command as CommandS, List as ListS, Redir as RedirS, Word as WordS},
	view,
};
use crate::bash::syntax::{
	ast::CaseTerm,
	span::{NodeId, Span},
};

pub(super) const CMD_PAYLOAD: usize = 0;
pub(super) const CMD_REDIRS: usize = 1;
const WHILE_COND: usize = 0;
const WHILE_BODY: usize = 1;
pub(super) const FOR_VAR: usize = 0;
pub(super) const FOR_BODY: usize = 1;
pub(super) const FOR_WORDS: usize = 2;
const ARITH_FOR_INIT: usize = 0;
const ARITH_FOR_COND: usize = 1;
const ARITH_FOR_STEP: usize = 2;
const ARITH_FOR_BODY: usize = 3;
const CASE_WORD: usize = 0;
const CASE_ARMS: usize = 1;
pub(super) const ARM_BODY: usize = 0;
pub(super) const ARM_PATTERNS: usize = 1;
const FUNC_BODY: usize = 0;
const FUNC_NAME: usize = 1;
const FUNC_EXTRA_NAMES: usize = 2;
const COPROC_BODY: usize = 0;
const COPROC_NAME: usize = 1;
const REPEAT_COUNT: usize = 0;
const REPEAT_BODY: usize = 1;
const TRY_BODY: usize = 0;
const TRY_ALWAYS: usize = 1;
const ANON_BODY: usize = 0;
const ANON_ARGS: usize = 1;
const ARITH_TEXT: usize = 0;

const PIPE_STDERR: u8 = 1;
const TYPESET: u8 = 1;
const HAS_ELSE: u8 = 1;
const UNTIL: u8 = 1;
pub(super) const HAS_WORDS: u8 = 1;
const KEYWORD: u8 = 1;
const TRACED: u8 = 2;
const BRACKET: u8 = 1;

view!(
	/// A command with its trailing redirections (also a pipeline stage).
	Command: Command,
	/// `a=1 cmd args`.
	Simple: Simple,
	/// `if` with its `elif` arms.
	If: If,
	/// `while` / `until`.
	While: While,
	/// `for` / `select` over words.
	For: For,
	/// `for ((init; cond; step))`.
	ArithFor: ArithFor,
	/// `case word in … esac`.
	Case: Case,
	/// One case arm.
	CaseArm: CaseArm,
	/// Function definition.
	FuncDef: FuncDef,
	/// `coproc [NAME] cmd`.
	Coproc: Coproc,
	/// zsh `repeat`.
	Repeat: Repeat,
	/// zsh `{ } always { }`.
	Try: Try,
	/// zsh anonymous function.
	AnonFunc: AnonFunc,
	/// Arithmetic text.
	ArithText: Arith,
);

/// Every command form, one row each: the command kind ([`Ck`], the `x`
/// of a `Command` node), the payload's handle ([`Payload`]) and its view
/// ([`CommandKind`]) all come from this list.
macro_rules! command_kinds {
	($($kind:ident: $shape:ident => $view:ident),* $(,)?) => {
		code_enum! {
			/// Command kinds (`x` of a [`K::Command`] node).
			pub enum Ck { $($kind),* }
		}

		/// What a command runs: its kind with the payload node.
		#[derive(Clone, Copy, Debug)]
		pub enum Payload { $($kind(Id<shape::$shape>)),* }

		/// Every command form, as views.
		#[derive(Clone, Copy, Debug)]
		pub enum CommandKind<'t> { $($kind($view<'t>)),* }

		impl Payload {
			/// The command kind and the payload node.
			const fn split(self) -> (Ck, u32) {
				match self { $(Self::$kind(i) => (Ck::$kind, i.index())),* }
			}

			/// The payload of command node `c` of `t`.
			fn of(t: &Tree, c: u32) -> Self {
				let p = t.kids_of(c)[CMD_PAYLOAD];
				match Ck::of(t.node(c).x) { $(Ck::$kind => Self::$kind(Id::new(p))),* }
			}

			/// The payload as a view of `t`.
			const fn view(self, t: &Tree) -> CommandKind<'_> {
				match self { $(Self::$kind(i) => CommandKind::$kind($view(At::new(t, i.index())))),* }
			}
		}
	};
}

command_kinds!(
	Simple: Simple => Simple,
	Brace: List => List,
	Subshell: List => List,
	If: If => If,
	While: While => While,
	For: For => For,
	ArithFor: ArithFor => ArithFor,
	Select: For => For,
	Case: Case => Case,
	Arith: Arith => ArithText,
	Cond: Cond => CondExpr,
	FuncDef: FuncDef => FuncDef,
	Coproc: Coproc => Coproc,
	Repeat: Repeat => Repeat,
	Try: Try => Try,
	AnonFunc: AnonFunc => AnonFunc,
);

// ─── building ──────────────────────────────────────────────────────────

impl Tree {
	/// A command running `payload` with redirections `redirs`.
	pub fn command(&mut self, span: Span, payload: Payload, redirs: &[Id<RedirS>]) -> Id<CommandS> {
		let mark = self.open::<RedirS>();
		for &r in redirs {
			self.kid(mark, r);
		}
		self.command_at(span, payload, mark)
	}

	/// A command running `payload` with the redirections collected since
	/// `mark`.
	pub fn command_at(&mut self, span: Span, payload: Payload, mark: Mark<RedirS>) -> Id<CommandS> {
		let (ck, p) = payload.split();
		self.kid_first(mark, p);
		Id::new(self.close(Node { x: ck.code(), ..Node::spanning(K::Command, span) }, mark))
	}

	/// A simple command over the assignments, words and redirections
	/// collected since `mark`, in any order: kept apart by node kind.
	pub fn simple_at(&mut self, span: Span, mark: Mark<Arg>) -> Id<CommandS> {
		let a = self.kids.len() as u32;
		let mut assigns = 0u32;
		for want in [K::Assign, K::Word] {
			for k in mark.0..self.scratch.len() {
				let v = self.scratch[k];
				if self.nodes[v as usize].kind == want {
					self.kids.push(v);
					assigns += u32::from(want == K::Assign);
				}
			}
		}
		let s =
			self.push(Node { c: assigns, a, b: self.kids.len() as u32 - a, ..Node::new(K::Simple) });
		let a = self.kids.len() as u32;
		self.kids.push(s);
		for k in mark.0..self.scratch.len() {
			let v = self.scratch[k];
			if self.nodes[v as usize].kind == K::Redir {
				self.kids.push(v);
			}
		}
		self.drop_opened(mark);
		let n = Node {
			x: Ck::Simple.code(),
			a,
			b: self.kids.len() as u32 - a,
			..Node::spanning(K::Command, span)
		};
		Id::new(self.push(n))
	}

	/// A simple command's payload: assignments first, then words.
	pub fn simple(
		&mut self,
		assigns: &[Id<shape::Assign>],
		words: &[Id<WordS>],
		typeset: bool,
	) -> Id<shape::Simple> {
		let mark = self.open::<()>();
		self.scratch.extend(assigns.iter().map(|a| a.index()));
		self.scratch.extend(words.iter().map(|w| w.index()));
		let n =
			Node { flags: flag(typeset, TYPESET), c: assigns.len() as u32, ..Node::new(K::Simple) };
		Id::new(self.close(n, mark))
	}

	/// Mark command `cmd` as followed by `|&`.
	pub fn set_pipe_stderr(&mut self, cmd: Id<CommandS>) {
		self.nodes[cmd.index() as usize].flags |= PIPE_STDERR;
	}

	/// `if` over `cond, body, …` lists collected since `mark`, then the
	/// `else` body.
	pub fn if_at(&mut self, else_body: Option<Id<ListS>>, mark: Mark<ListS>) -> Id<shape::If> {
		if let Some(e) = else_body {
			self.kid(mark, e);
		}
		let n = Node { flags: flag(else_body.is_some(), HAS_ELSE), ..Node::new(K::If) };
		Id::new(self.close(n, mark))
	}

	pub fn while_(&mut self, until: bool, cond: Id<ListS>, body: Id<ListS>) -> Id<shape::While> {
		let mut k = [NONE; 2];
		k[WHILE_COND] = cond.index();
		k[WHILE_BODY] = body.index();
		Id::new(self.push_with(Node { flags: flag(until, UNTIL), ..Node::new(K::While) }, &k))
	}

	/// A list of words (the `in` words of `for`, a declaration's elements).
	pub fn words(&mut self, words: &[Id<WordS>]) -> Id<shape::Words> {
		let run = self.run(words);
		Id::new(self.push_over(Node::new(K::Words), run))
	}

	/// A list of the words collected since `mark`.
	pub fn words_at(&mut self, mark: Mark<WordS>) -> Id<shape::Words> {
		Id::new(self.close(Node::new(K::Words), mark))
	}

	/// `for`/`select`: the variables (zsh takes several), their span, the
	/// `in` words when written (collected since `words`; `None` for `"$@"`)
	/// and the body.
	pub fn for_at(
		&mut self,
		vars: &[&[u8]],
		var_span: Span,
		words: Option<Mark<WordS>>,
		body: Id<ListS>,
	) -> Id<shape::For> {
		let words = words.map(|m| self.words_at(m));
		let var = self.text(vars[0]);
		let mark = self.open::<()>();
		debug_assert_eq!((FOR_VAR, FOR_BODY, FOR_WORDS), (0, 1, 2));
		self.scratch.extend([var.index(), body.index()]);
		if let Some(w) = words {
			self.scratch.push(w.index());
		}
		for v in &vars[1..] {
			let t = self.text(v);
			self.scratch.push(t.index());
		}
		Id::new(self.close(for_node(var_span, words.is_some()), mark))
	}

	pub fn arith_for(
		&mut self,
		init: Id<shape::Arith>,
		cond: Id<shape::Arith>,
		step: Id<shape::Arith>,
		body: Id<ListS>,
	) -> Id<shape::ArithFor> {
		let mut k = [NONE; 4];
		k[ARITH_FOR_INIT] = init.index();
		k[ARITH_FOR_COND] = cond.index();
		k[ARITH_FOR_STEP] = step.index();
		k[ARITH_FOR_BODY] = body.index();
		Id::new(self.push_with(Node::new(K::ArithFor), &k))
	}

	/// A `case` arm over the patterns collected since `mark`.
	pub fn case_arm_at(
		&mut self,
		body: Id<ListS>,
		term: CaseTerm,
		mark: Mark<WordS>,
	) -> Id<shape::CaseArm> {
		debug_assert_eq!(ARM_BODY, 0, "the body goes before the patterns");
		self.kid_first(mark, body.index());
		Id::new(self.close(Node { x: term.code(), ..Node::new(K::CaseArm) }, mark))
	}

	/// A `case` over `word` and the arms collected since `mark`.
	pub fn case_at(&mut self, word: Id<WordS>, mark: Mark<shape::CaseArm>) -> Id<shape::Case> {
		debug_assert_eq!(CASE_WORD, 0, "the word goes before the arms");
		self.kid_first(mark, word.index());
		Id::new(self.close(Node::new(K::Case), mark))
	}

	/// A function definition: names (zsh defines several at once) and the
	/// body command.
	pub fn funcdef(
		&mut self,
		names: &[&[u8]],
		keyword: bool,
		traced: bool,
		body: Id<CommandS>,
	) -> Id<shape::FuncDef> {
		let mark = self.open::<()>();
		debug_assert_eq!((FUNC_BODY, FUNC_NAME), (0, 1));
		self.scratch.push(body.index());
		for n in names {
			let t = self.text(n);
			self.scratch.push(t.index());
		}
		let flags = flag(keyword, KEYWORD) | flag(traced, TRACED);
		Id::new(self.close(Node { flags, ..Node::new(K::FuncDef) }, mark))
	}

	pub fn coproc(&mut self, name: Option<&[u8]>, body: Id<CommandS>) -> Id<shape::Coproc> {
		let mut k = [NONE; 2];
		k[COPROC_NAME] = opt(name.map(|n| self.text(n)));
		k[COPROC_BODY] = body.index();
		Id::new(self.push_with(Node::new(K::Coproc), &k))
	}

	pub fn repeat(&mut self, count: Id<WordS>, body: Id<ListS>) -> Id<shape::Repeat> {
		let mut k = [NONE; 2];
		k[REPEAT_COUNT] = count.index();
		k[REPEAT_BODY] = body.index();
		Id::new(self.push_with(Node::new(K::Repeat), &k))
	}

	pub fn try_(&mut self, body: Id<ListS>, always: Id<ListS>) -> Id<shape::Try> {
		let mut k = [NONE; 2];
		k[TRY_BODY] = body.index();
		k[TRY_ALWAYS] = always.index();
		Id::new(self.push_with(Node::new(K::Try), &k))
	}

	pub fn anon_func(
		&mut self,
		body: Id<CommandS>,
		args: &[Id<WordS>],
		traced: bool,
	) -> Id<shape::AnonFunc> {
		let mark = self.open::<()>();
		debug_assert_eq!((ANON_BODY, ANON_ARGS), (0, 1));
		self.scratch.push(body.index());
		self.scratch.extend(args.iter().map(|a| a.index()));
		Id::new(self.close(Node { flags: flag(traced, TRACED), ..Node::new(K::AnonFunc) }, mark))
	}

	/// Arithmetic text `src` written at `span`.
	pub fn arith(&mut self, span: Span, src: &[u8], bracket: bool) -> Id<shape::Arith> {
		let mut k = [NONE; 1];
		k[ARITH_TEXT] = self.text(src).index();
		let n = Node { flags: flag(bracket, BRACKET), ..Node::spanning(K::Arith, span) };
		Id::new(self.push_with(n, &k))
	}

	/// A command with no words (zsh's empty pipeline of `!`, `coproc`,
	/// `time`).
	pub fn empty_command(&mut self, span: Span) -> Id<CommandS> {
		let s = self.simple(&[], &[], false);
		self.command(span, Payload::Simple(s), &[])
	}

	/// A brace group around list `l`.
	pub fn group(&mut self, span: Span, l: Id<ListS>) -> Id<CommandS> {
		self.command(span, Payload::Brace(l), &[])
	}

	/// Pipeline `p` as one command: its lone stage, or a group around it.
	pub fn pipeline_command(&mut self, p: Id<shape::Pipeline>) -> Id<CommandS> {
		if let Some(stage) = self.lone_stage(p) {
			return stage;
		}
		let span = self.span_of(p.index());
		let l = self.pipeline_list(p);
		self.group(span, l)
	}

	/// List `l` as one command: its lone pipeline as a command, or a group.
	pub fn list_command(&mut self, l: Id<ListS>, span: Span) -> Id<CommandS> {
		match self.lone_pipeline(l) {
			Some(p) => self.pipeline_command(p),
			None => self.group(span, l),
		}
	}

	/// Command `c` with `extra` redirections after its own, spanning `span`.
	pub fn with_redirs(
		&mut self,
		c: Id<CommandS>,
		extra: &[Id<RedirS>],
		span: Span,
	) -> Id<CommandS> {
		self.with_more_redirs(c, span, |t, mark| {
			for &r in extra {
				t.kid(mark, r);
			}
		})
	}

	/// Command `c` rebuilt over `span` with its own redirections, then the
	/// ones `more` collects.
	fn with_more_redirs(
		&mut self,
		c: Id<CommandS>,
		span: Span,
		more: impl FnOnce(&mut Self, Mark<RedirS>),
	) -> Id<CommandS> {
		let payload = Payload::of(self, c.index());
		let mark = self.open::<RedirS>();
		self.kid_children(mark, c.index(), CMD_REDIRS);
		more(self, mark);
		self.command_at(span, payload, mark)
	}

	/// zsh keeps redirections written on a function definition with the
	/// function (`execfuncdef`'s `redir_prog`): they move onto the body, a
	/// group around it if it is not one. The command with them moved.
	pub fn attach_function_redirs(&mut self, cmd: Id<CommandS>) -> Id<CommandS> {
		let c = Command::of(self, cmd);
		let (Payload::FuncDef(fd), false) = (c.payload(), c.redirs().is_empty()) else {
			return cmd;
		};
		let span = c.span();
		let body = FuncDef::of(self, fd).body();
		let (body_span, body) = (body.span(), body.handle());
		let body = if let Payload::Brace(_) = Payload::of(self, body.index()) {
			body
		} else {
			let p = self.pipeline(body_span, false, None, &[body]);
			let l = self.pipeline_list(p);
			self.group(body_span, l)
		};
		let body = self.with_more_redirs(body, body_span, |t, mark| {
			t.kid_children(mark, cmd.index(), CMD_REDIRS);
		});
		let mark = self.open::<()>();
		debug_assert_eq!(FUNC_BODY, 0, "the body goes before the names");
		self.scratch.push(body.index());
		self.kid_children(mark, fd.index(), FUNC_BODY + 1);
		let fd = Id::new(self.close(*self.node(fd.index()), mark));
		self.command(span, Payload::FuncDef(fd), &[])
	}
}

const fn for_node(var_span: Span, has_words: bool) -> Node {
	Node { flags: flag(has_words, HAS_WORDS), ..Node::spanning(K::For, var_span) }
}

// ─── reading ───────────────────────────────────────────────────────────

impl<'t> Command<'t> {
	pub fn id(self) -> NodeId {
		self.0.id()
	}

	pub fn span(self) -> Span {
		self.0.span()
	}

	/// Connected to the next stage with `|&`.
	pub fn pipe_stderr(self) -> bool {
		self.0.flag(PIPE_STDERR)
	}

	pub fn redirs(self) -> Seq<'t, super::Redir<'t>> {
		self.0.seq(CMD_REDIRS)
	}

	pub fn kind(self) -> CommandKind<'t> {
		self.payload().view(self.0.t)
	}

	/// The payload, as a handle to build on.
	pub fn payload(self) -> Payload {
		Payload::of(self.0.t, self.0.i)
	}
}

impl<'t> Simple<'t> {
	pub fn assigns(self) -> Seq<'t, super::Assign<'t>> {
		let n = self.0.n().c as usize;
		self.0.seq::<super::Assign<'t>>(0).take(n)
	}

	pub fn words(self) -> Seq<'t, super::Word<'t>> {
		self.0.seq(self.0.n().c as usize)
	}

	pub fn typeset(self) -> bool {
		self.0.flag(TYPESET)
	}
}

/// One `if`/`elif` condition with its body.
#[derive(Clone, Copy, Debug)]
pub struct IfArm<'t> {
	pub cond: super::List<'t>,
	pub body: super::List<'t>,
}

impl<'t> If<'t> {
	pub fn arms(self) -> impl ExactSizeIterator<Item = IfArm<'t>> + DoubleEndedIterator + 't {
		let t = self.0.t;
		let mut k = self.0.kids();
		if self.0.flag(HAS_ELSE) {
			k = &k[..k.len() - 1];
		}
		k.as_chunks::<2>().0.iter().map(move |c| IfArm {
			cond: super::List(At::new(t, c[0])),
			body: super::List(At::new(t, c[1])),
		})
	}

	pub fn else_body(self) -> Option<super::List<'t>> {
		self
			.0
			.flag(HAS_ELSE)
			.then(|| super::List(At::new(self.0.t, *self.0.kids().last().expect("else body"))))
	}
}

impl<'t> While<'t> {
	pub fn until(self) -> bool {
		self.0.flag(UNTIL)
	}

	pub fn cond(self) -> super::List<'t> {
		super::List(self.0.must(WHILE_COND, "condition"))
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(WHILE_BODY, "body"))
	}
}

impl<'t> For<'t> {
	/// The loop variable as written.
	pub fn var(self) -> &'t [u8] {
		self.0.must(FOR_VAR, "loop variable").bytes()
	}

	pub fn var_span(self) -> Span {
		self.0.span()
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(FOR_BODY, "body"))
	}

	/// `in` words; `None` means `"$@"`.
	pub fn words(self) -> Option<Seq<'t, super::Word<'t>>> {
		self
			.0
			.flag(HAS_WORDS)
			.then(|| self.0.must(FOR_WORDS, "words").seq(0))
	}

	/// zsh `for a b c in …`: the variables after the first.
	pub fn extra_vars(self) -> impl ExactSizeIterator<Item = &'t [u8]> + 't {
		let from = if self.0.flag(HAS_WORDS) {
			FOR_WORDS + 1
		} else {
			FOR_WORDS
		};
		let t = self.0.t;
		self.0.kids()[from..]
			.iter()
			.map(move |&i| At::new(t, i).bytes())
	}
}

impl<'t> ArithFor<'t> {
	pub fn init(self) -> ArithText<'t> {
		ArithText(self.0.must(ARITH_FOR_INIT, "init"))
	}

	pub fn cond(self) -> ArithText<'t> {
		ArithText(self.0.must(ARITH_FOR_COND, "cond"))
	}

	pub fn step(self) -> ArithText<'t> {
		ArithText(self.0.must(ARITH_FOR_STEP, "step"))
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(ARITH_FOR_BODY, "body"))
	}
}

impl<'t> Case<'t> {
	pub fn word(self) -> super::Word<'t> {
		super::Word(self.0.must(CASE_WORD, "subject"))
	}

	pub fn arms(self) -> Seq<'t, CaseArm<'t>> {
		self.0.seq(CASE_ARMS)
	}
}

impl<'t> CaseArm<'t> {
	pub fn patterns(self) -> Seq<'t, super::Word<'t>> {
		self.0.seq(ARM_PATTERNS)
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(ARM_BODY, "body"))
	}

	pub fn term(self) -> CaseTerm {
		CaseTerm::of(self.0.n().x)
	}
}

impl<'t> FuncDef<'t> {
	pub fn name(self) -> &'t [u8] {
		self.0.must(FUNC_NAME, "name").bytes()
	}

	pub fn extra_names(self) -> impl ExactSizeIterator<Item = &'t [u8]> + 't {
		let t = self.0.t;
		self.0.kids()[FUNC_EXTRA_NAMES..]
			.iter()
			.map(move |&i| At::new(t, i).bytes())
	}

	pub fn keyword(self) -> bool {
		self.0.flag(KEYWORD)
	}

	pub fn traced(self) -> bool {
		self.0.flag(TRACED)
	}

	pub fn body(self) -> Command<'t> {
		Command(self.0.must(FUNC_BODY, "body"))
	}
}

impl<'t> Coproc<'t> {
	pub fn name(self) -> Option<&'t [u8]> {
		self.0.kid(COPROC_NAME).map(At::bytes)
	}

	pub fn body(self) -> Command<'t> {
		Command(self.0.must(COPROC_BODY, "body"))
	}
}

impl<'t> Repeat<'t> {
	pub fn count(self) -> super::Word<'t> {
		super::Word(self.0.must(REPEAT_COUNT, "count"))
	}

	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(REPEAT_BODY, "body"))
	}
}

impl<'t> Try<'t> {
	pub fn body(self) -> super::List<'t> {
		super::List(self.0.must(TRY_BODY, "body"))
	}

	pub fn always(self) -> super::List<'t> {
		super::List(self.0.must(TRY_ALWAYS, "always"))
	}
}

impl<'t> AnonFunc<'t> {
	pub fn body(self) -> Command<'t> {
		Command(self.0.must(ANON_BODY, "body"))
	}

	pub fn args(self) -> Seq<'t, super::Word<'t>> {
		self.0.seq(ANON_ARGS)
	}

	pub fn traced(self) -> bool {
		self.0.flag(TRACED)
	}
}

impl<'t> ArithText<'t> {
	pub fn span(self) -> Span {
		self.0.span()
	}

	/// Expression bytes as written.
	pub fn src(self) -> &'t [u8] {
		self.0.must(ARITH_TEXT, "expression").bytes()
	}

	pub fn bracket(self) -> bool {
		self.0.flag(BRACKET)
	}
}
