//! AST → bash text.
//!
//! [`PrintStyle::DeclareF`] is a port of bash 5.3's `print_cmd.c`: the AST is
//! viewed as bash's command tree (left-leaning `;`/`&`/`&&`/`||`
//! connections, right-leaning pipes, `elif` as a nested `if`) and printed
//! with the same state machine (`skip_this_indent`, `was_heredoc`, deferred
//! here-document bodies, `semicolon()`), so a function definition prints
//! byte for byte as `declare -f` does. [`PrintStyle::Compact`] is a one-line
//! rendering for logs and tests.
//!
//! Words print as the text bash stores for them: `\newline` removed, `$'…'`
//! decoded and single-quoted, `$"…"` as `"…"`, command substitutions as
//! bash re-prints them (`Comsub.text`), compound assignments with single
//! spaces. zsh words ([`WordPart::Zsh`]) print as their untokenized,
//! unmetafied text; zsh-only constructs (`repeat`, `always`, anonymous
//! functions, `&|`, `>>|`) print in zsh syntax.

use alloc::vec::Vec;

use crate::bash::syntax::{
	ast::*,
	util::{ansi_decode, push_u32, sh_single_quote},
	zsh::tok,
};

/// Output layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PrintStyle {
	/// Multi-line, as bash `declare -f` prints function bodies.
	DeclareF,
	/// Everything on one line (here-document bodies follow the line).
	Compact,
	/// zsh's function text (`functions`, `$functions`, `which`): what the
	/// engine keeps as a zsh function's source (zsh 5.9 `text.c`).
	Zsh,
}

/// Render one command.
///
/// For a function definition with [`PrintStyle::DeclareF`] this is exactly
/// what `declare -f name` prints for it (without the final newline). Other
/// commands print as they would inside a function body at indentation 0.
pub fn print(cmd: &Command, style: PrintStyle) -> Vec<u8> {
	match style {
		PrintStyle::DeclareF => {
			let mut p = Bp::new(false);
			let source_len = (cmd.span.hi - cmd.span.lo) as usize;
			p.out.reserve(source_len * 2);
			if let CommandKind::FuncDef(f) = &cmd.kind {
				p.named_function(f);
			} else {
				p.inside_function_def = 1;
				let node = Node::Cmd { cmd, fl: Fl::default() };
				p.mcsi(Some(&node));
				p.print_deferred_macro(b"");
			}
			p.out
		},
		PrintStyle::Compact => {
			let mut c = Compact::default();
			c.command(cmd);
			c.flush_docs();
			c.out
		},
		PrintStyle::Zsh => match &cmd.kind {
			CommandKind::FuncDef(f) => crate::bash::syntax::zsh::function_text(&f.name, f),
			_ => crate::bash::syntax::zsh::command_text(cmd),
		},
	}
}

/// Render a list (a unit's commands) in `style`.
///
/// With [`PrintStyle::DeclareF`], a list that is one function definition
/// prints as `declare -f` prints it.
pub fn print_list(list: &List, style: PrintStyle) -> Vec<u8> {
	match style {
		PrintStyle::DeclareF => {
			if let [item] = &list.items[..]
				&& item.and_or.rest.is_empty()
				&& !matches!(item.sep, Sep::Amp | Sep::Disown)
			{
				let p = &item.and_or.first;
				if let [stage] = &p.stages[..]
					&& !p.bang
					&& p.time.is_none()
					&& matches!(stage.cmd.kind, CommandKind::FuncDef(_))
				{
					return print(&stage.cmd, PrintStyle::DeclareF);
				}
			}
			let mut p = Bp::new(false);
			p.inside_function_def = 1;
			let node = list_node(list, false);
			p.mcsi(node.as_ref());
			p.print_deferred_macro(b"");
			p.out
		},
		PrintStyle::Compact => {
			let mut c = Compact::default();
			c.list(list);
			c.flush_docs();
			c.out
		},
		PrintStyle::Zsh => {
			if let [item] = &list.items[..]
				&& item.and_or.rest.is_empty()
				&& !matches!(item.sep, Sep::Amp | Sep::Disown)
				&& let [stage] = &item.and_or.first.stages[..]
				&& !item.and_or.first.bang
				&& item.and_or.first.time.is_none()
				&& let CommandKind::FuncDef(f) = &stage.cmd.kind
			{
				return crate::bash::syntax::zsh::function_text(&f.name, f);
			}
			crate::bash::syntax::zsh::getpermtext(list, 0)
		},
	}
}

/// bash `make_command_string` of a command read at top level, as `bash
/// --pretty-print` prints it (obash's `--pretty-print`): a `;` list stays on
/// one line, compound bodies are indented as in `declare -f`.
pub fn command_string(list: &List) -> Vec<u8> {
	let mut p = Bp::new(false);
	let node = list_node(list, false);
	p.mcsi(node.as_ref());
	p.print_deferred_macro(b"");
	p.out
}

/// bash `print_comsub`: the text bash stores for a command substitution
/// body.
pub fn comsub_text(list: &List) -> Vec<u8> {
	let mut p = Bp::new(true);
	let node = list_node(list, true);
	p.mcsi(node.as_ref());
	p.out
}

// ---- command tree ---------------------------------------------------------

/// Command flags bash keeps on a command node.
#[derive(Clone, Copy, Default)]
struct Fl {
	time:   bool,
	posix:  bool,
	invert: bool,
	/// `|&`: an extra `2>&1` redirection.
	stderr: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Conn {
	Amp,
	/// zsh `&|`.
	Disown,
	Pipe,
	And,
	Or,
	Semi,
	Nl,
}

/// A borrowed view of bash's connection tree; child views are made on the
/// stack.
#[derive(Clone, Copy)]
enum Node<'a> {
	Cmd {
		cmd: &'a Command,
		fl:  Fl,
	},
	IfTail {
		arms:      &'a [IfArm],
		else_body: Option<&'a List>,
	},
	List {
		items: &'a [ListItem],
		split: usize,
		nl:    bool,
		tail:  bool,
	},
	/// A left-leaning asynchronous chain after its last non-asynchronous
	/// connection.
	Async {
		items: &'a [ListItem],
		base:  usize,
		nl:    bool,
		tail:  bool,
	},
	AndOr {
		ao:  &'a AndOr,
		end: usize,
	},
	Pipe {
		pipeline: &'a Pipeline,
		start:    usize,
		fl:       Fl,
	},
}

