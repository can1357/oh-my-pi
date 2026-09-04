//! Prompt templates: Markdown files that become `/name` slash commands.
//!
//! Sources, in order: the user directory `<config root>/agent/prompts`, the
//! project directory `<project>/.omp/prompts` (both scanned recursively; a
//! nested `review/rust.md` is still `/rust`, its source reads
//! `(project:review)`), then every `--prompt-template <file|dir>` path
//! (`(custom)`). The first template to claim a name wins.
//! `--no-prompt-templates` drops the discovered directories; explicit paths
//! always load.
//!
//! Expansion: `$1`, `$2`, … are positional words,
//! `$ARGUMENTS` / `$@` every word, `$@[n]` words from `n`, `$@[n:len]` a
//! window; the substituted body then renders through `omp_scribe` with
//! `args`, `ARGUMENTS`, and `arguments` bound, and when the template names no
//! placeholder at all the words are appended after a blank line so they are
//! never lost.

use std::{
	fs,
	path::{Path, PathBuf},
};

use omp_core::Str;
use serde::Deserialize;

use super::rules::{Level, Warning, split_frontmatter};

/// One loaded template.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptTemplate {
	/// Command name: the file stem.
	pub name:        Str,
	/// Palette description: frontmatter `description`, else the first
	/// non-empty line (60 chars), followed by the source tag.
	pub description: Str,
	/// Body after the frontmatter.
	pub content:     Str,
	/// `(user)`, `(project)`, `(project:sub:dir)`, or `(custom)`.
	pub source:      Str,
	/// Canonical file path.
	pub path:        PathBuf,
}

/// The templates one launch registers.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptTemplates {
	/// Winning templates in discovery order.
	pub templates: Vec<PromptTemplate>,
	/// Unreadable or duplicate documents.
	pub warnings:  Vec<Warning>,
}

impl PromptTemplates {
	/// Discovers templates for `project_root`: the two standard directories
	/// when `discover` is set, then `explicit` files or directories.
	#[must_use]
	pub fn discover(
		project_root: &Path,
		config_root: &Path,
		explicit: &[PathBuf],
		discover: bool,
	) -> Self {
		let mut out = Self::default();
		if discover {
			out.load_dir(&config_root.join("agent/prompts"), Level::User, "", true);
			out.load_dir(&project_root.join(".omp/prompts"), Level::Project, "", true);
		}
		for path in explicit {
			let path = if path.is_absolute() {
				path.clone()
			} else {
				project_root.join(path)
			};
			match fs::metadata(&path) {
				Ok(metadata) if metadata.is_dir() => out.load_dir(&path, Level::Project, "", false),
				Ok(_) if is_markdown(&path) => out.load_file(&path, Str::new_static("(custom)")),
				Ok(_) => out.warnings.push(Warning {
					path,
					message: Str::new_static(
						"prompt template path is neither a directory nor a Markdown file",
					),
				}),
				Err(error) => out.warnings.push(Warning {
					path,
					message: Str::new(format!("cannot inspect prompt template path: {error}")),
				}),
			}
		}
		out
	}

