//! Conservative, allocation-conscious policy facts derived from the shell AST.
//!
//! This module never expands or executes a program.  Constructs whose effect
//! cannot be represented faithfully are recorded as opaque, making the hot
//! predicates fail closed.

use std::path::{Component, Path};

use omp_core::{Str, sf};
use omp_proto::omp::policy::v1 as proto;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::parser::{
	ParserOptions, SourceSpan,
	ast::{self, SourceLocation},
	word,
};

/// Static analysis of a parsed script, independent of expansion or execution.
pub fn analyze(program: &ast::Program, cwd: &str, root: &str) -> ScriptIr {
	let mut analyzer = Analyzer::new(cwd, root);
	for list in &program.complete_commands {
		analyzer.list(list, false);
	}
	analyzer.finish(program.to_string())
}

/// A flattened static script analysis suitable for policy transport.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ScriptIr {
	/// Reconstructed shell source; whitespace comments are not preserved by the
	/// AST.
	pub source:           Str,
	/// Stable analyzer vocabulary revision.
	pub rev:              Str,
	/// Flattened commands in lexical execution order.
	pub commands:         Vec<CommandIr>,
	/// All inferred read path facts.
	pub reads:            Vec<PathRefIr>,
	/// All inferred write path facts.
	pub writes:           Vec<PathRefIr>,
	/// All inferred network sinks.
	pub net:              Vec<NetRefIr>,
	/// Constructs deliberately degraded because static analysis cannot model
	/// them.
	pub opaque:           SmallVec<Str, 2>,
	/// Whether a dynamic interpreter payload may execute arbitrary shell code.
	pub has_dynamic_eval: bool,
	/// Number of AST command nodes visited.
	pub node_count:       u32,
}

impl ScriptIr {
	/// Returns whether the script has no writes, network sinks, or opaque
	/// execution.
	pub fn is_read_only(&self) -> bool {
		self.writes.is_empty()
			&& self.net.is_empty()
			&& self.opaque.is_empty()
			&& !self.has_dynamic_eval
	}

	/// Returns whether any known or dynamic write may escape `root`.
	pub fn writes_outside(&self, root: &str) -> bool {
		self.writes.iter().any(|path| {
			path.dynamic || !within_root(path.resolved.as_deref().unwrap_or(&path.lexical), root)
		})
	}

	/// Returns whether a known path fact touches `path`.
	pub fn touches(&self, path: &str) -> impl Iterator<Item = &PathRefIr> {
		self.reads.iter().chain(&self.writes).filter(move |fact| {
			fact.lexical.as_str() == path
				|| fact
					.resolved
					.as_deref()
					.is_some_and(|resolved| resolved == path)
		})
	}

	/// Returns inferred network sinks without allocating.
	pub fn net_sinks(&self) -> impl Iterator<Item = &NetRefIr> {
		self.net.iter()
	}
}

/// One flattened shell command.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CommandIr {
	/// Zero-based lexical command index.
	pub index:            u32,
	/// Literal command name, absent when the name is dynamic or absent.
	pub name:             Option<Str>,
	/// Command name followed by operands before expansion.
	pub argv:             SmallVec<ArgIr, 8>,
	/// Bit `n` marks argv element `n` as dynamic; elements above 63 use
	/// `dynamic_overflow`.
	pub dynamic_args:     u64,
	/// Dynamic argument indexes at or above 64.
	pub dynamic_overflow: SmallVec<u32, 2>,
	/// I/O redirections attached to this command.
	pub redirects:        SmallVec<RedirectIr, 2>,
	/// Read facts owned by this command.
	pub reads:            SmallVec<PathRefIr, 2>,
	/// Write or delete facts owned by this command.
	pub writes:           SmallVec<PathRefIr, 2>,
	/// Network facts owned by this command.
	pub net:              SmallVec<NetRefIr, 2>,
	/// Effective current directory at this command, if statically known.
	pub cwd:              Option<Str>,
	/// Compound nesting depth.
	pub depth:            u32,
	/// Whether the command runs in a subshell scope.
	pub subshell:         bool,
	/// Extracted literal interpreter payload, if present.
	pub interpreter_code: Option<Str>,
	/// Source coordinate of the command.
	pub span:             Span,
}

/// A shell word before expansion.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ArgIr {
	/// Raw word text.
	pub text:     Str,
	/// Dynamism causes recorded from constituent word pieces.
	pub dynamism: u32,
	/// Source coordinate of the word.
	pub span:     Span,
}

