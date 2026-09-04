//! Workspace slash commands: `/add-dir`, `/remove-dir`, `/dirs`, `/move`,
//! `/wt` (`/worktree`).
//!
//! The TS implementation keeps additional workspace directories on the session
//! manager; here they are the `SESSION` convar [`SV_WORKSPACE_DIRS`] (ADR
//! 0012), so they journal into `<meta><con>`, survive `-c` resume, fall off on
//! rewind, and seed spawned children. `/move` and `/wt` relocate the journal
//! and the process working directory through the controller
//! ([`HostCommand::Move`](crate::HostCommand::Move)); the worktree itself
//! is created by the application ([`Services::create_worktree`]).
//!
//! [`Services::create_worktree`]: crate::overlays::services::Services::create_worktree

use std::{
	ffi::OsStr,
	fs,
	path::{Component, Path, PathBuf},
};

use omp_con::{ConError, Suggestion, Value};
use omp_core::{Str, sf};
use omp_tui::Icon;

use super::{CommandAction, PaletteEntry, rest};
use crate::{
	actions::{HostAction, post},
	overlays::{PanelCall, PanelCx, PanelEvent},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "add-dir", icon: Icon::FolderPlus },
	PaletteEntry { name: "remove-dir", icon: Icon::FolderMinus },
	PaletteEntry { name: "dirs", icon: Icon::Folder },
	PaletteEntry { name: "move", icon: Icon::FolderMove },
	PaletteEntry { name: "wt", icon: Icon::Worktree },
	PaletteEntry { name: "worktree", icon: Icon::Worktree },
];

/// Console completion group attached to `/move`'s optional path argument.
pub const MOVE_COMPLETION: &str = "workspace::move-directory";

/// One directory path completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryChoice {
	/// Replacement text, preserving relative, absolute, home-relative, and
	/// outer-double-quoted input style.
	pub value: Str,
	/// Basename shown in the completion row.
	pub label: Str,
}

omp_con::var! {
	/// Extra workspace directories added to every session as additional roots.
	/// Relative paths resolve from the working directory.
	pub static SV_WORKSPACE_DIRS = sv_workspace_dirs: Vec<Str> {
		default: Vec::new(),
		flags: archive | session,
		meta: {
			"legacy.path": "workspace.additionalDirectories",
		},
	};
}

const fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

fn call(ctx: &omp_con::Ctx, call: PanelCall) -> omp_con::ConResult<()> {
	post(ctx, HostAction::Call(call))
}

fn notice(text: impl Into<Str>) -> PanelEvent {
	PanelEvent::Notice(text.into())
}

/// Quotes one free-text path as a console atom, removing an existing pair
/// of outer double quotes before escaping it.
pub fn quote_console_atom(line: &mut String, input: &str) {
	let input = input.trim();
	let input = input
		.strip_prefix('"')
		.and_then(|rest| rest.strip_suffix('"'))
		.unwrap_or(input);
	line.push('"');
	for ch in input.chars() {
		if matches!(ch, '"' | '\\') {
			line.push('\\');
		}
		line.push(ch);
	}
	line.push('"');
}

/// Absolute paths stand, `~` expands, and the rest joins the
/// working directory; the result is lexically normalized.
#[must_use]
pub fn resolve_to_cwd(input: &str, cwd: &Path) -> PathBuf {
	let input = input.trim();
	let input = input
		.strip_prefix('"')
		.and_then(|rest| rest.strip_suffix('"'))
		.unwrap_or(input);
	let raw = if let Some(rest) = input.strip_prefix("~/") {
		std::env::var_os("HOME")
			.map_or_else(|| PathBuf::from(input), |home| Path::new(&home).join(rest))
	} else if input == "~" {
		std::env::var_os("HOME").map_or_else(|| PathBuf::from(input), PathBuf::from)
	} else {
		PathBuf::from(input)
	};
	let joined = if raw.is_absolute() {
		raw
	} else {
		cwd.join(raw)
	};
	let mut out = PathBuf::new();
	for component in joined.components() {
		match component {
			std::path::Component::CurDir => {},
			std::path::Component::ParentDir => {
				out.pop();
			},
			other => out.push(other),
		}
	}
	out
}

/// Lists directory argument completions while preserving input path style.
///
/// `substring` is the centered MovePanel behavior (typing `ph` finds
/// `alpha/`); the slash-command completer passes `false` for prefix matching.
#[must_use]
pub fn directory_choices(
	input: &str,
	cwd: &Path,
	max: usize,
	substring: bool,
) -> Vec<DirectoryChoice> {
	path_choices(input, cwd, max, substring, false)
}

