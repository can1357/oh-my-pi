//! The XDG lookups behind `open` on Linux, as `xdg-open` and `gio open` make
//! them: a file's MIME type from the shared MIME database's globs, the default
//! application for a type from the `mimeapps.list` chain (then the desktop
//! entries' own `mimeinfo.cache`, then the type's parents), and the command
//! line a desktop entry's `Exec` makes for the things to open.
//!
//! Everything here reads files only; [`super::linux`] launches.

use std::{
	fs,
	io::{self, Read as _},
	path::{Path, PathBuf},
};

use super::Target;

/// The XDG base directories and desktop names of one environment.
#[derive(Debug)]
pub(super) struct Dirs {
	/// `$XDG_CONFIG_HOME`, then `$XDG_CONFIG_DIRS`.
	config:   Vec<PathBuf>,
	/// `$XDG_DATA_HOME`, then `$XDG_DATA_DIRS`.
	data:     Vec<PathBuf>,
	/// `$XDG_CURRENT_DESKTOP`'s names, lowercased, as `mimeapps.list` prefixes.
	desktops: Vec<String>,
}

/// One type's lines of a `mimeapps.list` (or `mimeinfo.cache`).
#[derive(Default)]
struct Associations {
	defaults: Vec<String>,
	added:    Vec<String>,
	removed:  Vec<String>,
}

/// The lines for `mime` in `file`, if it can be read.
fn associations(file: &Path, mime: &str) -> Option<Associations> {
	let text = fs::read_to_string(file).ok()?;
	let mut found = Associations::default();
	let mut group = "";
	for line in text.lines() {
		let line = line.trim();
		if let Some(name) = line.strip_prefix('[').and_then(|line| line.strip_suffix(']')) {
			group = name;
			continue;
		}
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		if key.trim_end() != mime {
			continue;
		}
		let ids = value
			.split(';')
			.map(str::trim)
			.filter(|id| !id.is_empty())
			.map(str::to_owned);
		match group {
			"Default Applications" => found.defaults.extend(ids),
			"Added Associations" | "MIME Cache" => found.added.extend(ids),
			"Removed Associations" => found.removed.extend(ids),
			_ => {},
		}
	}
	Some(found)
}

