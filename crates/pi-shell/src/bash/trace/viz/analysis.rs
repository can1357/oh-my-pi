//! Static facts over announced canonical syntax; runtime observations never
//! enter this analysis.
use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use parking_lot::Mutex;

use super::{
	model::{Effect, EffectKind, NodeKey},
	runtime::VizSource,
};
use crate::bash::{
	syntax::{
		NodeId, RedirOp, Sep, Span,
		tree::{
			ArithText, ArrayElem, Assign, AssignValue, Command, CommandKind, Cond, CondExpr, List,
			ParamName, ParamOp, Part, Pipeline, RedirFd, RedirTarget, Seq, Simple, Subscript, Tree,
			Word, WordPart,
		},
	},
	trace::syntax::{Root, UnitSyntax},
};

type ArithmeticCache = Mutex<HashMap<Vec<u8>, Option<Arc<str>>>>;

#[derive(Debug, Default)]
pub struct Analysis {
	/// Pure formatting of the engine's arithmetic `Expr`, shared across
	/// repaints.
	pub arithmetic:        Arc<ArithmeticCache>,
	pub variables:         HashMap<String, Variable>,
	pub effects:           HashMap<NodeKey, Vec<Effect>>,
	pub owners:            HashMap<NodeKey, NodeKey>,
	/// Actual enclosing canonical Command, never inferred from source spans.
	pub parents:           HashMap<NodeKey, NodeKey>,
	pub spans:             HashMap<NodeKey, Span>,
	/// Disjoint decoded-byte namespaces reserved in canonical word preorder.
	pub source_slots:      HashMap<NodeKey, u32>,
	pub guards:            HashSet<NodeKey>,
	/// Runtime branch events identify the final condition `AndOr`, not its
	/// leaves.
	pub branch_conditions: HashMap<NodeKey, Vec<NodeKey>>,
	/// Actual engine-announced child units keyed by their proven invoking word.
	pub children:          HashMap<NodeKey, Vec<u32>>,
	/// Announced outer-script units, in original source order.
	pub roots:             Vec<u32>,
	pub tainted:           HashSet<String>,
	pub functions:         HashMap<String, u32>,
	pub leaves:            HashSet<NodeKey>,
	/// Canonical byte spans; source projection belongs to the renderer.
	pub colors:            Vec<(NodeKey, Span, String)>,
}

impl Analysis {
	pub fn arithmetic(&self, text: &[u8]) -> Option<Arc<str>> {
		let mut cache = self.arithmetic.lock();
		if let Some(value) = cache.get(text) {
			return value.clone();
		}
		let value = crate::bash::vm::arith::pseudo(text).map(Arc::<str>::from);
		cache.insert(text.to_vec(), value.clone());
		value
	}
}

#[derive(Debug)]
pub struct Variable {
	pub value:  Option<String>,
	pub inline: bool,
	pub setter: Option<NodeKey>,
}

/// Quote removal only: expansions, translations and unquoted tilde are not
/// literals.
pub fn literal(word: Word<'_>) -> Option<String> {
	let mut out = Vec::new();
	append_literal(word.parts(), false, &mut out)?;
	String::from_utf8(out).ok()
}

fn append_literal(parts: Seq<'_, WordPart<'_>>, quoted: bool, out: &mut Vec<u8>) -> Option<()> {
	for part in parts {
		match part.get() {
			Part::Lit(bytes) if quoted || !bytes.contains(&b'~') => out.extend_from_slice(bytes),
			Part::Escaped(bytes) | Part::SQuote(bytes) => out.extend_from_slice(bytes),
			Part::DQuote(parts) => append_literal(parts, true, out)?,
			Part::AnsiC(bytes) if !quoted => {
				let decoded = crate::bash::syntax::ansi_decode_all(bytes);
				out.extend_from_slice(decoded.split(|b| *b == 0).next().unwrap_or_default());
			},
			_ => return None,
		}
	}
	Some(())
}

fn contains_parameter(parts: Seq<'_, WordPart<'_>>) -> bool {
	parts.iter().any(|part| match part.get() {
		Part::Param(_) => true,
		Part::DQuote(parts) | Part::Locale(parts) => contains_parameter(parts),
		_ => false,
	})
}

pub fn command_name(simple: Simple<'_>) -> Option<String> {
	literal(simple.words().first()?)
}

#[derive(Clone, Copy)]
struct Context {
	restricted: bool,
	background: bool,
	order:      usize,
}