/// A flattened redirection.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RedirectIr {
	/// Source file descriptor, if explicitly specified.
	pub fd:          Option<i32>,
	/// Shell spelling of the redirection operation.
	pub op:          Str,
	/// Structural target kind (`filename`, `fd`, `duplicate`, or
	/// `process_substitution`).
	pub target_kind: Str,
	/// Literal target text, if applicable.
	pub target:      Option<Str>,
	/// Target file descriptor when applicable.
	pub target_fd:   Option<i32>,
	/// Dynamism causes in the target word.
	pub dynamism:    u32,
	/// Inferred file fact when the target is a filename.
	pub path:        Option<PathRefIr>,
	/// Source coordinate; AST redirections currently lack locations, so this is
	/// zeroed.
	pub span:        Span,
}

/// A filesystem fact inferred without expansion.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PathRefIr {
	/// Lexical path as written.
	pub lexical:           Str,
	/// Lexically resolved path under the effective cwd, when literal.
	pub resolved:          Option<Str>,
	/// Access bitmask: read=1, write=2, append=4, exec=8, delete=16,
	/// metadata=32, create=64.
	pub access:            u32,
	/// Rule or syntax which inferred this fact.
	pub origin:            Str,
	/// Owning flattened command index.
	pub command_index:     u32,
	/// Whether a literal resolved path lies outside the analyzer root.
	pub outside_workspace: bool,
	/// Whether the path is dynamic.
	pub dynamic:           bool,
	/// Source coordinate of the operand.
	pub span:              Span,
}

/// A network fact inferred from a command operand.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NetRefIr {
	/// Transport family, currently `url` or `network`.
	pub kind:          Str,
	/// Flow direction, currently `outbound`.
	pub direction:     Str,
	/// Literal host if parsed from a URL.
	pub host:          Option<Str>,
	/// Literal URL scheme if parsed.
	pub scheme:        Option<Str>,
	/// Literal URL if present.
	pub url:           Option<Str>,
	/// Owning flattened command index.
	pub command_index: u32,
	/// Whether the endpoint is dynamic.
	pub dynamic:       bool,
	/// Source coordinate of the operand.
	pub span:          Span,
}

/// A socket-safe flattened source coordinate.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Span {
	/// UTF-8 byte offset at the start of the span.
	pub start:  u32,
	/// UTF-8 byte offset immediately after the span.
	pub end:    u32,
	/// One-based source line.
	pub line:   u32,
	/// One-based source column.
	pub column: u32,
}

const PARAMETER: u32 = 1;
const COMMAND_SUBSTITUTION: u32 = 2;
const ARITHMETIC: u32 = 4;
const TILDE: u32 = 8;
const GLOB: u32 = 16;
const BRACE: u32 = 32;
const ESCAPE: u32 = 64;
const READ: u32 = 1;
const WRITE: u32 = 2;
const APPEND: u32 = 4;
const DELETE: u32 = 16;
const CREATE: u32 = 64;

struct Analyzer<'a> {
	cwd:   EffectiveCwd,
	root:  &'a str,
	ir:    ScriptIr,
	depth: u32,
}

#[derive(Clone)]
enum EffectiveCwd {
	Known(Str),
	Unknown,
}

impl<'a> Analyzer<'a> {
	fn new(cwd: &str, root: &'a str) -> Self {
		Self {
			cwd: EffectiveCwd::Known(Str::new(cwd)),
			root,
			ir: ScriptIr { rev: sf!("omp.policy.v1"), ..ScriptIr::default() },
			depth: 0,
		}
	}

	fn finish(mut self, source: String) -> ScriptIr {
		self.ir.source = source.into();
		self.ir
	}

	fn list(&mut self, list: &ast::CompoundList, subshell: bool) {
		for ast::CompoundListItem(and_or, _) in &list.0 {
			for (_, pipeline) in and_or {
				let saved = self.cwd.clone();
				let last = pipeline.seq.len().saturating_sub(1);
				for (stage, command) in pipeline.seq.iter().enumerate() {
					self.command(command, subshell || pipeline.seq.len() > 1);
					// Each pipeline stage, and a parenthesized compound command, has an
					// isolated process cwd. Reassert this at the caller boundary as well as
					// in `compound` so nested lists cannot leak a `cd`.
					if stage != last
						|| matches!(command, ast::Command::Compound(ast::CompoundCommand::Subshell(_), _))
					{
						self.cwd = saved.clone();
					}
				}
				if pipeline.seq.len() > 1 {
					self.cwd = saved;
				}
			}
		}
	}

	fn command(&mut self, command: &ast::Command, subshell: bool) {
		self.ir.node_count = self.ir.node_count.saturating_add(1);
		match command {
			ast::Command::Simple(simple) => self.simple(simple, subshell),
			ast::Command::Compound(compound, redirects) => {
				self.compound(compound, redirects.as_ref(), subshell);
			},
			ast::Command::Function(_) => self.opaque("function_definition"),
			ast::Command::ExtendedTest(..) => {},
		}
	}