impl Dirs {
	/// The directories the environment `var` reads names, with the
	/// specification's defaults for what it leaves unset.
	pub(super) fn from_env<'a>(var: impl Fn(&str) -> Option<&'a str>) -> Self {
		let set = |name: &str| var(name).filter(|value| !value.is_empty());
		let home = set("HOME").map(PathBuf::from);
		let own = |name: &str, fallback: &str| {
			set(name)
				.map(PathBuf::from)
				.filter(|dir| dir.is_absolute())
				.or_else(|| home.as_ref().map(|home| home.join(fallback)))
		};
		let shared = |name: &str, fallback: &'static str| {
			set(name)
				.unwrap_or(fallback)
				.split(':')
				.map(PathBuf::from)
				.filter(|dir| dir.is_absolute())
				.collect::<Vec<_>>()
		};
		let mut config: Vec<PathBuf> = own("XDG_CONFIG_HOME", ".config").into_iter().collect();
		config.extend(shared("XDG_CONFIG_DIRS", "/etc/xdg"));
		let mut data: Vec<PathBuf> = own("XDG_DATA_HOME", ".local/share").into_iter().collect();
		data.extend(shared("XDG_DATA_DIRS", "/usr/local/share:/usr/share"));
		let desktops = set("XDG_CURRENT_DESKTOP")
			.unwrap_or_default()
			.split(':')
			.filter(|name| !name.is_empty())
			.map(str::to_lowercase)
			.collect();
		Self { config, data, desktops }
	}

	/// Every `mimeapps.list` that may exist, most important first, then the
	/// legacy `defaults.list`s.
	fn mimeapps_files(&self) -> Vec<PathBuf> {
		let directories = self
			.config
			.iter()
			.cloned()
			.chain(self.data.iter().map(|dir| dir.join("applications")));
		let mut files = Vec::new();
		for directory in directories {
			for desktop in &self.desktops {
				files.push(directory.join(format!("{desktop}-mimeapps.list")));
			}
			files.push(directory.join("mimeapps.list"));
		}
		files.extend(self.data.iter().map(|dir| dir.join("applications/defaults.list")));
		files
	}

	/// The desktop entry with ID `id` (`firefox.desktop`, or without the
	/// suffix). A dash in an ID may stand for a subdirectory
	/// (`kde4-okular.desktop` for `kde4/okular.desktop`).
	pub(super) fn desktop_file(&self, id: &str) -> Option<PathBuf> {
		let id = if id.ends_with(".desktop") { id.to_owned() } else { format!("{id}.desktop") };
		if id.contains('/') {
			return None;
		}
		for dir in &self.data {
			let applications = dir.join("applications");
			let flat = applications.join(&id);
			if flat.is_file() {
				return Some(flat);
			}
			for (dash, _) in id.match_indices('-') {
				let nested = applications.join(&id[..dash]).join(&id[dash + 1..]);
				if nested.is_file() {
					return Some(nested);
				}
			}
		}
		None
	}

	/// The default application for exactly `mime`: the first installed entry
	/// among the `mimeapps.list` defaults, else among the added associations
	/// and the entries declaring the type, minus the removed ones.
	fn default_application(&self, mime: &str) -> Option<PathBuf> {
		let lists: Vec<Associations> = self
			.mimeapps_files()
			.iter()
			.filter_map(|file| associations(file, mime))
			.collect();
		let installed = |ids: &[String], removed: &[&str]| {
			ids.iter()
				.filter(|id| !removed.contains(&id.as_str()))
				.find_map(|id| self.desktop_file(id))
		};
		if let Some(found) = lists.iter().find_map(|list| installed(&list.defaults, &[])) {
			return Some(found);
		}
		let mut removed: Vec<&str> = Vec::new();
		for list in &lists {
			if let Some(found) = installed(&list.added, &removed) {
				return Some(found);
			}
			removed.extend(list.removed.iter().map(String::as_str));
		}
		self.data.iter().find_map(|dir| {
			let cache = associations(&dir.join("applications/mimeinfo.cache"), mime)?;
			installed(&cache.added, &removed)
		})
	}

	/// The types `mime` is a kind of: its alias target and declared
	/// superclasses in the shared MIME database, and `text/plain` for any
	/// other text type.
	fn parents(&self, mime: &str) -> Vec<String> {
		let mut parents = Vec::new();
		for dir in &self.data {
			for table in ["mime/aliases", "mime/subclasses"] {
				let Ok(text) = fs::read_to_string(dir.join(table)) else {
					continue;
				};
				parents.extend(
					text
						.lines()
						.filter_map(|line| line.split_once(' '))
						.filter(|(child, _)| *child == mime)
						.map(|(_, parent)| parent.trim().to_owned()),
				);
			}
		}
		if mime.starts_with("text/") && mime != "text/plain" {
			parents.push("text/plain".to_owned());
		}
		parents
	}

	/// The desktop entry that opens `mime`: its default application, else that
	/// of the nearest type it is a kind of.
	pub(super) fn handler(&self, mime: &str) -> Option<PathBuf> {
		let mut types = vec![mime.to_owned()];
		let mut next = 0;
		while let Some(mime) = types.get(next).cloned() {
			if let Some(found) = self.default_application(&mime) {
				return Some(found);
			}
			for parent in self.parents(&mime) {
				if !types.contains(&parent) {
					types.push(parent);
				}
			}
			next += 1;
		}
		None
	}

	/// The MIME type of the file at `path`: `inode/directory`, else the best
	/// glob of the shared MIME database for its name, else what its first
	/// bytes look like.
	pub(super) fn mime_type(&self, path: &Path) -> String {
		if path.is_dir() {
			return "inode/directory".to_owned();
		}
		path
			.file_name()
			.and_then(|name| name.to_str())
			.and_then(|name| self.glob_type(name))
			.unwrap_or_else(|| sniffed(path).to_owned())
	}

	/// The type of the heaviest, then longest, glob in `mime/globs2` matching
	/// the file name `name`: as spelled, else ignoring letter case for the
	/// globs that allow it.
	fn glob_type(&self, name: &str) -> Option<String> {
		let folded = name.to_lowercase();
		let mut exact: Option<(u32, usize, String)> = None;
		let mut loose: Option<(u32, usize, String)> = None;
		let better = |best: &Option<(u32, usize, String)>, weight: u32, glob: &str| {
			best
				.as_ref()
				.is_none_or(|(heaviest, longest, _)| (weight, glob.len()) > (*heaviest, *longest))
		};
		for dir in &self.data {
			let Ok(text) = fs::read_to_string(dir.join("mime/globs2")) else {
				continue;
			};
			for line in text.lines() {
				let mut fields = line.splitn(4, ':');
				let (Some(weight), Some(mime), Some(glob)) = (fields.next(), fields.next(), fields.next())
				else {
					continue;
				};
				let Ok(weight) = weight.parse::<u32>() else {
					continue;
				};
				let case_sensitive = fields.next().is_some_and(|flags| flags.split(',').any(|flag| flag == "cs"));
				if better(&exact, weight, glob) && glob_matches(glob.as_bytes(), name.as_bytes()) {
					exact = Some((weight, glob.len(), mime.to_owned()));
				} else if !case_sensitive
					&& exact.is_none()
					&& better(&loose, weight, glob)
					&& glob_matches(glob.to_lowercase().as_bytes(), folded.as_bytes())
				{
					loose = Some((weight, glob.len(), mime.to_owned()));
				}
			}
		}
		exact.or(loose).map(|(_, _, mime)| mime)
	}

	/// The desktop entry of the application called `name`: a desktop-entry ID
	/// (`org.gnome.TextEditor`), an ID in any letter case or by its last
	/// component (`firefox`, `texteditor`), or an entry's `Name` (`Text
	/// Editor`).
	pub(super) fn application(&self, name: &str) -> Option<PathBuf> {
		if let Some(file) = self.desktop_file(name) {
			return Some(file);
		}
		let wanted = name.strip_suffix(".desktop").unwrap_or(name).to_lowercase();
		let mut files = Vec::new();
		for dir in &self.data {
			let first = files.len();
			desktop_files(&dir.join("applications"), 2, &mut files);
			files[first..].sort_unstable();
		}
		let by_id = |file: &&PathBuf| {
			file.file_stem().and_then(|stem| stem.to_str()).is_some_and(|stem| {
				let stem = stem.to_lowercase();
				stem == wanted || stem.rsplit('.').next() == Some(wanted.as_str())
			})
		};
		let by_name =
			|file: &&PathBuf| Entry::read(file).is_ok_and(|entry| entry.name.to_lowercase() == wanted);
		files
			.iter()
			.find(by_id)
			.or_else(|| files.iter().find(by_name))
			.cloned()
	}
}

