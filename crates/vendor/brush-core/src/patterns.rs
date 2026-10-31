//! Shell patterns

use std::{collections::VecDeque, path::Path};

use crate::{error, regex, sys, trace_categories};

/// Represents a piece of a shell pattern.
#[derive(Clone, Debug)]
pub(crate) enum PatternPiece {
	/// A pattern that should be interpreted as a shell pattern.
	Pattern(String),
	/// A literal string that should be matched exactly.
	Literal(String),
}

impl PatternPiece {
	pub fn as_str(&self) -> &str {
		match self {
			Self::Pattern(s) => s,
			Self::Literal(s) => s,
		}
	}
}

type PatternWord = Vec<PatternPiece>;

fn component_string(components: &[PatternWord], index: usize) -> Option<String> {
	components
		.get(index)
		.map(|component| component.iter().map(|piece| piece.as_str()).collect())
}

/// Options for filename expansion.
#[derive(Clone, Debug, Default)]
pub(crate) struct FilenameExpansionOptions {
	pub require_dot_in_pattern_to_match_dot_files: bool,
	/// `shopt -s globstar`: a path component that is exactly `**` matches any
	/// number of directory levels.
	pub globstar: bool,
	/// The run's cancellation token. Expansion checks it before each directory
	/// it lists or path it probes: after a `**` walk that can be millions of
	/// synchronous reads that never yield.
	pub cancel: Option<tokio_util::sync::CancellationToken>,
}

/// What a `**` component matches under `globstar`, decided by what follows it.
#[derive(Clone, Copy, Debug)]
enum GlobstarMode {
	/// `**` ends the pattern: every entry below the base, plus the base itself,
	/// spelled `base/` unless an earlier component is a glob.
	Entries { globbed_base: bool },
	/// `**/`, at the end or followed by more slashes (`**//x`): every directory
	/// below the base (a symlink to a directory counts), plus the base itself.
	Dirs,
	/// More components follow: the base and every real directory below it.
	/// With `link_bases`, also every symlink to a directory found below it,
	/// which is not walked.
	Bases { link_bases: bool },
	/// Directly followed by another `**`: bash collapses the run into its last
	/// `**`, so this one matches nothing of its own.
	Collapsed,
}

/// True for a component spelled exactly `**` by unquoted pattern text.
fn is_globstar_component(component: &PatternWord) -> bool {
	component.iter().all(|piece| matches!(piece, PatternPiece::Pattern(_)))
		&& component.iter().map(|piece| piece.as_str()).collect::<String>() == "**"
}

/// True for the empty component between two slashes (or after a final one).
fn is_empty_component(component: &PatternWord) -> bool {
	component.iter().all(|piece| piece.as_str().is_empty())
}

/// Stops expansion with [`error::ErrorKind::Interrupted`] once the run is
/// cancelled.
fn ensure_not_cancelled(cancel: Option<&tokio_util::sync::CancellationToken>) -> Result<(), error::Error> {
	if cancel.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
		return Err(error::ErrorKind::Interrupted.into());
	}
	Ok(())
}

/// The path to ask the filesystem about: matches keep the pattern's spelling
/// (`./`, `../`), but a virtual provider is only asked about lexically
/// normalized paths.
fn probe_path<'a>(fs: &pi_vfs::Fs, path: &'a Path) -> std::borrow::Cow<'a, Path> {
	if fs.is_native_local(path) {
		std::borrow::Cow::Borrowed(path)
	} else {
		std::borrow::Cow::Owned(pi_vfs::normalize_lexically(path))
	}
}

/// Returns the `scheme://` root when the pattern's leading components spell a
/// virtual path (`scheme:` then an empty component, from splitting on `/`).
fn url_pattern_root(components: &[PatternWord]) -> Option<std::path::PathBuf> {
	let [first, second, ..] = components else {
		return None;
	};
	if !second.iter().all(|piece| piece.as_str().is_empty()) {
		return None;
	}
	let mut root: String = first.iter().map(|piece| piece.as_str()).collect();
	let scheme_len = root.strip_suffix(':')?.len();
	root.push_str("//");
	let root = std::path::PathBuf::from(root);
	(pi_vfs::url_scheme(&root).map(str::len) == Some(scheme_len)).then_some(root)
}

/// Result of a pattern expansion, distinguishing "no glob metacharacters" from
/// "glob expansion attempted but found no matches".
#[derive(Debug, Default)]
pub(crate) enum PatternExpansionResult {
	/// No glob metacharacters found; no expansion was attempted.
	#[default]
	NoGlob,
	/// Glob expansion was attempted. Contains matching paths (may be empty).
	Expanded(Vec<String>),
}

impl PatternExpansionResult {
	/// Returns the expansion results, regardless of variant.
	pub fn into_paths(self) -> Vec<String> {
		match self {
			Self::NoGlob => vec![],
			Self::Expanded(paths) => paths,
		}
	}

	/// Returns true if glob expansion was attempted but produced no results.
	pub const fn is_unmatched_glob(&self) -> bool {
		matches!(self, Self::Expanded(paths) if paths.is_empty())
	}
}

/// Encapsulates a shell pattern.
#[derive(Clone, Debug)]
pub struct Pattern {
	pieces:                   PatternWord,
	enable_extended_globbing: bool,
	multiline:                bool,
	case_insensitive:         bool,
}

impl Default for Pattern {
	fn default() -> Self {
		Self {
			pieces:                   vec![],
			enable_extended_globbing: false,
			multiline:                true,
			case_insensitive:         false,
		}
	}
}

impl From<PatternWord> for Pattern {
	fn from(pieces: PatternWord) -> Self {
		Self { pieces, ..Default::default() }
	}
}

impl From<&PatternWord> for Pattern {
	fn from(value: &PatternWord) -> Self {
		Self { pieces: value.clone(), ..Default::default() }
	}
}

impl From<&str> for Pattern {
	fn from(value: &str) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value.to_owned())], ..Default::default() }
	}
}

impl From<String> for Pattern {
	fn from(value: String) -> Self {
		Self { pieces: vec![PatternPiece::Pattern(value)], ..Default::default() }
	}
}

impl Pattern {
	/// Enables (or disables) extended globbing support for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable extended globbing (extglob).
	#[must_use]
	pub const fn set_extended_globbing(mut self, value: bool) -> Self {
		self.enable_extended_globbing = value;
		self
	}

	/// Enables (or disables) multiline support for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable multiline matching.
	#[must_use]
	pub const fn set_multiline(mut self, value: bool) -> Self {
		self.multiline = value;
		self
	}

	/// Enables (or disables) case-insensitive matching for this pattern.
	///
	/// # Arguments
	///
	/// * `value` - Whether or not to enable case-insensitive matching.
	#[must_use]
	pub const fn set_case_insensitive(mut self, value: bool) -> Self {
		self.case_insensitive = value;
		self
	}

	/// Returns whether or not the pattern is empty.
	pub fn is_empty(&self) -> bool {
		self.pieces.iter().all(|p| p.as_str().is_empty())
	}