/// Lists destination path completions, including existing files when
/// `include_files` is true. Directory values retain a trailing slash so an
/// editor can continue with a child filename.
#[must_use]
pub fn path_choices(
	input: &str,
	cwd: &Path,
	max: usize,
	substring: bool,
	include_files: bool,
) -> Vec<DirectoryChoice> {
	let original = input.trim();
	let quoted = original.starts_with('"');
	let prefix = original
		.strip_prefix('"')
		.map_or(original, |inner| inner.strip_suffix('"').unwrap_or(inner));
	let expanded = if let Some(rest) = prefix.strip_prefix("~/") {
		std::env::var_os("HOME")
			.map_or_else(|| PathBuf::from(prefix), |home| Path::new(&home).join(rest))
	} else if prefix == "~" {
		std::env::var_os("HOME").map_or_else(|| PathBuf::from(prefix), PathBuf::from)
	} else {
		PathBuf::from(prefix)
	};
	let absolute = expanded.is_absolute();
	let resolved = resolve_to_cwd(prefix, cwd);
	let exact_dir = !prefix.is_empty() && resolved.is_dir();
	let directory_input = prefix.is_empty()
		|| matches!(prefix, "." | "./" | ".." | "../" | "~" | "~/" | "/")
		|| prefix.ends_with('/')
		|| (substring && exact_dir);
	let (search_dir, query) = if directory_input {
		(
			if prefix.is_empty() {
				cwd.to_path_buf()
			} else {
				resolved
			},
			"",
		)
	} else {
		let parent = expanded.parent().unwrap_or_else(|| Path::new(""));
		let query = expanded
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or_default();
		(
			if absolute {
				parent.to_path_buf()
			} else {
				cwd.join(parent)
			},
			query,
		)
	};
	let include_hidden = if substring {
		query.starts_with('.')
			|| prefix
				.rsplit('/')
				.next()
				.is_some_and(|segment| segment.starts_with('.') && !segment.is_empty())
	} else {
		true
	};
	let lower = query.to_ascii_lowercase();
	let Ok(entries) = fs::read_dir(&search_dir) else {
		return Vec::new();
	};
	let mut choices = entries
		.filter_map(Result::ok)
		.filter_map(|entry| {
			let name = entry.file_name();
			let name = name.to_str()?;
			if name == ".git" || (!include_hidden && name.starts_with('.')) {
				return None;
			}
			let matches = if substring {
				name.to_ascii_lowercase().contains(&lower)
			} else {
				name.to_ascii_lowercase().starts_with(&lower)
			};
			if !matches {
				return None;
			}
			let file_type = entry.file_type().ok();
			let known_file = file_type.as_ref().is_some_and(std::fs::FileType::is_file);
			let directory = file_type.as_ref().is_some_and(std::fs::FileType::is_dir)
				|| (!known_file && fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir()));
			if !directory && !include_files {
				return None;
			}
			let value = completion_value(prefix, quoted, &entry.path(), cwd, directory);
			let label = if directory {
				sf!("{name}/")
			} else {
				Str::new(name)
			};
			Some(DirectoryChoice { value, label })
		})
		.collect::<Vec<_>>();
	choices.sort_unstable_by(|a, b| {
		a.label
			.bytes()
			.map(|byte| byte.to_ascii_lowercase())
			.cmp(b.label.bytes().map(|byte| byte.to_ascii_lowercase()))
			.then_with(|| a.label.cmp(&b.label))
	});
	choices.truncate(max);
	choices
}

fn completion_value(
	prefix: &str,
	quoted: bool,
	absolute: &Path,
	cwd: &Path,
	directory: bool,
) -> Str {
	let normalized = resolve_to_cwd(absolute.to_string_lossy().as_ref(), cwd);
	let path = if prefix.starts_with("~/") || prefix == "~" {
		let home = std::env::var_os("HOME")
			.map(PathBuf::from)
			.unwrap_or_default();
		let relative = normalized.strip_prefix(home).unwrap_or(&normalized);
		sf!("~/{}", relative.to_string_lossy().replace('\\', "/"))
	} else if prefix.starts_with('/') {
		Str::new(normalized.to_string_lossy().replace('\\', "/"))
	} else {
		let relative = relative_path(cwd, &normalized);
		let relative = relative.to_string_lossy().replace('\\', "/");
		if prefix.starts_with("./") {
			sf!("./{relative}")
		} else {
			Str::new(relative)
		}
	};
	let path = if !directory || path.ends_with('/') {
		path
	} else {
		sf!("{path}/")
	};
	if quoted { sf!("\"{path}\"") } else { path }
}