struct Definition<'a> {
	assignment:   Option<Assign<'a>>,
	owner:        NodeKey,
	order:        usize,
	safe:         bool,
	dependencies: Vec<String>,
	secret:       bool,
}

struct Reference {
	name:   String,
	order:  usize,
	simple: bool,
}
struct Call<'a> {
	command:    Command<'a>,
	key:        NodeKey,
	background: bool,
	refs:       std::ops::Range<usize>,
}

#[derive(Default)]
struct Walker<'a> {
	result:          Analysis,
	definitions:     HashMap<String, Vec<Definition<'a>>>,
	references:      Vec<Reference>,
	writes:          HashSet<String>,
	calls:           Vec<Call<'a>>,
	unit:            u32,
	source:          u32,
	order:           usize,
	opaque_mutation: bool,
	env_file:        bool,
	secret_reads:    usize,
	function_arity:  Vec<u32>,
	command_stack:   Vec<NodeKey>,
	source_slot:     Option<u32>,
}

pub fn analyze(source: &impl VizSource) -> Analysis {
	let mut walker = Walker::default();
	for index in 0..source.unit_count() {
		let Some(unit) = source.unit(index) else {
			continue;
		};
		let Some(syntax) = unit.syntax else { continue };
		if syntax.parent.is_none() && unit.at.is_some() {
			walker.result.roots.push(unit.index);
		}
		if let Some(parent) = syntax.parent {
			walker
				.result
				.children
				.entry(NodeKey::engine(parent.unit, NodeId(parent.node)))
				.or_default()
				.push(unit.index);
		}
		walker.unit = unit.index;
		walker.root(syntax);
	}
	walker
		.result
		.roots
		.sort_by_key(|index| source.unit(*index as usize).and_then(|unit| unit.at));
	walker.finish()
}

/// Analyze an already parsed static body using its caller-assigned source
/// identities: one tree and `List` root per complete command. Each restarts
/// canonical node numbering.
pub fn program(commands: &[(Tree, u32)], unit: u32, sources: &[u32]) -> Analysis {
	assert_eq!(commands.len(), sources.len(), "one source identity per complete command");
	let mut walker = Walker { unit, ..Walker::default() };
	for ((tree, root), &source) in commands.iter().zip(sources) {
		walker.source = source;
		walker.list(List::at(tree, *root), Context {
			restricted: false,
			background: false,
			order:      0,
		});
	}
	walker.finish()
}

impl<'a> Walker<'a> {
	fn root(&mut self, syntax: &'a UnitSyntax) {
		self.source_slot = Some(1);
		let context =
			Context { restricted: syntax.parent.is_some(), background: false, order: 0 };
		match syntax.tree.view() {
			Root::List(list) => self.list(list, context),
			Root::Command(command) => self.command(command, context),
			Root::Word(word) => {
				let key = self.key(word.id());
				self.word(word, key, Context { restricted: true, ..context }, "arg");
			},
		}
	}

	const fn key(&self, node: NodeId) -> NodeKey {
		NodeKey::nested(self.unit, self.source, node)
	}

	fn register(&mut self, id: NodeId, span: Span, owner: NodeKey) {
		let key = self.key(id);
		self.result.spans.insert(key, span);
		self.result.owners.insert(key, owner);
	}

	fn color(&mut self, owner: NodeKey, span: Span, style: &str) {
		self.result.colors.push((owner, span, style.to_owned()));
	}

	fn list(&mut self, list: List<'a>, context: Context) {
		for item in list.items() {
			let background = context.background || matches!(item.sep(), Sep::Amp | Sep::Disown);
			let and_or = item.and_or();
			let context = Context {
				background,
				restricted: context.restricted || background || and_or.rest().len() != 0,
				..context
			};
			self.and_or(and_or, context);
		}
	}

	fn and_or(&mut self, and_or: crate::bash::syntax::tree::AndOr<'a>, context: Context) {
		self
			.result
			.spans
			.insert(self.key(and_or.id()), and_or.span());
		self.pipeline(and_or.first(), context);
		for (_, pipeline) in and_or.rest() {
			self.pipeline(pipeline, context);
		}
	}

	fn pipeline(&mut self, pipeline: Pipeline<'a>, context: Context) {
		self
			.result
			.spans
			.insert(self.key(pipeline.id()), pipeline.span());
		let stages = pipeline.stages();
		let context = Context {
			restricted: context.restricted || stages.len() != 1 || pipeline.bang(),
			..context
		};
		for stage in stages {
			self.command(stage, context);
		}
	}

