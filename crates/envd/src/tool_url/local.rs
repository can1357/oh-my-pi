//! Session-local scratch resource resolver.

use std::{
	ffi, fs, io,
	path::{self, Component, Path, PathBuf},
	str,
	sync::Arc,
};

use omp_core::{CowBytes, FastHashMap, Str};
use omp_tools::read::{
	Fault,
	image::MAX_IMAGE_INPUT_BYTES,
	resolver::{
		LineOffsetCache, Resolve, ResourceCompletion, ResourceEntry, ResourceList, fuzzy_score,
	},
	selector::ParsedSelector,
};
use parking_lot::Mutex;
use url::Url;

const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const SNIFF_BYTES: usize = 8 * 1024;
/// Returns the confined scratch root for one stable session identity.
///
/// Ordinary ULID/session identifiers remain human-readable. Identities with
/// path syntax are mapped to a deterministic digest so they cannot escape the
/// project sessions directory.
pub(crate) fn session_local_root(sessions_dir: &Path, session_id: &str) -> PathBuf {
	let component = if !session_id.is_empty()
		&& session_id
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
	{
		session_id.to_owned()
	} else {
		omp_core::Hash32::sum(session_id.as_bytes())
			.to_hex()
			.to_string()
	};
	sessions_dir.join(component).join("local")
}

/// Copies session-local artifacts across a session handoff.
///
/// Only regular files and directories are migrated; symbolic links and other
/// filesystem objects are ignored rather than followed.
pub(crate) fn migrate_session_artifacts(
	sessions_dir: &Path,
	source_session: &str,
	destination_session: &str,
) -> Result<(), io::Error> {
	if source_session == destination_session {
		return Ok(());
	}
	let source = session_local_root(sessions_dir, source_session);
	let destination = session_local_root(sessions_dir, destination_session);
	match fs::symlink_metadata(&source) {
		Ok(metadata) if metadata.file_type().is_dir() => {},
		Ok(_) => return Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error),
	}
	fs::create_dir_all(&destination)?;
	copy_artifact_entries(&source, &destination)
}

fn copy_artifact_entries(source: &Path, destination: &Path) -> Result<(), io::Error> {
	for entry in fs::read_dir(source)? {
		let entry = entry?;
		let file_type = entry.file_type()?;
		let destination = destination.join(entry.file_name());
		if file_type.is_dir() {
			if destination.exists() && !fs::symlink_metadata(&destination)?.file_type().is_dir() {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					"local artifact destination collides with a non-directory",
				));
			}
			fs::create_dir_all(&destination)?;
			copy_artifact_entries(&entry.path(), &destination)?;
		} else if file_type.is_file() {
			if destination.exists() && fs::symlink_metadata(&destination)?.file_type().is_symlink() {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					"local artifact destination is a symbolic link",
				));
			}
			fs::copy(entry.path(), destination)?;
		}
	}
	Ok(())
}

/// Confined resolver for one session's local scratch root.
#[derive(Debug)]
pub(crate) struct LocalResolver {
	sessions_dir: PathBuf,
	roots:        Mutex<FastHashMap<Str, Arc<SessionRoot>>>,
}

#[derive(Debug)]
struct SessionRoot {
	path:  PathBuf,
	lines: LineOffsetCache,
}

impl LocalResolver {
	pub(super) fn open(sessions_dir: PathBuf) -> Result<Self, io::Error> {
		fs::create_dir_all(&sessions_dir)?;
		let sessions_dir = fs::canonicalize(sessions_dir)?;
		Ok(Self { sessions_dir, roots: Mutex::new(FastHashMap::default()) })
	}

	fn session_root(&self) -> Result<Arc<SessionRoot>, Fault> {
		let session_id = crate::tools::invocation_session_id().ok_or(Fault::Invalid {
			message: Str::new_static("session-scoped URL requires a session principal"),
		})?;
		let cached = self.roots.lock().get(&session_id).cloned();
		if let Some(root) = cached {
			return Ok(root);
		}

		let root = session_local_root(&self.sessions_dir, &session_id);
		fs::create_dir_all(&root).map_err(io_fault)?;
		let path = fs::canonicalize(root).map_err(io_fault)?;
		if !path.starts_with(&self.sessions_dir) {
			return Err(Fault::Invalid {
				message: Str::new_static("session local root escapes the sessions directory"),
			});
		}
		let root = Arc::new(SessionRoot { path, lines: LineOffsetCache::default() });
		let mut roots = self.roots.lock();
		Ok(Arc::clone(roots.entry(session_id).or_insert_with(|| Arc::clone(&root))))
	}