	fn compound(
		&mut self,
		compound: &ast::CompoundCommand,
		redirects: Option<&ast::RedirectList>,
		subshell: bool,
	) {
		if let Some(redirects) = redirects {
			for redirect in &redirects.0 {
				self.redirect_only(redirect);
			}
		}
		self.depth += 1;
		match compound {
			ast::CompoundCommand::BraceGroup(group) => self.list(&group.list, subshell),
			ast::CompoundCommand::Subshell(group) => {
				let saved = self.cwd.clone();
				self.list(&group.list, true);
				self.cwd = saved;
			},
			ast::CompoundCommand::IfClause(value) => {
				self.list(&value.condition, subshell);
				self.list(&value.then, subshell);
				if let Some(elses) = &value.elses {
					for clause in elses {
						if let Some(condition) = &clause.condition {
							self.list(condition, subshell);
						}
						self.list(&clause.body, subshell);
					}
				}
				self.cwd = EffectiveCwd::Unknown;
			},
			ast::CompoundCommand::WhileClause(value) | ast::CompoundCommand::UntilClause(value) => {
				self.list(&value.0, subshell);
				self.list(&value.1.list, subshell);
				self.cwd = EffectiveCwd::Unknown;
			},
			ast::CompoundCommand::ForClause(value) => {
				self.list(&value.body.list, subshell);
				self.cwd = EffectiveCwd::Unknown;
			},
			ast::CompoundCommand::ArithmeticForClause(value) => {
				self.list(&value.body.list, subshell);
				self.cwd = EffectiveCwd::Unknown;
			},
			ast::CompoundCommand::CaseClause(value) => {
				for item in &value.cases {
					if let Some(list) = &item.cmd {
						self.list(list, subshell);
					}
				}
				self.cwd = EffectiveCwd::Unknown;
			},
			ast::CompoundCommand::Coprocess(value) => {
				let saved = self.cwd.clone();
				self.command(&value.body, true);
				self.cwd = saved;
			},
			ast::CompoundCommand::Arithmetic(_) => self.opaque("arithmetic_command"),
		}
		self.depth -= 1;
	}

	fn simple(&mut self, simple: &ast::SimpleCommand, subshell: bool) {
		let index = self.ir.commands.len() as u32;
		let mut command = CommandIr {
			index,
			cwd: self.cwd.known(),
			depth: self.depth,
			subshell,
			span: span(simple.location()),
			..CommandIr::default()
		};
		if let Some(prefix) = &simple.prefix {
			self.items(&prefix.0, &mut command);
		}
		if let Some(word) = &simple.word_or_name {
			self.arg(word, &mut command);
		}
		if let Some(suffix) = &simple.suffix {
			self.items(&suffix.0, &mut command);
		}
		command.name = command
			.argv
			.first()
			.filter(|arg| arg.dynamism == 0)
			.map(|arg| arg.text.clone());
		self.infer(&mut command);
		command.reads = self
			.ir
			.reads
			.iter()
			.filter(|path| path.command_index == index)
			.cloned()
			.collect();
		command.writes = self
			.ir
			.writes
			.iter()
			.filter(|path| path.command_index == index)
			.cloned()
			.collect();
		command.net = self
			.ir
			.net
			.iter()
			.filter(|sink| sink.command_index == index)
			.cloned()
			.collect();
		self.fold_cd(&command);
		self.ir.commands.push(command);
	}

	fn items(&mut self, items: &[ast::CommandPrefixOrSuffixItem], command: &mut CommandIr) {
		for item in items {
			match item {
				ast::CommandPrefixOrSuffixItem::Word(word) => self.arg(word, command),
				ast::CommandPrefixOrSuffixItem::AssignmentWord(_, word) => self.arg(word, command),
				ast::CommandPrefixOrSuffixItem::IoRedirect(redirect) => {
					self.redirect(redirect, command)
				},
				ast::CommandPrefixOrSuffixItem::ProcessSubstitution(..) => {
					self.opaque("process_substitution")
				},
			}
		}
	}

	fn arg(&self, word: &ast::Word, command: &mut CommandIr) {
		let position = command.argv.len() as u32;
		let dynamism = dynamism(&word.value);
		if dynamism != 0 {
			if position < 64 {
				command.dynamic_args |= 1_u64 << position;
			} else {
				command.dynamic_overflow.push(position);
			}
		}
		command
			.argv
			.push(ArgIr { text: word.value.clone(), dynamism, span: span(word.loc.clone()) });
	}