	/// Only direct single-stage predicates in the final condition `AndOr` are
	/// guards; earlier semicolon commands and nested substitutions are not.
	fn guard(&mut self, list: List<'_>) {
		let Some(item) = list.items().last() else {
			return;
		};
		if matches!(item.sep(), Sep::Amp | Sep::Disown) {
			return;
		}
		let and_or = item.and_or();
		for pipeline in std::iter::once(and_or.first()).chain(and_or.rest().map(|(_, p)| p)) {
			let Some(command) = pipeline.stages().one() else {
				continue;
			};
			let predicate = match command.kind() {
				CommandKind::Cond(_) | CommandKind::Arith(_) => true,
				CommandKind::Simple(simple) => command_name(simple)
					.is_some_and(|name| matches!(name.as_str(), "test" | "[" | "false" | "true")),
				_ => false,
			};
			if predicate {
				self.result.guards.insert(self.key(command.id()));
			}
		}
	}

	fn command(&mut self, command: Command<'a>, context: Context) {
		self.order += 1;
		let context = Context { order: self.order, ..context };
		let (id, span, kind) = (command.id(), command.span(), command.kind());
		let owner = self.key(id);
		self.register(id, span, owner);
		if let Some(parent) = self.command_stack.last().copied() {
			self.result.parents.insert(owner, parent);
		}
		self.command_stack.push(owner);
		if matches!(kind, CommandKind::Simple(_) | CommandKind::Arith(_) | CommandKind::Cond(_)) {
			self.result.leaves.insert(owner);
		}
		let start = self.references.len();
		let scoped = Context { restricted: true, ..context };
		let keyword = match kind {
			CommandKind::If(_) => Some("if"),
			CommandKind::While(w) => Some(if w.until() { "until" } else { "while" }),
			CommandKind::For(_) | CommandKind::ArithFor(_) => Some("for"),
			CommandKind::Select(_) => Some("select"),
			CommandKind::Case(_) => Some("case"),
			CommandKind::Coproc(_) => Some("coproc"),
			CommandKind::Repeat(_) => Some("repeat"),
			_ => None,
		};
		if let Some(keyword) = keyword {
			self.color(owner, Span::new(span.lo, span.lo + keyword.len() as u32), "kw");
		}
		let redirs = command.redirs();
		match kind {
			CommandKind::Simple(simple) => {
				self.simple(simple, owner, context, redirs.is_empty());
			},
			CommandKind::Brace(list) => self.list(list, scoped),
			CommandKind::Subshell(list) => self.list(list, scoped),
			CommandKind::If(branch) => {
				let conditions = branch
					.arms()
					.filter_map(|arm| arm.cond.items().last())
					.map(|item| self.key(item.and_or().id()))
					.collect();
				self.result.branch_conditions.insert(owner, conditions);
				for arm in branch.arms() {
					self.guard(arm.cond);
					self.list(arm.cond, scoped);
					self.list(arm.body, scoped);
				}
				if let Some(body) = branch.else_body() {
					self.list(body, scoped);
				}
			},
			CommandKind::While(loop_) => {
				let conditions = loop_
					.cond()
					.items()
					.last()
					.map(|item| self.key(item.and_or().id()))
					.into_iter()
					.collect();
				self.result.branch_conditions.insert(owner, conditions);
				self.guard(loop_.cond());
				self.list(loop_.cond(), scoped);
				self.list(loop_.body(), scoped);
			},
			CommandKind::For(loop_) | CommandKind::Select(loop_) => {
				self.writes.insert(text(loop_.var()));
				for name in loop_.extra_vars() {
					self.writes.insert(text(name));
				}
				if let Some(words) = loop_.words() {
					for word in words {
						self.word(word, owner, scoped, "arg");
					}
				}
				self.list(loop_.body(), scoped);
			},
			CommandKind::ArithFor(loop_) => {
				self.arithmetic(loop_.init(), scoped);
				self.arithmetic(loop_.cond(), scoped);
				self.arithmetic(loop_.step(), scoped);
				self.list(loop_.body(), scoped);
			},
			CommandKind::Case(case) => {
				self.word(case.word(), owner, scoped, "arg");
				for arm in case.arms() {
					for word in arm.patterns() {
						self.word(word, owner, scoped, "arg");
					}
					self.list(arm.body(), scoped);
				}
			},
			CommandKind::Arith(expr) => self.arithmetic(expr, context),
			CommandKind::Cond(expr) => self.condition(expr, owner, context),
			CommandKind::FuncDef(function) => {
				self.function_arity.push(0);
				self.command(function.body(), scoped);
				let arity = self.function_arity.pop().unwrap_or(0);
				self.result.functions.insert(text(function.name()), arity);
				for name in function.extra_names() {
					self.result.functions.insert(text(name), arity);
				}
			},
			CommandKind::Coproc(coproc) => {
				self.command(coproc.body(), Context { background: true, ..scoped });
			},
			CommandKind::Repeat(repeat) => {
				self.word(repeat.count(), owner, scoped, "arg");
				self.list(repeat.body(), scoped);
			},
			CommandKind::Try(try_) => {
				self.list(try_.body(), scoped);
				self.list(try_.always(), scoped);
			},
			CommandKind::AnonFunc(function) => {
				for word in function.args() {
					self.word(word, owner, context, "arg");
				}
				self.command(function.body(), scoped);
			},
		}
		for redir in redirs {
			if let Some(RedirFd::Var(name)) = redir.fd() {
				self.writes.insert(text(name));
			}
			match redir.target() {
				RedirTarget::Word(word) => self.word(word, owner, context, "path"),
				RedirTarget::HereDoc(doc) if !doc.quoted() => self.deferred_text(doc.text(), context),
				RedirTarget::HereDoc(_) => {},
			}
		}
		self.calls.push(Call {
			command,
			key: owner,
			background: context.background,
			refs: start..self.references.len(),
		});
		self.command_stack.pop();
	}