	/// The template named `name`.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<&PromptTemplate> {
		self
			.templates
			.iter()
			.find(|template| template.name.as_str() == name)
	}

	/// Expands a submitted line when it is `/name [args]` for a known
	/// template; `None` leaves the line as typed.
	#[must_use]
	pub fn expand_line(&self, text: &str) -> Option<Str> {
		let command = text.strip_prefix('/')?;
		let (name, rest) = command
			.split_once(' ')
			.map_or((command, ""), |(name, rest)| (name, rest));
		let template = self.get(name)?;
		Some(expand(template, &parse_command_args(rest)))
	}

	/// Expands template `name` with already-split words.
	#[must_use]
	pub fn expand(&self, name: &str, args: &[Str]) -> Option<Str> {
		self.get(name).map(|template| expand(template, args))
	}

	/// Recursively loads `*.md` files below `dir`. `standard` sources tag
	/// nested directories (`(project:review)`), explicit ones read `(custom)`.
	fn load_dir(&mut self, dir: &Path, level: Level, subdir: &str, standard: bool) {
		let entries = match fs::read_dir(dir) {
			Ok(entries) => entries,
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
			Err(error) => {
				self.warnings.push(Warning {
					path:    dir.to_path_buf(),
					message: Str::new(format!("cannot read prompt template directory: {error}")),
				});
				return;
			},
		};
		let mut paths = entries
			.filter_map(Result::ok)
			.map(|entry| entry.path())
			.filter(|path| {
				!path
					.file_name()
					.is_some_and(|name| name.to_string_lossy().starts_with('.'))
			})
			.collect::<Vec<_>>();
		paths.sort();
		// Shallower entries are ordered first so a top-level template claims
		// its name before a nested namesake.
		for path in paths
			.iter()
			.filter(|path| path.is_file() && is_markdown(path))
		{
			let source = if !standard {
				Str::new_static("(custom)")
			} else {
				let level: &'static str = level.into();
				if subdir.is_empty() {
					Str::new(format!("({level})"))
				} else {
					Str::new(format!("({level}:{subdir})"))
				}
			};
			self.load_file(path, source);
		}
		for path in paths.iter().filter(|path| path.is_dir()) {
			let name = path
				.file_name()
				.map(|name| name.to_string_lossy())
				.unwrap_or_default();
			let nested = if subdir.is_empty() {
				name.into_owned()
			} else {
				format!("{subdir}:{name}")
			};
			self.load_dir(path, level, &nested, standard);
		}
	}

	fn load_file(&mut self, path: &Path, source: Str) {
		let canonical = match fs::canonicalize(path) {
			Ok(canonical) => canonical,
			Err(error) => {
				self.warnings.push(Warning {
					path:    path.to_path_buf(),
					message: Str::new(format!("cannot read prompt template: {error}")),
				});
				return;
			},
		};
		let text = match fs::read_to_string(&canonical) {
			Ok(text) => text,
			Err(error) => {
				self.warnings.push(Warning {
					path:    canonical,
					message: Str::new(format!("cannot read prompt template: {error}")),
				});
				return;
			},
		};
		let Some(name) = path
			.file_stem()
			.map(|stem| Str::new(stem.to_string_lossy()))
		else {
			return;
		};
		if self.get(&name).is_some() {
			self.warnings.push(Warning {
				path:    canonical,
				message: Str::new(format!("prompt template name collision: \"{name}\" already loaded")),
			});
			return;
		}
		let (header, body) = split_frontmatter(&text);
		let header = match header.map(serde_yaml::from_str::<TemplateHeader>) {
			None => TemplateHeader::default(),
			Some(Ok(header)) => header,
			Some(Err(error)) => {
				self.warnings.push(Warning {
					path:    canonical,
					message: Str::new(format!("failed to parse prompt template frontmatter: {error}")),
				});
				return;
			},
		};
		let mut description = header
			.description
			.map(|value| value.trim().to_owned())
			.filter(|value| !value.is_empty())
			.unwrap_or_else(|| {
				body
					.lines()
					.map(str::trim)
					.find(|line| !line.is_empty())
					.map(|line| {
						let mut short = line.chars().take(60).collect::<String>();
						if line.chars().count() > 60 {
							short.push_str("...");
						}
						short
					})
					.unwrap_or_default()
			});
		if !description.is_empty() {
			description.push(' ');
		}
		description.push_str(&source);
		self.templates.push(PromptTemplate {
			name,
			description: Str::new(description),
			content: Str::new(body),
			source,
			path: canonical,
		});
	}
}

#[derive(Default, Deserialize)]
struct TemplateHeader {
	description: Option<String>,
}