/// Collects the `.desktop` files of `directory`, descending `depth` levels.
fn desktop_files(directory: &Path, depth: u32, files: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(directory) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		// Not following directory symlinks: they can form cycles.
		if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
			if depth > 0 {
				desktop_files(&path, depth - 1, files);
			}
		} else if path.extension().is_some_and(|extension| extension == "desktop") {
			files.push(path);
		}
	}
}

/// Whether the shell glob `pattern` (`*`, `?`, `[…]`) matches all of `name`.
fn glob_matches(pattern: &[u8], name: &[u8]) -> bool {
	// Nearly every glob of the database is `*.ext`.
	if let Some(suffix) = pattern.strip_prefix(b"*")
		&& !suffix.iter().any(|byte| matches!(byte, b'*' | b'?' | b'['))
	{
		return name.ends_with(suffix);
	}
	match pattern.split_first() {
		None => name.is_empty(),
		Some((b'*', rest)) => (0..=name.len()).any(|skipped| glob_matches(rest, &name[skipped..])),
		Some((b'?', rest)) => !name.is_empty() && glob_matches(rest, &name[1..]),
		Some((b'[', rest)) => {
			let Some(close) = rest.iter().skip(1).position(|&byte| byte == b']').map(|at| at + 1) else {
				return name.first() == Some(&b'[') && glob_matches(rest, &name[1..]);
			};
			name.split_first().is_some_and(|(first, name)| {
				class_contains(&rest[..close], *first) && glob_matches(&rest[close + 1..], name)
			})
		},
		Some((byte, rest)) => name.first() == Some(byte) && glob_matches(rest, &name[1..]),
	}
}

/// Whether the bracket expression body `class` (`abc`, `0-9`, `!x`) has `byte`.
fn class_contains(class: &[u8], byte: u8) -> bool {
	let (negated, mut class) = match class.split_first() {
		Some((b'!' | b'^', rest)) => (true, rest),
		_ => (false, class),
	};
	let mut found = false;
	while let Some((&first, rest)) = class.split_first() {
		if let [b'-', last, rest @ ..] = rest {
			found |= (first..=*last).contains(&byte);
			class = rest;
		} else {
			found |= first == byte;
			class = rest;
		}
	}
	found != negated
}