	fn simple(&mut self, simple: Simple<'a>, owner: NodeKey, context: Context, no_redirs: bool) {
		let name = command_name(simple).unwrap_or_default();
		let words = simple.words();
		let args: Vec<_> = words.iter().map(literal).collect();
		let mutation = |name: &str| {
			matches!(
				name,
				"eval"
					| "read"
					| "readarray"
					| "mapfile"
					| "let"
					| "declare"
					| "typeset"
					| "local"
					| "unset"
					| "trap"
					| "source"
					| "."
			)
		};
		if mutation(&name)
			|| simple.typeset()
			|| (matches!(name.as_str(), "command" | "builtin")
				&& args.get(1).and_then(Option::as_deref).is_some_and(mutation))
			|| (name == "printf" && args.iter().any(|arg| arg.as_deref() == Some("-v")))
		{
			self.opaque_mutation = true;
		}
		if matches!(name.as_str(), "source" | ".") {
			self.env_file = true;
		}
		let secret_command = (name == "security"
			&& args
				.iter()
				.flatten()
				.any(|arg| arg.starts_with("find-") && arg.ends_with("password")))
			|| args.iter().flatten().any(|arg| arg.contains(".env"));
		if secret_command {
			self.secret_reads += 1;
		}
		for assignment in simple.assigns() {
			let (id, span, aname) = (assignment.id(), assignment.span(), assignment.name());
			self.register(id, span, owner);
			self.color(owner, Span::new(span.lo, span.lo + aname.len() as u32), "var def");
			let start = self.references.len();
			let secret_before = self.secret_reads;
			let calls_before = self.calls.len();
			if let Some(index) = assignment.index() {
				self.word(index, owner, Context { restricted: true, ..context }, "arg");
			}
			let value = assignment.value();
			match value {
				AssignValue::Scalar(word) => self.word(word, owner, context, "str"),
				AssignValue::Array(elements) => self.elements(elements, owner, context),
			}
			let dependencies = self.references[start..]
				.iter()
				.map(|reference| reference.name.clone())
				.collect();
			let definition = Definition {
				assignment: Some(assignment),
				owner,
				order: context.order,
				safe: !context.restricted
					&& words.is_empty()
					&& no_redirs
					&& assignment.index().is_none()
					&& !assignment.append()
					&& matches!(value, AssignValue::Scalar(_)),
				dependencies,
				secret: self.secret_reads != secret_before
					|| (secret_name(&text(aname)) && self.calls.len() != calls_before),
			};
			self
				.definitions
				.entry(text(aname))
				.or_default()
				.push(definition);
		}
		for (index, word) in words.iter().enumerate() {
			let start = self.references.len();
			let secret_before = self.secret_reads;
			let calls_before = self.calls.len();
			self.word(word, owner, context, if index == 0 { "cmd" } else { "arg" });
			if index > 0
				&& matches!(name.as_str(), "export" | "readonly" | "declare" | "typeset" | "local")
				&& let Some(variable) = declaration_name(word)
			{
				self.writes.insert(variable.clone());
				self
					.definitions
					.entry(variable.clone())
					.or_default()
					.push(Definition {
						assignment: None,
						owner,
						order: context.order,
						safe: false,
						dependencies: self.references[start..]
							.iter()
							.map(|reference| reference.name.clone())
							.collect(),
						secret: self.secret_reads != secret_before
							|| (secret_name(&variable) && self.calls.len() != calls_before),
					});
			}
		}
	}