	fn redirect(&mut self, redirect: &ast::IoRedirect, command: &mut CommandIr) {
		let (fd, op, target_kind, target, target_fd, dynamism, access) = match redirect {
			ast::IoRedirect::File(fd, kind, target) => {
				let access = match kind {
					ast::IoFileRedirectKind::Read => READ,
					ast::IoFileRedirectKind::Append => WRITE | APPEND | CREATE,
					ast::IoFileRedirectKind::Write | ast::IoFileRedirectKind::Clobber => WRITE | CREATE,
					ast::IoFileRedirectKind::ReadAndWrite => READ | WRITE | CREATE,
					ast::IoFileRedirectKind::DuplicateInput
					| ast::IoFileRedirectKind::DuplicateOutput => 0,
				};
				match target {
					ast::IoFileRedirectTarget::Filename(word) => (
						*fd,
						format!("{kind}").into(),
						sf!("filename"),
						Some(word.value.clone()),
						None,
						dynamism(&word.value),
						access,
					),
					ast::IoFileRedirectTarget::Fd(target) => {
						(*fd, format!("{kind}").into(), sf!("fd"), None, Some(*target), 0, access)
					},
					ast::IoFileRedirectTarget::Duplicate(word) => (
						*fd,
						format!("{kind}").into(),
						sf!("duplicate"),
						Some(word.value.clone()),
						None,
						dynamism(&word.value),
						0,
					),
					ast::IoFileRedirectTarget::ProcessSubstitution(..) => {
						(*fd, format!("{kind}").into(), sf!("process_substitution"), None, None, 0, 0)
					},
				}
			},
			ast::IoRedirect::OutputAndError(word, append) => (
				None,
				if *append { sf!(">&>>") } else { sf!("&>") },
				sf!("filename"),
				Some(word.value.clone()),
				None,
				dynamism(&word.value),
				if *append {
					WRITE | APPEND | CREATE
				} else {
					WRITE | CREATE
				},
			),
			ast::IoRedirect::HereDocument(..) | ast::IoRedirect::HereString(..) => {
				self.opaque("here_redirect");
				return;
			},
		};
		let path = target.as_ref().map(|target| {
			self.path(target.clone(), dynamism, access, "redirect", command.index, Span::default())
		});
		if let Some(path) = &path {
			self.record_path(path.clone());
		}
		command.redirects.push(RedirectIr {
			fd,
			op,
			target_kind,
			target,
			target_fd,
			dynamism,
			path,
			span: Span::default(),
		});
	}

	fn redirect_only(&mut self, redirect: &ast::IoRedirect) {
		let mut command = CommandIr { index: self.ir.commands.len() as u32, ..CommandIr::default() };
		self.redirect(redirect, &mut command);
	}

	fn infer(&mut self, command: &mut CommandIr) {
		let Some(name) = command.name.as_deref() else {
			self.opaque("dynamic_command_name");
			return;
		};
		let args = &command.argv;
		let operands = args.iter().skip(1).filter(|arg| !arg.text.starts_with("-"));
		match name {
			"cp" | "install" => {
				let values: SmallVec<&ArgIr, 8> = operands.collect();
				if let Some((destination, sources)) = values.split_last() {
					for source in sources {
						self.record_path(self.path(
							source.text.clone(),
							source.dynamism,
							READ,
							name,
							command.index,
							source.span,
						));
					}
					self.record_path(self.path(
						destination.text.clone(),
						destination.dynamism,
						WRITE | CREATE,
						name,
						command.index,
						destination.span,
					));
				}
			},
			"mv" => {
				let values: SmallVec<&ArgIr, 8> = operands.collect();
				if let Some((destination, sources)) = values.split_last() {
					for source in sources {
						self.record_path(self.path(
							source.text.clone(),
							source.dynamism,
							DELETE,
							name,
							command.index,
							source.span,
						));
					}
					self.record_path(self.path(
						destination.text.clone(),
						destination.dynamism,
						WRITE | CREATE,
						name,
						command.index,
						destination.span,
					));
				}
			},
			"rm" | "rmdir" | "unlink" => {
				for arg in operands {
					self.record_path(self.path(
						arg.text.clone(),
						arg.dynamism,
						DELETE,
						name,
						command.index,
						arg.span,
					));
				}
			},
			"touch" | "mkdir" | "truncate" => {
				for arg in operands {
					self.record_path(self.path(
						arg.text.clone(),
						arg.dynamism,
						WRITE | CREATE,
						name,
						command.index,
						arg.span,
					));
				}
			},
			"dd" => {
				for arg in args.iter().skip(1) {
					if let Some(value) = arg.text.strip_prefix("of=") {
						self.record_path(self.path(
							value.into(),
							arg.dynamism,
							WRITE | CREATE,
							"dd:of",
							command.index,
							arg.span,
						));
					} else if let Some(value) = arg.text.strip_prefix("if=") {
						self.record_path(self.path(
							value.into(),
							arg.dynamism,
							READ,
							"dd:if",
							command.index,
							arg.span,
						));
					}
				}
			},
			"curl" | "wget" | "nc" | "ssh" | "scp" => self.infer_network(command),
			"sh" | "bash" | "zsh" | "python" | "python3" | "node" | "ruby" | "perl" => {
				self.interpreter(command)
			},
			"cat" | "head" | "tail" | "less" | "more" | "wc" | "ls" | "stat" | "file" | "sort"
			| "uniq" | "cut" | "readlink" | "realpath" => self.read_operands(command),
			"grep" => self.grep_read_operands(command),
			"tr" | "basename" | "dirname" | "which" | "pwd" | "env" | "date" => {},
			"cd" | "echo" | "printf" | "true" | "false" | "test" | "[" | "]" => {},
			// Commands outside the colocated coreutils table can have arbitrary effects.
			_ => self.opaque("unclassified_command"),
		}
	}