/// A type for a file no glob names, from its first bytes: a few unmistakable
/// signatures, else text or not.
fn sniffed(path: &Path) -> &'static str {
	const SIGNATURES: &[(&[u8], &str)] = &[
		(b"%PDF-", "application/pdf"),
		(b"\x89PNG\r\n\x1a\n", "image/png"),
		(b"\xff\xd8\xff", "image/jpeg"),
		(b"GIF8", "image/gif"),
		(b"PK\x03\x04", "application/zip"),
		(b"\x1f\x8b", "application/gzip"),
	];
	let mut head = [0u8; 4096];
	let mut filled = 0;
	if let Ok(mut file) = fs::File::open(path) {
		while filled < head.len() {
			match file.read(&mut head[filled..]) {
				Ok(0) | Err(_) => break,
				Ok(read) => filled += read,
			}
		}
	}
	let head = &head[..filled];
	if let Some((_, mime)) = SIGNATURES.iter().find(|(signature, _)| head.starts_with(signature)) {
		return mime;
	}
	// A multi-byte character cut by the buffer's end is still text.
	let text = match xutf::decode(head) {
		Ok(text) | Err(xutf::DecodeError::Incomplete { valid_prefix: text, .. }) => text,
		Err(xutf::DecodeError::Invalid { .. }) => return "application/octet-stream",
	};
	if text.contains('\0') {
		return "application/octet-stream";
	}
	let start = text.trim_start().get(..15).unwrap_or(text.trim_start()).to_ascii_lowercase();
	if start.starts_with("<!doctype html") || start.starts_with("<html") {
		"text/html"
	} else {
		"text/plain"
	}
}

/// The `[Desktop Entry]` group of a `.desktop` file, as far as launching needs
/// it.
#[derive(Debug)]
pub(super) struct Entry {
	/// The `.desktop` file.
	pub(super) file:             PathBuf,
	/// `Name`, unlocalized.
	pub(super) name:             String,
	exec:                        Option<String>,
	icon:                        Option<String>,
	/// `Terminal`: the program needs a terminal window.
	pub(super) terminal:         bool,
	/// `DBusActivatable`: the application takes its files over D-Bus.
	pub(super) dbus_activatable: bool,
	/// `Path`: the directory to run the program in.
	pub(super) working_dir:      Option<PathBuf>,
}

/// A desktop-entry string value with its escapes (`\s`, `\n`, `\t`, `\r`,
/// `\\`) decoded.
fn unescaped(value: &str) -> String {
	let mut decoded = String::with_capacity(value.len());
	let mut chars = value.chars();
	while let Some(c) = chars.next() {
		if c != '\\' {
			decoded.push(c);
			continue;
		}
		match chars.next() {
			Some('s') => decoded.push(' '),
			Some('n') => decoded.push('\n'),
			Some('t') => decoded.push('\t'),
			Some('r') => decoded.push('\r'),
			Some(other) => decoded.push(other),
			None => decoded.push('\\'),
		}
	}
	decoded
}

impl Entry {
	/// Reads the entry in `file`.
	///
	/// # Errors
	///
	/// The read error.
	pub(super) fn read(file: &Path) -> io::Result<Self> {
		let text = fs::read_to_string(file)?;
		let mut entry = Self {
			file:             file.to_path_buf(),
			name:             String::new(),
			exec:             None,
			icon:             None,
			terminal:         false,
			dbus_activatable: false,
			working_dir:      None,
		};
		let mut in_entry = false;
		for line in text.lines() {
			let line = line.trim();
			if line.starts_with('[') {
				in_entry = line == "[Desktop Entry]";
				continue;
			}
			if !in_entry {
				continue;
			}
			let Some((key, value)) = line.split_once('=') else {
				continue;
			};
			let value = value.trim_start();
			match key.trim_end() {
				"Name" => entry.name = unescaped(value),
				"Exec" => entry.exec = Some(unescaped(value)),
				"Icon" => entry.icon = Some(unescaped(value)),
				"Path" => entry.working_dir = Some(PathBuf::from(unescaped(value))).filter(|dir| dir.is_absolute()),
				"Terminal" => entry.terminal = value == "true",
				"DBusActivatable" => entry.dbus_activatable = value == "true",
				_ => {},
			}
		}
		Ok(entry)
	}

	/// The entry's ID: its file name without `.desktop`.
	pub(super) fn id(&self) -> String {
		self
			.file
			.file_stem()
			.map(|stem| stem.to_string_lossy().into_owned())
			.unwrap_or_default()
	}

