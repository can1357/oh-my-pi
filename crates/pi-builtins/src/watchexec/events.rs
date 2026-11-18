//! Watchexec's event model and the forms it hands events to a command in.
//!
//! The watcher reports one event per path with every change that happened to
//! it; watchexec's events carry one change each (`Create(File)`,
//! `Modify(Data(Content))`, …), so a path's flags expand into a [`Change`]
//! apiece.

use std::{
	collections::BTreeSet,
	fmt::{self, Write as _},
	path::{Component, Path, PathBuf},
};

use pi_watch::Flags;

/// What a changed path is, where known.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FileType {
	File,
	Dir,
	Symlink,
	Other,
}

impl FileType {
	/// The `filetype` of the JSON and text forms.
	const fn name(self) -> &'static str {
		match self {
			Self::File => "file",
			Self::Dir => "dir",
			Self::Symlink => "symlink",
			Self::Other => "other",
		}
	}

	/// The type the watcher reported, else what the path is now; `None` for a
	/// path that is gone.
	fn of(path: &Path, flags: Flags) -> Option<Self> {
		if flags.contains(Flags::IS_DIR) {
			return Some(Self::Dir);
		}
		if flags.contains(Flags::IS_SYMLINK) {
			return Some(Self::Symlink);
		}
		if flags.contains(Flags::IS_FILE) {
			return Some(Self::File);
		}
		let kind = std::fs::symlink_metadata(path).ok()?.file_type();
		Some(if kind.is_dir() {
			Self::Dir
		} else if kind.is_symlink() {
			Self::Symlink
		} else if kind.is_file() {
			Self::File
		} else {
			Self::Other
		})
	}
}

/// The classes `--fs-events` selects from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub(super) enum FsEvent {
	Access,
	Create,
	Remove,
	Rename,
	Modify,
	Metadata,
}

/// One change to a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
	Create,
	Ownership,
	Metadata,
	RenameFrom,
	RenameTo,
	Rename,
	Data,
	Remove,
	CloseWrite,
	Access,
	/// Changes were lost: something below the path changed.
	Other,
}

impl Kind {
	/// The watcher flag each kind stands for, in the order a path's changes
	/// are reported.
	const OF_FLAG: [(Flags, Self); 8] = [
		(Flags::CREATED, Self::Create),
		(Flags::OWNER_MODIFIED, Self::Ownership),
		(Flags::ATTRIBUTE_MODIFIED, Self::Metadata),
		(Flags::RENAMED, Self::Rename),
		(Flags::UPDATED, Self::Data),
		(Flags::REMOVED, Self::Remove),
		(Flags::CLOSE_WRITE, Self::CloseWrite),
		(Flags::PLATFORM_SPECIFIC, Self::Access),
	];

	/// The `--fs-events` class; `None` for a kind no class covers, which
	/// every selection lets through.
	pub(super) const fn class(self) -> Option<FsEvent> {
		Some(match self {
			Self::Create => FsEvent::Create,
			Self::Remove => FsEvent::Remove,
			Self::RenameFrom | Self::RenameTo | Self::Rename => FsEvent::Rename,
			Self::Data => FsEvent::Modify,
			Self::Ownership | Self::Metadata => FsEvent::Metadata,
			Self::CloseWrite | Self::Access => FsEvent::Access,
			Self::Other => return None,
		})
	}

	/// The `simple` type of the JSON form.
	const fn simple(self) -> &'static str {
		match self {
			Self::Create => "create",
			Self::Remove => "remove",
			Self::CloseWrite | Self::Access => "access",
			Self::Other => "other",
			_ => "modify",
		}
	}

	/// The prefix of the text form.
	const fn prefix(self) -> &'static str {
		match self {
			Self::Create => "create",
			Self::Remove => "remove",
			Self::RenameFrom | Self::RenameTo | Self::Rename => "rename",
			Self::Ownership | Self::Metadata | Self::Data => "modify",
			Self::CloseWrite | Self::Access | Self::Other => "other",
		}
	}

	/// The variable of the environment form the kind's paths go in.
	const fn variable(self) -> &'static str {
		match self {
			Self::Data | Self::CloseWrite => "WATCHEXEC_WRITTEN_PATH",
			Self::Ownership | Self::Metadata => "WATCHEXEC_META_CHANGED_PATH",
			Self::Remove => "WATCHEXEC_REMOVED_PATH",
			Self::Create => "WATCHEXEC_CREATED_PATH",
			Self::RenameFrom | Self::RenameTo | Self::Rename => "WATCHEXEC_RENAMED_PATH",
			Self::Access | Self::Other => "WATCHEXEC_OTHERWISE_CHANGED_PATH",
		}
	}
}

/// One event: a change to a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Change {
	/// The absolute path.
	pub path:      PathBuf,
	pub kind:      Kind,
	pub file_type: Option<FileType>,
}

impl Change {
	/// Appends the changes `flags` report for `path`.
	pub(super) fn expand(path: &Path, flags: Flags, out: &mut Vec<Self>) {
		let file_type = FileType::of(path, flags);
		let mut push = |kind| out.push(Self { path: path.to_path_buf(), kind, file_type });
		for (flag, kind) in Kind::OF_FLAG {
			if !flags.contains(flag) {
				continue;
			}
			push(match kind {
				Kind::Rename if flags.contains(Flags::MOVED_FROM) => Kind::RenameFrom,
				Kind::Rename if flags.contains(Flags::MOVED_TO) => Kind::RenameTo,
				kind => kind,
			});
		}
		if flags.contains(Flags::OVERFLOW) {
			push(Kind::Other);
		}
	}