	fn target(&self, resource: &str) -> Result<(Arc<SessionRoot>, PathBuf), Fault> {
		let root = self.session_root()?;
		let relative = decode_relative(resource)?;
		let candidate = root.path.join(&relative);
		let canonical = fs::canonicalize(&candidate).map_err(|source| Fault::Source {
			message: Str::new(format!(
				"Local resource '{}' cannot be resolved: {source}",
				relative.display()
			)),
		})?;
		if !canonical.starts_with(&root.path) {
			return Err(Fault::Invalid {
				message: Str::new_static("local:// path escapes the session scratch root."),
			});
		}
		Ok((root, canonical))
	}

	fn entries(root: &Path, directory: &Path) -> Result<Vec<ResourceEntry>, Fault> {
		let mut entries = Vec::new();
		for entry in fs::read_dir(directory).map_err(io_fault)? {
			let entry = entry.map_err(io_fault)?;
			let path = entry.path();
			let canonical = fs::canonicalize(&path).map_err(io_fault)?;
			if !canonical.starts_with(root) {
				continue;
			}
			let metadata = fs::metadata(&canonical).map_err(io_fault)?;
			if !metadata.is_file() && !metadata.is_dir() {
				continue;
			}
			let relative = canonical
				.strip_prefix(root)
				.expect("contained local path")
				.to_string_lossy()
				.replace(path::MAIN_SEPARATOR, "/");
			let directory = metadata.is_dir();
			let name = entry.file_name().to_string_lossy().into_owned();
			entries.push(ResourceEntry {
				uri: Str::new(format!("local://{}{}", relative, if directory { "/" } else { "" })),
				name: Str::new(name),
				directory,
				size: if directory { 0 } else { metadata.len() },
			});
		}
		entries.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		Ok(entries)
	}

	fn completion_files(root: &Path) -> Result<Vec<(Str, Str)>, Fault> {
		let mut pending = vec![root.to_path_buf()];
		let mut output = Vec::new();
		while let Some(directory) = pending.pop() {
			for entry in fs::read_dir(&directory).map_err(io_fault)? {
				let entry = entry.map_err(io_fault)?;
				let canonical = fs::canonicalize(entry.path()).map_err(io_fault)?;
				if !canonical.starts_with(root) {
					continue;
				}
				let metadata = fs::metadata(&canonical).map_err(io_fault)?;
				if metadata.is_dir() {
					pending.push(canonical);
				} else if metadata.is_file() {
					let relative = canonical
						.strip_prefix(root)
						.expect("contained local path")
						.to_string_lossy()
						.replace(path::MAIN_SEPARATOR, "/");
					output.push((Str::new(format!("local://{relative}")), Str::new(relative)));
				}
			}
		}
		output.sort_unstable_by(|left, right| left.0.cmp(&right.0));
		Ok(output)
	}
}

impl Resolve for LocalResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		use super::select_bytes;
		let (root, target) = self.target(resource)?;
		let metadata = fs::metadata(&target).map_err(io_fault)?;
		if metadata.is_dir() {
			let entries = Self::entries(&root.path, &target)?;
			let mut output = String::from("# Local\n\n");
			if entries.is_empty() {
				output.push_str("(empty)\n");
			} else {
				for entry in entries {
					output.push_str("- [");
					output.push_str(&entry.name);
					if entry.directory {
						output.push('/');
					}
					output.push_str("](");
					output.push_str(&entry.uri);
					output.push_str(")\n");
				}
			}
			return Ok(CowBytes::from(output.into_bytes()));
		}
		if !metadata.is_file() {
			return Err(Fault::Invalid {
				message: Str::new_static("local:// resources must be regular files or directories."),
			});
		}
		let image = matches!(selector, ParsedSelector::Image);
		if !image && known_binary(&target) {
			return Err(binary_fault(resource));
		}
		let byte_limit = if image {
			MAX_IMAGE_INPUT_BYTES as u64
		} else {
			MAX_TEXT_BYTES
		};
		if metadata.len() > byte_limit
			&& matches!(selector, ParsedSelector::None | ParsedSelector::Raw | ParsedSelector::Image)
		{
			return Err(Fault::Invalid {
				message: Str::new(format!(
					"local://{resource} is {} bytes; full resolution is limited to {byte_limit} bytes. \
					 Use a line selector or path-only read.",
					metadata.len()
				)),
			});
		}
		let bytes = fs::read(&target).map_err(io_fault)?;
		let sniff = &bytes[..bytes.len().min(SNIFF_BYTES)];
		if !image && (sniff.contains(&0) || str::from_utf8(sniff).is_err()) {
			return Err(binary_fault(resource));
		}
		select_bytes(&root.lines, resource, CowBytes::from(bytes), selector)
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		let (root, target) = self.target(resource)?;
		if !target.is_dir() {
			return Err(Fault::Invalid {
				message: Str::new_static("Only local:// directories can be listed."),
			});
		}
		let mut entries = Self::entries(&root.path, &target)?;
		let mut used = 0;
		let retain = entries
			.iter()
			.take(max_entries)
			.take_while(|entry| {
				let next = used + entry.uri.len() + entry.name.len();
				let keep = next <= max_bytes;
				if keep {
					used = next;
				}
				keep
			})
			.count();
		let truncated = retain < entries.len();
		entries.truncate(retain);
		Ok(ResourceList { entries, truncated })
	}

	async fn path(&self, resource: &str) -> Result<Option<Str>, Fault> {
		let (_, target) = self.target(resource)?;
		let url = Url::from_file_path(target).map_err(|()| Fault::Invalid {
			message: Str::new_static("local:// path cannot be represented as a file URI."),
		})?;
		Ok(Some(Str::new(url.as_str())))
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let root = self.session_root()?;
		let mut matches = Self::completion_files(&root.path)?
			.into_iter()
			.filter_map(|(value, relative)| {
				let score = fuzzy_score(query, &relative)?;
				Some(ResourceCompletion { value, description: relative, score })
			})
			.collect::<Vec<_>>();
		matches.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		matches.truncate(max_results);
		Ok(matches)
	}
}