	/// Whether the entry has a program to run.
	pub(super) const fn has_exec(&self) -> bool {
		self.exec.is_some()
	}

	/// The command lines `Exec` makes to open `targets`, each followed by
	/// `extra`: one for all of them when `Exec` takes a list (`%F`, `%U`) or
	/// names no place for them (they are then appended), one per target when
	/// it takes a single file or URL (`%f`, `%u`).
	///
	/// # Errors
	///
	/// A message for an entry with no usable `Exec`.
	pub(super) fn command_lines(
		&self,
		targets: &[Target],
		extra: &[String],
	) -> Result<Vec<Vec<String>>, String> {
		let unusable = |why: &str| format!("{}: {why}", self.file.display());
		let exec = self.exec.as_deref().ok_or_else(|| unusable("no Exec to run"))?;
		let words = exec_words(exec).ok_or_else(|| unusable("unterminated quote in Exec"))?;
		if words.is_empty() {
			return Err(unusable("no Exec to run"));
		}
		let one_each = words
			.iter()
			.any(|word| word.contains("%f") || word.contains("%u"));
		let batches: Vec<&[Target]> = if one_each && targets.len() > 1 {
			targets.chunks(1).collect()
		} else {
			vec![targets]
		};
		Ok(batches
			.into_iter()
			.map(|batch| self.command_line(&words, batch, extra))
			.collect())
	}

	fn command_line(&self, words: &[String], targets: &[Target], extra: &[String]) -> Vec<String> {
		let plain = |target: &Target| match target {
			Target::File(path) => path.to_string_lossy().into_owned(),
			Target::Url(url) => url.clone(),
		};
		let mut argv = Vec::with_capacity(words.len() + targets.len() + extra.len());
		let mut placed = false;
		for word in words {
			match word.as_str() {
				"%F" => {
					argv.extend(targets.iter().map(plain));
					placed = true;
				},
				"%U" => {
					argv.extend(targets.iter().map(Target::to_url));
					placed = true;
				},
				"%i" => {
					if let Some(icon) = self.icon.as_ref().filter(|icon| !icon.is_empty()) {
						argv.push("--icon".to_owned());
						argv.push(icon.clone());
					}
				},
				_ => {
					let mut expanded = String::with_capacity(word.len());
					let mut dropped = false;
					let mut chars = word.chars();
					while let Some(c) = chars.next() {
						if c != '%' {
							expanded.push(c);
							continue;
						}
						match chars.next() {
							Some('%') => expanded.push('%'),
							Some('f' | 'F') => {
								placed = true;
								match targets.first() {
									Some(target) => expanded.push_str(&plain(target)),
									None => dropped = true,
								}
							},
							Some('u' | 'U') => {
								placed = true;
								match targets.first() {
									Some(target) => expanded.push_str(&target.to_url()),
									None => dropped = true,
								}
							},
							Some('c') => expanded.push_str(&self.name),
							Some('k') => expanded.push_str(&self.file.to_string_lossy()),
							// Deprecated codes, and any unknown one, stand for nothing.
							_ => dropped = true,
						}
					}
					if !(dropped && expanded.is_empty()) {
						argv.push(expanded);
					}
				},
			}
		}
		if !placed {
			argv.extend(targets.iter().map(plain));
		}
		argv.extend(extra.iter().cloned());
		argv
	}
}

/// `Exec` split into words: whitespace separates them, double quotes group,
/// and a backslash inside quotes takes the next character literally. `None`
/// for an unterminated quote.
fn exec_words(exec: &str) -> Option<Vec<String>> {
	let mut words = Vec::new();
	let mut word = String::new();
	let mut started = false;
	let mut quoted = false;
	let mut chars = exec.chars();
	while let Some(c) = chars.next() {
		match c {
			'"' => {
				quoted = !quoted;
				started = true;
			},
			'\\' if quoted => word.extend(chars.next()),
			c if !quoted && c.is_ascii_whitespace() => {
				if started {
					words.push(std::mem::take(&mut word));
					started = false;
				}
			},
			c => {
				word.push(c);
				started = true;
			},
		}
	}
	if quoted {
		return None;
	}
	if started {
		words.push(word);
	}
	Some(words)
}