	fn read_operands(&mut self, command: &CommandIr) {
		for arg in command
			.argv
			.iter()
			.skip(1)
			.filter(|arg| !arg.text.starts_with("-"))
		{
			self.record_path(self.path(
				arg.text.clone(),
				arg.dynamism,
				READ,
				command.name.as_deref().unwrap_or_default(),
				command.index,
				arg.span,
			));
		}
	}

	fn grep_read_operands(&mut self, command: &CommandIr) {
		let mut operands = command
			.argv
			.iter()
			.skip(1)
			.filter(|arg| !arg.text.starts_with("-"));
		let _pattern = operands.next();
		for arg in operands {
			self.record_path(self.path(
				arg.text.clone(),
				arg.dynamism,
				READ,
				"grep",
				command.index,
				arg.span,
			));
		}
	}

	fn infer_network(&mut self, command: &CommandIr) {
		let net_before = self.ir.net.len();
		for arg in command.argv.iter().skip(1) {
			if arg.text == "-o" {
				continue;
			}
			if arg.text.starts_with("http://") || arg.text.starts_with("https://") {
				let (scheme, rest) = arg.text.split_once("://").unwrap_or(("", ""));
				let host = rest.split('/').next().filter(|host| !host.is_empty());
				self.ir.net.push(NetRefIr {
					kind:          sf!("url"),
					direction:     sf!("outbound"),
					host:          host.map(Str::new),
					scheme:        Some(Str::new(scheme)),
					url:           Some(arg.text.clone()),
					command_index: command.index,
					dynamic:       arg.dynamism != 0,
					span:          arg.span,
				});
			}
		}
		if self.ir.net.len() == net_before {
			if let Some(arg) = command
				.argv
				.iter()
				.skip(1)
				.find(|arg| !arg.text.starts_with("-"))
			{
				self.ir.net.push(NetRefIr {
					kind:          sf!("network"),
					direction:     sf!("outbound"),
					host:          Some(arg.text.clone()),
					scheme:        None,
					url:           None,
					command_index: command.index,
					dynamic:       arg.dynamism != 0,
					span:          arg.span,
				});
			}
		}
		let args = &command.argv;
		for pair in args.windows(2) {
			if pair[0].text == "-o" {
				self.record_path(self.path(
					pair[1].text.clone(),
					pair[1].dynamism,
					WRITE | CREATE,
					"network_output",
					command.index,
					pair[1].span,
				));
			}
		}
	}

	fn interpreter(&mut self, command: &mut CommandIr) {
		for pair in command.argv.windows(2) {
			if matches!(pair[0].text.as_str(), "-c" | "-e" | "--eval" | "-f") {
				if pair[1].dynamism == 0 {
					command.interpreter_code = Some(pair[1].text.clone());
				} else {
					self.ir.has_dynamic_eval = true;
					self.opaque("dynamic_interpreter_payload");
				}
				return;
			}
		}
	}

	fn fold_cd(&mut self, command: &CommandIr) {
		if command.name.as_deref() != Some("cd") {
			return;
		}
		let Some(target) = command.argv.get(1) else {
			self.cwd = EffectiveCwd::Unknown;
			return;
		};
		if target.dynamism != 0 {
			self.cwd = EffectiveCwd::Unknown;
			return;
		}
		self.cwd = match &self.cwd {
			EffectiveCwd::Known(base) => EffectiveCwd::Known(resolve(base, &target.text).into()),
			EffectiveCwd::Unknown => EffectiveCwd::Unknown,
		};
	}

	fn path(
		&self,
		lexical: Str,
		dynamism: u32,
		access: u32,
		origin: &str,
		command_index: u32,
		span: Span,
	) -> PathRefIr {
		let resolved = if dynamism == 0 {
			self.cwd.known().map(|cwd| resolve(&cwd, &lexical).into())
		} else {
			None
		};
		let outside_workspace = dynamism != 0
			|| resolved
				.as_deref()
				.is_none_or(|value| !within_root(value, self.root));
		PathRefIr {
			lexical,
			resolved,
			access,
			origin: Str::new(origin),
			command_index,
			outside_workspace,
			dynamic: dynamism != 0,
			span,
		}
	}