	/// Expands the pattern into a list of matching file paths, reading
	/// directories through `fs`. Patterns rooted at `scheme://` expand within
	/// that virtual namespace.
	///
	/// # Arguments
	///
	/// * `fs` - The filesystem to search.
	/// * `working_dir` - The current working directory, used for relative paths.
	/// * `options` - Expansion options.
	#[expect(clippy::too_many_lines)]
	pub(crate) async fn expand(
		&self,
		fs: &pi_vfs::Fs,
		working_dir: &Path,
		options: &FilenameExpansionOptions,
	) -> Result<PatternExpansionResult, error::Error> {
		// If the pattern has no pieces at all, short-circuit; there's nothing to
		// expand. Note: we intentionally do NOT short-circuit when pieces are present
		// but empty (e.g. from a quoted empty string ""); those fall through to the
		// literal branch below which correctly returns Expanded([""]) instead of
		// NoGlob, preserving the argument even when nullglob is enabled.
		if self.pieces.is_empty() {
			return Ok(PatternExpansionResult::NoGlob);

		// Similarly, if we're *confident* the pattern doesn't require expansion,
		// then we know there's a single expansion (before filtering).
		} else if !self.pieces.iter().any(|piece| {
			matches!(piece, PatternPiece::Pattern(_))
				&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
		}) {
			let concatenated: String = self.pieces.iter().map(|piece| piece.as_str()).collect();

			return Ok(PatternExpansionResult::Expanded(vec![concatenated]));
		}

		tracing::debug!(target: trace_categories::PATTERN, "expanding pattern: {self:?}");

		let mut components: Vec<PatternWord> = vec![];
		for piece in &self.pieces {
			let mut split_result: VecDeque<_> = sys::fs::split_path_for_pattern(piece.as_str())
				.map(|s| match piece {
					PatternPiece::Pattern(_) => PatternPiece::Pattern(s.to_owned()),
					PatternPiece::Literal(_) => PatternPiece::Literal(s.to_owned()),
				})
				.collect();

			if let Some(first_piece) = split_result.pop_front() {
				if let Some(last_component) = components.last_mut() {
					last_component.push(first_piece);
				} else {
					components.push(vec![first_piece]);
				}
			}

			while let Some(piece) = split_result.pop_front() {
				components.push(vec![piece]);
			}
		}

		// Check if the path appears to be absolute by inspecting the first components.
		// On Unix, a leading `/` produces an empty first component. On Windows, a
		// drive-letter prefix like `c:` is also recognized, and a forward-slash
		// MSYS/WSL drive alias (`/d/...`, `/mnt/d/...`) must be translated before
		// `read_dir()` sees the root.
		let starts_with_forward_slash = self
			.pieces
			.iter()
			.find_map(|piece| piece.as_str().as_bytes().first().copied())
			.is_some_and(|byte| byte == b'/');
		let first_component = component_string(&components, 0);
		let second_component = component_string(&components, 1);
		let third_component = component_string(&components, 2);
		let alias_root = first_component.as_deref().and_then(|first| {
			sys::fs::pattern_drive_alias_root(
				starts_with_forward_slash,
				first,
				second_component.as_deref(),
				third_component.as_deref(),
			)
		});
		let (absolute_root, components_to_remove) =
			if let Some(root) = url_pattern_root(&components) {
				// `scheme:` and the empty component between the two slashes.
				(Some(root), 2)
			} else if let Some((root, consumed)) = alias_root {
				(Some(root), consumed)
			} else {
				(
					first_component
						.as_deref()
						.and_then(sys::fs::pattern_path_root),
					1,
				)
			};

		let prefix_to_remove;
		let mut paths_so_far = if let Some(root) = absolute_root {
			prefix_to_remove = None;
			// Skip the component(s) consumed to determine the root.
			drop(components.drain(0..components_to_remove));
			vec![root]
		} else {
			// Build a prefix to remove after glob expansion so results are
			// returned relative to the working directory. The prefix is
			// normalized to use `/` separators because `push_path_for_pattern`
			// also uses `/` on Windows (to avoid `PathBuf::push` drive-letter
			// semantics) — if we left `\` here, the strip_prefix below would
			// miss on Windows and leave results as absolute paths.
			let working_dir_str = working_dir.to_string_lossy();
			let mut working_dir_str =
				sys::fs::normalize_path_separators(&working_dir_str).into_owned();
			if !working_dir_str.ends_with('/') {
				working_dir_str.push('/');
			}

			prefix_to_remove = Some(working_dir_str);
			vec![working_dir.to_path_buf()]
		};

		// Under `globstar`, bash reads a run of slashes after `**` as one
		// (`**//` is `**/`), and `**//**` as `**/**`. A single slash between
		// `**` and a pattern component still counts: `**//x` takes `**/` as
		// its directory part (see `GlobstarMode::Dirs`).
		if options.globstar {
			let mut kept: Vec<PatternWord> = Vec::with_capacity(components.len());
			for component in components {
				let after_globstar_slash = kept.len() >= 2
					&& kept.last().is_some_and(is_empty_component)
					&& is_globstar_component(&kept[kept.len() - 2]);
				if after_globstar_slash && is_empty_component(&component) {
					continue;
				}
				if after_globstar_slash && is_globstar_component(&component) {
					kept.pop();
				}
				kept.push(component);
			}
			components = kept;
		}

		// Under `globstar`, what each `**` component matches depends on what
		// comes before and after it (see `GlobstarMode`); decide it before the
		// loop consumes the components.
		let last_index = components.len().saturating_sub(1);
		let is_globbed = |component: &PatternWord| {
			component.iter().any(|piece| {
				matches!(piece, PatternPiece::Pattern(_))
					&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
			})
		};
		// One slot per component, so the mode a `**` component gets cannot drift
		// from the component the loop below is at.
		let globstar_modes: Vec<Option<GlobstarMode>> = if options.globstar {
			components
				.iter()
				.enumerate()
				.map(|(index, component)| {
					if !is_globstar_component(component) {
						return None;
					}
					Some(if components.get(index + 1).is_some_and(is_globstar_component) {
						GlobstarMode::Collapsed
					} else if index == last_index {
						// Bash spells the zero-depth match as the directory before
						// `**` was spelled, with its slash only when no earlier
						// component is a glob: `a1/**` gives `a1/`, `*/**` gives
						// `a1`, `**/sub/**` gives `d1/sub`.
						let globbed_base = components[..index].iter().any(is_globbed);
						GlobstarMode::Entries { globbed_base }
					} else if is_empty_component(&components[index + 1]) {
						// `**/` ends the pattern, or a slash follows it (`**//x`,
						// one empty component after the collapse above). Bash takes
						// `**/` as the directory part either way, so the bases are
						// the directories `**/` lists.
						GlobstarMode::Dirs
					} else {
						// Bash takes symlinks to directories as bases (one hop, not
						// walked) unless everything before `**` is `**`: `a1/**/x`,
						// `./**/x` and `/**/x` reach `a1/lup/x`, `**/x` does not.
						let link_bases = prefix_to_remove.is_none()
							|| components[..index].iter().any(|c| !is_globstar_component(c));
						GlobstarMode::Bases { link_bases }
					})
				})
				.collect()
		} else {
			Vec::new()
		};
		let relative_root = prefix_to_remove.is_some().then(|| working_dir.to_path_buf());
		let globstar_walked = globstar_modes.iter().any(Option::is_some);

		// URL spelling: an absolute `scheme://` pattern is already spelled
		// percent-encoded, while a relative pattern under a virtual working
		// directory names raw segments (encoded once when joined, decoded back
		// once in the results). Host paths keep their spelling untouched.
		let virtual_spelling = paths_so_far.first().is_some_and(|p| pi_vfs::is_virtual_path(p));
		let raw_relative = virtual_spelling && prefix_to_remove.is_some();
		let match_encoded = virtual_spelling && prefix_to_remove.is_none();

		// Literal components after the last glob are appended to every match
		// without being listed, so nothing has proven they exist yet: `*/x`
		// would keep `file/x`, and `*/` would keep `file/`. Bash keeps only
		// paths that exist, and a trailing `/` keeps only directories.
		let mut globbed = false;
		let mut unverified_suffix = false;
		let mut trailing_slash = false;
		for (index, component) in components.into_iter().enumerate() {
			if !component.iter().any(|piece| {
				matches!(piece, PatternPiece::Pattern(_))
					&& requires_expansion(piece.as_str(), self.enable_extended_globbing)
			}) {
				let flattened = component
					.iter()
					.map(|piece| piece.as_str())
					.collect::<String>();
				for p in &mut paths_so_far {
					if raw_relative {
						*p = pi_vfs::join_path(p, Path::new(&flattened));
					} else {
						sys::fs::push_path_for_pattern(p, &flattened);
					}
				}
				unverified_suffix = globbed;
				trailing_slash = flattened.is_empty();
				continue;
			}
			globbed = true;
			unverified_suffix = false;

			if let Some(mode) = globstar_modes.get(index).copied().flatten() {
				if matches!(mode, GlobstarMode::Collapsed) {
					continue;
				}
				paths_so_far = Self::expand_globstar(
					fs,
					std::mem::take(&mut paths_so_far),
					mode,
					relative_root.as_deref(),
					!options.require_dot_in_pattern_to_match_dot_files,
					options.cancel.as_ref(),
				)
				.await?;
				continue;
			}
			let current_paths = std::mem::take(&mut paths_so_far);
			for current_path in current_paths {
				// After a `**` walk this lists every directory it found again.
				ensure_not_cancelled(options.cancel.as_ref())?;
				let subpattern = Self::from(&component)
					.set_extended_globbing(self.enable_extended_globbing)
					.set_case_insensitive(self.case_insensitive);

				let subpattern_starts_with_dot = subpattern
					.pieces
					.first()
					.is_some_and(|piece| piece.as_str().starts_with('.'));

				let allow_dot_files =
					!options.require_dot_in_pattern_to_match_dot_files || subpattern_starts_with_dot;

				let regex = subpattern.to_regex(true, true)?;

				// Matches keep the pattern's spelling (`./`, `../`), but a virtual
				// provider is only asked to list a lexically normalized path.
				let listing = fs.read_dir(probe_path(fs, &current_path)).await;
				let mut matching_paths_in_dir: Vec<_> = Vec::new();
				if let Ok(entries) = listing {
					for entry in entries.filter_map(Result::ok) {
						// One directory can hold millions of entries, and nothing
						// here yields on the native route.
						ensure_not_cancelled(options.cancel.as_ref())?;
						let file_name = entry.file_name();
						let name = file_name.to_string_lossy();
						if !allow_dot_files && name.starts_with('.') {
							continue;
						}
						// Raw names match as on any filesystem; a pattern
						// spelled as an absolute URL may also name the
						// encoded segment (`my%20*`).
						let matches = regex.is_match(name.as_ref()).unwrap_or(false)
							|| (match_encoded && {
								let encoded = pi_vfs::encode_segment(&file_name);
								matches!(encoded, std::borrow::Cow::Owned(_))
									&& regex.is_match(&encoded.to_string_lossy()).unwrap_or(false)
							});
						if matches {
							matching_paths_in_dir.push(pi_vfs::child_path(&current_path, &file_name));
						}
					}
				}

				matching_paths_in_dir.sort();

				paths_so_far.append(&mut matching_paths_in_dir);
			}
		}

		if unverified_suffix {
			let mut existing = Vec::with_capacity(paths_so_far.len());
			for path in paths_so_far {
				// After a `**` walk this probes a path under every directory.
				ensure_not_cancelled(options.cancel.as_ref())?;
				let probe = probe_path(fs, &path);
				// `*/` follows symlinks like bash (a link to a directory
				// matches); a named suffix only has to exist, dangling or not.
				let exists = if trailing_slash {
					fs.is_dir(&probe).await
				} else {
					fs.symlink_metadata(&probe).await.is_ok()
				};
				if exists {
					existing.push(path);
				}
			}
			paths_so_far = existing;
		}

		let results: Vec<_> = paths_so_far
			.into_iter()
			.map(|path| {
				// Normalize separators *before* stripping the working-dir
				// prefix so that `prefix_to_remove` (already normalized to
				// use `/`) matches paths that may contain a mix of `\` and
				// `/` on Windows.
				let path_str = path.to_string_lossy();
				let normalized = sys::fs::normalize_path_separators(&path_str);
				let mut path_ref: &str = normalized.as_ref();

				if let Some(prefix_to_remove) = &prefix_to_remove
					&& let Some(stripped) = path_ref.strip_prefix(prefix_to_remove.as_str())
				{
					path_ref = stripped;
				}

				if raw_relative {
					// Back to the raw relative spelling the user typed, so
					// resolving it against the virtual cwd encodes it once.
					return path_ref
						.split('/')
						.map(|segment| {
							pi_vfs::decode_segment(std::ffi::OsStr::new(segment))
								.to_string_lossy()
								.into_owned()
						})
						.collect::<Vec<_>>()
						.join("/");
				}

				path_ref.to_string()
			})
			.collect();

		// Bash sorts the whole result. Without `**` each component's listing is
		// already sorted per base; a walk mixes depths (`**/*.rs` lists the base
		// before its subdirectories), so sort it all.
		let results = if globstar_walked {
			let mut results = results;
			results.sort();
			results
		} else {
			results
		};

		tracing::debug!(target: trace_categories::PATTERN, "  => results: {results:?}");

		Ok(PatternExpansionResult::Expanded(results))
	}