	fn elements(&mut self, elements: Seq<'a, ArrayElem<'a>>, owner: NodeKey, context: Context) {
		for element in elements {
			if let Some(key) = element.key() {
				self.word(key, owner, Context { restricted: true, ..context }, "arg");
			}
			self.word(element.value(), owner, context, "arg");
		}
	}

	fn word(&mut self, word: Word<'a>, owner: NodeKey, context: Context, fallback: &str) {
		self.register(word.id(), word.span(), owner);
		let value = literal(word);
		if let (Some(body), Some(slot)) = (&value, self.source_slot) {
			let next = u32::try_from(body.len())
				.ok()
				.and_then(|len| len.checked_add(1))
				.and_then(|len| slot.checked_add(len));
			// Exhaustion disables subsequent reservations instead of wrapping
			// into an already allocated source identity.
			self.source_slot = next;
			if next.is_some() {
				self.result.source_slots.insert(self.key(word.id()), slot);
			}
		}
		let style = if fallback == "cmd" {
			"cmd"
		} else if let Some(value) = value {
			if value.starts_with('-') {
				"flag"
			} else if value.contains('/') {
				"path"
			} else if word
				.parts()
				.iter()
				.any(|part| matches!(part.get(), Part::SQuote(_) | Part::DQuote(_) | Part::AnsiC(_)))
			{
				"str"
			} else {
				fallback
			}
		} else if contains_parameter(word.parts()) {
			"var"
		} else {
			fallback
		};
		self.color(owner, word.span(), style);
		self.parts(word.parts(), owner, context);
	}

	fn parts(&mut self, parts: Seq<'a, WordPart<'a>>, owner: NodeKey, context: Context) {
		for part in parts {
			match part.get() {
				Part::DQuote(parts) | Part::Locale(parts) => self.parts(parts, owner, context),
				Part::Param(param) => {
					let (name, index, op) = (param.name(), param.index(), param.op());
					if let ParamName::Positional(position) = name
						&& let Some(arity) = self.function_arity.last_mut()
					{
						*arity = (*arity).max(position);
					}
					if let ParamName::Var(name) = name {
						self.references.push(Reference {
							name:   text(name),
							order:  context.order,
							simple: !context.restricted
								&& index.is_none()
								&& !param.indirect()
								&& matches!(op, ParamOp::None),
						});
						if matches!(op, ParamOp::Assign { .. }) {
							self.writes.insert(text(name));
						}
					}
					if param.indirect() || matches!(op, ParamOp::Indirect | ParamOp::PrefixNames { .. })
					{
						self.opaque_mutation = true;
					}
					// Operator operands have their own expansion rules (patterns,
					// replacement strings, conditional words, or arithmetic), not
					// the surrounding command's simple argument context.
					let operand_context = Context { restricted: true, ..context };
					if let Some(Subscript::Expr(word)) = index {
						self.word(word, owner, operand_context, "arg");
						self.opaque_mutation = true;
					}
					match op {
						ParamOp::Default { word, .. }
						| ParamOp::Assign { word, .. }
						| ParamOp::Alt { word, .. } => self.word(word, owner, operand_context, "arg"),
						ParamOp::Error { word: Some(word), .. } => {
							self.word(word, owner, operand_context, "arg");
						},
						ParamOp::Substr { offset, len } => {
							self.arithmetic(offset, operand_context);
							if let Some(len) = len {
								self.arithmetic(len, operand_context);
							}
						},
						ParamOp::Trim { pat, .. } => self.word(pat, owner, operand_context, "arg"),
						ParamOp::Replace { pat, rep, .. } => {
							self.word(pat, owner, operand_context, "arg");
							if let Some(rep) = rep {
								self.word(rep, owner, operand_context, "arg");
							}
						},
						ParamOp::Case { pat: Some(pat), .. } => {
							self.word(pat, owner, operand_context, "arg");
						},
						_ => {},
					}
				},
				Part::Comsub(sub) => self.list(sub.body(), Context { restricted: true, ..context }),
				Part::ProcSub(sub) => self.list(sub.body(), Context { restricted: true, ..context }),
				Part::Arith(expr) => self.arithmetic(expr, context),
				Part::Compound(elements) => self.elements(elements, owner, context),
				Part::Zsh(_) | Part::BadSubst(_) | Part::BadComsub(_) => {
					self.opaque_mutation = true;
				},
				_ => {},
			}
		}
	}