	fn record_path(&mut self, path: PathRefIr) {
		if path.access & READ != 0 {
			self.ir.reads.push(path.clone());
		}
		if path.access & (WRITE | DELETE) != 0 {
			self.ir.writes.push(path);
		}
	}

	fn opaque(&mut self, reason: &str) {
		self.ir.opaque.push(Str::new(reason));
	}
}

impl EffectiveCwd {
	fn known(&self) -> Option<Str> {
		match self {
			Self::Known(value) => Some(value.clone()),
			Self::Unknown => None,
		}
	}
}

fn dynamism(value: &str) -> u32 {
	// Follow-up: record this bitmap on ast::Word during parsing to avoid reparsing
	// here.
	let mut mask = 0;
	match word::parse(value, &ParserOptions::default()) {
		Ok(pieces) => {
			for piece in pieces {
				mask |= piece_dynamism(&piece.piece);
			}
		},
		Err(_) => {
			return PARAMETER | COMMAND_SUBSTITUTION | ARITHMETIC | TILDE | GLOB | BRACE | ESCAPE;
		},
	}
	if value.contains('*') || value.contains('?') || value.contains('[') {
		mask |= GLOB;
	}
	if value.contains('{') && value.contains('}') {
		mask |= BRACE;
	}
	mask
}

fn piece_dynamism(piece: &word::WordPiece) -> u32 {
	match piece {
		word::WordPiece::Text(_)
		| word::WordPiece::SingleQuotedText(_)
		| word::WordPiece::AnsiCQuotedText(_) => 0,
		word::WordPiece::DoubleQuotedSequence(items)
		| word::WordPiece::GettextDoubleQuotedSequence(items) => items
			.iter()
			.fold(0, |mask, item| mask | piece_dynamism(&item.piece)),
		word::WordPiece::TildeExpansion(_) => TILDE,
		word::WordPiece::ParameterExpansion(_) => PARAMETER,
		word::WordPiece::CommandSubstitution(_)
		| word::WordPiece::BackquotedCommandSubstitution(_) => COMMAND_SUBSTITUTION,
		word::WordPiece::EscapeSequence(_) => ESCAPE,
		word::WordPiece::ArithmeticExpression(_) => ARITHMETIC,
	}
}

fn span(span: Option<SourceSpan>) -> Span {
	span
		.map(|span| Span {
			start:  span.start.index.min(u32::MAX as usize) as u32,
			end:    span.end.index.min(u32::MAX as usize) as u32,
			line:   span.start.line.min(u32::MAX as usize) as u32,
			column: span.start.column.min(u32::MAX as usize) as u32,
		})
		.unwrap_or_default()
}

fn resolve(cwd: &str, value: &str) -> String {
	let joined = if Path::new(value).is_absolute() {
		value.to_owned()
	} else {
		format!("{cwd}/{value}")
	};
	let mut output = String::new();
	for component in Path::new(&joined).components() {
		match component {
			Component::RootDir => output.push('/'),
			Component::Normal(value) => {
				if !output.ends_with('/') {
					output.push('/');
				}
				output.push_str(&value.to_string_lossy());
			},
			Component::ParentDir => {
				if let Some(index) = output.rfind('/') {
					output.truncate(index.max(1));
				}
			},
			Component::CurDir | Component::Prefix(_) => {},
		}
	}
	if output.is_empty() {
		"/".into()
	} else {
		output
	}
}
fn within_root(path: &str, root: &str) -> bool {
	let root = resolve("/", root);
	let path = resolve("/", path);
	path == root
		|| path
			.strip_prefix(&root)
			.is_some_and(|rest| rest.starts_with('/'))
}