impl Node<'_> {
	const fn flags(&self) -> Fl {
		match self {
			Self::Cmd { fl, .. } | Self::Pipe { fl, .. } => *fl,
			_ => Fl { time: false, posix: false, invert: false, stderr: false },
		}
	}
}

/// A list as bash connects it; newlines remain connections inside command
/// substitutions.
fn list_node(list: &List, nl: bool) -> Option<Node<'_>> {
	list_items(&list.items, nl, true)
}

fn list_items(items: &[ListItem], nl: bool, tail: bool) -> Option<Node<'_>> {
	let last = items.last()?;
	let tail = tail && matches!(last.sep, Sep::Amp | Sep::Disown);
	if items.len() == 1 && !tail {
		return Some(and_or_node(&last.and_or, last.and_or.rest.len()));
	}
	if let Some(at) = items[..items.len() - 1]
		.iter()
		.rposition(|item| !matches!(item.sep, Sep::Amp | Sep::Disown))
	{
		// `connect_async_list` absorbs a background command into the right
		// side of `;`, but not into a newline connection in command
		// substitutions.
		if !(nl && items[at].sep == Sep::Newline) || (!tail && at + 2 == items.len()) {
			return Some(Node::List { items, split: at + 1, nl, tail });
		}
		return Some(Node::Async { items, base: at + 2, nl, tail });
	}
	Some(Node::Async { items, base: 1, nl, tail })
}

fn and_or_node(ao: &AndOr, end: usize) -> Node<'_> {
	if end == 0 {
		pipeline_node(&ao.first, 0)
	} else {
		Node::AndOr { ao, end }
	}
}

fn pipeline_node(pipeline: &Pipeline, start: usize) -> Node<'_> {
	let stage = &pipeline.stages[start];
	let fl = Fl {
		time:   start == 0 && pipeline.time.is_some(),
		posix:  start == 0 && pipeline.time.is_some_and(|t| t.posix),
		invert: start == 0 && pipeline.bang,
		stderr: stage.pipe_stderr,
	};
	if start + 1 == pipeline.stages.len() {
		Node::Cmd { cmd: &stage.cmd, fl }
	} else {
		Node::Pipe { pipeline, start, fl: Fl { stderr: false, ..fl } }
	}
}

fn async_conn(sep: Sep) -> Conn {
	if sep == Sep::Disown {
		Conn::Disown
	} else {
		Conn::Amp
	}
}

// ---- the print_cmd.c port ---------------------------------------------------

const INDENT_AMOUNT: usize = 4;

/// One redirection to print: a real one or the `2>&1` of `|&`.
#[derive(Clone, Copy)]
enum R<'a> {
	Real(&'a Redir),
	StderrDup,
}

/// bash's printer state.
struct Bp<'a> {
	out:                 Vec<u8>,
	indentation:         usize,
	inside_function_def: u32,
	skip_this_indent:    u32,
	was_heredoc:         bool,
	printing_connection: u32,
	printing_comsub:     bool,
	deferred:            Vec<&'a Redir>,
}

impl<'a> Bp<'a> {
	const fn new(comsub: bool) -> Self {
		Self {
			out:                 Vec::new(),
			indentation:         0,
			inside_function_def: 0,
			skip_this_indent:    0,
			was_heredoc:         false,
			printing_connection: 0,
			printing_comsub:     comsub,
			deferred:            Vec::new(),
		}
	}

	fn put(&mut self, s: &[u8]) {
		self.out.extend_from_slice(s);
	}

	fn indent(&mut self, n: usize) {
		self.out.resize(self.out.len() + n, b' ');
	}

	fn newline(&mut self, s: &[u8]) {
		self.put(b"\n");
		self.indent(self.indentation);
		self.put(s);
	}

	fn semicolon(&mut self) {
		let n = self.out.len();
		if (n > 0 && self.out[n - 1] == b'\n')
			|| (n > 1 && self.out[n - 1] == b'&' && self.out[n - 2] == b' ')
			|| self.out.ends_with(b" &|")
		{
			return;
		}
		self.put(b";");
	}

	/// `PRINT_DEFERRED_HEREDOCS`.
	fn print_deferred_macro(&mut self, s: &[u8]) {
		if !self.deferred.is_empty() {
			self.print_deferred(s);
		}
	}

	fn print_deferred(&mut self, s: &[u8]) {
		let show = !s.is_empty() && (s[0] != b';' || s.len() > 1);
		if show {
			self.put(s);
		}
		if !self.deferred.is_empty() {
			let docs = core::mem::take(&mut self.deferred);
			self.heredoc_bodies(&docs);
			if show {
				self.put(b" ");
			}
			self.was_heredoc = true;
		}
	}

	fn heredoc_bodies(&mut self, docs: &[&Redir]) {
		self.put(b"\n");
		for r in docs {
			if let RedirTarget::HereDoc(d) = &r.target {
				self.put(&d.text);
				self.put(&d.delim);
			}
			self.put(b"\n");
		}
		self.was_heredoc = true;
	}