	fn condition(&mut self, expr: CondExpr<'a>, owner: NodeKey, context: Context) {
		match expr.get() {
			Cond::Unary { arg, .. } | Cond::Word(arg) => self.word(arg, owner, context, "arg"),
			Cond::Binary { lhs, rhs, op } => {
				self.word(lhs, owner, context, "arg");
				self.word(rhs, owner, context, "arg");
				if matches!(op, b"-eq" | b"-ne" | b"-lt" | b"-le" | b"-gt" | b"-ge") {
					self.opaque_mutation = true;
				}
			},
			Cond::Not(expr) | Cond::Group(expr) => self.condition(expr, owner, context),
			Cond::And(lhs, rhs) | Cond::Or(lhs, rhs) => {
				self.condition(lhs, owner, context);
				self.condition(rhs, owner, context);
			},
		}
	}

	fn arithmetic(&mut self, expr: ArithText<'_>, context: Context) {
		// Arithmetic recursively dereferences variable contents and array
		// subscripts. Any identifier here is not a direct immutable
		// parameter reference.
		let src = expr.src();
		for name in identifiers(src) {
			self.references.push(Reference {
				name:   text(name),
				order:  context.order,
				simple: false,
			});
		}
		if src.windows(2).any(|pair| pair == b"++" || pair == b"--")
			|| src.iter().enumerate().any(|(i, byte)| {
				*byte == b'='
					&& !matches!(src.get(i.wrapping_sub(1)).copied(), Some(b'=' | b'!' | b'<' | b'>'))
					&& src.get(i + 1) != Some(&b'=')
			}) {
			self.opaque_mutation = true;
		}
	}

	fn deferred_text(&mut self, bytes: &[u8], context: Context) {
		// Deferred heredocs have no canonical child node ids. Never invent an
		// AST; conservatively retain possible references and mutations
		// until expansion.
		for name in identifiers(bytes) {
			self.references.push(Reference {
				name:   text(name),
				order:  context.order,
				simple: false,
			});
		}
		if bytes.contains(&b'$') || bytes.contains(&b'`') {
			self.opaque_mutation = true;
		}
	}

	fn finish(mut self) -> Analysis {
		if self.env_file {
			for reference in &self.references {
				if secret_name(&reference.name) && !self.definitions.contains_key(&reference.name) {
					self.result.tainted.insert(reference.name.clone());
				}
			}
		}
		for (name, definitions) in &self.definitions {
			if definitions.iter().any(|definition| definition.secret) {
				self.result.tainted.insert(name.clone());
			}
		}
		loop {
			let mut changed = false;
			for (name, definitions) in &self.definitions {
				if !self.result.tainted.contains(name)
					&& definitions.iter().any(|definition| {
						definition
							.dependencies
							.iter()
							.any(|dependency| self.result.tainted.contains(dependency))
					}) {
					self.result.tainted.insert(name.clone());
					changed = true;
				}
			}
			if !changed {
				break;
			}
		}
		for (name, definitions) in &self.definitions {
			let Some(first) = definitions.first() else {
				continue;
			};
			let (refs, simple_uses) = self
				.references
				.iter()
				.filter(|reference| reference.name == *name)
				.fold((0, true), |(count, safe), reference| {
					(count + 1, safe && reference.simple && reference.order > first.order)
				});
			let value = self.constant_definition(name, usize::MAX, &mut HashSet::new());
			let inline = value.is_some()
				&& definitions.len() == 1
				&& first.safe
				&& !self.writes.contains(name)
				&& !self.opaque_mutation
				&& refs != 0
				&& simple_uses;
			self.result.variables.insert(name.clone(), Variable {
				value,
				inline,
				setter: Some(first.owner),
			});
		}
		for call in &self.calls {
			self
				.result
				.effects
				.insert(call.key, effects(call, &self.references, &self.result.tainted));
		}
		self.result
	}