impl From<Span> for proto::Span {
	fn from(value: Span) -> Self {
		Self { start: value.start, end: value.end, line: value.line, column: value.column }
	}
}
impl From<&ArgIr> for proto::BashArg {
	fn from(value: &ArgIr) -> Self {
		Self {
			text:     value.text.to_string(),
			dynamic:  value.dynamism != 0,
			dynamism: value.dynamism,
			quoting:  String::new(),
			span:     Some(value.span.into()),
			props:    None,
		}
	}
}
impl From<&PathRefIr> for proto::PathRef {
	fn from(value: &PathRefIr) -> Self {
		Self {
			lexical:           value.lexical.to_string(),
			resolved:          value.resolved.as_ref().map(ToString::to_string),
			absolute:          value.resolved.as_ref().map(ToString::to_string),
			access:            value.access,
			origin:            value.origin.to_string(),
			command_index:     value.command_index,
			outside_workspace: value.outside_workspace,
			exists:            false,
			dynamic:           value.dynamic,
			span:              Some(value.span.into()),
			props:             None,
		}
	}
}
impl From<&NetRefIr> for proto::NetRef {
	fn from(value: &NetRefIr) -> Self {
		Self {
			kind:          value.kind.to_string(),
			direction:     value.direction.to_string(),
			host:          value.host.as_ref().map(ToString::to_string),
			port:          None,
			scheme:        value.scheme.as_ref().map(ToString::to_string),
			url:           value.url.as_ref().map(ToString::to_string),
			command_index: value.command_index,
			dynamic:       value.dynamic,
			span:          Some(value.span.into()),
			props:         None,
		}
	}
}
impl From<&RedirectIr> for proto::BashRedirect {
	fn from(value: &RedirectIr) -> Self {
		Self {
			fd:          value.fd,
			op:          value.op.to_string(),
			target_kind: value.target_kind.to_string(),
			target:      value.target.as_ref().map(ToString::to_string),
			target_fd:   value.target_fd,
			dynamism:    value.dynamism,
			path:        value.path.as_ref().map(Into::into),
			span:        Some(value.span.into()),
			props:       None,
		}
	}
}
impl From<&CommandIr> for proto::BashCommand {
	fn from(value: &CommandIr) -> Self {
		Self {
			index:            value.index,
			name:             value.name.as_ref().map(ToString::to_string),
			argv:             value.argv.iter().map(Into::into).collect(),
			dynamic_args:     value.argv.iter().map(|arg| arg.dynamism != 0).collect(),
			redirects:        value.redirects.iter().map(Into::into).collect(),
			reads:            value.reads.iter().map(Into::into).collect(),
			writes:           value.writes.iter().map(Into::into).collect(),
			net:              value.net.iter().map(Into::into).collect(),
			cwd:              value.cwd.as_ref().map(ToString::to_string),
			depth:            value.depth,
			container:        String::new(),
			subshell:         value.subshell,
			classification:   0,
			interpreter_code: value.interpreter_code.as_ref().map(ToString::to_string),
			span:             Some(value.span.into()),
			props:            None,
		}
	}
}
impl From<&ScriptIr> for proto::BashIr {
	fn from(value: &ScriptIr) -> Self {
		Self {
			source:           value.source.to_string(),
			rev:              value.rev.to_string(),
			parser_rev:       String::new(),
			parse_ok:         true,
			parse_error:      None,
			truncated:        false,
			node_count:       value.node_count,
			is_compound:      value.commands.len() != 1,
			has_dynamic_eval: value.has_dynamic_eval,
			commands:         value.commands.iter().map(Into::into).collect(),
			reads:            value.reads.iter().map(Into::into).collect(),
			writes:           value.writes.iter().map(Into::into).collect(),
			net:              value.net.iter().map(Into::into).collect(),
			opaque:           value.opaque.iter().map(ToString::to_string).collect(),
			props:            None,
		}
	}
}
impl From<ScriptIr> for proto::BashIr {
	fn from(value: ScriptIr) -> Self {
		(&value).into()
	}
}