	/// `make_command_string_internal`.
	fn mcsi(&mut self, node: Option<&Node<'a>>) {
		let Some(node) = node else { return };
		if self.skip_this_indent > 0 {
			self.skip_this_indent -= 1;
		} else {
			self.indent(self.indentation);
		}
		let fl = node.flags();
		if fl.time {
			self.put(b"time ");
			if fl.posix {
				self.put(b"-p ");
			}
		}
		if fl.invert {
			self.put(b"! ");
		}
		match node {
			Node::List { items, split, nl, tail } => {
				let first = list_items(&items[..*split], *nl, false).expect("nonempty prefix");
				let second = list_items(&items[*split..], *nl, *tail);
				let conn = if *nl && items[*split - 1].sep == Sep::Newline {
					Conn::Nl
				} else {
					Conn::Semi
				};
				self.connection(&first, second.as_ref(), conn);
			},
			Node::Async { items, base, nl, tail } => {
				if *tail {
					let first = if items.len() == *base {
						list_items(items, *nl, false).expect("nonempty chain")
					} else {
						Node::Async { items, base: *base, nl: *nl, tail: false }
					};
					self.connection(&first, None, async_conn(items.last().expect("chain").sep));
				} else {
					let prefix = &items[..items.len() - 1];
					let first = if prefix.len() == *base {
						list_items(prefix, *nl, false).expect("nonempty prefix")
					} else {
						Node::Async { items: prefix, base: *base, nl: *nl, tail: false }
					};
					let last = &items.last().expect("chain").and_or;
					let second = and_or_node(last, last.rest.len());
					self.connection(
						&first,
						Some(&second),
						async_conn(prefix.last().expect("prefix").sep),
					);
				}
			},
			Node::AndOr { ao, end } => {
				let first = and_or_node(ao, *end - 1);
				let (op, pipeline) = &ao.rest[*end - 1];
				let second = pipeline_node(pipeline, 0);
				let conn = if *op == AndOrOp::And {
					Conn::And
				} else {
					Conn::Or
				};
				self.connection(&first, Some(&second), conn);
			},
			Node::Pipe { pipeline, start, .. } => {
				let stage = &pipeline.stages[*start];
				let first = Node::Cmd {
					cmd: &stage.cmd,
					fl:  Fl { stderr: stage.pipe_stderr, ..Fl::default() },
				};
				let second = pipeline_node(pipeline, *start + 1);
				self.connection(&first, Some(&second), Conn::Pipe);
			},
			Node::IfTail { arms, else_body } => self.if_cmd(arms, *else_body),
			Node::Cmd { cmd, fl } => self.command(cmd, *fl),
		}
	}

	fn connection(&mut self, first: &Node<'a>, second: Option<&Node<'a>>, c: Conn) {
		self.skip_this_indent += 1;
		self.printing_connection += 1;
		self.mcsi(Some(first));
		match c {
			Conn::Amp | Conn::Disown | Conn::Pipe => {
				let s: &[u8] = match c {
					Conn::Amp => b" &",
					Conn::Disown => b" &|",
					_ => b" |",
				};
				self.print_deferred(s);
				if c == Conn::Pipe || second.is_some() {
					self.put(b" ");
					self.skip_this_indent += 1;
				}
			},
			Conn::And | Conn::Or => {
				self.print_deferred(if c == Conn::And { b" && " } else { b" || " });
				if second.is_some() {
					self.skip_this_indent += 1;
				}
			},
			Conn::Semi | Conn::Nl => {
				let ch: &[u8] = if self.printing_comsub && c == Conn::Nl {
					b"\n"
				} else {
					b";"
				};
				let was_newline = self.deferred.is_empty() && !self.was_heredoc && c == Conn::Nl;
				if self.deferred.is_empty() {
					if self.was_heredoc {
						self.was_heredoc = false;
					} else {
						self.put(ch);
					}
				} else {
					self.print_deferred(if self.inside_function_def > 0 {
						b""
					} else {
						b";"
					});
				}
				if self.inside_function_def > 0
					|| (self.printing_comsub && c == Conn::Nl && !was_newline)
				{
					self.put(b"\n");
				} else {
					if c == Conn::Semi {
						self.put(b" ");
					}
					if second.is_some() {
						self.skip_this_indent += 1;
					}
				}
			},
		}
		self.mcsi(second);
		if self.printing_connection == 1 {
			self.print_deferred_macro(b"");
		}
		self.printing_connection -= 1;
	}

	fn command(&mut self, cmd: &'a Command, fl: Fl) {
		match &cmd.kind {
			CommandKind::Simple(s) => {
				self.simple(s, &cmd.redirs, fl.stderr);
				return;
			},
			CommandKind::For(f) => self.for_like(b"for ", f),
			CommandKind::Select(f) => self.for_like(b"select ", f),
			CommandKind::ArithFor(f) => {
				self.put(b"for ((");
				self.arith_part(&f.init.src);
				self.put(b"; ");
				self.arith_part(&f.cond.src);
				self.put(b"; ");
				self.arith_part(&f.step.src);
				self.put(b"))");
				self.loop_body(&f.body);
			},
			CommandKind::Case(c) => self.case(c),
			CommandKind::While(w) => self.while_cmd(w),
			CommandKind::If(i) => self.if_cmd(&i.arms, i.else_body.as_ref()),
			CommandKind::Arith(a) => {
				self.put(b"((");
				self.put(&a.src);
				self.put(b"))");
			},
			CommandKind::Cond(e) => {
				self.put(b"[[ ");
				self.cond(e);
				self.put(b" ]]");
			},
			CommandKind::FuncDef(f) => self.function_def(f),
			CommandKind::Brace(body) => self.group(body),
			CommandKind::Subshell(body) => {
				self.put(b"( ");
				self.skip_this_indent += 1;
				let node = list_node(body, self.printing_comsub);
				self.mcsi(node.as_ref());
				self.print_deferred_macro(b"");
				self.put(b" )");
				self.was_heredoc = false;
			},
			CommandKind::Coproc(c) => {
				self.put(b"coproc ");
				if !matches!(c.body.kind, CommandKind::Simple(_)) {
					self.put(c.name.as_deref().unwrap_or(b"COPROC"));
					self.put(b" ");
				}
				self.skip_this_indent += 1;
				let node = Node::Cmd { cmd: &c.body, fl: Fl::default() };
				self.mcsi(Some(&node));
			},
			CommandKind::Repeat(r) => {
				self.put(b"repeat ");
				word_text(&r.count, &mut self.out);
				self.put(b";");
				self.loop_body(&r.body);
			},
			CommandKind::Try(t) => {
				self.group(&t.body);
				self.put(b" always ");
				self.group(&t.always);
			},
			CommandKind::AnonFunc(a) => {
				self.put(b"() ");
				self.skip_this_indent += 1;
				let node = Node::Cmd { cmd: &a.body, fl: Fl::default() };
				self.mcsi(Some(&node));
				for w in &a.args {
					self.put(b" ");
					word_text(w, &mut self.out);
				}
			},
		}
		if !cmd.redirs.is_empty() || fl.stderr {
			self.put(b" ");
			self.redirection_list(&cmd.redirs, fl.stderr);
		}
	}