fn decode_relative(resource: &str) -> Result<PathBuf, Fault> {
	let mut bytes = Vec::with_capacity(resource.len());
	let mut index = 0;
	while index < resource.len() {
		if resource.as_bytes()[index] == b'%' {
			let encoded = resource
				.as_bytes()
				.get(index + 1..index + 3)
				.ok_or_else(|| Fault::Invalid {
					message: Str::new_static("local:// path contains invalid percent encoding."),
				})?;
			let high = hex_nibble(encoded[0]).ok_or_else(|| Fault::Invalid {
				message: Str::new_static("local:// path contains invalid percent encoding."),
			})?;
			let low = hex_nibble(encoded[1]).ok_or_else(|| Fault::Invalid {
				message: Str::new_static("local:// path contains invalid percent encoding."),
			})?;
			bytes.push(high << 4 | low);
			index += 3;
		} else {
			bytes.push(resource.as_bytes()[index]);
			index += 1;
		}
	}
	let decoded = String::from_utf8(bytes).map_err(|_| Fault::Invalid {
		message: Str::new_static("local:// path contains invalid percent-encoded UTF-8."),
	})?;
	let path = Path::new(&decoded);
	if path.is_absolute()
		|| decoded.contains('\\')
		|| path
			.components()
			.any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
	{
		return Err(Fault::Invalid {
			message: Str::new_static("local:// path must be relative and cannot traverse its root."),
		});
	}
	Ok(path.to_path_buf())
}