/// The `file://` URL of the absolute host path `path`.
pub(super) fn file_url(path: &Path) -> String {
	let bytes = path.as_os_str().as_encoded_bytes();
	let mut url = String::with_capacity(bytes.len() + 7);
	url.push_str("file://");
	for &byte in bytes {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~') {
			url.push(char::from(byte));
		} else {
			url.push('%');
			url.push(char::from(b"0123456789ABCDEF"[usize::from(byte >> 4)]));
			url.push(char::from(b"0123456789ABCDEF"[usize::from(byte & 0xf)]));
		}
	}
	url
}

/// The host path a local `file://` URL names (`file:///x`, `file://localhost/x`,
/// `file:/x`); `None` for any other URL.
pub(super) fn file_url_path(url: &str) -> Option<PathBuf> {
	let rest = url.get(..5).filter(|scheme| scheme.eq_ignore_ascii_case("file:")).map(|_| &url[5..])?;
	let path = match rest.strip_prefix("//") {
		Some(authority) => {
			let slash = authority.find('/')?;
			let host = &authority[..slash];
			if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
				return None;
			}
			&authority[slash..]
		},
		None => rest,
	};
	let path = path.split(['?', '#']).next().unwrap_or(path);
	if !path.starts_with('/') {
		return None;
	}
	let mut decoded = Vec::with_capacity(path.len());
	let mut bytes = path.bytes();
	while let Some(byte) = bytes.next() {
		if byte != b'%' {
			decoded.push(byte);
			continue;
		}
		let hex = [bytes.next()?, bytes.next()?];
		let hex = std::str::from_utf8(&hex).ok()?;
		decoded.push(u8::from_str_radix(hex, 16).ok()?);
	}
	String::from_utf8(decoded).ok().map(PathBuf::from)
}