	fn arith_part(&mut self, src: &[u8]) {
		self.put(if src.is_empty() { b"1" } else { src });
	}

	fn for_like(&mut self, kw: &[u8], f: &'a For) {
		self.put(kw);
		self.put(&f.var);
		for v in &f.extra_vars {
			self.put(b" ");
			self.put(v);
		}
		self.put(b" in ");
		match &f.words {
			Some(words) => {
				for (i, w) in words.iter().enumerate() {
					if i > 0 {
						self.put(b" ");
					}
					word_text(w, &mut self.out);
				}
			},
			None => self.put(b"\"$@\""),
		}
		self.put(b";");
		self.loop_body(&f.body);
	}

	/// `newline("do\n")` … `newline("done")` of `for` and `select`.
	fn loop_body(&mut self, body: &'a List) {
		self.newline(b"do\n");
		self.indentation += INDENT_AMOUNT;
		let node = list_node(body, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		self.semicolon();
		self.indentation -= INDENT_AMOUNT;
		self.newline(b"done");
	}

	fn group(&mut self, body: &'a List) {
		self.put(b"{ ");
		if self.inside_function_def == 0 {
			self.skip_this_indent += 1;
		} else {
			self.put(b"\n");
			self.indentation += INDENT_AMOUNT;
		}
		let node = list_node(body, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		if self.inside_function_def > 0 {
			self.put(b"\n");
			self.indentation -= INDENT_AMOUNT;
			self.indent(self.indentation);
		} else {
			self.semicolon();
			self.put(b" ");
		}
		self.put(b"}");
		self.was_heredoc = false;
	}

	fn case(&mut self, c: &'a Case) {
		self.put(b"case ");
		word_text(&c.word, &mut self.out);
		self.put(b" in ");
		if !c.arms.is_empty() {
			self.indentation += INDENT_AMOUNT;
			for (i, arm) in c.arms.iter().enumerate() {
				if !self.printing_comsub || i > 0 {
					self.newline(b"");
				}
				if arm.patterns.first().is_some_and(|p| is_lit(p, b"esac")) {
					self.put(b"(");
				}
				for (j, p) in arm.patterns.iter().enumerate() {
					if j > 0 {
						self.put(b" | ");
					}
					word_text(p, &mut self.out);
				}
				self.put(b")\n");
				self.indentation += INDENT_AMOUNT;
				let node = list_node(&arm.body, self.printing_comsub);
				self.mcsi(node.as_ref());
				self.indentation -= INDENT_AMOUNT;
				self.print_deferred_macro(b"");
				self.newline(match arm.term {
					CaseTerm::Break => b";;",
					CaseTerm::FallThrough => b";&",
					CaseTerm::Continue => b";;&",
				});
			}
			self.indentation -= INDENT_AMOUNT;
		}
		self.newline(b"esac");
	}

	fn while_cmd(&mut self, w: &'a While) {
		self.put(if w.until { b"until " } else { b"while " });
		self.skip_this_indent += 1;
		let node = list_node(&w.cond, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		self.semicolon();
		if self.was_heredoc {
			self.indent(self.indentation);
			self.put(b"do\n");
			self.was_heredoc = false;
		} else {
			self.put(b" do\n");
		}
		self.indentation += INDENT_AMOUNT;
		let node = list_node(&w.body, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		self.indentation -= INDENT_AMOUNT;
		self.semicolon();
		self.newline(b"done");
	}

	fn if_cmd(&mut self, arms: &'a [IfArm], else_body: Option<&'a List>) {
		let Some((arm, rest)) = arms.split_first() else {
			return;
		};
		self.put(b"if ");
		self.skip_this_indent += 1;
		let node = list_node(&arm.cond, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		self.semicolon();
		if self.was_heredoc {
			self.indent(INDENT_AMOUNT);
			self.put(b"then\n");
			self.was_heredoc = false;
		} else {
			self.put(b" then\n");
		}
		self.indentation += INDENT_AMOUNT;
		let node = list_node(&arm.body, self.printing_comsub);
		self.mcsi(node.as_ref());
		self.print_deferred_macro(b"");
		self.indentation -= INDENT_AMOUNT;
		let false_case = if rest.is_empty() {
			else_body.and_then(|e| list_node(e, self.printing_comsub))
		} else {
			Some(Node::IfTail { arms: rest, else_body })
		};
		if let Some(fc) = false_case {
			self.semicolon();
			self.newline(b"else\n");
			self.indentation += INDENT_AMOUNT;
			self.mcsi(Some(&fc));
			self.print_deferred_macro(b"");
			self.indentation -= INDENT_AMOUNT;
		}
		self.semicolon();
		self.newline(b"fi");
	}

	fn cond(&mut self, e: &CondExpr) {
		let mut e = e;
		let mut invert = false;
		while let CondExpr::Not(inner) = e {
			invert = !invert;
			e = inner;
		}
		if invert {
			self.put(b"! ");
		}
		match e {
			CondExpr::Group(inner) => {
				self.put(b"( ");
				self.cond(inner);
				self.put(b" )");
			},
			CondExpr::And(a, b) => {
				self.cond(a);
				self.put(b" && ");
				self.cond(b);
			},
			CondExpr::Or(a, b) => {
				self.cond(a);
				self.put(b" || ");
				self.cond(b);
			},
			CondExpr::Unary { op, arg } => {
				self.put(op);
				self.put(b" ");
				word_text(arg, &mut self.out);
			},
			CondExpr::Binary { op, lhs, rhs } => {
				word_text(lhs, &mut self.out);
				self.put(b" ");
				self.put(op);
				self.put(b" ");
				word_text(rhs, &mut self.out);
			},
			CondExpr::Word(w) => {
				self.put(b"-n ");
				word_text(w, &mut self.out);
			},
			CondExpr::Not(_) => {},
		}
	}

	fn simple(&mut self, s: &'a Simple, redirs: &'a [Redir], stderr: bool) {
		let mut any = false;
		for a in &s.assigns {
			if any {
				self.put(b" ");
			}
			any = true;
			assign_text(a, &mut self.out);
		}
		for w in &s.words {
			if any {
				self.put(b" ");
			}
			any = true;
			word_text(w, &mut self.out);
		}
		if !redirs.is_empty() || stderr {
			if any {
				self.put(b" ");
			}
			self.redirection_list(redirs, stderr);
		}
	}

	fn redirection_list(&mut self, redirs: &'a [Redir], stderr: bool) {
		let mut heredocs: Vec<&'a Redir> = Vec::new();
		self.was_heredoc = false;
		let mut all: Vec<R<'a>> = redirs.iter().map(R::Real).collect();
		if stderr {
			all.push(R::StderrDup);
		}
		let n = all.len();
		for (i, r) in all.into_iter().enumerate() {
			match r {
				R::Real(r) if matches!(r.op, RedirOp::HereDoc { .. }) => {
					self.heredoc_header(r);
					heredocs.push(r);
				},
				R::Real(r) => redirection_text(r, &mut self.out),
				R::StderrDup => self.put(b"2>&1"),
			}
			if i + 1 < n {
				self.put(b" ");
			}
		}
		if !heredocs.is_empty() && self.printing_connection > 0 {
			self.deferred = heredocs;
		} else if !heredocs.is_empty() {
			self.heredoc_bodies(&heredocs);
		}
	}

	fn heredoc_header(&mut self, r: &Redir) {
		let RedirTarget::HereDoc(d) = &r.target else {
			return;
		};
		match &r.fd {
			Some(RedirFd::Var(v)) => {
				self.put(b"{");
				self.put(v);
				self.put(b"}");
			},
			Some(RedirFd::Num(n)) if *n != 0 => push_u32(&mut self.out, *n),
			_ => {},
		}
		self.put(b"<<");
		if matches!(r.op, RedirOp::HereDoc { strip_tabs: true }) {
			self.put(b"-");
		}
		if d.quoted {
			sh_single_quote(&mut self.out, &d.delim);
		} else {
			self.put(&d.delim);
		}
	}

	/// `print_function_def`: a definition nested in a function body.
	fn function_def(&mut self, f: &'a FuncDef) {
		self.put(b"function ");
		self.put(&f.name);
		self.extra_names(f);
		self.put(b" () \n");
		self.indent(self.indentation);
		self.put(b"{ \n");
		self.inside_function_def += 1;
		self.indentation += INDENT_AMOUNT;
		let redirs = self.function_body(&f.body);
		self.print_deferred_macro(b"");
		self.indentation -= INDENT_AMOUNT;
		self.inside_function_def -= 1;
		self.function_close(redirs);
	}

	/// Body of a function: a group prints its contents (its redirections
	/// are returned for after the `}`).
	fn function_body(&mut self, body: &'a Command) -> &'a [Redir] {
		if let CommandKind::Brace(list) = &body.kind {
			let node = list_node(list, self.printing_comsub);
			self.mcsi(node.as_ref());
			&body.redirs
		} else {
			let node = Node::Cmd { cmd: body, fl: Fl::default() };
			self.mcsi(Some(&node));
			&[]
		}
	}

	/// zsh `f g h () …`: the names after the first.
	fn extra_names(&mut self, f: &FuncDef) {
		for n in &f.extra_names {
			self.put(b" ");
			self.put(n);
		}
	}

	fn function_close(&mut self, redirs: &'a [Redir]) {
		if redirs.is_empty() {
			self.newline(b"}");
			self.was_heredoc = false;
		} else {
			self.newline(b"} ");
			self.redirection_list(redirs, false);
		}
	}

	/// `named_function_string` with `FUNC_MULTILINE`: `declare -f`.
	fn named_function(&mut self, f: &'a FuncDef) {
		if crate::bash::syntax::parser::looks_like_assignment(&f.name) {
			self.put(b"function ");
		}
		self.put(&f.name);
		self.extra_names(f);
		self.put(b" () \n");
		self.indentation += INDENT_AMOUNT;
		self.inside_function_def += 1;
		self.put(b"{ \n");
		let redirs = self.function_body(&f.body);
		self.print_deferred_macro(b"");
		self.indentation = 0;
		self.inside_function_def -= 1;
		self.function_close(redirs);
	}
}

fn is_lit(w: &Word, s: &[u8]) -> bool {
	matches!(&w.parts[..], [WordPart::Lit(l)] if l == s)
}

/// A redirection other than a here-document (`print_redirection`).
fn redirection_text(r: &Redir, out: &mut Vec<u8>) {
	let var = |out: &mut Vec<u8>| {
		if let Some(RedirFd::Var(v)) = &r.fd {
			out.push(b'{');
			out.extend_from_slice(v);
			out.push(b'}');
			true
		} else {
			false
		}
	};
	let fd = match r.fd {
		Some(RedirFd::Num(n)) => Some(n),
		_ => None,
	};
	let target = match &r.target {
		RedirTarget::Word(w) => w,
		RedirTarget::HereDoc(_) => return,
	};
	let simple = |out: &mut Vec<u8>, default: u32, op: &[u8]| {
		if !var(out) {
			let n = fd.unwrap_or(default);
			if n != default {
				push_u32(out, n);
			}
		}
		out.extend_from_slice(op);
		word_text(target, out);
	};
	match r.op {
		RedirOp::In => simple(out, 0, b"< "),
		RedirOp::Out => simple(out, 1, b"> "),
		RedirOp::Clobber => simple(out, 1, b">| "),
		RedirOp::Append => simple(out, 1, b">> "),
		RedirOp::AppendClobber => simple(out, 1, b">>| "),
		RedirOp::ReadWrite => simple(out, 0, b"<> "),
		RedirOp::HereString => simple(out, 0, b"<<< "),
		RedirOp::OutErr => {
			out.extend_from_slice(b"&> ");
			word_text(target, out);
		},
		RedirOp::AppendErr => {
			out.extend_from_slice(b"&>> ");
			word_text(target, out);
		},
		RedirOp::OutErrClobber => {
			out.extend_from_slice(b"&>| ");
			word_text(target, out);
		},
		RedirOp::AppendErrClobber => {
			out.extend_from_slice(b"&>>| ");
			word_text(target, out);
		},
		RedirOp::DupIn | RedirOp::DupOut => {
			let input = r.op == RedirOp::DupIn;
			let default = u32::from(!input);
			let op: &[u8] = if input { b"<&" } else { b">&" };
			if is_lit(target, b"-") {
				if !var(out) {
					push_u32(out, fd.unwrap_or(default));
				}
				out.extend_from_slice(b">&-");
			} else if is_fd_number(target) {
				if !var(out) {
					push_u32(out, fd.unwrap_or(default));
				}
				out.extend_from_slice(op);
				word_text(target, out);
			} else {
				let mut text = Vec::new();
				word_text(target, &mut text);
				// A target ending in `-` is a move (`r_move_input_word` …),
				// which bash prints with the fd even when it is the default.
				let moves = text.last() == Some(&b'-');
				if !var(out) {
					let n = fd.unwrap_or(default);
					if moves || n != default {
						push_u32(out, n);
					}
				}
				out.extend_from_slice(op);
				out.extend_from_slice(&text);
			}
		},
		RedirOp::HereDoc { .. } => {},
	}
}

/// A dup target bash lexed as a number.
fn is_fd_number(w: &Word) -> bool {
	match &w.parts[..] {
		[WordPart::Lit(s)] if !s.is_empty() && s.len() <= 10 && s.iter().all(u8::is_ascii_digit) => {
			i32::try_from(s.iter().fold(0u64, |n, &d| n * 10 + u64::from(d - b'0'))).is_ok()
		},
		_ => false,
	}
}

// ---- word text --------------------------------------------------------------

/// Where a part is printed (decides how `$'…'` prints).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
	/// Unquoted word.
	Plain,
	/// Inside `"…"`.
	Dq,
	/// An operator word of a `${…}` inside `"…"`; `quote`: the operator makes
	/// single quotes special (`#`, `%`, `/`, `^`, `,`).
	DqParam { quote: bool },
}

/// The text bash stores for `w`.
pub fn word_text(w: &Word, out: &mut Vec<u8>) {
	parts_ctx(&w.parts, out, Ctx::Plain);
}

/// The text bash stores for a sequence of parts in an unquoted word.
pub fn parts_text(parts: &[WordPart], out: &mut Vec<u8>) {
	parts_ctx(parts, out, Ctx::Plain);
}

/// The text bash stores for an assignment.
pub fn assign_text(a: &Assign, out: &mut Vec<u8>) {
	out.extend_from_slice(&a.name);
	if let Some(i) = &a.index {
		out.push(b'[');
		word_text(i, out);
		out.push(b']');
	}
	out.extend_from_slice(if a.append { b"+=" } else { b"=" });
	match &a.value {
		AssignValue::Scalar(w) => word_text(w, out),
		AssignValue::Array(elems) => elems_text(elems, out),
	}
}

fn elems_text(elems: &[ArrayElem], out: &mut Vec<u8>) {
	out.push(b'(');
	for (i, e) in elems.iter().enumerate() {
		if i > 0 {
			out.push(b' ');
		}
		if let Some(k) = &e.key {
			out.push(b'[');
			word_text(k, out);
			out.extend_from_slice(if e.append { b"]+=" } else { b"]=" });
		}
		word_text(&e.value, out);
	}
	out.push(b')');
}

fn parts_ctx(parts: &[WordPart], out: &mut Vec<u8>, ctx: Ctx) {
	for p in parts {
		part_text(p, out, ctx);
	}
}

fn part_text(p: &WordPart, out: &mut Vec<u8>, ctx: Ctx) {
	match p {
		WordPart::Lit(s) => out.extend_from_slice(s),
		WordPart::Escaped(s) => {
			out.push(b'\\');
			out.extend_from_slice(s);
		},
		WordPart::SQuote(s) => {
			out.push(b'\'');
			out.extend_from_slice(s);
			out.push(b'\'');
		},
		WordPart::DQuote(inner) => {
			out.push(b'"');
			parts_ctx(inner, out, Ctx::Dq);
			out.push(b'"');
		},
		WordPart::AnsiC(raw) => match ctx {
			Ctx::Dq => {
				out.extend_from_slice(b"$'");
				out.extend_from_slice(raw);
				out.push(b'\'');
			},
			Ctx::DqParam { quote: false } => out.extend_from_slice(&ansi_decode(raw)),
			Ctx::Plain | Ctx::DqParam { quote: true } => sh_single_quote(out, &ansi_decode(raw)),
		},
		WordPart::Locale(inner) => {
			out.push(b'"');
			parts_ctx(inner, out, Ctx::Dq);
			out.push(b'"');
		},
		WordPart::Param(p) => param_text(p, out, ctx),
		WordPart::Comsub(c) => match c.kind {
			ComsubKind::Dollar => {
				out.extend_from_slice(b"$(");
				out.extend_from_slice(&c.text);
				out.push(b')');
			},
			ComsubKind::Backtick => {
				out.push(b'`');
				out.extend_from_slice(&c.text);
				out.push(b'`');
			},
			ComsubKind::NoFork | ComsubKind::ValueSub => {
				out.extend_from_slice(b"${");
				out.extend_from_slice(&c.text);
				out.push(b'}');
			},
		},
		WordPart::Arith(a) if a.bracket => {
			out.extend_from_slice(b"$[");
			out.extend_from_slice(&a.src);
			out.push(b']');
		},
		WordPart::Arith(a) => {
			out.extend_from_slice(b"$((");
			out.extend_from_slice(&a.src);
			out.extend_from_slice(b"))");
		},
		WordPart::ProcSub(p) => {
			out.extend_from_slice(if p.output { b">(" } else { b"<(" });
			let text = comsub_text(&p.body);
			if text.first() == Some(&b'(') {
				out.push(b' ');
			}
			out.extend_from_slice(&text);
			out.push(b')');
		},
		WordPart::Compound(elems) => elems_text(elems, out),
		WordPart::BadSubst(text) => out.extend_from_slice(text),
		WordPart::BadComsub(b) => out.extend_from_slice(&b.text),
		WordPart::DroppedQuote => out.push(b'"'),
		WordPart::Zsh(raw) => zsh_text(raw, out),
	}
}

/// The source-like text of a zsh word (zsh `untokenize` then `unmetafy`):
/// tokens become the characters they stand for, quotes included, and
/// `Nularg` is dropped. Used by both printers and the JSON export.
pub fn zsh_text(raw: &[u8], out: &mut Vec<u8>) {
	let mut i = 0;
	while i < raw.len() {
		let c = raw[i];
		i += 1;
		if c == tok::META && i < raw.len() {
			out.push(raw[i] ^ 32);
			i += 1;
		} else if tok::is_tok(c) {
			if let Some(ch) = tok::tok_char(c) {
				out.push(ch);
			}
		} else {
			out.push(c);
		}
	}
}

fn param_name_text(name: &ParamName, out: &mut Vec<u8>) {
	match name {
		ParamName::Var(v) => out.extend_from_slice(v),
		ParamName::Positional(n) => push_u32(out, *n),
		ParamName::Special(s) => out.push(match s {
			Special::At => b'@',
			Special::Star => b'*',
			Special::Count => b'#',
			Special::Status => b'?',
			Special::Flags => b'-',
			Special::ShellPid => b'$',
			Special::LastBg => b'!',
		}),
	}
}

fn param_text(p: &Param, out: &mut Vec<u8>, ctx: Ctx) {
	if !p.braced {
		out.push(b'$');
		param_name_text(&p.name, out);
		return;
	}
	let dq = ctx != Ctx::Plain;
	let word_ctx = |quote: bool| {
		if dq {
			Ctx::DqParam { quote }
		} else {
			Ctx::Plain
		}
	};
	out.extend_from_slice(b"${");
	match &p.op {
		ParamOp::Length => out.push(b'#'),
		ParamOp::Indirect | ParamOp::PrefixNames { .. } => out.push(b'!'),
		_ if p.indirect => out.push(b'!'),
		_ => {},
	}
	param_name_text(&p.name, out);
	match &p.index {
		Some(Subscript::At) => out.extend_from_slice(b"[@]"),
		Some(Subscript::Star) => out.extend_from_slice(b"[*]"),
		Some(Subscript::Expr(w)) => {
			out.push(b'[');
			parts_ctx(&w.parts, out, word_ctx(false));
			out.push(b']');
		},
		None => {},
	}
	let op_word = |out: &mut Vec<u8>, colon: bool, op: u8, w: Option<&Word>| {
		if colon {
			out.push(b':');
		}
		out.push(op);
		if let Some(w) = w {
			parts_ctx(&w.parts, out, word_ctx(false));
		}
	};
	match &p.op {
		ParamOp::None | ParamOp::Length | ParamOp::Indirect => {},
		ParamOp::PrefixNames { star } => out.push(if *star { b'*' } else { b'@' }),
		ParamOp::Default { colon, word } => op_word(out, *colon, b'-', Some(word)),
		ParamOp::Assign { colon, word } => op_word(out, *colon, b'=', Some(word)),
		ParamOp::Error { colon, word } => op_word(out, *colon, b'?', word.as_ref()),
		ParamOp::Alt { colon, word } => op_word(out, *colon, b'+', Some(word)),
		ParamOp::Substr { offset, len } => {
			out.push(b':');
			out.extend_from_slice(&offset.src);
			if let Some(len) = len {
				out.push(b':');
				out.extend_from_slice(&len.src);
			}
		},
		ParamOp::Trim { suffix, longest, pat } => {
			let c = if *suffix { b'%' } else { b'#' };
			out.push(c);
			if *longest {
				out.push(c);
			}
			parts_ctx(&pat.parts, out, word_ctx(true));
		},
		ParamOp::Replace { mode, pat, rep } => {
			out.extend_from_slice(match mode {
				ReplaceMode::First => b"/",
				ReplaceMode::All => b"//",
				ReplaceMode::Prefix => b"/#",
				ReplaceMode::Suffix => b"/%",
			});
			parts_ctx(&pat.parts, out, word_ctx(true));
			if let Some(rep) = rep {
				out.push(b'/');
				parts_ctx(&rep.parts, out, word_ctx(true));
			}
		},
		ParamOp::Case { mode, all, pat } => {
			let c = match mode {
				CaseMode::Upper => b'^',
				CaseMode::Lower => b',',
				CaseMode::Toggle => b'~',
			};
			out.push(c);
			if *all {
				out.push(c);
			}
			if let Some(pat) = pat {
				parts_ctx(&pat.parts, out, word_ctx(*mode != CaseMode::Toggle));
			}
		},
		ParamOp::Transform(op) => {
			out.push(b'@');
			out.push(*op);
		},
	}
	out.push(b'}');
}

// ---- compact one-line form --------------------------------------------------

/// One-line printer: `a; b && c | d`, compound commands on one line.
#[derive(Default)]
struct Compact<'a> {
	out:  Vec<u8>,
	docs: Vec<&'a HereDoc>,
}

impl<'a> Compact<'a> {
	fn put(&mut self, s: &[u8]) {
		self.out.extend_from_slice(s);
	}

	/// Here-document bodies after the line.
	fn flush_docs(&mut self) {
		for d in core::mem::take(&mut self.docs) {
			self.put(b"\n");
			self.put(&d.text);
			self.put(&d.delim);
		}
	}

	fn list(&mut self, list: &'a List) {
		let n = list.items.len();
		for (i, item) in list.items.iter().enumerate() {
			self.and_or(&item.and_or);
			let last = i + 1 == n;
			match item.sep {
				Sep::Amp if last => self.put(b" &"),
				Sep::Amp => self.put(b" & "),
				Sep::Disown if last => self.put(b" &|"),
				Sep::Disown => self.put(b" &| "),
				_ if last => {},
				_ => self.put(b"; "),
			}
		}
	}

	/// A body inside a one-line compound: `a; b; ` (a trailing `&` needs no
	/// `;`).
	fn body(&mut self, list: &'a List) {
		self.list(list);
		if list
			.items
			.last()
			.is_some_and(|it| matches!(it.sep, Sep::Amp | Sep::Disown))
		{
			self.put(b" ");
		} else {
			self.put(b"; ");
		}
	}

	fn and_or(&mut self, ao: &'a AndOr) {
		self.pipeline(&ao.first);
		for (op, p) in &ao.rest {
			self.put(if *op == AndOrOp::And {
				b" && "
			} else {
				b" || "
			});
			self.pipeline(p);
		}
	}

	fn pipeline(&mut self, p: &'a Pipeline) {
		if let Some(t) = p.time {
			self.put(if t.posix { b"time -p " } else { b"time " });
		}
		if p.bang {
			self.put(b"! ");
		}
		for (i, st) in p.stages.iter().enumerate() {
			if i > 0 {
				self.put(b" | ");
			}
			self.command(&st.cmd);
			if st.pipe_stderr {
				self.put(b" 2>&1");
			}
		}
	}

	fn command(&mut self, cmd: &'a Command) {
		match &cmd.kind {
			CommandKind::Simple(s) => {
				let mut any = false;
				for a in &s.assigns {
					if any {
						self.put(b" ");
					}
					any = true;
					assign_text(a, &mut self.out);
				}
				for w in &s.words {
					if any {
						self.put(b" ");
					}
					any = true;
					word_text(w, &mut self.out);
				}
				for r in &cmd.redirs {
					if any {
						self.put(b" ");
					}
					any = true;
					self.redir(r);
				}
				return;
			},
			CommandKind::Brace(body) => {
				self.put(b"{ ");
				self.body(body);
				self.put(b"}");
			},
			CommandKind::Subshell(body) => {
				self.put(b"( ");
				self.list(body);
				self.put(b" )");
			},
			CommandKind::If(i) => {
				for (n, arm) in i.arms.iter().enumerate() {
					self.put(if n == 0 { b"if " } else { b"elif " });
					self.list(&arm.cond);
					self.put(b"; then ");
					self.body(&arm.body);
				}
				if let Some(e) = &i.else_body {
					self.put(b"else ");
					self.body(e);
				}
				self.put(b"fi");
			},
			CommandKind::While(w) => {
				self.put(if w.until { b"until " } else { b"while " });
				self.list(&w.cond);
				self.put(b"; do ");
				self.body(&w.body);
				self.put(b"done");
			},
			CommandKind::For(f) | CommandKind::Select(f) => {
				let kw: &[u8] = if matches!(cmd.kind, CommandKind::For(_)) {
					b"for "
				} else {
					b"select "
				};
				self.put(kw);
				self.put(&f.var);
				for v in &f.extra_vars {
					self.put(b" ");
					self.put(v);
				}
				if let Some(words) = &f.words {
					self.put(b" in");
					for w in words {
						self.put(b" ");
						word_text(w, &mut self.out);
					}
				}
				self.put(b"; do ");
				self.body(&f.body);
				self.put(b"done");
			},
			CommandKind::ArithFor(f) => {
				self.put(b"for ((");
				self.put(&f.init.src);
				self.put(b"; ");
				self.put(&f.cond.src);
				self.put(b"; ");
				self.put(&f.step.src);
				self.put(b")); do ");
				self.body(&f.body);
				self.put(b"done");
			},
			CommandKind::Case(c) => {
				self.put(b"case ");
				word_text(&c.word, &mut self.out);
				self.put(b" in ");
				for arm in &c.arms {
					self.put(b"(");
					for (j, p) in arm.patterns.iter().enumerate() {
						if j > 0 {
							self.put(b" | ");
						}
						word_text(p, &mut self.out);
					}
					self.put(b") ");
					if !arm.body.items.is_empty() {
						self.list(&arm.body);
						self.put(b" ");
					}
					self.put(match arm.term {
						CaseTerm::Break => b";; ",
						CaseTerm::FallThrough => b";& ",
						CaseTerm::Continue => b";;& ",
					});
				}
				self.put(b"esac");
			},
			CommandKind::Arith(a) => {
				self.put(b"((");
				self.put(&a.src);
				self.put(b"))");
			},
			CommandKind::Cond(e) => {
				let mut bp = Bp::new(false);
				bp.cond(e);
				self.put(b"[[ ");
				self.put(&bp.out);
				self.put(b" ]]");
			},
			CommandKind::FuncDef(f) => {
				if f.keyword {
					self.put(b"function ");
				}
				self.put(&f.name);
				for n in &f.extra_names {
					self.put(b" ");
					self.put(n);
				}
				self.put(b" () ");
				self.command(&f.body);
			},
			CommandKind::Coproc(c) => {
				self.put(b"coproc ");
				if let Some(name) = &c.name {
					self.put(name);
					self.put(b" ");
				}
				self.command(&c.body);
			},
			CommandKind::Repeat(r) => {
				self.put(b"repeat ");
				word_text(&r.count, &mut self.out);
				self.put(b"; do ");
				self.body(&r.body);
				self.put(b"done");
			},
			CommandKind::Try(t) => {
				self.put(b"{ ");
				self.body(&t.body);
				self.put(b"} always { ");
				self.body(&t.always);
				self.put(b"}");
			},
			CommandKind::AnonFunc(a) => {
				self.put(b"() ");
				self.command(&a.body);
				for w in &a.args {
					self.put(b" ");
					word_text(w, &mut self.out);
				}
			},
		}
		for r in &cmd.redirs {
			self.put(b" ");
			self.redir(r);
		}
	}

	fn redir(&mut self, r: &'a Redir) {
		match &r.target {
			RedirTarget::HereDoc(d) => {
				let mut bp = Bp::new(false);
				bp.heredoc_header(r);
				self.put(&bp.out);
				self.docs.push(d);
			},
			RedirTarget::Word(_) => redirection_text(r, &mut self.out),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::syntax::{Features, NO_ALIASES, Parser};

	#[test]
	fn borrowed_connections_keep_background_grouping_and_comsub_newlines() {
		let cases: &[(&[u8], &[u8])] = &[
			(
				b"f() { a; b & c & d; e && f || g | h; }",
				b"f () \n{ \n    a;\n    b & c & d;\n    e && f || g | h\n}",
			),
			(
				b"g() { echo $(a; b & c); echo $(a\nb & c); }",
				b"g () \n{ \n    echo $(a; b & c);\n    echo $(a\nb & c)\n}",
			),
		];
		for &(source, expected) in cases {
			let command = Parser::new(source, Features::NONE, NO_ALIASES)
				.next_command()
				.unwrap()
				.unwrap();
			let actual =
				print(&command.list.items[0].and_or.first.stages[0].cmd, PrintStyle::DeclareF);
			assert_eq!(actual, expected, "{}", String::from_utf8_lossy(source));
		}
	}
}