fn relative_path(from: &Path, target: &Path) -> PathBuf {
	let from = from
		.components()
		.filter_map(|component| match component {
			Component::Normal(value) => Some(value),
			_ => None,
		})
		.collect::<Vec<&OsStr>>();
	let target = target
		.components()
		.filter_map(|component| match component {
			Component::Normal(value) => Some(value),
			_ => None,
		})
		.collect::<Vec<&OsStr>>();
	let common = from
		.iter()
		.zip(&target)
		.take_while(|(left, right)| left == right)
		.count();
	let mut relative = PathBuf::new();
	for _ in common..from.len() {
		relative.push("..");
	}
	for component in &target[common..] {
		relative.push(component);
	}
	if relative.as_os_str().is_empty() {
		relative.push(".");
	}
	relative
}

/// Registers the live `/move` directory completer. The service is queried on
/// every request so a prior move changes completion roots immediately.
pub fn register_move_completer(
	ctx: &omp_con::Ctx,
	services: &std::sync::Arc<dyn crate::overlays::Services>,
) {
	let services = std::sync::Arc::clone(services);
	ctx.register_completer(MOVE_COMPLETION, move |_ctx, prefix| {
		let cwd = services
			.project_dir()
			.or_else(|_| std::env::current_dir())
			.unwrap_or_else(|_| PathBuf::from("."));
		directory_choices(prefix, &cwd, 20, false)
			.into_iter()
			.map(|choice| Suggestion { text: choice.value, help: choice.label })
			.collect()
	});
}

/// `wt/<yyyymmdd-hhmmss>` branch name in local time.
#[must_use]
pub fn default_worktree_branch() -> Str {
	let now = jiff::Zoned::now();
	Str::new(
		jiff::fmt::strtime::format("wt/%Y%m%d-%H%M%S", &now)
			.unwrap_or_else(|_| format!("wt/{}", now.timestamp().as_second())),
	)
}

/// The working directory the commands resolve against.
fn cwd(cx: &PanelCx<'_>) -> PathBuf {
	cx.services
		.project_dir()
		.or_else(|_| std::env::current_dir())
		.unwrap_or_else(|_| PathBuf::from("."))
}

fn dirs(cx: &PanelCx<'_>) -> Vec<Str> {
	SV_WORKSPACE_DIRS.get(cx.con)
}

fn set_dirs(cx: &PanelCx<'_>, dirs: &[Str]) -> Result<(), Str> {
	let value = Value::List(dirs.iter().cloned().map(Value::Str).collect());
	cx.con
		.exec(&format!("sv_workspace_dirs {value}"), omp_con::Source::Console)
		.map(|_| ())
		.map_err(|error| Str::new(error.to_string()))
}

/// Formats workspace directories.
#[must_use]
pub fn format_dirs(cwd: &Path, additional: &[Str], note: Option<&str>) -> Str {
	let mut lines = String::new();
	if let Some(note) = note {
		lines.push_str(note);
		lines.push('\n');
	}
	lines.push_str("Workspace directories:\n  ");
	lines.push_str(&cwd.display().to_string());
	lines.push_str(" (working directory)");
	for dir in additional {
		lines.push_str("\n  ");
		lines.push_str(dir);
	}
	Str::new(lines)
}

fn add_dir(cx: &PanelCx<'_>, input: &str) -> PanelEvent {
	let cwd = cwd(cx);
	let resolved = resolve_to_cwd(input, &cwd);
	if !resolved.is_dir() {
		return notice(if resolved.exists() {
			sf!("Not a directory: {}", resolved.display())
		} else {
			sf!("Directory does not exist: {}", resolved.display())
		});
	}
	let resolved = Str::new(resolved.display().to_string());
	let mut dirs = dirs(cx);
	if resolved.as_str() == cwd.display().to_string() || dirs.contains(&resolved) {
		return notice(sf!("Already in the workspace: {resolved}"));
	}
	dirs.push(resolved.clone());
	if let Err(error) = set_dirs(cx, &dirs) {
		return notice(error);
	}
	notice(format_dirs(&cwd, &dirs, Some(&format!("Added {resolved}."))))
}