fn hex_nibble(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn known_binary(path: &Path) -> bool {
	path
		.extension()
		.and_then(ffi::OsStr::to_str)
		.is_some_and(|extension| {
			matches!(
				extension.to_ascii_lowercase().as_str(),
				"png"
					| "jpg" | "jpeg"
					| "gif" | "webp"
					| "pdf" | "zip"
					| "gz" | "mp3"
					| "mp4" | "mov"
					| "wasm" | "sqlite"
					| "db"
			)
		})
}

fn binary_fault(resource: &str) -> Fault {
	Fault::Invalid {
		message: Str::new(format!(
			"local://{resource} is not UTF-8 text; use a metadata or media-specific workflow."
		)),
	}
}

fn io_fault(source: io::Error) -> Fault {
	Fault::Source { message: Str::new(format!("local:// I/O failed: {source}")) }
}
#[cfg(test)]
mod tests {
	use super::*;
	fn write_session_file(sessions: &Path, session_id: &str, content: &str) {
		let root = session_local_root(sessions, session_id);
		fs::create_dir_all(&root).expect("create session root");
		fs::write(root.join("shared.txt"), content).expect("write session file");
	}

	#[tokio::test]
	async fn resolution_without_a_session_principal_is_a_typed_fault() {
		let temp = tempfile::tempdir().expect("temp dir");
		let resolver = LocalResolver::open(temp.path().join("sessions")).expect("resolver");
		let fault = resolver
			.read("shared.txt", &ParsedSelector::None)
			.await
			.expect_err("unscoped local URL must fail");
		assert!(matches!(
			fault,
			Fault::Invalid { message }
				if message.as_str() == "session-scoped URL requires a session principal"
		));
	}

	#[tokio::test]
	async fn concurrent_session_scopes_resolve_independent_roots() {
		let temp = tempfile::tempdir().expect("temp dir");
		let sessions = temp.path().join("sessions");
		write_session_file(&sessions, "first", "first session");
		write_session_file(&sessions, "second", "second session");
		let resolver = LocalResolver::open(sessions).expect("resolver");
		let selector = ParsedSelector::None;

		let first = crate::tools::with_invocation_session_scope(
			Some(Str::new_static("first")),
			resolver.read("shared.txt", &selector),
		);
		let second = crate::tools::with_invocation_session_scope(
			Some(Str::new_static("second")),
			resolver.read("shared.txt", &selector),
		);
		let (first, second) = tokio::join!(first, second);
		assert_eq!(first.expect("first read").as_ref(), b"first session");
		assert_eq!(second.expect("second read").as_ref(), b"second session");
	}

	#[tokio::test]
	async fn unsafe_session_identity_is_hashed_and_resolves_inside_sessions() {
		let temp = tempfile::tempdir().expect("temp dir");
		let sessions = temp.path().join("sessions");
		let hostile = "../escape";
		write_session_file(&sessions, hostile, "confined");
		let root = session_local_root(&sessions, hostile);
		assert_eq!(root.parent().and_then(Path::parent), Some(sessions.as_path()));
		assert_ne!(root.parent().and_then(Path::file_name), Some(std::ffi::OsStr::new("escape")));

		let resolver = LocalResolver::open(sessions).expect("resolver");
		let content = crate::tools::with_invocation_session_scope(
			Some(Str::new_static(hostile)),
			resolver.read("shared.txt", &ParsedSelector::None),
		)
		.await
		.expect("scoped embedded resolution");
		assert_eq!(content.as_ref(), b"confined");
	}

	#[tokio::test]
	async fn production_local_entry_reads_scratch_files_and_rejects_escapes() {
		use omp_tools::read::resolver::{ResolverTable, Scheme};

		let temp = tempfile::tempdir().expect("temp dir");
		let sessions = temp.path().join("sessions");
		let root = session_local_root(&sessions, "scoped");
		fs::create_dir_all(&root).expect("create session root");
		fs::write(root.join("foo.md"), "# scratch\n").expect("write scratch file");
		fs::write(sessions.join("outside.md"), "leaked").expect("write outside file");

		let mut builder = ResolverTable::builder();
		builder
			.register(
				super::super::local_scheme_entry(),
				LocalResolver::open(sessions).expect("resolver"),
			)
			.expect("local registers once");
		let table = builder.build();
		let entry = table
			.entry(Scheme::Local)
			.expect("local entry is installed");
		assert!(entry.readable, "local:// must be readable");
		assert!(!entry.mintable, "local:// is never model-minted");

		let readable = crate::tools::with_invocation_session_scope(
			Some(Str::new_static("scoped")),
			table.read(Scheme::Local, "foo.md", &ParsedSelector::None),
		)
		.await
		.expect("readable entry routes to the resolver")
		.expect("scratch file resolves");
		assert_eq!(readable.as_ref(), b"# scratch\n");

		for escape in ["../outside.md", "/etc/passwd", "..%2Foutside.md", "a\\..\\outside.md"] {
			let fault = crate::tools::with_invocation_session_scope(
				Some(Str::new_static("scoped")),
				table.read(Scheme::Local, escape, &ParsedSelector::None),
			)
			.await
			.expect("readable entry routes to the resolver")
			.expect_err("escape must be rejected");
			assert!(
				matches!(
					fault,
					Fault::Invalid { ref message }
						if message.as_str()
							== "local:// path must be relative and cannot traverse its root."
				),
				"{escape}: {fault:?}"
			);
		}
	}

	#[test]
	fn session_roots_are_stable_isolated_and_confined() {
		let sessions = Path::new("/state/sessions");
		assert_eq!(session_local_root(sessions, "01TEST"), sessions.join("01TEST").join("local"));
		assert_ne!(session_local_root(sessions, "first"), session_local_root(sessions, "second"));
		let hostile = session_local_root(sessions, "../escape");
		assert!(hostile.starts_with(sessions));
		assert_eq!(hostile.parent().and_then(Path::parent), Some(sessions));
	}
}