	fn constant_definition(
		&self,
		name: &str,
		before: usize,
		seen: &mut HashSet<String>,
	) -> Option<String> {
		let definitions = self.definitions.get(name)?;
		let first = definitions.first()?;
		if definitions.len() != 1
			|| !first.safe
			|| first.order >= before
			|| self.writes.contains(name)
			|| seen.len() >= 64
			|| !seen.insert(name.to_owned())
		{
			return None;
		}
		let value = match first.assignment?.value() {
			AssignValue::Scalar(word) => self.constant_parts(word.parts(), first.order, seen, false),
			AssignValue::Array(_) => None,
		};
		seen.remove(name);
		value
	}

	fn constant_parts(
		&self,
		parts: Seq<'_, WordPart<'_>>,
		before: usize,
		seen: &mut HashSet<String>,
		quoted: bool,
	) -> Option<String> {
		let mut out = String::new();
		self.append_constant_parts(parts, before, seen, quoted, &mut out)?;
		Some(out)
	}

	fn append_constant_parts(
		&self,
		parts: Seq<'_, WordPart<'_>>,
		before: usize,
		seen: &mut HashSet<String>,
		quoted: bool,
		out: &mut String,
	) -> Option<()> {
		for part in parts {
			match part.get() {
				Part::Param(param)
					if param.index().is_none()
						&& !param.indirect()
						&& matches!(param.op(), ParamOp::None) =>
				{
					let ParamName::Var(name) = param.name() else {
						return None;
					};
					out.push_str(&self.constant_definition(
						std::str::from_utf8(name).ok()?,
						before,
						seen,
					)?);
				},
				Part::DQuote(parts) => {
					self.append_constant_parts(parts, before, seen, true, out)?;
				},
				Part::Lit(bytes) if quoted || !bytes.contains(&b'~') => {
					out.push_str(std::str::from_utf8(bytes).ok()?);
				},
				Part::Escaped(bytes) | Part::SQuote(bytes) => {
					out.push_str(std::str::from_utf8(bytes).ok()?);
				},
				Part::AnsiC(bytes) if !quoted => {
					let bytes = crate::bash::syntax::ansi_decode_all(bytes);
					let bytes = bytes.split(|byte| *byte == 0).next().unwrap_or_default();
					out.push_str(std::str::from_utf8(bytes).ok()?);
				},
				_ => return None,
			}
		}
		Some(())
	}
}

// Declaration builtins retain their arguments as canonical words rather than
// Assign nodes. Inspect only the literal name prefix, never fabricate an
// Assign.
fn declaration_name(word: Word<'_>) -> Option<String> {
	let Part::Lit(prefix) = word.parts().first()?.get() else {
		return None;
	};
	let end = prefix
		.iter()
		.position(|byte| matches!(*byte, b'=' | b'['))?;
	let name = prefix
		.get(..end)?
		.strip_suffix(b"+")
		.unwrap_or(&prefix[..end]);
	if !name
		.first()
		.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
		|| !name
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
	{
		return None;
	}
	Some(text(name))
}

fn text(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
}

