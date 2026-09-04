//! Autocompletion: names, typed values, and pluggable provider groups.
//!
//! Because the namespace is `::`-segmented and flat, prefix match *is*
//! namespace query: completing `sv::` enumerates the whole `sv` domain.
//! Types complete themselves (enum variants, booleans); string-ish slots
//! opt into a named provider group via [`Hint::Group`], resolved against
//! built-in `con::*` groups and [`Ctx::register_completer`].
//!
//! Built-in groups: `con::name` (every dispatchable name), `con::var`,
//! `con::cmd`, `con::alias`, `con::key` (currently bound keys), and
//! `con::script` (recursive statement completion, used by `bind`/`alias`
//! bodies).

use omp_core::{Str, StrMut};

use crate::{Ctx, Hint, RegItem, TypeSpec, ValueKind};

/// One completion candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Suggestion {
	/// Replacement text for the token being completed.
	pub text: Str,
	/// Short human context (item description, variant docs); may be empty.
	pub help: Str,
}

impl Suggestion {
	/// Candidate without help text.
	#[must_use]
	pub fn bare(text: impl Into<Str>) -> Self {
		Self { text: text.into(), help: Str::new_static("") }
	}
}

/// Completion provider: `(ctx, partial-token)` → candidates.
pub type CompleterFn = dyn Fn(&Ctx, &str) -> Vec<Suggestion> + Send + Sync;

impl Ctx {
	/// Registers (or replaces) a named completion provider group.
	pub fn register_completer(
		&self,
		group: impl Into<Str>,
		provider: impl Fn(&Self, &str) -> Vec<Suggestion> + Send + Sync + 'static,
	) {
		self
			.completers
			.write()
			.insert(group.into(), Box::new(provider));
	}

	/// Completes `line` at byte offset `cursor`.
	///
	/// Returns candidates for the token under the cursor, sorted by text.
	#[must_use]
	pub fn complete(&self, line: &str, cursor: usize) -> Vec<Suggestion> {
		let cursor = cursor.min(line.len());
		let prefix = &line[..cursor];
		let stmt = statement_prefix(prefix);
		let tokens = lenient_tokens(stmt);
		let (done, partial) = match tokens.last() {
			Some(tok) if !stmt.ends_with(char::is_whitespace) => {
				(&tokens[..tokens.len() - 1], tok.as_str())
			},
			_ => (&tokens[..], ""),
		};
		let mut out = if done.is_empty() {
			self.complete_name(partial)
		} else {
			self.complete_arg(&tokens, done.len(), partial)
		};
		out.sort_unstable_by(|a, b| a.text.cmp(&b.text));
		out.dedup_by(|a, b| a.text == b.text);
		out
	}

	/// Candidates for the name position (vars, commands, aliases, signed
	/// actions).
	fn complete_name(&self, partial: &str) -> Vec<Suggestion> {
		let mut out = Vec::new();
		let (sign, base) = match partial.as_bytes().first() {
			Some(b'+') => ("+", &partial[1..]),
			Some(b'-') => ("-", &partial[1..]),
			_ => ("", partial),
		};
		if sign.is_empty() {
			for var in self.vars().filter(|var| starts_with_ci(var.name, base)) {
				out.push(Suggestion { text: Str::from(var.name), help: first_line(var.desc) });
			}
		}
		for item in self.items() {
			match item {
				RegItem::Action(spec) => {
					// Actions complete under both signs; unsigned partials get `+`.
					if starts_with_ci(spec.name, base) {
						let sign = if sign.is_empty() { "+" } else { sign };
						let mut text = StrMut::new("");
						text.push_str(sign);
						text.push_str(spec.name);
						out.push(Suggestion { text: text.freeze(), help: first_line(spec.desc) });
					}
				},
				RegItem::Cmd(spec) if sign.is_empty() && starts_with_ci(spec.name, base) => {
					out.push(Suggestion {
						text: Str::new_static(spec.name),
						help: first_line(spec.desc),
					});
				},
				_ => {},
			}
		}
		if sign.is_empty() {
			for (name, desc) in self.dynamic_cmds() {
				if starts_with_ci(name, base) {
					out.push(Suggestion { text: name.clone(), help: first_line(desc) });
				}
			}
			for (name, body) in self.aliases() {
				if starts_with_ci(name.as_str(), base) {
					out.push(Suggestion { text: name, help: body });
				}
			}
		}
		out
	}

	/// Candidates for an argument position of `tokens[0]`.
	fn complete_arg(&self, tokens: &[Str], index: usize, partial: &str) -> Vec<Suggestion> {
		if index == 1
			&& let Some(var) = self
				.vars()
				.find(|var| var.name.eq_ignore_ascii_case(tokens[0].as_str()))
		{
			return self.complete_typed(var.ty, var.hint, partial);
		}
		let Some(RegItem::Cmd(spec)) = self.find(tokens[0].as_str()) else {
			return Vec::new();
		};
		match spec.args.get(index - 1) {
			Some(arg) if matches!(arg.hint, Hint::Group("con::script")) => {
				// Recursive statement completion for bind/alias bodies.
				self.complete_name(partial)
			},
			Some(arg) => self.complete_typed(arg.ty, arg.hint, partial),
			None => Vec::new(),
		}
	}