	/// Expands one `**` component under `globstar`, as bash 5.2 does: the walk
	/// starts at each base (a symlinked base is followed) and does not descend
	/// into symlinked directories found below it. Hidden entries are skipped
	/// unless `allow_dot_files`. A base that is not a directory matches
	/// nothing. The relative working directory itself is never a result of
	/// `**` or `**/`, only a base for components that follow.
	///
	/// Returns [`error::ErrorKind::Interrupted`] once `cancel` is cancelled: the
	/// reads below are synchronous on the native route, so the walk never
	/// yields and nothing else can stop it.
	async fn expand_globstar(
		fs: &pi_vfs::Fs,
		bases: Vec<std::path::PathBuf>,
		mode: GlobstarMode,
		relative_root: Option<&Path>,
		allow_dot_files: bool,
		cancel: Option<&tokio_util::sync::CancellationToken>,
	) -> Result<Vec<std::path::PathBuf>, error::Error> {
		let mut matches = Vec::new();

		for base in bases {
			// Each base costs a synchronous probe on the native route, and a
			// base that is not a directory never reaches the walk's check below.
			ensure_not_cancelled(cancel)?;
			if !fs.is_dir(probe_path(fs, &base)).await {
				continue;
			}
			// Byte comparison: `./**/` must still list `./`, though `cwd/.` and
			// `cwd` are equal as `Path`s.
			let is_root = relative_root.is_some_and(|root| root.as_os_str() == base.as_os_str());
			match mode {
				GlobstarMode::Entries { globbed_base: true } if !is_root => matches.push(base.clone()),
				GlobstarMode::Entries { globbed_base: false } if !is_root => {
					let mut itself = base.clone();
					sys::fs::push_path_for_pattern(&mut itself, "");
					matches.push(itself);
				},
				GlobstarMode::Dirs if !is_root => matches.push(base.clone()),
				GlobstarMode::Bases { .. } => matches.push(base.clone()),
				GlobstarMode::Entries { .. } | GlobstarMode::Dirs | GlobstarMode::Collapsed => {},
			}

			let mut pending = vec![base];
			while let Some(dir) = pending.pop() {
				ensure_not_cancelled(cancel)?;
				let Ok(listing) = fs.read_dir(probe_path(fs, &dir)).await else {
					continue;
				};
				for entry in listing.filter_map(Result::ok) {
					// A single directory can hold millions of entries, and on the
					// native route nothing below yields, so a timeout arriving
					// during this loop is only seen if it is read here.
					ensure_not_cancelled(cancel)?;
					let file_name = entry.file_name();
					if !allow_dot_files && file_name.to_string_lossy().starts_with('.') {
						continue;
					}
					let path = pi_vfs::child_path(&dir, &file_name);
					// The entry's own type: a symlink to a directory is not walked.
					let file_type = entry.file_type_async().await.ok();
					let real_dir = file_type.is_some_and(|file_type| file_type.is_dir());
					let may_link_dir = file_type.is_none_or(|file_type| file_type.is_symlink());
					let matched = match mode {
						GlobstarMode::Entries { .. } => true,
						GlobstarMode::Dirs | GlobstarMode::Bases { link_bases: true } => {
							real_dir || (may_link_dir && fs.is_dir(probe_path(fs, &path)).await)
						},
						GlobstarMode::Bases { link_bases: false } | GlobstarMode::Collapsed => real_dir,
					};
					if real_dir {
						pending.push(path.clone());
					}
					if matched {
						matches.push(path);
					}
				}
			}
		}

		// One sorted list across all bases, as bash prints it. Nested bases
		// (`**/b*/**` with `a/b1` and `a/b1/b2`) reach the same path once per
		// base, and bash keeps each of those words.
		matches.sort();
		Ok(matches)
	}

	/// Converts the pattern to a regular expression string.
	///
	/// # Arguments
	///
	/// * `strict_prefix_match` - Whether or not the pattern should strictly
	///   match the beginning of the string.
	/// * `strict_suffix_match` - Whether or not the pattern should strictly
	///   match the end of the string.
	pub(crate) fn to_regex_str(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<String, error::Error> {
		let mut regex_str = String::new();

		if strict_prefix_match {
			regex_str.push('^');
		}

		let mut current_pattern = String::new();
		for piece in &self.pieces {
			match piece {
				PatternPiece::Pattern(s) => {
					current_pattern.push_str(s);
				},
				PatternPiece::Literal(s) => {
					for c in s.chars() {
						if crate::regex::regex_char_is_special(c) {
							current_pattern.push('\\');
						}
						current_pattern.push(c);
					}
				},
			}
		}

		let regex_piece =
			pattern_to_regex_str(current_pattern.as_str(), self.enable_extended_globbing)?;
		regex_str.push_str(regex_piece.as_str());

		if strict_suffix_match {
			regex_str.push('$');
		}

		Ok(regex_str)
	}

	/// Converts the pattern to a regular expression.
	///
	/// # Arguments
	///
	/// * `strict_prefix_match` - Whether or not the pattern should strictly
	///   match the beginning of the string.
	/// * `strict_suffix_match` - Whether or not the pattern should strictly
	///   match the end of the string.
	pub(crate) fn to_regex(
		&self,
		strict_prefix_match: bool,
		strict_suffix_match: bool,
	) -> Result<fancy_regex::Regex, error::Error> {
		let regex_str = self.to_regex_str(strict_prefix_match, strict_suffix_match)?;

		tracing::debug!(target: trace_categories::PATTERN, "pattern: '{self:?}' => regex: '{regex_str}'");

		let re = regex::compile_regex(regex_str, self.case_insensitive, self.multiline)?;
		Ok(re)
	}

	/// Checks if the pattern exactly matches the given string. An error result
	/// is returned if the pattern is found to be invalid or malformed
	/// during processing.
	///
	/// # Arguments
	///
	/// * `value` - The string to check for a match.
	pub fn exactly_matches(&self, value: &str) -> Result<bool, error::Error> {
		let re = self.to_regex(true, true)?;
		Ok(re.is_match(value)?)
	}
}

/// Checks whether a string contains glob metacharacters that would trigger
/// pathname expansion. Delegates to the pattern parser's grammar, which is
/// the single source of truth for what constitutes a glob metacharacter.
fn requires_expansion(s: &str, enable_extended_globbing: bool) -> bool {
	brush_parser::pattern::pattern_has_glob_metacharacters(s, enable_extended_globbing)
}

fn pattern_to_regex_str(
	pattern: &str,
	enable_extended_globbing: bool,
) -> Result<String, error::Error> {
	Ok(brush_parser::pattern::pattern_to_regex_str(pattern, enable_extended_globbing)?)
}

/// Removes the largest matching prefix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the prefix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_largest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let indices = s.char_indices().rev();
		let mut last_idx = s.len();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in indices {
			let prefix = &s[0..last_idx];
			if re.is_match(prefix)? {
				return Ok(&s[last_idx..]);
			}

			last_idx = idx;
		}
	}
	Ok(s)
}