	pub(super) fn is_dir(&self) -> bool {
		self.file_type == Some(FileType::Dir)
	}

	/// The `full` type of the JSON form: the notification kind as Rust's
	/// `notify` names it.
	fn full(&self) -> &'static str {
		let (file, folder, any) = match self.kind {
			Kind::Create => ("Create(File)", "Create(Folder)", "Create(Any)"),
			Kind::Remove => ("Remove(File)", "Remove(Folder)", "Remove(Any)"),
			Kind::Ownership => return "Modify(Metadata(Ownership))",
			Kind::Metadata => return "Modify(Metadata(Any))",
			Kind::RenameFrom => return "Modify(Name(From))",
			Kind::RenameTo => return "Modify(Name(To))",
			Kind::Rename => return "Modify(Name(Any))",
			Kind::Data if cfg!(target_os = "macos") => return "Modify(Data(Content))",
			Kind::Data => return "Modify(Data(Any))",
			Kind::CloseWrite => return "Access(Close(Write))",
			Kind::Access => return "Access(Any)",
			Kind::Other => return "Other",
		};
		match self.file_type {
			Some(FileType::File) => file,
			Some(FileType::Dir) => folder,
			_ => any,
		}
	}

	/// The line `--print-events` prints for the event numbered `index`.
	pub(super) fn describe(&self, index: usize) -> String {
		let mut line = format!(
			"[EVENT {index}] Event source=Filesystem kind={} path={}",
			self.full(),
			self.path.display()
		);
		if let Some(file_type) = self.file_type {
			let _ = write!(line, " filetype={}", file_type.name());
		}
		line
	}

	/// The event as a line of the text form: `create:/absolute/path`.
	pub(super) fn write_text(&self, out: &mut String) {
		let _ = writeln!(out, "{}:{}", self.kind.prefix(), self.path.display());
	}

	/// The event as a line of the JSON form.
	pub(super) fn write_json(&self, out: &mut String) {
		let _ = write!(
			out,
			r#"{{"tags":[{{"kind":"source","source":"filesystem"}},{{"kind":"fs","simple":"{}","full":"{}"}},{{"kind":"path","absolute":{}"#,
			self.kind.simple(),
			self.full(),
			JsonString(&self.path.to_string_lossy()),
		);
		if let Some(file_type) = self.file_type {
			let _ = write!(out, r#","filetype":"{}""#, file_type.name());
		}
		out.push_str("}]}\n");
	}
}

/// A string as a JSON string literal.
struct JsonString<'a>(&'a str);

impl fmt::Display for JsonString<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_char('"')?;
		for c in self.0.chars() {
			match c {
				'"' => f.write_str("\\\"")?,
				'\\' => f.write_str("\\\\")?,
				'\n' => f.write_str("\\n")?,
				'\r' => f.write_str("\\r")?,
				'\t' => f.write_str("\\t")?,
				c if (c as u32) < 0x20 => write!(f, "\\u{:04x}", c as u32)?,
				c => f.write_char(c)?,
			}
		}
		f.write_char('"')
	}
}

/// The longest path every one of `paths` lies at or below.
pub(super) fn common_prefix<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Option<PathBuf> {
	let mut paths = paths.into_iter();
	let mut common: Vec<Component<'a>> = paths.next()?.components().collect();
	for path in paths {
		let shared = common
			.iter()
			.zip(path.components())
			.take_while(|(a, b)| *a == b)
			.count();
		common.truncate(shared);
	}
	(!common.is_empty()).then(|| common.iter().collect())
}

/// The environment form: `WATCHEXEC_COMMON_PATH`, the longest path the
/// changed files' directories share, and one variable per kind of change
/// listing its paths below that, sorted and separated like `PATH`.
pub(super) fn environment(changes: &[Change]) -> Vec<(&'static str, String)> {
	if changes.is_empty() {
		return Vec::new();
	}
	let trunks = changes.iter().map(|change| {
		if change.is_dir() { &*change.path } else { change.path.parent().unwrap_or(&change.path) }
	});
	let common = common_prefix(trunks);
	let mut groups: Vec<(&'static str, BTreeSet<&Path>)> = Vec::new();
	for change in changes {
		let below = common
			.as_deref()
			.and_then(|common| change.path.strip_prefix(common).ok())
			.unwrap_or(&change.path);
		let variable = change.kind.variable();
		match groups.iter_mut().find(|(known, _)| *known == variable) {
			Some((_, paths)) => {
				paths.insert(below);
			},
			None => groups.push((variable, BTreeSet::from([below]))),
		}
	}
	let separator = if cfg!(windows) { ";" } else { ":" };
	let mut variables: Vec<(&'static str, String)> = groups
		.into_iter()
		.map(|(variable, paths)| {
			let joined = paths
				.into_iter()
				.map(|path| path.to_string_lossy())
				.collect::<Vec<_>>()
				.join(separator);
			(variable, joined)
		})
		.collect();
	if let Some(common) = common {
		variables.push(("WATCHEXEC_COMMON_PATH", common.to_string_lossy().into_owned()));
	}
	variables
}