	/// Type- and hint-implied candidates for one value slot.
	fn complete_typed(&self, ty: &TypeSpec, hint: Hint, partial: &str) -> Vec<Suggestion> {
		let ty = if ty.kind == ValueKind::List {
			ty.elem.unwrap_or(TypeSpec::STR)
		} else {
			ty
		};
		match ty.kind {
			ValueKind::Enum => ty
				.variants
				.iter()
				.filter(|v| starts_with_ci(v, partial))
				.map(|v| Suggestion::bare(Str::new_static(v)))
				.collect(),
			ValueKind::Bool => ["true", "false"]
				.into_iter()
				.filter(|v| starts_with_ci(v, partial))
				.map(|v| Suggestion::bare(Str::new_static(v)))
				.collect(),
			ValueKind::Duration => {
				let mut out: Vec<Suggestion> = match hint {
					Hint::Suggest(values) => values
						.iter()
						.filter(|v| starts_with_ci(v, partial))
						.map(|v| Suggestion::bare(Str::new_static(v)))
						.collect(),
					_ => Vec::new(),
				};
				if starts_with_ci("never", partial) {
					out.push(Suggestion::bare(Str::new_static("never")));
				}
				out
			},
			_ => match hint {
				Hint::Suggest(values) => values
					.iter()
					.filter(|v| starts_with_ci(v, partial))
					.map(|v| Suggestion::bare(Str::new_static(v)))
					.collect(),
				Hint::Group(group) => self.complete_group(group, partial),
				Hint::None => Vec::new(),
			},
		}
	}

	/// Resolves a named group: built-in `con::*` groups first, then
	/// registered providers.
	fn complete_group(&self, group: &str, partial: &str) -> Vec<Suggestion> {
		match group {
			"con::name" | "con::script" => self.complete_name(partial),
			"con::var" => self
				.vars()
				.filter(|var| starts_with_ci(var.name, partial))
				.map(|var| Suggestion { text: Str::from(var.name), help: first_line(var.desc) })
				.collect(),
			"con::cmd" => {
				let static_cmds = self.filter_items(partial, |item| matches!(item, RegItem::Cmd(_)));
				let dynamic_cmds = self
					.dynamic_cmds()
					.filter(|(name, _)| starts_with_ci(name, partial))
					.map(|(name, desc)| Suggestion { text: name.clone(), help: first_line(desc) });
				static_cmds.into_iter().chain(dynamic_cmds).collect()
			},
			"con::alias" => self
				.aliases()
				.into_iter()
				.filter(|(name, _)| starts_with_ci(name.as_str(), partial))
				.map(|(name, body)| Suggestion { text: name, help: body })
				.collect(),
			"con::key" => self
				.binds()
				.into_iter()
				.filter(|(key, _)| starts_with_ci(key.as_str(), partial))
				.map(|(key, script)| Suggestion { text: key, help: script })
				.collect(),
			_ => match self.completers.read().get(group) {
				Some(provider) => provider(self, partial),
				None => Vec::new(),
			},
		}
	}

	fn filter_items(&self, partial: &str, keep: impl Fn(&RegItem) -> bool) -> Vec<Suggestion> {
		self
			.items()
			.filter(|item| keep(item) && starts_with_ci(item.name(), partial))
			.map(|item| Suggestion {
				text: Str::new_static(item.name()),
				help: first_line(item.desc()),
			})
			.collect()
	}
}

/// The current statement's slice of `prefix` (after the last top-level
/// `;`/newline outside quotes and literals).
fn statement_prefix(prefix: &str) -> &str {
	let mut start = 0;
	let mut in_quotes = false;
	let mut escaped = false;
	let mut depth = 0usize;
	for (i, ch) in prefix.char_indices() {
		match ch {
			_ if escaped => escaped = false,
			'\\' if in_quotes => escaped = true,
			'"' => in_quotes = !in_quotes,
			'[' | '{' if !in_quotes => depth += 1,
			']' | '}' if !in_quotes => depth = depth.saturating_sub(1),
			';' | '\n' if !in_quotes && depth == 0 => start = i + 1,
			_ => {},
		}
	}
	&prefix[start..]
}

/// Whitespace-split top-level tokens, tolerant of unterminated quotes.
fn lenient_tokens(stmt: &str) -> Vec<Str> {
	let mut out = Vec::new();
	let mut current = StrMut::new("");
	let mut in_quotes = false;
	let mut escaped = false;
	let mut has_token = false;
	for ch in stmt.chars() {
		match ch {
			_ if escaped => {
				escaped = false;
				current.push(ch);
			},
			'\\' if in_quotes => escaped = true,
			'"' => {
				in_quotes = !in_quotes;
				has_token = true;
			},
			ch if ch.is_whitespace() && !in_quotes => {
				if has_token {
					out.push(std::mem::take(&mut current).freeze());
					has_token = false;
				}
			},
			ch => {
				has_token = true;
				current.push(ch);
			},
		}
	}
	if has_token {
		out.push(current.freeze());
	}
	out
}

fn starts_with_ci(candidate: &str, prefix: &str) -> bool {
	candidate.len() >= prefix.len()
		&& candidate.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn first_line(desc: &str) -> Str {
	match desc.trim().lines().next() {
		Some(line) => Str::from(line.trim()),
		None => Str::new_static(""),
	}
}