/// Removes the smallest matching prefix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the prefix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_smallest_matching_prefix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		let mut indices = s.char_indices();

		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		while indices.next().is_some() {
			let next_index = indices.offset();
			let prefix = &s[0..next_index];
			if re.is_match(prefix)? {
				return Ok(&s[next_index..]);
			}
		}
	}
	Ok(s)
}

/// Removes the largest matching suffix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the suffix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_largest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}

/// Removes the smallest matching suffix from a string that matches the given
/// pattern.
///
/// # Arguments
///
/// * `s` - The string to remove the suffix from.
/// * `pattern` - The pattern to match.
pub(crate) fn remove_smallest_matching_suffix<'a>(
	s: &'a str,
	pattern: Option<&Pattern>,
) -> Result<&'a str, error::Error> {
	if let Some(pattern) = pattern {
		let re = pattern.to_regex(true, true)?;
		#[allow(clippy::string_slice, reason = "because we get the indices from char_indices()")]
		for (idx, _) in s.char_indices().rev() {
			let suffix = &s[idx..];
			if re.is_match(suffix)? {
				return Ok(&s[..idx]);
			}
		}
	}
	Ok(s)
}

#[cfg(test)]
#[expect(clippy::panic_in_result_fn)]
mod tests {
	use anyhow::Result;

	use super::*;

	fn pattern_to_exact_regex_str<P>(pattern: P) -> Result<String, error::Error>
	where
		P: Into<Pattern>,
	{
		let pattern: Pattern = pattern
			.into()
			.set_extended_globbing(true)
			.set_multiline(false);

		pattern.to_regex_str(true, true)
	}

	#[test]
	fn test_pattern_translation() -> Result<()> {
		assert_eq!(pattern_to_exact_regex_str("a")?.as_str(), "^a$");
		assert_eq!(pattern_to_exact_regex_str("a*")?.as_str(), "^a.*$");
		assert_eq!(pattern_to_exact_regex_str("a?")?.as_str(), "^a.$");
		assert_eq!(pattern_to_exact_regex_str("a@(b|c)")?.as_str(), "^a(b|c)$");
		assert_eq!(pattern_to_exact_regex_str("a?(b|c)")?.as_str(), "^a(b|c)?$");
		assert_eq!(pattern_to_exact_regex_str("a*(ab|ac)")?.as_str(), "^a(ab|ac)*$");
		assert_eq!(pattern_to_exact_regex_str("a+(ab|ac)")?.as_str(), "^a(ab|ac)+$");
		assert_eq!(pattern_to_exact_regex_str("[ab]")?.as_str(), "^[ab]$");
		assert_eq!(pattern_to_exact_regex_str("[ab]*")?.as_str(), "^[ab].*$");
		assert_eq!(pattern_to_exact_regex_str("[<{().[]*")?.as_str(), r"^[<{().\[].*$");
		assert_eq!(pattern_to_exact_regex_str("[a-d]")?.as_str(), "^[a-d]$");
		assert_eq!(pattern_to_exact_regex_str(r"\*")?.as_str(), r"^\*$");

		Ok(())
	}

	#[test]
	fn test_pattern_word_translation() -> Result<()> {
		assert_eq!(
			pattern_to_exact_regex_str(vec![PatternPiece::Pattern("a*".to_owned())])?.as_str(),
			"^a.*$"
		);
		assert_eq!(
			pattern_to_exact_regex_str(vec![
				PatternPiece::Pattern("a*".to_owned()),
				PatternPiece::Literal("b".to_owned()),
			])?
			.as_str(),
			"^a.*b$"
		);
		assert_eq!(
			pattern_to_exact_regex_str(vec![
				PatternPiece::Literal("a*".to_owned()),
				PatternPiece::Pattern("b".to_owned()),
			])?
			.as_str(),
			r"^a\*b$"
		);

		Ok(())
	}