fn remove_dir(cx: &PanelCx<'_>, input: &str) -> PanelEvent {
	let cwd = cwd(cx);
	let resolved = resolve_to_cwd(input, &cwd);
	if resolved == cwd {
		return notice("Cannot remove the working directory; use /move to change it.");
	}
	let resolved = Str::new(resolved.display().to_string());
	let mut dirs = dirs(cx);
	let Some(at) = dirs.iter().position(|dir| *dir == resolved) else {
		return notice(sf!("Not a workspace directory: {resolved}"));
	};
	dirs.remove(at);
	if let Err(error) = set_dirs(cx, &dirs) {
		return notice(error);
	}
	notice(format_dirs(&cwd, &dirs, Some(&format!("Removed {resolved}."))))
}

omp_con::cmd! {
	/// Adds a workspace directory to this session (multi-root): `/add-dir <path>`.
	"add-dir"(?path: Str) = |ctx, args| {
		let path = rest(args, 0);
		call(ctx, PanelCall::new(move |cx| match &path {
			Some(path) => add_dir(cx, path),
			None => notice(format_dirs(&cwd(cx), &dirs(cx), Some("Usage: /add-dir <path>"))),
		}))
	};

	/// Removes a workspace directory from this session: `/remove-dir <path>`.
	"remove-dir"(?path: Str) = |ctx, args| {
		let path = rest(args, 0).ok_or_else(|| usage("Usage: /remove-dir <path>"))?;
		call(ctx, PanelCall::new(move |cx| remove_dir(cx, &path)))
	};

	/// Lists this session's workspace directories.
	dirs() = |ctx, _args| {
		call(ctx, PanelCall::new(|cx| notice(format_dirs(&cwd(cx), &dirs(cx), None))))
	};

	/// Moves the current session to a different directory: `/move [path]`.
	"move"(?path @ "workspace::move-directory": Str) = |ctx, args| {
		post(ctx, HostAction::Command(CommandAction::Move { path: rest(args, 0) }))
	};

	/// Moves this session into a new worktree, changes included: `/wt [branch]`.
	wt(?branch: Str) = |ctx, args| {
		post(ctx, HostAction::Command(CommandAction::Worktree { branch: rest(args, 0) }))
	};

	/// Moves this session into a new worktree (alias of `wt`).
	worktree(?branch: Str) = |ctx, args| {
		post(ctx, HostAction::Command(CommandAction::Worktree { branch: rest(args, 0) }))
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn paths_resolve_against_the_working_directory_and_normalize() {
		let cwd = Path::new("/work/omp");
		assert_eq!(resolve_to_cwd("crates", cwd), PathBuf::from("/work/omp/crates"));
		assert_eq!(resolve_to_cwd("../pi", cwd), PathBuf::from("/work/pi"));
		assert_eq!(resolve_to_cwd("/tmp/x/./y", cwd), PathBuf::from("/tmp/x/y"));
		assert_eq!(resolve_to_cwd("\"/tmp/quoted\"", cwd), PathBuf::from("/tmp/quoted"));
	}

	#[test]
	fn default_worktree_branch_is_a_timestamp() {
		let branch = default_worktree_branch();
		assert!(branch.starts_with("wt/"), "{branch}");
		assert_eq!(branch.len(), "wt/20260903-120000".len(), "{branch}");
	}

	#[test]
	fn workspace_listing_matches_pi() {
		let text = format_dirs(
			Path::new("/work/omp"),
			&[Str::new_static("/work/pi")],
			Some("Added /work/pi."),
		);
		assert_eq!(
			text,
			"Added /work/pi.\nWorkspace directories:\n  /work/omp (working directory)\n  /work/pi"
		);
	}

	#[test]
	fn move_completions_preserve_path_style_and_ignore_files() {
		let root = tempfile::tempdir().expect("root");
		std::fs::create_dir(root.path().join("src")).expect("src");
		std::fs::create_dir(root.path().join("My Project")).expect("spaced");
		std::fs::create_dir(root.path().join("My Project").join("nested")).expect("nested");
		std::fs::write(root.path().join("README.md"), "").expect("file");
		let values = |prefix| {
			directory_choices(prefix, root.path(), 20, false)
				.into_iter()
				.map(|choice| choice.value)
				.collect::<Vec<_>>()
		};
		assert!(values("").contains(&Str::new_static("src/")));
		assert!(!values("").iter().any(|value| value.contains("README")));
		assert!(values("./sr").contains(&Str::new_static("./src/")));
		assert!(values("My Project/").contains(&Str::new_static("My Project/nested/")));
		assert!(
			values("\"My Pro").contains(&Str::new_static("\"My Project/\"")),
			"outer quote style is retained"
		);
		assert!(
			path_choices("READ", root.path(), 20, false, true)
				.into_iter()
				.any(|choice| choice.value == "README.md"),
			"destination editors also complete existing files"
		);
	}
}
