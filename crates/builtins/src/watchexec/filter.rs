//! Which events run the command: watchexec's filters, ignores and ignore
//! files.
//!
//! An event passes when its kind is among `--fs-events`, no ignore file and
//! no `--ignore` pattern (or default ignore) covers its path, and, if there
//! are `--filter` patterns or `--exts`, one of them matches. A file given to
//! `--watch` itself always passes.
//!
//! Patterns are gitignore globs relative to the project origin. Ignore files
//! are found per directory, on the way from the origin down to each changed
//! path, and compiled once; a walk of the whole project at startup is not
//! needed for that.

use std::{
	borrow::Cow,
	collections::HashMap,
	ffi::{OsStr, OsString},
	path::{Path, PathBuf},
	sync::Arc,
};

use parking_lot::Mutex;
use omp_vfs::BlockingFs;
use omp_xfs::ignore::{Match, Rules};

use super::events::{Change, FsEvent, Kind};

/// What watchexec ignores unless `--no-default-ignore`: editor swap and
/// backup files, compiled Python, its own logs, and the insides of version
/// control directories.
const DEFAULT_IGNORES: &str = "\
**/.DS_Store
watchexec.*.log
*.py[co]
#*#
.#*
.*.kate-swp
.*.sw?
.*.sw?x
**/.bzr/**
**/_darcs/**
**/.fossil-settings/**
**/.git/**
**/.hg/**
**/.pijul/**
**/.svn/**
";

/// Entries that mark a directory as a project's origin.
const ORIGIN_MARKERS: [&str; 44] = [
	".bzr",
	"_darcs",
	".fossil-settings",
	".git",
	".github",
	".hg",
	".pijul",
	".svn",
	".asf.yaml",
	".bzrignore",
	".codecov.yml",
	".ctags",
	".editorconfig",
	".gitattributes",
	".gitmodules",
	".hgignore",
	".hgtags",
	".perltidyrc",
	".travis.yml",
	"appveyor.yml",
	"build.gradle",
	"build.properties",
	"build.xml",
	"Cargo.toml",
	"Cargo.lock",
	"cgmanifest.json",
	"CMakeLists.txt",
	"composer.json",
	"COPYING",
	"docker-compose.yml",
	"Dockerfile",
	"Gemfile",
	"LICENSE.txt",
	"LICENSE",
	"Makefile",
	"mix.exs",
	"moonshine-dependencies.xml",
	"package.json",
	"pom.xml",
	"project.clj",
	"README.md",
	"README",
	"requirements.txt",
	"v.mod",
];

/// Which ignore files apply (`--no-vcs-ignore` and its kin).
#[derive(Clone, Copy, Debug)]
pub(super) struct Discovery {
	/// Git's and other version control systems' files.
	pub vcs:     bool,
	/// Files inside the project.
	pub project: bool,
	/// The user's files.
	pub global:  bool,
}

/// Where the user's configuration lives.
pub(super) struct Homes {
	/// `$HOME`, or `%USERPROFILE%`.
	pub home:       Option<String>,
	/// `$XDG_CONFIG_HOME`.
	pub xdg_config: Option<String>,
	/// `%APPDATA%`.
	pub appdata:    Option<String>,
}

/// The project origin of `paths`: the directory every watched path and every
/// marked directory above one shares. The home directory does not count as
/// marked unless it is watched itself.
pub(super) fn project_origin(
	fs: &BlockingFs,
	paths: &[PathBuf],
	home: Option<&Path>,
	workdir: &Path,
) -> PathBuf {
	let home_watched = home.is_some_and(|home| paths.iter().any(|path| path == home));
	let mut origins: Vec<&Path> = Vec::new();
	for path in paths {
		for dir in path.ancestors() {
			if !home_watched && Some(dir) == home {
				continue;
			}
			if ORIGIN_MARKERS.iter().any(|marker| fs.exists(dir.join(marker))) && !origins.contains(&dir) {
				origins.push(dir);
			}
		}
	}
	if origins.is_empty() {
		return workdir.to_path_buf();
	}
	super::events::common_prefix(origins).unwrap_or_else(|| workdir.to_path_buf())
}

/// `path` below `base` as the `/`-separated bytes gitignore rules match;
/// a path outside `base` whole.
fn below<'a>(base: &Path, path: &'a Path) -> Cow<'a, [u8]> {
	let bytes = path
		.strip_prefix(base)
		.unwrap_or(path)
		.as_os_str()
		.as_encoded_bytes();
	if cfg!(windows) && bytes.contains(&b'\\') {
		return Cow::Owned(
			bytes
				.iter()
				.map(|&byte| if byte == b'\\' { b'/' } else { byte })
				.collect(),
		);
	}
	Cow::Borrowed(bytes)
}

/// The ignore files of a project and of the user.
struct IgnoreFiles {
	fs:      BlockingFs,
	origin:  PathBuf,
	/// Names of the files every directory may have, strongest first.
	names:   Vec<&'static str>,
	/// The rules of the files that apply to the whole project, relative to
	/// the origin, strongest first.
	fixed:   Vec<Rules>,
	/// Compiled per-directory files, by directory; `None` for one without.
	per_dir: Mutex<HashMap<PathBuf, Option<Arc<[Rules]>>>>,
}

impl IgnoreFiles {
	/// The compiled ignore files of `dir`.
	fn of_dir(&self, dir: &Path) -> Option<Arc<[Rules]>> {
		if let Some(known) = self.per_dir.lock().get(dir) {
			return known.clone();
		}
		let rules: Vec<Rules> = self
			.names
			.iter()
			.filter_map(|name| self.fs.read(dir.join(name)).ok())
			.map(|data| Rules::parse(&data))
			.filter(|rules| !rules.is_empty())
			.collect();
		let rules = (!rules.is_empty()).then(|| Arc::<[Rules]>::from(rules));
		self
			.per_dir
			.lock()
			.insert(dir.to_path_buf(), rules.clone());
		rules
	}

	/// Whether an ignore file covers `path`: the nearest directory with a
	/// rule for it or for a directory it lies in decides, then the project's
	/// and the user's files.
	fn ignores(&self, path: &Path, is_dir: bool) -> bool {
		let verdict = |rules: &Rules, base: &Path| match rules
			.matched_path_or_parents(&below(base, path), is_dir)
		{
			Match::Ignore => Some(true),
			Match::Whitelist => Some(false),
			Match::None => None,
		};
		if !self.names.is_empty() && path.starts_with(&self.origin) {
			for dir in path.ancestors().skip(1) {
				if let Some(rules) = self.of_dir(dir)
					&& let Some(ignored) = rules.iter().find_map(|rules| verdict(rules, dir))
				{
					return ignored;
				}
				if dir == self.origin {
					break;
				}
			}
		}
		self
			.fixed
			.iter()
			.find_map(|rules| verdict(rules, &self.origin))
			.unwrap_or(false)
	}

	/// A per-directory ignore file changed: compile it afresh when next
	/// needed.
	fn forget(&self, file: &Path) {
		let is_ignore_file = file
			.file_name()
			.and_then(OsStr::to_str)
			.is_some_and(|name| self.names.contains(&name));
		if is_ignore_file && let Some(dir) = file.parent() {
			self.per_dir.lock().remove(dir);
		}
	}
}

/// The value of `core.excludesFile` in the git configuration `text`.
fn excludes_file(text: &str) -> Option<&str> {
	let mut in_core = false;
	let mut found = None;
	for line in text.lines().map(str::trim) {
		if let Some(section) = line.strip_prefix('[') {
			in_core = section
				.trim_end_matches(']')
				.trim()
				.eq_ignore_ascii_case("core");
		} else if in_core
			&& let Some((key, value)) = line.split_once('=')
			&& key.trim().eq_ignore_ascii_case("excludesfile")
		{
			found = Some(value.trim().trim_matches('"'));
		}
	}
	found
}

/// What the filterer is built from.
pub(super) struct Settings {
	pub origin:         PathBuf,
	pub fs_events:      Vec<FsEvent>,
	/// `--filter` patterns and the lines of `--filter-file`s.
	pub filters:        Vec<String>,
	/// `--ignore` patterns.
	pub ignores:        Vec<String>,
	pub extensions:     Vec<OsString>,
	pub default_ignore: bool,
	/// `None` skips ignore-file discovery altogether.
	pub discovery:      Option<Discovery>,
	/// `--ignore-file`s and `$WATCHEXEC_IGNORE_FILES`.
	pub ignore_files:   Vec<PathBuf>,
	/// Files watched by name, which always pass.
	pub watched_files:  Vec<PathBuf>,
	pub homes:          Homes,
}

/// Decides which events pass; shared with the watcher's thread.
pub(super) struct Filterer {
	origin:        PathBuf,
	fs_events:     Vec<FsEvent>,
	ignores:       Rules,
	filters:       Rules,
	extensions:    Vec<OsString>,
	watched_files: Vec<PathBuf>,
	ignore_files:  IgnoreFiles,
}

impl Filterer {
	pub(super) fn new(fs: &BlockingFs, settings: Settings) -> Self {
		let Settings {
			origin,
			fs_events,
			filters,
			ignores,
			extensions,
			default_ignore,
			discovery,
			ignore_files,
			watched_files,
			homes,
		} = settings;
		let mut ignore_lines = String::new();
		if default_ignore {
			ignore_lines.push_str(DEFAULT_IGNORES);
		}
		for pattern in &ignores {
			ignore_lines.push_str(pattern);
			ignore_lines.push('\n');
		}
		let read = |path: &Path| {
			fs.read(path)
				.ok()
				.map(|data| Rules::parse(&data))
				.filter(|rules| !rules.is_empty())
		};
		let mut names = Vec::new();
		let mut fixed = Vec::new();
		if let Some(Discovery { vcs, project, global }) = discovery {
			let uses = |marker: &str| vcs && fs.exists(origin.join(marker));
			let (git, mercurial, bazaar, darcs, fossil) =
				(uses(".git"), uses(".hg"), uses(".bzr"), uses("_darcs"), uses(".fossil-settings"));
			let home = homes.home.as_deref().map(Path::new);
			let expand = |file: &str| match (file.strip_prefix("~/"), home) {
				(Some(rest), Some(home)) => home.join(rest),
				_ => PathBuf::from(file),
			};
			if project {
				names.push(".ignore");
				if git {
					names.push(".gitignore");
				}
				if mercurial {
					names.push(".hgignore");
				}
				let mut project_files = Vec::new();
				if git {
					project_files.push(origin.join(".git/info/exclude"));
					if let Ok(config) = fs.read_to_string(origin.join(".git/config"))
						&& let Some(file) = excludes_file(&config)
					{
						project_files.push(expand(file));
					}
				}
				if bazaar {
					project_files.push(origin.join(".bzrignore"));
				}
				if darcs {
					project_files.push(origin.join("_darcs/prefs/boring"));
				}
				if fossil {
					project_files.push(origin.join(".fossil-settings/ignore-glob"));
				}
				fixed.extend(project_files.iter().filter_map(|file| read(file)));
			}
			if global {
				let config_home = homes
					.xdg_config
					.as_deref()
					.map(PathBuf::from)
					.or_else(|| home.map(|home| home.join(".config")));
				let first = |candidates: &[Option<PathBuf>]| {
					candidates
						.iter()
						.flatten()
						.find_map(|candidate| read(candidate))
				};
				let appdata = homes.appdata.as_deref().map(Path::new);
				if git {
					let configured = [
						home.map(|home| home.join(".gitconfig")),
						config_home.as_ref().map(|config| config.join("git/config")),
					]
					.into_iter()
					.flatten()
					.find_map(|config| {
						let text = fs.read_to_string(config).ok()?;
						excludes_file(&text).map(expand)
					});
					fixed.extend(match configured {
						Some(file) => read(&file),
						None => first(&[
							config_home.as_ref().map(|config| config.join("git/ignore")),
							appdata.map(|appdata| appdata.join(".gitignore")),
							home.map(|home| home.join(".config/git/ignore")),
							home.map(|home| home.join(".gitignore")),
						]),
					});
				}
				if bazaar {
					fixed.extend(first(&[
						appdata.map(|appdata| appdata.join("Bazzar/2.0/ignore")),
						home.map(|home| home.join(".bazaar/ignore")),
					]));
				}
				fixed.extend(first(&[
					config_home.as_ref().map(|config| config.join("watchexec/ignore")),
					appdata.map(|appdata| appdata.join("watchexec/ignore")),
					home.map(|home| home.join(".watchexec/ignore")),
				]));
			}
		}
		fixed.extend(ignore_files.iter().filter_map(|file| read(file)));
		let mut filter_lines = String::new();
		for pattern in &filters {
			filter_lines.push_str(pattern);
			filter_lines.push('\n');
		}
		Self {
			fs_events,
			ignores: Rules::parse(ignore_lines.as_bytes()),
			filters: Rules::parse(filter_lines.as_bytes()),
			extensions,
			watched_files,
			ignore_files: IgnoreFiles {
				fs: fs.clone(),
				origin: origin.clone(),
				names,
				fixed,
				per_dir: Mutex::new(HashMap::new()),
			},
			origin,
		}
	}

	/// The project origin: what patterns are relative to.
	pub(super) fn origin(&self) -> &Path {
		&self.origin
	}

	/// Whether the event passes.
	pub(super) fn passes(&self, change: &Change) -> bool {
		if change
			.kind
			.class()
			.is_some_and(|class| !self.fs_events.contains(&class))
		{
			return false;
		}
		let path = &*change.path;
		// Lost events name a directory, not what changed in it: they pass
		// unless nothing in the directory could.
		if change.kind == Kind::Other {
			return self.watches(path);
		}
		if change.kind != Kind::Access {
			self.ignore_files.forget(path);
		}
		if self.watched_files.iter().any(|file| file == path) {
			return true;
		}
		let is_dir = change.is_dir();
		if self.ignore_files.ignores(path, is_dir) {
			return false;
		}
		let relative = below(&self.origin, path);
		if self.ignores.matched(&relative, is_dir) == Match::Ignore {
			return false;
		}
		let mut filtered = false;
		if !self.filters.is_empty() {
			filtered = true;
			if self.filters.matched(&relative, is_dir) == Match::Ignore {
				return true;
			}
		}
		if !self.extensions.is_empty() {
			filtered = true;
			if is_dir {
				return false;
			}
			if path
				.extension()
				.is_some_and(|extension| self.extensions.iter().any(|known| known == extension))
			{
				return true;
			}
		}
		!filtered
	}

	/// Whether a directory can hold anything that passes: `false` for one an
	/// ignore file covers, or whose contents the ignore patterns cover at
	/// every depth (`.git`, `target/**`). Its changes need no watch.
	pub(super) fn watches(&self, dir: &Path) -> bool {
		if self.watched_files.iter().any(|file| file.starts_with(dir)) {
			return true;
		}
		if self.ignore_files.ignores(dir, true) {
			return false;
		}
		// Names no file has, two levels down: `dir/*` does not cover them,
		// `dir/**` does.
		let probe = dir.join("\u{1}").join("\u{1}");
		self.ignores.matched(&below(&self.origin, &probe), false) != Match::Ignore
	}
}