impl From<proto::Span> for Span {
	fn from(value: proto::Span) -> Self {
		Self { start: value.start, end: value.end, line: value.line, column: value.column }
	}
}
impl From<proto::BashArg> for ArgIr {
	fn from(value: proto::BashArg) -> Self {
		Self {
			text:     value.text.into(),
			dynamism: value.dynamism,
			span:     value.span.map(Into::into).unwrap_or_default(),
		}
	}
}
impl From<proto::PathRef> for PathRefIr {
	fn from(value: proto::PathRef) -> Self {
		Self {
			lexical:           value.lexical.into(),
			resolved:          value.resolved.map(Into::into),
			access:            value.access,
			origin:            value.origin.into(),
			command_index:     value.command_index,
			outside_workspace: value.outside_workspace,
			dynamic:           value.dynamic,
			span:              value.span.map(Into::into).unwrap_or_default(),
		}
	}
}
impl From<proto::NetRef> for NetRefIr {
	fn from(value: proto::NetRef) -> Self {
		Self {
			kind:          value.kind.into(),
			direction:     value.direction.into(),
			host:          value.host.map(Into::into),
			scheme:        value.scheme.map(Into::into),
			url:           value.url.map(Into::into),
			command_index: value.command_index,
			dynamic:       value.dynamic,
			span:          value.span.map(Into::into).unwrap_or_default(),
		}
	}
}
impl From<proto::BashRedirect> for RedirectIr {
	fn from(value: proto::BashRedirect) -> Self {
		Self {
			fd:          value.fd,
			op:          value.op.into(),
			target_kind: value.target_kind.into(),
			target:      value.target.map(Into::into),
			target_fd:   value.target_fd,
			dynamism:    value.dynamism,
			path:        value.path.map(Into::into),
			span:        value.span.map(Into::into).unwrap_or_default(),
		}
	}
}
impl From<proto::BashCommand> for CommandIr {
	fn from(value: proto::BashCommand) -> Self {
		let argv: SmallVec<ArgIr, 8> = value.argv.into_iter().map(Into::into).collect();
		let mut dynamic_args = 0;
		let mut dynamic_overflow = SmallVec::new();
		for (index, _) in argv.iter().enumerate().filter(|(_, arg)| arg.dynamism != 0) {
			if index < 64 {
				dynamic_args |= 1_u64 << index;
			} else {
				dynamic_overflow.push(index as u32);
			}
		}
		Self {
			index: value.index,
			name: value.name.map(Into::into),
			argv,
			dynamic_args,
			dynamic_overflow,
			redirects: value.redirects.into_iter().map(Into::into).collect(),
			reads: value.reads.into_iter().map(Into::into).collect(),
			writes: value.writes.into_iter().map(Into::into).collect(),
			net: value.net.into_iter().map(Into::into).collect(),
			cwd: value.cwd.map(Into::into),
			depth: value.depth,
			subshell: value.subshell,
			interpreter_code: value.interpreter_code.map(Into::into),
			span: value.span.map(Into::into).unwrap_or_default(),
		}
	}
}
impl From<proto::BashIr> for ScriptIr {
	fn from(value: proto::BashIr) -> Self {
		Self {
			source:           value.source.into(),
			rev:              value.rev.into(),
			commands:         value.commands.into_iter().map(Into::into).collect(),
			reads:            value.reads.into_iter().map(Into::into).collect(),
			writes:           value.writes.into_iter().map(Into::into).collect(),
			net:              value.net.into_iter().map(Into::into).collect(),
			opaque:           value.opaque.into_iter().map(Into::into).collect(),
			has_dynamic_eval: value.has_dynamic_eval,
			node_count:       value.node_count,
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::BufReader;

	use super::*;
	use crate::parser::Parser;

	fn parsed(source: &str) -> ast::Program {
		let mut parser = Parser::new(BufReader::new(source.as_bytes()), &ParserOptions::default());
		parser.parse_program().expect("test script parses")
	}

	#[test]
	fn records_literal_and_dynamic_words() {
		let ir = analyze(&parsed("echo literal \"$HOME\" $(hostname)"), "/work", "/work");
		assert_eq!(ir.commands[0].argv[1].dynamism, 0);
		assert_ne!(ir.commands[0].argv[2].dynamism & PARAMETER, 0);
		assert_ne!(ir.commands[0].argv[3].dynamism & COMMAND_SUBSTITUTION, 0);
		assert_eq!(ir.commands[0].dynamic_args, 0b1100);
	}

	#[test]
	fn folds_cwd_without_leaking_subshells_or_pipeline_stages() {
		let ir = analyze(
			&parsed("cd src && cat a; (cd tmp; cat b); cd pipe | cat c; cat d"),
			"/work",
			"/work",
		);
		assert_eq!(ir.commands[1].cwd.as_deref(), Some("/work/src"));
		assert_eq!(ir.commands[3].cwd.as_deref(), Some("/work/src/tmp"));
		assert_eq!(
			ir.commands
				.last()
				.and_then(|command| command.cwd.as_deref()),
			Some("/work/src")
		);
	}

	#[test]
	fn records_redirect_targets_as_path_writes() {
		let ir = analyze(&parsed("echo x > output; cat < input"), "/work", "/work");
		assert_eq!(ir.commands[0].redirects[0].target.as_deref(), Some("output"));
		assert!(
			ir.writes
				.iter()
				.any(|path| path.lexical == "output" && path.access & WRITE != 0)
		);
		assert!(
			ir.reads
				.iter()
				.any(|path| path.lexical == "input" && path.access & READ != 0)
		);
	}

	#[test]
	fn extracts_literal_interpreter_payloads_and_opaque_dynamic_ones() {
		let literal = analyze(&parsed("python -c 'print(1)'"), "/work", "/work");
		assert_eq!(literal.commands[0].interpreter_code.as_deref(), Some("'print(1)'"));
		let dynamic = analyze(&parsed("python -c \"$CODE\""), "/work", "/work");
		assert!(dynamic.has_dynamic_eval);
		assert!(!dynamic.is_read_only());
	}

	#[test]
	fn policy_predicates_cover_small_script_corpus() {
		let read = analyze(&parsed("cat src/a"), "/work", "/work");
		assert!(read.is_read_only());
		assert!(read.touches("src/a").next().is_some());
		let write = analyze(&parsed("touch ../outside"), "/work", "/work");
		assert!(!write.is_read_only());
		assert!(write.writes_outside("/work"));
		let network = analyze(&parsed("curl https://example.test/a"), "/work", "/work");
		assert_eq!(
			network
				.net_sinks()
				.next()
				.and_then(|sink| sink.host.as_deref()),
			Some("example.test")
		);
	}
}