/// The command lines `$BROWSER` gives for `url`, in its order of preference:
/// a colon-separated list of commands, the URL replacing `%s` or else
/// appended (`%c` is a colon, `%%` a percent sign).
pub(super) fn browser_commands(browser: &str, url: &str) -> Vec<Vec<String>> {
	browser
		.split(':')
		.filter_map(|command| {
			let mut placed = false;
			let mut argv: Vec<String> = command
				.split_ascii_whitespace()
				.map(|word| {
					let mut expanded = String::with_capacity(word.len());
					let mut chars = word.chars();
					while let Some(c) = chars.next() {
						if c != '%' {
							expanded.push(c);
							continue;
						}
						match chars.next() {
							Some('s') => {
								expanded.push_str(url);
								placed = true;
							},
							Some('c') => expanded.push(':'),
							Some('%') | None => expanded.push('%'),
							Some(other) => {
								expanded.push('%');
								expanded.push(other);
							},
						}
					}
					expanded
				})
				.collect();
			if argv.is_empty() {
				return None;
			}
			if !placed {
				argv.push(url.to_owned());
			}
			Some(argv)
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A home with a config and a data directory, as [`Dirs`] sees them.
	struct Home {
		dir: tempfile::TempDir,
	}

	impl Home {
		fn new() -> Self {
			Self { dir: tempfile::tempdir().expect("tempdir") }
		}

		fn write(&self, relative: &str, contents: &str) -> PathBuf {
			let file = self.dir.path().join(relative);
			fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
			fs::write(&file, contents).expect("write");
			file
		}

		fn app(&self, id: &str, contents: &str) -> PathBuf {
			self.write(&format!("data/applications/{id}"), contents)
		}

		fn dirs(&self, desktop: &str) -> Dirs {
			let root = self.dir.path().to_str().expect("utf-8 tempdir").to_owned();
			let config = format!("{root}/config");
			let data = format!("{root}/data");
			let vars = [
				("XDG_CONFIG_HOME", config.as_str()),
				("XDG_CONFIG_DIRS", "/nonexistent/etc"),
				("XDG_DATA_HOME", data.as_str()),
				("XDG_DATA_DIRS", "/nonexistent/share"),
				("XDG_CURRENT_DESKTOP", desktop),
			];
			Dirs::from_env(|name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| *value))
		}
	}

	const APP: &str = "[Desktop Entry]\nType=Application\nName=App\nExec=app %U\n";

	/// Failure mode: a default naming an uninstalled application wins (nothing
	/// opens), or a desktop's own list is ignored for the generic one.
	#[test]
	fn defaults_skip_uninstalled_entries_and_prefer_the_desktops_list() {
		let home = Home::new();
		let browser = home.app("browser.desktop", APP);
		let other = home.app("other.desktop", APP);
		home.write(
			"config/mimeapps.list",
			"[Default Applications]\ntext/html=gone.desktop;browser.desktop;\n",
		);
		assert_eq!(home.dirs("").handler("text/html"), Some(browser));
		home.write("config/gnome-mimeapps.list", "[Default Applications]\ntext/html=other.desktop\n");
		assert_eq!(home.dirs("ubuntu:GNOME").handler("text/html"), Some(other));
		assert_eq!(home.dirs("").handler("application/pdf"), None);
	}

	/// Failure mode: with no explicit default, an application the user removed
	/// for the type still opens it, or the entries' own declarations
	/// (`mimeinfo.cache`) are never consulted.
	#[test]
	fn associations_honor_removals_then_fall_back_to_the_cache() {
		let home = Home::new();
		let viewer = home.app("viewer.desktop", APP);
		home.app("editor.desktop", APP);
		home.write(
			"data/applications/mimeinfo.cache",
			"[MIME Cache]\nimage/png=editor.desktop;viewer.desktop;\n",
		);
		home.write("config/mimeapps.list", "[Removed Associations]\nimage/png=editor.desktop;\n");
		assert_eq!(home.dirs("").handler("image/png"), Some(viewer));
		let added = home.app("added.desktop", APP);
		home.write(
			"config/mimeapps.list",
			"[Added Associations]\nimage/png=added.desktop;\n[Removed Associations]\nimage/png=editor.desktop;\n",
		);
		assert_eq!(home.dirs("").handler("image/png"), Some(added));
	}

	/// Failure mode: a Python or Markdown file has no handler although a text
	/// editor is installed, because only the exact type is looked up.
	#[test]
	fn a_type_without_a_handler_uses_its_parents() {
		let home = Home::new();
		let editor = home.app("editor.desktop", APP);
		let archiver = home.app("archiver.desktop", APP);
		home.write(
			"config/mimeapps.list",
			"[Default Applications]\ntext/plain=editor.desktop\napplication/zip=archiver.desktop\n",
		);
		home.write("data/mime/subclasses", "application/epub+zip application/zip\n");
		home.write("data/mime/aliases", "application/x-epub application/epub+zip\n");
		let dirs = home.dirs("");
		assert_eq!(dirs.handler("text/x-python"), Some(editor));
		assert_eq!(dirs.handler("application/x-epub"), Some(archiver));
		assert_eq!(dirs.handler("image/png"), None);
	}

	/// Failure mode: the wrong application opens a file because its type is
	/// misread: weights and pattern length ignored, letter case, directories,
	/// and names no glob covers.
	#[test]
	fn mime_types_come_from_globs_then_contents() {
		let home = Home::new();
		home.write(
			"data/mime/globs2",
			"# comment\n50:text/html:*.html\n50:application/gzip:*.gz\n50:application/x-compressed-tar:*.tar.gz\n\
			 50:text/x-makefile:[Mm]akefile\n60:text/x-readme:README*\n50:text/x-csrc:*.c\n50:text/x-c++src:*.C:cs\n",
		);
		let dirs = home.dirs("");
		let mime = |name: &str, contents: &[u8]| {
			let file = home.dir.path().join(name);
			fs::write(&file, contents).expect("write");
			dirs.mime_type(&file)
		};
		assert_eq!(mime("Report.HTML", b""), "text/html");
		assert_eq!(mime("a.tar.gz", b""), "application/x-compressed-tar");
		assert_eq!(mime("makefile", b""), "text/x-makefile");
		assert_eq!(mime("README.c", b""), "text/x-readme");
		assert_eq!(mime("x.C", b""), "text/x-c++src");
		assert_eq!(mime("x.c", b""), "text/x-csrc");
		assert_eq!(mime("page", b"  <!DOCTYPE HTML><p>"), "text/html");
		assert_eq!(mime("notes", "caf\u{e9}\n".as_bytes()), "text/plain");
		assert_eq!(mime("doc", b"%PDF-1.7\n\0\0"), "application/pdf");
		assert_eq!(mime("blob", b"\0\x01\x02"), "application/octet-stream");
		assert_eq!(dirs.mime_type(home.dir.path()), "inode/directory");
	}

	fn entry(exec: &str) -> Entry {
		let home = Home::new();
		let file = home.app(
			"viewer.desktop",
			&format!("[Desktop Entry]\nName=The Viewer\nIcon=viewer-icon\nExec={exec}\n[Desktop Action New]\nExec=wrong\n"),
		);
		let mut entry = Entry::read(&file).expect("entry");
		entry.file = PathBuf::from("/apps/viewer.desktop");
		entry
	}

	fn lines(exec: &str, targets: &[Target], extra: &[&str]) -> Vec<Vec<String>> {
		let extra: Vec<String> = extra.iter().map(ToString::to_string).collect();
		entry(exec).command_lines(targets, &extra).expect("command lines")
	}

	/// Failure mode: the application starts without the file (or with a
	/// literal `%f`), gets several files where it takes one, or a quoted
	/// program path is split at its spaces.
	#[test]
	fn exec_field_codes_place_the_targets() {
		let a = Target::File(PathBuf::from("/tmp/a b.txt"));
		let b = Target::Url("https://example.com/?q=1".into());
		let both = [a.clone(), b.clone()];
		assert_eq!(lines("view %f", &both, &[]), [
			vec!["view", "/tmp/a b.txt"],
			vec!["view", "https://example.com/?q=1"]
		]);
		assert_eq!(lines("view --new %U", &both, &["--flag"]), [vec![
			"view",
			"--new",
			"file:///tmp/a%20b.txt",
			"https://example.com/?q=1",
			"--flag"
		]]);
		assert_eq!(lines(r#""/opt/my app/view" --name=%c %i --from %k --url=%u 100%% %F"#, &[a.clone()], &[]), [
			vec![
				"/opt/my app/view",
				"--name=The Viewer",
				"--icon",
				"viewer-icon",
				"--from",
				"/apps/viewer.desktop",
				"--url=file:///tmp/a%20b.txt",
				"100%",
				"/tmp/a b.txt"
			]
		]);
		// No place named: the targets follow the command.
		assert_eq!(lines("view", &both, &[]), [vec!["view", "/tmp/a b.txt", "https://example.com/?q=1"]]);
		// Nothing to open: the codes vanish.
		assert_eq!(lines("view %u %F --keep", &[], &[]), [vec!["view", "--keep"]]);
		assert!(entry("\"view %f").command_lines(&[a], &[]).is_err());
	}

	/// Failure mode: `open -a Firefox` or `open -a "Text Editor"` finds
	/// nothing because only exact desktop-entry IDs are accepted.
	#[test]
	fn applications_are_found_by_id_or_name() {
		let home = Home::new();
		let editor = home.app(
			"org.gnome.TextEditor.desktop",
			"[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\n",
		);
		let okular = home.app("kde4/okular.desktop", "[Desktop Entry]\nName=Okular\nExec=okular %U\n");
		let dirs = home.dirs("");
		for name in ["org.gnome.TextEditor", "org.gnome.TextEditor.desktop", "texteditor", "Text Editor"] {
			assert_eq!(dirs.application(name), Some(editor.clone()), "{name}");
		}
		assert_eq!(dirs.application("kde4-okular.desktop"), Some(okular.clone()));
		assert_eq!(dirs.application("OKULAR"), Some(okular));
		assert_eq!(dirs.application("nothing-like-this"), None);
	}

	/// Failure mode: a path with spaces or non-ASCII letters reaches an
	/// application as a broken URL, or a `file://` URL is not recognized as
	/// the local file it names.
	#[test]
	fn file_urls_round_trip() {
		let path = Path::new("/tmp/caf\u{e9} notes/a#1.txt");
		let url = file_url(path);
		assert_eq!(url, "file:///tmp/caf%C3%A9%20notes/a%231.txt");
		assert_eq!(file_url_path(&url).as_deref(), Some(path));
		assert_eq!(file_url_path("file://localhost/etc/hosts"), Some(PathBuf::from("/etc/hosts")));
		assert_eq!(file_url_path("FILE:/etc/hosts"), Some(PathBuf::from("/etc/hosts")));
		assert_eq!(file_url_path("file://server/share/x"), None);
		assert_eq!(file_url_path("https://example.com/x"), None);
	}

	/// Failure mode: a remote session's `BROWSER` helper is run without the
	/// URL, or only its first alternative is tried.
	#[test]
	fn browser_lists_expand_per_command() {
		assert_eq!(browser_commands("helper --open %s:firefox::w3m -o x=%c", "http://h/p"), [
			vec!["helper", "--open", "http://h/p"],
			vec!["firefox", "http://h/p"],
			vec!["w3m", "-o", "x=:", "http://h/p"],
		]);
	}
}