	#[test]
	fn test_remove_largest_matching_prefix() -> Result<()> {
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("")))?, "ooof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("x")))?, "ooof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o")))?, "oof");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o*o")))?, "f");
		assert_eq!(remove_largest_matching_prefix("ooof", Some(&Pattern::from("o*")))?, "");
		assert_eq!(
			remove_largest_matching_prefix("🚀🚀🚀rocket", Some(&Pattern::from("🚀")))?,
			"🚀🚀rocket"
		);
		Ok(())
	}

	#[test]
	fn test_remove_smallest_matching_prefix() -> Result<()> {
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("")))?, "ooof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("x")))?, "ooof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o")))?, "oof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o*o")))?, "of");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("o*")))?, "oof");
		assert_eq!(remove_smallest_matching_prefix("ooof", Some(&Pattern::from("ooof")))?, "");
		assert_eq!(
			remove_smallest_matching_prefix("🚀🚀🚀rocket", Some(&Pattern::from("🚀")))?,
			"🚀🚀rocket"
		);
		Ok(())
	}

	#[test]
	fn test_remove_largest_matching_suffix() -> Result<()> {
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("")))?, "foo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("x")))?, "foo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("o")))?, "fo");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("o*")))?, "f");
		assert_eq!(remove_largest_matching_suffix("foo", Some(&Pattern::from("foo")))?, "");
		assert_eq!(
			remove_largest_matching_suffix("rocket🚀🚀🚀", Some(&Pattern::from("🚀")))?,
			"rocket🚀🚀"
		);
		Ok(())
	}

	#[test]
	fn test_remove_smallest_matching_suffix() -> Result<()> {
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("")))?, "fooo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("x")))?, "fooo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o")))?, "foo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o*o")))?, "fo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("o*")))?, "foo");
		assert_eq!(remove_smallest_matching_suffix("fooo", Some(&Pattern::from("fooo")))?, "");
		assert_eq!(
			remove_smallest_matching_suffix("rocket🚀🚀🚀", Some(&Pattern::from("🚀")))?,
			"rocket🚀🚀"
		);
		Ok(())
	}

	#[test]
	#[expect(clippy::cognitive_complexity)]
	fn test_matching() -> Result<()> {
		assert!(Pattern::from("abc").exactly_matches("abc")?);

		assert!(!Pattern::from("abc").exactly_matches("ABC")?);
		assert!(!Pattern::from("abc").exactly_matches("xabcx")?);
		assert!(!Pattern::from("abc").exactly_matches("")?);
		assert!(!Pattern::from("abc").exactly_matches("abcd")?);
		assert!(!Pattern::from("abc").exactly_matches("def")?);

		assert!(Pattern::from("*").exactly_matches("")?);
		assert!(Pattern::from("*").exactly_matches("abc")?);
		assert!(Pattern::from("*").exactly_matches(" ")?);

		assert!(Pattern::from("a*").exactly_matches("a")?);
		assert!(Pattern::from("a*").exactly_matches("ab")?);
		assert!(Pattern::from("a*").exactly_matches("a ")?);

		assert!(!Pattern::from("a*").exactly_matches("A")?);
		assert!(!Pattern::from("a*").exactly_matches("")?);
		assert!(!Pattern::from("a*").exactly_matches("bc")?);
		assert!(!Pattern::from("a*").exactly_matches("xax")?);
		assert!(!Pattern::from("a*").exactly_matches(" a")?);

		assert!(Pattern::from("*a").exactly_matches("a")?);
		assert!(Pattern::from("*a").exactly_matches("ba")?);
		assert!(Pattern::from("*a").exactly_matches("aa")?);
		assert!(Pattern::from("*a").exactly_matches(" a")?);

		assert!(!Pattern::from("*a").exactly_matches("BA")?);
		assert!(!Pattern::from("*a").exactly_matches("")?);
		assert!(!Pattern::from("*a").exactly_matches("ab")?);
		assert!(!Pattern::from("*a").exactly_matches("xax")?);

		Ok(())
	}

	fn make_extglob(s: &str) -> Pattern {
		let pattern = Pattern::from(s).set_extended_globbing(true);
		let regex_str = pattern.to_regex_str(true, true).unwrap();
		eprintln!("pattern: '{s}' => regex: '{regex_str}'");

		pattern
	}

	#[test]
	fn test_extglob_or_matching() -> Result<()> {
		assert!(make_extglob("@(a|b)").exactly_matches("a")?);
		assert!(make_extglob("@(a|b)").exactly_matches("b")?);

		assert!(!make_extglob("@(a|b)").exactly_matches("")?);
		assert!(!make_extglob("@(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("@(a|b)").exactly_matches("ab")?);

		assert!(!make_extglob("@(a|b)").exactly_matches("")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("ab")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("axb")?);
		assert!(make_extglob("@(a*b|b)").exactly_matches("b")?);

		assert!(!make_extglob("@(a*b|b)").exactly_matches("a")?);

		Ok(())
	}

	#[test]
	fn test_extglob_not_matching() -> Result<()> {
		// Basic cases.
		assert!(make_extglob("!(a)").exactly_matches("")?);
		assert!(make_extglob("!(a)").exactly_matches(" ")?);
		assert!(make_extglob("!(a)").exactly_matches("x")?);
		assert!(make_extglob("!(a)").exactly_matches(" a ")?);
		assert!(make_extglob("!(a)").exactly_matches("a ")?);
		assert!(make_extglob("!(a)").exactly_matches("aa")?);
		assert!(!make_extglob("!(a)").exactly_matches("a")?);

		assert!(make_extglob("a!(a)a").exactly_matches("aa")?);
		assert!(make_extglob("a!(a)a").exactly_matches("aaaa")?);
		assert!(make_extglob("a!(a)a").exactly_matches("aba")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("a")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("aaa")?);
		assert!(!make_extglob("a!(a)a").exactly_matches("baaa")?);

		// Alternates.
		assert!(make_extglob("!(a|b)").exactly_matches("c")?);
		assert!(make_extglob("!(a|b)").exactly_matches("ab")?);
		assert!(make_extglob("!(a|b)").exactly_matches("aa")?);
		assert!(make_extglob("!(a|b)").exactly_matches("bb")?);
		assert!(!make_extglob("!(a|b)").exactly_matches("a")?);
		assert!(!make_extglob("!(a|b)").exactly_matches("b")?);

		Ok(())
	}

	#[test]
	fn test_extglob_advanced_not_matching() -> Result<()> {
		assert!(make_extglob("!(a*)").exactly_matches("b")?);
		assert!(make_extglob("!(a*)").exactly_matches("")?);
		assert!(!make_extglob("!(a*)").exactly_matches("a")?);
		assert!(!make_extglob("!(a*)").exactly_matches("abc")?);
		assert!(!make_extglob("!(a*)").exactly_matches("aabc")?);

		Ok(())
	}

	#[test]
	fn test_extglob_not_degenerate_matching() -> Result<()> {
		// Degenerate case.
		assert!(make_extglob("!()").exactly_matches("a")?);
		assert!(!make_extglob("!()").exactly_matches("")?);

		Ok(())
	}

	#[test]
	fn test_extglob_zero_or_more_matching() -> Result<()> {
		assert!(make_extglob("x*(a)x").exactly_matches("xx")?);
		assert!(make_extglob("x*(a)x").exactly_matches("xax")?);
		assert!(make_extglob("x*(a)x").exactly_matches("xaax")?);

		assert!(!make_extglob("x*(a)x").exactly_matches("x")?);
		assert!(!make_extglob("x*(a)x").exactly_matches("xa")?);
		assert!(!make_extglob("x*(a)x").exactly_matches("xxx")?);

		assert!(make_extglob("*(a|b)").exactly_matches("")?);
		assert!(make_extglob("*(a|b)").exactly_matches("a")?);
		assert!(make_extglob("*(a|b)").exactly_matches("b")?);
		assert!(make_extglob("*(a|b)").exactly_matches("aba")?);
		assert!(make_extglob("*(a|b)").exactly_matches("aaa")?);

		assert!(!make_extglob("*(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("*(a|b)").exactly_matches("ca")?);

		Ok(())
	}

	#[test]
	fn test_extglob_one_or_more_matching() -> Result<()> {
		fn make_extglob(s: &str) -> Pattern {
			Pattern::from(s).set_extended_globbing(true)
		}

		assert!(make_extglob("x+(a)x").exactly_matches("xax")?);
		assert!(make_extglob("x+(a)x").exactly_matches("xaax")?);

		assert!(!make_extglob("x+(a)x").exactly_matches("xx")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("x")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("xa")?);
		assert!(!make_extglob("x+(a)x").exactly_matches("xxx")?);

		assert!(make_extglob("+(a|b)").exactly_matches("a")?);
		assert!(make_extglob("+(a|b)").exactly_matches("b")?);
		assert!(make_extglob("+(a|b)").exactly_matches("aba")?);
		assert!(make_extglob("+(a|b)").exactly_matches("aaa")?);

		assert!(!make_extglob("+(a|b)").exactly_matches("")?);
		assert!(!make_extglob("+(a|b)").exactly_matches("c")?);
		assert!(!make_extglob("+(a|b)").exactly_matches("ca")?);

		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xaby")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xababy")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xabababy")?);
		assert!(make_extglob("+(x+(ab)y)").exactly_matches("xabababyxabababyxabababy")?);

		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xy")?);
		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xay")?);
		assert!(!make_extglob("+(x+(ab)y)").exactly_matches("xyxy")?);

		Ok(())
	}

	#[test]
	fn test_requires_expansion() {
		// Delegates to the PEG grammar; thorough coverage is in brush-parser.
		// Here we just verify the integration works.
		assert!(requires_expansion("*", false));
		assert!(requires_expansion("[abc]", false));
		assert!(!requires_expansion("]", false));
		assert!(!requires_expansion("hello", false));
		assert!(!requires_expansion("@(a)", false));
		assert!(requires_expansion("@(a)", true));
	}

	/// Extracts the `Expanded` payload from a `PatternExpansionResult`,
	/// failing the test via `anyhow::bail!` otherwise. Avoids `panic!` which
	/// is forbidden by the workspace clippy config.
	fn expect_expanded(result: PatternExpansionResult) -> Result<Vec<String>> {
		let PatternExpansionResult::Expanded(paths) = result else {
			anyhow::bail!("expected Expanded, got {result:?}");
		};
		Ok(paths)
	}

	/// Regression test for the Windows prefix-strip mismatch fix.
	///
	/// On Windows (pre-fix), `expand` would build the `prefix_to_remove`
	/// using the platform `MAIN_SEPARATOR` (`\`) while `push_path_for_pattern`
	/// appended components with `/`. The resulting mismatch made the
	/// `strip_prefix` call a no-op, so relative globs produced absolute
	/// paths. This test exercises the expansion path and verifies results
	/// are returned relative to the working directory.
	///
	/// On Unix, the same code path is exercised (both builds go through the
	/// shared `normalize_path_separators` helpers), so this test serves as a
	/// regression guard on both platforms.
	#[tokio::test]
	async fn test_relative_glob_returns_relative_paths() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let sub = scratch.path().join("sub");
		std::fs::create_dir_all(&sub)?;
		std::fs::write(sub.join("a.txt"), "")?;
		std::fs::write(sub.join("b.txt"), "")?;

		let pattern = Pattern::from("sub/*.txt").set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), scratch.path(), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;

		let mut sorted = paths.clone();
		sorted.sort();
		assert_eq!(sorted, vec!["sub/a.txt".to_string(), "sub/b.txt".to_string()]);

		// None of the results should contain the absolute scratch path.
		let scratch_str: String = scratch.path().to_string_lossy().into_owned();
		for p in &paths {
			assert!(
				!p.contains(scratch_str.as_str()),
				"result {p:?} still contains absolute working-dir prefix {scratch_str:?}"
			);
		}

		Ok(())
	}

	/// Verifies absolute-pattern expansion still works after the prefix
	/// handling changes.
	#[tokio::test]
	async fn test_absolute_glob_returns_absolute_paths() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::write(scratch.path().join("one.log"), "")?;
		std::fs::write(scratch.path().join("two.log"), "")?;

		let abs_pattern = format!("{}/*.log", scratch.path().to_string_lossy());
		// Normalize to forward slashes so the test works consistently across
		// platforms; the expander's `pattern_path_root` handles both.
		let abs_pattern = abs_pattern.replace('\\', "/");

		let pattern = Pattern::from(abs_pattern.as_str()).set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), Path::new("/"), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;

		assert_eq!(paths.len(), 2, "unexpected results: {paths:?}");
		let scratch_normalized: String = scratch.path().to_string_lossy().replace('\\', "/");
		for p in &paths {
			// Use a plain byte-level suffix check rather than `Path::extension`
			// since the results are strings and clippy flags `ends_with(".log")`
			// as potentially case-sensitive. We explicitly wrote lowercase files.
			assert!(p.as_bytes().ends_with(b".log"), "unexpected result {p:?}");
			// Should still reference the scratch directory (i.e., absolute).
			assert!(
				p.contains(scratch_normalized.as_str()),
				"absolute result {p:?} should contain {scratch_normalized:?}"
			);
		}

		Ok(())
	}

	/// Literal components after the last glob are appended to each match, never
	/// listed, so they must be checked against the filesystem as bash does: a
	/// trailing `/` keeps only directories, and `*/name` keeps only matches that
	/// contain `name`. Before the fix `ls -d DIR/*/` handed every regular file in
	/// DIR to `ls` as `file/`, one "Not a directory" error each.
	#[tokio::test]
	async fn test_literal_suffix_after_glob_must_exist() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::create_dir_all(scratch.path().join("d1"))?;
		std::fs::create_dir_all(scratch.path().join("d2"))?;
		std::fs::write(scratch.path().join("d1").join("x"), "")?;
		std::fs::write(scratch.path().join("f.md"), "")?;

		let fs = pi_vfs::Fs::native();
		let options = FilenameExpansionOptions::default();
		let expand = async |pattern: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, scratch.path(), &options)
				.await?;
			expect_expanded(result)
		};

		assert_eq!(expand("*/").await?, vec!["d1/".to_string(), "d2/".to_string()]);
		assert_eq!(expand("*/x").await?, vec!["d1/x".to_string()]);
		assert_eq!(expand("*/missing").await?, Vec::<String>::new());

		let absolute = format!("{}/*/", scratch.path().to_string_lossy().replace('\\', "/"));
		let result = Pattern::from(absolute.as_str())
			.set_extended_globbing(false)
			.expand(&fs, Path::new("/"), &options)
			.await?;
		let paths = expect_expanded(result)?;
		assert_eq!(paths.len(), 2, "only the two directories should match: {paths:?}");
		assert!(paths.iter().all(|p| !p.contains("f.md")), "a regular file matched `*/`: {paths:?}");

		// Bash tests a named tail with lstat (a dangling link still matches) and a
		// trailing `/` with stat (a link to a directory matches).
		#[cfg(unix)]
		{
			std::os::unix::fs::symlink("nowhere", scratch.path().join("d2").join("dangling"))?;
			std::os::unix::fs::symlink("d1", scratch.path().join("ld"))?;
			assert_eq!(expand("*/dangling").await?, vec!["d2/dangling".to_string()]);
			let dirs = expand("*/").await?;
			assert!(dirs.contains(&"ld/".to_string()), "a link to a directory must match `*/`: {dirs:?}");
		}

		Ok(())
	}

	/// Serves a fixed `mem://` tree: `a.md`, `b.txt`, `.hidden.md`, and
	/// `dir/c.md`.
	#[derive(Debug)]
	struct MemListing;

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for MemListing {
		async fn open(
			&self,
			_path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> std::io::Result<pi_vfs::File> {
			Err(pi_vfs::unsupported("open"))
		}

		async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			let kind = match path.to_str() {
				Some("mem://" | "mem://dir") => pi_vfs::FileKind::Dir,
				Some("mem://a.md" | "mem://b.txt" | "mem://.hidden.md" | "mem://dir/c.md") => {
					pi_vfs::FileKind::File
				},
				_ => return Err(std::io::ErrorKind::NotFound.into()),
			};
			Ok(pi_vfs::Metadata::new(
				pi_vfs::FileType::from_kind(kind),
				0,
				pi_vfs::Permissions::from_mode(0o644),
			))
		}

		async fn read_dir(&self, path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			let names: &[&str] = match path.to_str() {
				Some("mem://") => &["a.md", "b.txt", ".hidden.md", "dir"],
				Some("mem://dir") => &["c.md"],
				_ => return Err(std::io::ErrorKind::NotFound.into()),
			};
			let entries: Vec<_> = names
				.iter()
				.map(|name| {
					Ok(pi_vfs::DirEntry::new(
						pi_vfs::child_path(path, std::ffi::OsStr::new(name)),
						(*name).into(),
						None,
					))
				})
				.collect();
			Ok(pi_vfs::ReadDir::from_entries(entries))
		}
	}

	/// A glob rooted at `scheme://` lists that virtual root instead of being
	/// read as a relative `scheme:` directory, and a relative glob in a
	/// virtual working directory keeps results relative to it.
	#[tokio::test]
	async fn test_globs_expand_within_virtual_namespaces() -> Result<()> {
		let fs = pi_vfs::Fs::new(std::sync::Arc::new(MemListing));
		let options = FilenameExpansionOptions { require_dot_in_pattern_to_match_dot_files: true, ..Default::default() };
		let expand = async |pattern: &str, cwd: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, Path::new(cwd), &options)
				.await?;
			expect_expanded(result)
		};

		assert_eq!(expand("mem://*.md", "/").await?, vec!["mem://a.md".to_string()]);
		assert_eq!(expand("mem://d*/*.md", "/").await?, vec!["mem://dir/c.md".to_string()]);
		assert_eq!(expand("*.md", "mem://dir").await?, vec!["c.md".to_string()]);
		assert_eq!(expand("mem://*.none", "/").await?, Vec::<String>::new());

		// A literal tail is checked through the provider at the lexically
		// normalized path (`mem://./dir/` is asked about as `mem://dir`), and only
		// existing paths are kept; `*/` keeps only directories.
		assert_eq!(expand("mem://*/", "/").await?, vec!["mem://dir/".to_string()]);
		assert_eq!(expand("mem://*/c.md", "/").await?, vec!["mem://dir/c.md".to_string()]);
		assert_eq!(expand("mem://*/missing", "/").await?, Vec::<String>::new());
		assert_eq!(expand("*/", "mem://").await?, vec!["dir/".to_string()]);
		assert_eq!(expand("./*/", "mem://").await?, vec!["./dir/".to_string()]);

		Ok(())
	}

	#[cfg(windows)]
	#[tokio::test]
	async fn test_msys_drive_alias_glob_expands_from_drive_root() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		std::fs::write(scratch.path().join("one.txt"), "")?;
		std::fs::write(scratch.path().join("two.txt"), "")?;

		let scratch_normalized = scratch.path().to_string_lossy().replace('\\', "/");
		let Some((drive, tail)) = scratch_normalized.split_once(":/") else {
			anyhow::bail!("expected drive-qualified temp path, got {scratch_normalized:?}");
		};
		let alias_pattern = format!("/{}/{}/*.txt", drive.to_ascii_lowercase(), tail);

		let pattern = Pattern::from(alias_pattern.as_str()).set_extended_globbing(false);
		let result = pattern
			.expand(&pi_vfs::Fs::native(), Path::new("/"), &FilenameExpansionOptions::default())
			.await?;

		let paths = expect_expanded(result)?;
		assert_eq!(paths.len(), 2, "unexpected results: {paths:?}");
		for p in &paths {
			assert!(
				p.contains(scratch_normalized.as_str()),
				"alias result {p:?} should contain native scratch path {scratch_normalized:?}"
			);
		}

		Ok(())
	}

	/// Under `shopt -s globstar` a `**` component matches any number of
	/// directory levels; before this, `**` matched like `*`. Expected values are
	/// bash 5.2.21's output on the same tree. The walk lists but does not enter
	/// a symlink to a directory, and skips hidden entries unless dotglob.
	#[cfg(unix)]
	#[tokio::test]
	async fn test_globstar_matches_any_depth_like_bash() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let root = scratch.path();
		for dir in ["a1/b1/c1", "a2", "d1/sub/deep", ".hd/x2"] {
			std::fs::create_dir_all(root.join(dir))?;
		}
		for file in ["x", "a1/x", "a1/b1/x", "a1/b1/c1/y", "d1/x", "f.md", ".hf", "a1/.hx"] {
			std::fs::write(root.join(file), "")?;
		}
		std::os::unix::fs::symlink("d1", root.join("ld"))?;
		std::os::unix::fs::symlink("nowhere", root.join("dang"))?;

		let fs = pi_vfs::Fs::native();
		let expand = async |pattern: &str, globstar: bool, dotglob: bool| {
			let options = FilenameExpansionOptions {
				require_dot_in_pattern_to_match_dot_files: !dotglob,
				globstar,
				..Default::default()
			};
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, root, &options)
				.await?;
			expect_expanded(result)
		};
		let split = |expected: &str| expected.split('|').map(str::to_string).collect::<Vec<_>>();

		assert_eq!(
			expand("**", true, false).await?,
			split("a1|a1/b1|a1/b1/c1|a1/b1/c1/y|a1/b1/x|a1/x|a2|d1|d1/sub|d1/sub/deep|d1/x|dang|f.md|ld|x")
		);
		assert_eq!(
			expand("**/", true, false).await?,
			split("a1/|a1/b1/|a1/b1/c1/|a2/|d1/|d1/sub/|d1/sub/deep/|ld/")
		);
		assert_eq!(
			expand("a1/**", true, false).await?,
			split("a1/|a1/b1|a1/b1/c1|a1/b1/c1/y|a1/b1/x|a1/x")
		);
		assert_eq!(expand("a1/**/", true, false).await?, split("a1/|a1/b1/|a1/b1/c1/"));
		assert_eq!(expand("**/*.md", true, false).await?, split("f.md"));
		assert_eq!(expand("**/c1/*", true, false).await?, split("a1/b1/c1/y"));
		assert_eq!(expand("ld/**/", true, false).await?, split("ld/|ld/sub/|ld/sub/deep/"));
		// A globbed base is printed without its slash and walked even when it is
		// a symlink; a run of `**` is one walk, so `**/**` is `**`.
		assert_eq!(
			expand("*/**", true, false).await?,
			split("a1|a1/b1|a1/b1/c1|a1/b1/c1/y|a1/b1/x|a1/x|a2|d1|d1/sub|d1/sub/deep|d1/x|ld|ld/sub|ld/sub/deep|ld/x")
		);
		assert_eq!(expand("**/**", true, false).await?, expand("**", true, false).await?);
		assert_eq!(
			expand("./**/", true, false).await?,
			split("./|./a1/|./a1/b1/|./a1/b1/c1/|./a2/|./d1/|./d1/sub/|./d1/sub/deep/|./ld/")
		);
		assert_eq!(
			expand("**/", true, true).await?,
			split(".hd/|.hd/x2/|a1/|a1/b1/|a1/b1/c1/|a2/|d1/|d1/sub/|d1/sub/deep/|ld/")
		);
		// Without globstar, `**` is `*`.
		assert_eq!(expand("**", false, false).await?, split("a1|a2|d1|dang|f.md|ld|x"));
		// No match leaves the word unmatched, as bash keeps `missing/**` literal.
		assert_eq!(expand("missing/**", true, false).await?, Vec::<String>::new());

		Ok(())
	}

	/// Bash 5.2 takes every symlink to a directory that a `**` walk finds as a
	/// base for the components after it (one hop, never walked), unless
	/// everything before that `**` is `**` too. A run of `**` components acts
	/// as one, and the zero-depth match of a final `**` keeps its slash only
	/// when no earlier component is a glob. Expected values are bash 5.2.21's
	/// output on the same tree.
	#[cfg(unix)]
	#[tokio::test]
	async fn test_globstar_takes_symlinked_dirs_as_bases_like_bash() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let root = scratch.path();
		for dir in ["a1/b1", "d1/sub/deep"] {
			std::fs::create_dir_all(root.join(dir))?;
		}
		for file in ["top.rs", "a1/b1/z.rs", "d1/sub/deep/q.rs"] {
			std::fs::write(root.join(file), "")?;
		}
		std::os::unix::fs::symlink("d1", root.join("ld"))?;
		std::os::unix::fs::symlink("..", root.join("a1/lup"))?;
		std::os::unix::fs::symlink("../..", root.join("d1/sub/lback"))?;
		std::os::unix::fs::symlink("top.rs", root.join("lf"))?;
		std::os::unix::fs::symlink("nowhere", root.join("dang"))?;

		let fs = pi_vfs::Fs::native();
		let options = FilenameExpansionOptions { globstar: true, ..Default::default() };
		let expand = async |pattern: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, root, &options)
				.await?;
			expect_expanded(result)
		};
		let split = |expected: &str| expected.split('|').map(str::to_string).collect::<Vec<_>>();

		// Only `**` before the walk: links are not bases.
		assert_eq!(expand("**/*.rs").await?, split("a1/b1/z.rs|d1/sub/deep/q.rs|top.rs"));
		assert_eq!(expand("**/**/*.rs").await?, split("a1/b1/z.rs|d1/sub/deep/q.rs|top.rs"));
		// A directory before the walk: links found below it are bases too.
		assert_eq!(expand("a1/**/*.rs").await?, split("a1/b1/z.rs|a1/lup/top.rs"));
		assert_eq!(expand("a1/**/**/*.rs").await?, split("a1/b1/z.rs|a1/lup/top.rs"));
		assert_eq!(expand("ld/**/*.rs").await?, split("ld/sub/deep/q.rs|ld/sub/lback/top.rs"));
		assert_eq!(
			expand("./**/*.rs").await?,
			split("./a1/b1/z.rs|./a1/lup/top.rs|./d1/sub/deep/q.rs|./d1/sub/lback/top.rs|./top.rs")
		);
		assert_eq!(expand("**/sub/**/*.rs").await?, split("d1/sub/deep/q.rs|d1/sub/lback/top.rs"));
		assert_eq!(
			expand("*/**/*.rs").await?,
			split("a1/b1/z.rs|a1/lup/top.rs|d1/sub/deep/q.rs|d1/sub/lback/top.rs|ld/sub/deep/q.rs|ld/sub/lback/top.rs")
		);
		let absolute = root.to_string_lossy();
		assert_eq!(
			expand(&format!("{absolute}/**/*.rs")).await?,
			["a1/b1/z.rs", "a1/lup/top.rs", "d1/sub/deep/q.rs", "d1/sub/lback/top.rs", "top.rs"]
				.map(|tail| format!("{absolute}/{tail}"))
		);
		// Zero-depth spelling after a glob that is not directly before `**`.
		assert_eq!(expand("**/sub/**").await?, split("d1/sub|d1/sub/deep|d1/sub/deep/q.rs|d1/sub/lback"));
		assert_eq!(expand("a1/**/**").await?, split("a1|a1/b1|a1/b1/z.rs|a1/lup"));

		Ok(())
	}

	/// Under globstar, bash reads a run of slashes after `**` as one slash
	/// (`**//` is `**/`, `**//**` is `**/**`), and takes `**/` as the
	/// directory part of `**//x`: its bases are the directories `**/` lists,
	/// symlinks to directories included and the working directory not. Same
	/// tree as the test above; expected values are bash 5.2.21's output.
	#[cfg(unix)]
	#[tokio::test]
	async fn test_globstar_reads_doubled_slashes_like_bash() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let root = scratch.path();
		for dir in ["a1/b1", "d1/sub/deep"] {
			std::fs::create_dir_all(root.join(dir))?;
		}
		for file in ["top.rs", "a1/b1/z.rs", "d1/sub/deep/q.rs"] {
			std::fs::write(root.join(file), "")?;
		}
		std::os::unix::fs::symlink("d1", root.join("ld"))?;
		std::os::unix::fs::symlink("..", root.join("a1/lup"))?;
		std::os::unix::fs::symlink("../..", root.join("d1/sub/lback"))?;
		std::os::unix::fs::symlink("top.rs", root.join("lf"))?;
		std::os::unix::fs::symlink("nowhere", root.join("dang"))?;

		let fs = pi_vfs::Fs::native();
		let options = FilenameExpansionOptions { globstar: true, ..Default::default() };
		let expand = async |pattern: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, root, &options)
				.await?;
			expect_expanded(result)
		};
		let split = |expected: &str| expected.split('|').map(str::to_string).collect::<Vec<_>>();

		let dirs = split("a1/|a1/b1/|a1/lup/|d1/|d1/sub/|d1/sub/deep/|d1/sub/lback/|ld/");
		assert_eq!(expand("**/").await?, dirs);
		assert_eq!(expand("**//").await?, dirs);
		assert_eq!(expand("**///").await?, dirs);
		assert_eq!(expand("a1/**//").await?, split("a1/|a1/b1/|a1/lup/"));
		assert_eq!(
			expand("./**//").await?,
			split("./|./a1/|./a1/b1/|./a1/lup/|./d1/|./d1/sub/|./d1/sub/deep/|./d1/sub/lback/|./ld/")
		);
		// `**//x` searches under every directory `**/` lists: links count,
		// the working directory does not (no `top.rs`).
		let link_tree = split("a1/b1/z.rs|a1/lup/top.rs|d1/sub/deep/q.rs|d1/sub/lback/top.rs");
		assert_eq!(expand("**//*.rs").await?, link_tree);
		assert_eq!(expand("**///*.rs").await?, link_tree);
		assert_eq!(expand("**//**//*.rs").await?, link_tree);
		assert_eq!(expand("**//sub").await?, split("d1/sub|ld/sub"));
		assert_eq!(expand("**//lf").await?, split("a1/lup/lf|d1/sub/lback/lf"));
		assert_eq!(expand("a1/**//*.rs").await?, split("a1/b1/z.rs|a1/lup/top.rs"));
		// `**//**` is `**/**`.
		assert_eq!(
			expand("**//**").await?,
			split("a1|a1/b1|a1/b1/z.rs|a1/lup|d1|d1/sub|d1/sub/deep|d1/sub/deep/q.rs|d1/sub/lback|dang|ld|lf|top.rs")
		);

		Ok(())
	}

	/// Two `**` components with a component between them give overlapping bases,
	/// and bash prints one word for every way the pattern reaches a path, so a
	/// path a nested base reaches again appears again. Expected values are bash
	/// 5.2.21's output on the same tree (`LC_ALL=C`).
	#[tokio::test]
	async fn test_globstar_keeps_duplicate_matches_like_bash() -> Result<()> {
		let scratch = tempfile::tempdir()?;
		let root = scratch.path();
		std::fs::create_dir_all(root.join("b1/b2/c"))?;
		for file in ["b1/x", "b1/b2/x", "b1/b2/c/x"] {
			std::fs::write(root.join(file), "")?;
		}

		let fs = pi_vfs::Fs::native();
		let options = FilenameExpansionOptions { globstar: true, ..Default::default() };
		let expand = async |pattern: &str| {
			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, root, &options)
				.await?;
			expect_expanded(result)
		};
		let split = |expected: &str| expected.split('|').map(str::to_string).collect::<Vec<_>>();

		assert_eq!(
			expand("**/b*/**").await?,
			split("b1|b1/b2|b1/b2|b1/b2/c|b1/b2/c|b1/b2/c/x|b1/b2/c/x|b1/b2/x|b1/b2/x|b1/x")
		);
		assert_eq!(
			expand("**/b*/**/x").await?,
			split("b1/b2/c/x|b1/b2/c/x|b1/b2/x|b1/b2/x|b1/x")
		);
		assert_eq!(
			expand("**/*/**/x").await?,
			split("b1/b2/c/x|b1/b2/c/x|b1/b2/c/x|b1/b2/x|b1/b2/x|b1/x")
		);
		// A run of `**` is still one walk, so it repeats nothing.
		assert_eq!(expand("b1/**/**/x").await?, split("b1/b2/c/x|b1/b2/x|b1/x"));

		Ok(())
	}

	/// Serves `big://`, a tree ten directories wide and four deep (11,111
	/// directories), counts directory listings and path probes, and cancels
	/// `cancel` during listing number `cancel_at`.
	#[derive(Debug)]
	struct CancellingTree {
		cancel:    tokio_util::sync::CancellationToken,
		cancel_at: usize,
		listings:  std::sync::atomic::AtomicUsize,
		probes:    std::sync::atomic::AtomicUsize,
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for CancellingTree {
		async fn open(
			&self,
			_path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> std::io::Result<pi_vfs::File> {
			Err(pi_vfs::unsupported("open"))
		}

		async fn metadata(&self, _path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
			Ok(pi_vfs::Metadata::new(
				pi_vfs::FileType::from_kind(pi_vfs::FileKind::Dir),
				0,
				pi_vfs::Permissions::from_mode(0o755),
			))
		}

		async fn read_dir(&self, path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			if self.listings.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == self.cancel_at {
				self.cancel.cancel();
			}
			let depth = path
				.to_string_lossy()
				.trim_start_matches("big://")
				.split('/')
				.filter(|segment| !segment.is_empty())
				.count();
			let names: Vec<String> =
				if depth < 4 { (0..10).map(|i| format!("d{i}")).collect() } else { Vec::new() };
			let entries: Vec<_> = names
				.into_iter()
				.map(|name| {
					Ok(pi_vfs::DirEntry::new(
						pi_vfs::child_path(path, std::ffi::OsStr::new(&name)),
						name.into(),
						Some(pi_vfs::FileType::from_kind(pi_vfs::FileKind::Dir)),
					))
				})
				.collect();
			Ok(pi_vfs::ReadDir::from_entries(entries))
		}
	}

	/// Once the run is cancelled, `**` expansion stops before the next
	/// directory it lists or path it probes and reports the interrupt, in each
	/// of its phases: the walk, the listing of every walked directory for the
	/// component after `**`, and the existence check of a literal tail. Each
	/// phase reads the whole tree again (on a real disk, minutes of reads that
	/// never yield), so finishing a phase first ignores a timeout.
	#[tokio::test]
	async fn test_globstar_expansion_stops_when_cancelled() -> Result<()> {
		const DIRS: usize = 11_111;
		// (pattern, listing that cancels, listings and probes made by then)
		let cases = [
			// During the walk: the walk stops at its next directory.
			("big://**", 3, 3, 1),
			// First listing after the walk: `*` lists no second directory.
			("big://**/*", DIRS + 1, DIRS + 1, 1),
			// Last walk listing: the tail `x` is probed under no directory.
			("big://**/x", DIRS, DIRS, 1),
		];
		for (pattern, cancel_at, listings, probes) in cases {
			let cancel = tokio_util::sync::CancellationToken::new();
			let tree = std::sync::Arc::new(CancellingTree {
				cancel: cancel.clone(),
				cancel_at,
				listings: std::sync::atomic::AtomicUsize::new(0),
				probes: std::sync::atomic::AtomicUsize::new(0),
			});
			let fs = pi_vfs::Fs::new(tree.clone());
			let options =
				FilenameExpansionOptions { globstar: true, cancel: Some(cancel), ..Default::default() };

			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, Path::new("/"), &options)
				.await;

			let err = result.expect_err(&format!("`{pattern}` finished despite the cancellation"));
			assert!(matches!(err.kind(), error::ErrorKind::Interrupted), "`{pattern}`: unexpected error: {err}");
			assert_eq!(
				(
					tree.listings.load(std::sync::atomic::Ordering::SeqCst),
					tree.probes.load(std::sync::atomic::Ordering::SeqCst)
				),
				(listings, probes),
				"`{pattern}`: (listings, probes) after the cancellation"
			);
		}

		Ok(())
	}

	/// Serves `wide://`, one directory of 10,000 files, and cancels `cancel`
	/// as it hands out the listing.
	#[derive(Debug)]
	struct WideDirectory {
		cancel: tokio_util::sync::CancellationToken,
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for WideDirectory {
		async fn open(
			&self,
			_path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> std::io::Result<pi_vfs::File> {
			Err(pi_vfs::unsupported("open"))
		}

		async fn metadata(&self, _path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			Ok(pi_vfs::Metadata::new(
				pi_vfs::FileType::from_kind(pi_vfs::FileKind::Dir),
				0,
				pi_vfs::Permissions::from_mode(0o755),
			))
		}

		async fn read_dir(&self, path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			self.cancel.cancel();
			let entries: Vec<_> = (0..10_000)
				.map(|i| {
					let name = format!("f{i}");
					Ok(pi_vfs::DirEntry::new(
						pi_vfs::child_path(path, std::ffi::OsStr::new(&name)),
						name.into(),
						Some(pi_vfs::FileType::from_kind(pi_vfs::FileKind::File)),
					))
				})
				.collect();
			Ok(pi_vfs::ReadDir::from_entries(entries))
		}
	}

	/// One directory can hold millions of entries, and both the `**` walk and
	/// the listing of a component after it read them without yielding, so the
	/// cancellation has to be read per entry: a cancellation that arrives while
	/// a single directory is being consumed must still stop the expansion, even
	/// when that directory holds no subdirectory to move on to.
	#[tokio::test]
	async fn test_expansion_stops_inside_one_wide_directory() -> Result<()> {
		// `**` consumes the directory in the walk, `*` in the listing loop.
		for pattern in ["wide://**", "wide://*"] {
			let cancel = tokio_util::sync::CancellationToken::new();
			let fs = pi_vfs::Fs::new(std::sync::Arc::new(WideDirectory { cancel: cancel.clone() }));
			let options =
				FilenameExpansionOptions { globstar: true, cancel: Some(cancel), ..Default::default() };

			let result = Pattern::from(pattern)
				.set_extended_globbing(false)
				.expand(&fs, Path::new("/"), &options)
				.await;

			let err =
				result.expect_err(&format!("`{pattern}` finished despite the cancellation"));
			assert!(
				matches!(err.kind(), error::ErrorKind::Interrupted),
				"`{pattern}`: unexpected error: {err}"
			);
		}

		Ok(())
	}

	/// Serves `files://`, one directory of 10,000 files, counts the probes of
	/// those files, and cancels `cancel` on the first one.
	#[derive(Debug)]
	struct FileBases {
		cancel: tokio_util::sync::CancellationToken,
		probes: std::sync::atomic::AtomicUsize,
	}

	impl FileBases {
		fn is_root(path: &Path) -> bool {
			path.to_string_lossy().trim_start_matches("files://").trim_matches('/').is_empty()
		}
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for FileBases {
		async fn open(
			&self,
			_path: &Path,
			_options: &pi_vfs::OpenOptions,
		) -> std::io::Result<pi_vfs::File> {
			Err(pi_vfs::unsupported("open"))
		}

		async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			let kind = if Self::is_root(path) {
				pi_vfs::FileKind::Dir
			} else {
				self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
				self.cancel.cancel();
				pi_vfs::FileKind::File
			};
			Ok(pi_vfs::Metadata::new(
				pi_vfs::FileType::from_kind(kind),
				0,
				pi_vfs::Permissions::from_mode(0o644),
			))
		}

		async fn read_dir(&self, path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			let entries: Vec<_> = if Self::is_root(path) {
				(0..10_000)
					.map(|i| {
						let name = format!("f{i}");
						Ok(pi_vfs::DirEntry::new(
							pi_vfs::child_path(path, std::ffi::OsStr::new(&name)),
							name.into(),
							Some(pi_vfs::FileType::from_kind(pi_vfs::FileKind::File)),
						))
					})
					.collect()
			} else {
				Vec::new()
			};
			Ok(pi_vfs::ReadDir::from_entries(entries))
		}
	}

	/// `*/**` makes every file of a wide directory a `**` base, and each base
	/// is probed before the walk starts. None of them is a directory, so the
	/// walk never runs; the cancellation must still stop the probes.
	#[tokio::test]
	async fn test_globstar_stops_probing_bases_when_cancelled() -> Result<()> {
		let cancel = tokio_util::sync::CancellationToken::new();
		let tree = std::sync::Arc::new(FileBases {
			cancel: cancel.clone(),
			probes: std::sync::atomic::AtomicUsize::new(0),
		});
		let fs = pi_vfs::Fs::new(tree.clone());
		let options =
			FilenameExpansionOptions { globstar: true, cancel: Some(cancel), ..Default::default() };

		let result = Pattern::from("files://*/**")
			.set_extended_globbing(false)
			.expand(&fs, Path::new("/"), &options)
			.await;

		let err = result.expect_err("`files://*/**` finished despite the cancellation");
		assert!(matches!(err.kind(), error::ErrorKind::Interrupted), "unexpected error: {err}");
		assert_eq!(tree.probes.load(std::sync::atomic::Ordering::SeqCst), 1, "base probes");

		Ok(())
	}
}