fn identifiers(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
	bytes
		.split(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_')
		.filter(|name| {
			name
				.first()
				.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
		})
}

fn secret_name(name: &str) -> bool {
	let upper = name.to_ascii_uppercase();
	["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD"]
		.iter()
		.any(|suffix| upper.ends_with(suffix))
}

fn effects(call: &Call<'_>, references: &[Reference], tainted: &HashSet<String>) -> Vec<Effect> {
	let mut result = Vec::new();
	let simple = match call.command.kind() {
		CommandKind::Simple(simple) => Some(simple),
		_ => None,
	};
	let name = simple.and_then(command_name).unwrap_or_default();
	let args: Vec<_> = simple
		.into_iter()
		.flat_map(|simple| simple.words().iter())
		.filter_map(literal)
		.collect();
	let has = |values: &[&str]| {
		args
			.iter()
			.skip(1)
			.any(|arg| values.contains(&arg.as_str()))
	};
	let joined = args.join(" ");
	let mut add = |kind, glyph: &str, label: &str, why: String| {
		result.push(Effect {
			kind,
			glyph: glyph.to_owned(),
			label: label.to_owned(),
			why: format!("{why} (heuristic, not a safety guarantee)"),
		});
	};
	let packages =
		matches!(name.as_str(), "bun" | "npm" | "pnpm" | "yarn") && has(&["install", "add", "i"]);
	let network = matches!(name.as_str(), "curl" | "wget" | "gh" | "ssh" | "scp" | "rsync")
		|| (name == "git" && has(&["fetch", "push", "pull", "clone"]));
	if network {
		let host = args
			.iter()
			.find_map(|arg| {
				arg.strip_prefix("https://")
					.or_else(|| arg.strip_prefix("http://"))
			})
			.and_then(|url| url.split('/').next())
			.unwrap_or(if name == "gh" {
				"api.github.com"
			} else {
				"remote"
			});
		add(EffectKind::Network, "⇅", "network", format!("{name} → {host}"));
	}
	if matches!(name.as_str(), "rm" | "kill" | "pkill")
		|| (name == "git"
			&& ((has(&["reset"]) && has(&["--hard"]))
				|| (has(&["branch"]) && has(&["-D", "-d", "--delete"]))
				|| (has(&["worktree"]) && has(&["remove"]))))
	{
		add(EffectKind::Destructive, "×", "destructive", joined.clone());
	}
	if matches!(name.as_str(), "mkdir" | "touch" | "cp" | "mv" | "ln" | "tee" | "install")
		|| (name == "sed" && args.iter().any(|arg| arg.starts_with("-i")))
		|| (name == "git"
			&& has(&[
				"add",
				"commit",
				"rebase",
				"checkout",
				"switch",
				"merge",
				"cherry-pick",
				"stash",
				"tag",
				"branch",
				"worktree",
			])) {
		add(EffectKind::Write, "✎", "write", joined.clone());
	}
	if packages {
		add(EffectKind::Network, "⇅", "network", "package installation fetches packages".to_owned());
		add(EffectKind::Write, "✎", "write", "package installation writes dependencies".to_owned());
	}
	if matches!(name.as_str(), "sudo" | "su" | "runuser" | "chmod" | "chown") {
		add(EffectKind::Privilege, "⇪", "privilege", joined.clone());
	}
	if call.background {
		add(EffectKind::Background, "⇉", "background", "runs in background".to_owned());
	}
	if name == "docker" && has(&["exec", "run", "compose", "start", "stop", "restart"]) {
		add(EffectKind::Background, "⇉", "process", joined);
	}
	if name == "security"
		&& args
			.iter()
			.any(|arg| arg.starts_with("find-") && arg.ends_with("password"))
	{
		add(EffectKind::Secret, "◆", "secret", "reads macOS keychain".to_owned());
	}
	if matches!(name.as_str(), "source" | ".") && args.iter().any(|arg| arg.contains(".env")) {
		add(EffectKind::Secret, "◆", "secret", "loads environment file".to_owned());
	}
	for redir in call.command.redirs() {
		match redir.target() {
			RedirTarget::Word(word)
				if matches!(
					redir.op(),
					RedirOp::Out
						| RedirOp::Append
						| RedirOp::Clobber
						| RedirOp::ReadWrite
						| RedirOp::OutErr
						| RedirOp::AppendErr
						| RedirOp::AppendClobber
						| RedirOp::OutErrClobber
						| RedirOp::AppendErrClobber
				) =>
			{
				let target = literal(word).unwrap_or_else(|| "dynamic target".to_owned());
				if !target.starts_with("/dev/") {
					add(EffectKind::Write, "✎", "write", format!("writes {target}"));
				}
			},
			RedirTarget::HereDoc(doc)
				if doc.text().windows(4).any(|bytes| bytes == b".env")
					|| doc.text().windows(7).any(|bytes| bytes == b"API_KEY") =>
			{
				add(
					EffectKind::Secret,
					"◆",
					"secret",
					"embedded program reads an environment secret".to_owned(),
				);
			},
			_ => {},
		}
	}
	let mut names: Vec<_> = references[call.refs.clone()]
		.iter()
		.filter(|reference| tainted.contains(&reference.name))
		.map(|reference| reference.name.as_str())
		.collect();
	names.sort_unstable();
	names.dedup();
	if !names.is_empty() {
		add(
			EffectKind::Secret,
			"◆",
			"secret",
			format!(
				"{} {}",
				names.join(", "),
				if network || packages {
					"sent to network"
				} else {
					"used here"
				}
			),
		);
	}
	result
}

#[cfg(test)]
#[path = "analysis_tests.rs"]
mod tests;