fn is_markdown(path: &Path) -> bool {
	path
		.extension()
		.is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

/// Expands one template with `args`.
#[must_use]
pub fn expand(template: &PromptTemplate, args: &[Str]) -> Str {
	let joined = args.join(" ");
	let uses_placeholders = uses_inline_arg_placeholders(&template.content);
	let substituted = substitute_args(&template.content, args);
	let rendered = render(&substituted, args, &joined);
	Str::new(append_inline_args_fallback(rendered, &joined, uses_placeholders))
}

/// Renders the substituted body through `omp_scribe` with `args`,
/// `ARGUMENTS`, and `arguments` bound. A template that is not valid scribe
/// syntax is used verbatim.
fn render(source: &str, args: &[Str], joined: &str) -> String {
	let engine = omp_scribe::Engine::new();
	let Ok(template) = engine.compile_owned(Str::new_static("prompt-template"), source) else {
		return source.to_owned();
	};
	let mut props = omp_scribe::Props::new();
	props.set("args", args.to_vec());
	props.set("ARGUMENTS", Str::new(joined));
	props.set("arguments", Str::new(joined));
	template
		.render_str(&engine, &props)
		.map_or_else(|_| source.to_owned(), |rendered| rendered.to_string())
}

/// Recognizes `$ARGUMENTS`, `$@`, `$@[n]`,
/// `$@[n:len]`, `$1`…, or a `{{ … }}` expression over `args`/`arguments`/
/// `ARGUMENTS`.
#[must_use]
pub fn uses_inline_arg_placeholders(source: &str) -> bool {
	let bytes = source.as_bytes();
	let mut index = 0;
	while let Some(offset) = source[index..].find('$') {
		let at = index + offset + 1;
		let rest = &source[at..];
		if rest.starts_with("ARGUMENTS") || rest.starts_with('@') {
			return true;
		}
		if bytes.get(at).is_some_and(u8::is_ascii_digit) {
			return true;
		}
		index = at;
	}
	let mut index = 0;
	while let Some(offset) = source[index..].find("{{") {
		let start = index + offset + 2;
		let Some(end) = source[start..].find("}}") else {
			break;
		};
		let inner = &source[start..start + end];
		if inner
			.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
			.any(|word| matches!(word, "arguments" | "ARGUMENTS" | "args" | "arg"))
		{
			return true;
		}
		index = start + end + 2;
	}
	false
}

/// Appends words the template never referenced after a blank line.
#[must_use]
pub fn append_inline_args_fallback(
	rendered: String,
	args_text: &str,
	uses_inline_arg_placeholders: bool,
) -> String {
	if args_text.is_empty() || uses_inline_arg_placeholders {
		return rendered;
	}
	if rendered.is_empty() {
		return args_text.to_owned();
	}
	let mut out = rendered;
	out.push_str("\n\n");
	out.push_str(args_text);
	out
}

/// Splits whitespace-separated words with `"…"` / `'…'` quoting.
#[must_use]
pub fn parse_command_args(text: &str) -> Vec<Str> {
	let mut args = Vec::new();
	let mut current = String::new();
	let mut quote: Option<char> = None;
	for c in text.chars() {
		match quote {
			Some(open) if c == open => quote = None,
			Some(_) => current.push(c),
			None if c == '"' || c == '\'' => quote = Some(c),
			None if c == ' ' || c == '\t' => {
				if !current.is_empty() {
					args.push(Str::new(std::mem::take(&mut current)));
				}
			},
			None => current.push(c),
		}
	}
	if !current.is_empty() {
		args.push(Str::new(current));
	}
	args
}

/// Replaces placeholders on the template text only; argument values are never
/// re-scanned.
#[must_use]
pub fn substitute_args(content: &str, args: &[Str]) -> String {
	let mut out = String::with_capacity(content.len());
	let mut rest = content;
	while let Some(offset) = rest.find('$') {
		out.push_str(&rest[..offset]);
		let tail = &rest[offset..];
		let (replacement, consumed) = match_placeholder(tail, args);
		match replacement {
			Some(text) => out.push_str(&text),
			None => out.push_str(&tail[..consumed]),
		}
		rest = &tail[consumed..];
	}
	out.push_str(rest);
	out
}

/// Matches one placeholder at the start of `tail` (which begins with `$`):
/// returns the replacement (or `None` for a literal `$`) and the bytes
/// consumed.
fn match_placeholder(tail: &str, args: &[Str]) -> (Option<String>, usize) {
	let body = &tail[1..];
	if body.starts_with("ARGUMENTS") {
		return (Some(args.join(" ")), 1 + "ARGUMENTS".len());
	}
	if let Some(after) = body.strip_prefix("@[") {
		// `$@[start]`, `$@[start:]`, `$@[start:len]`
		if let Some(close) = after.find(']') {
			let spec = &after[..close];
			let (start, length) = spec
				.split_once(':')
				.map_or((spec, None), |(start, length)| (start, Some(length)));
			if !start.is_empty()
				&& start.bytes().all(|b| b.is_ascii_digit())
				&& length.is_none_or(|length| length.bytes().all(|b| b.is_ascii_digit()))
			{
				let consumed = 1 + 2 + close + 1;
				let Ok(start) = start.parse::<usize>() else {
					return (Some(String::new()), consumed);
				};
				if start < 1 || start - 1 >= args.len() {
					return (Some(String::new()), consumed);
				}
				let from = start - 1;
				let window = match length {
					None | Some("") => &args[from..],
					Some(length) => match length.parse::<usize>() {
						Ok(length) if length > 0 => &args[from..(from + length).min(args.len())],
						_ => return (Some(String::new()), consumed),
					},
				};
				return (Some(window.join(" ")), consumed);
			}
		}
	}
	if body.starts_with('@') {
		return (Some(args.join(" ")), 2);
	}
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	if digits > 0 {
		let index = body[..digits].parse::<usize>().unwrap_or(0);
		let value = index
			.checked_sub(1)
			.and_then(|index| args.get(index))
			.map_or_else(String::new, |word| word.to_string());
		return (Some(value), 1 + digits);
	}
	(None, 1)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn words(list: &[&str]) -> Vec<Str> {
		list.iter().map(|word| Str::new(*word)).collect()
	}

	fn template(content: &str) -> PromptTemplate {
		PromptTemplate {
			name:        Str::new_static("t"),
			description: Str::new_static("t (project)"),
			content:     Str::new(content),
			source:      Str::new_static("(project)"),
			path:        PathBuf::from("/t.md"),
		}
	}

	#[test]
	fn substitutes_positional_windows_and_all_args_without_rescanning_values() {
		let args = words(&["a", "$1", "c", "d"]);
		assert_eq!(substitute_args("$1|$2|$5|$@|$ARGUMENTS", &args), "a|$1||a $1 c d|a $1 c d");
		assert_eq!(
			substitute_args("$@[2] $@[2:2] $@[3:] $@[9] $@[0] $@[1:0]", &args),
			"$1 c d $1 c c d   "
		);
		assert_eq!(substitute_args("cost $5.00 and $x", &[]), "cost .00 and $x");
	}

	#[test]
	fn parses_quoted_words_like_pi() {
		assert_eq!(
			parse_command_args("one \"two words\" 'three'\tfour"),
			words(&["one", "two words", "three", "four"])
		);
		assert!(parse_command_args("   ").is_empty());
	}

	#[test]
	fn expansion_appends_unreferenced_args_and_renders_scribe_names() {
		assert_eq!(expand(&template("Review $1 now"), &words(&["lib.rs", "x"])), "Review lib.rs now");
		assert_eq!(expand(&template("Review this"), &words(&["lib.rs"])), "Review this\n\nlib.rs");
		assert_eq!(expand(&template("Review this"), &[]), "Review this");
		assert_eq!(expand(&template(""), &words(&["only"])), "only");
		assert_eq!(
			expand(&template("Args: {{ ARGUMENTS }} / {{ args | join(\",\") }}"), &words(&["a", "b"])),
			"Args: a b / a,b"
		);
		assert!(uses_inline_arg_placeholders("{{#if arguments}}x{{/if}}"));
		assert!(!uses_inline_arg_placeholders("price is $ 5 and {{ name }}"));
	}

	#[test]
	fn discovers_user_project_and_explicit_templates_with_sources_and_flags() {
		let temp = tempfile::tempdir().unwrap();
		let root = temp.path().canonicalize().unwrap();
		let config_root = root.join(".o2");
		let project = root.join("proj");
		let write = |path: PathBuf, text: &str| {
			fs::create_dir_all(path.parent().unwrap()).unwrap();
			fs::write(path, text).unwrap();
		};
		write(
			config_root.join("agent/prompts/review.md"),
			"---\ndescription: Review code\n---\nReview $ARGUMENTS",
		);
		write(project.join(".omp/prompts/review.md"), "project namesake loses");
		write(project.join(".omp/prompts/fix.md"), "Fix the failing test in $1\nsecond line");
		write(project.join(".omp/prompts/rust/lint.md"), "Lint rust");
		write(project.join(".omp/prompts/.hidden.md"), "hidden");
		write(project.join(".omp/prompts/notes.txt"), "not a template");
		write(root.join("extra/summarize.md"), "Summarize");
		write(root.join("extra.md"), "Explicit file");

		let templates = PromptTemplates::discover(
			&project,
			&config_root,
			&[root.join("extra"), PathBuf::from("../extra.md"), root.join("missing.md")],
			true,
		);
		let rows = templates
			.templates
			.iter()
			.map(|t| (t.name.as_str(), t.description.as_str(), t.source.as_str()))
			.collect::<Vec<_>>();
		assert_eq!(rows, [
			("review", "Review code (user)", "(user)"),
			("fix", "Fix the failing test in $1 (project)", "(project)"),
			("lint", "Lint rust (project:rust)", "(project:rust)"),
			("summarize", "Summarize (custom)", "(custom)"),
			("extra", "Explicit file (custom)", "(custom)"),
		]);
		assert_eq!(templates.warnings.len(), 2, "{:?}", templates.warnings);
		assert_eq!(
			templates
				.expand_line("/fix src/lib.rs \"and more\"")
				.as_deref(),
			Some("Fix the failing test in src/lib.rs\nsecond line")
		);
		assert_eq!(templates.expand_line("/review a b").as_deref(), Some("Review a b"));
		assert_eq!(templates.expand_line("/unknown a").as_deref(), None);
		assert_eq!(templates.expand_line("plain text").as_deref(), None);

		let suppressed =
			PromptTemplates::discover(&project, &config_root, &[root.join("extra.md")], false);
		let names = suppressed
			.templates
			.iter()
			.map(|t| t.name.as_str())
			.collect::<Vec<_>>();
		assert_eq!(names, ["extra"], "--no-prompt-templates keeps explicit paths only");
	}
}
