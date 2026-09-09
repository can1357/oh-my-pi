//! External editor resolution and safe temporary-draft round trips.

use std::{
	env,
	fs::{self, File, OpenOptions},
	io,
	io::{Read as _, Write as _},
	path::{Path, PathBuf},
	process::{Command, ExitStatus, Stdio},
};

use thiserror::Error;

/// External editor launch options.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EditorOptions<'a> {
	/// Temporary-file extension, including or excluding the leading dot.
	pub extension:             &'a str,
	/// Remove one terminal newline from the successful edited draft.
	pub trim_trailing_newline: bool,
}

impl Default for EditorOptions<'_> {
	fn default() -> Self {
		Self { extension: "md", trim_trailing_newline: true }
	}
}

/// Failure to resolve or run an external editor.
#[derive(Debug, Error)]
pub enum EditorError {
	/// No POSIX editor is configured in `VISUAL` or `EDITOR`.
	#[error("No editor configured. Set $VISUAL or $EDITOR environment variable.")]
	NotConfigured,
	/// Temporary extension contains a path separator or unsupported character.
	#[error("external editor temporary extension is invalid")]
	InvalidExtension,
	/// Unique temporary draft names were exhausted.
	#[error("external editor could not allocate a temporary draft in {directory}")]
	TemporaryNameExhausted {
		/// Directory in which drafts were attempted.
		directory: PathBuf,
	},
	/// Temporary draft creation failed.
	#[error("external editor could not create temporary draft {path}: {source}")]
	TemporaryCreate {
		/// Draft path.
		path:   PathBuf,
		/// Underlying operating-system failure.
		#[source]
		source: io::Error,
	},
	/// Writing the initial draft failed.
	#[error("external editor could not write temporary draft {path}: {source}")]
	DraftWrite {
		/// Draft path.
		path:   PathBuf,
		/// Underlying operating-system failure.
		#[source]
		source: io::Error,
	},
	/// Syncing the initial draft failed.
	#[error("external editor could not sync temporary draft {path}: {source}")]
	DraftSync {
		/// Draft path.
		path:   PathBuf,
		/// Underlying operating-system failure.
		#[source]
		source: io::Error,
	},
	/// Starting or waiting for the configured editor failed.
	#[error("external editor command failed to launch ({command}): {source}")]
	Launch {
		/// Configured editor command line.
		command: omp_core::Str,
		/// Underlying operating-system failure.
		#[source]
		source:  io::Error,
	},
	/// Reopening the edited draft failed.
	#[error("external editor could not reopen temporary draft {path}: {source}")]
	DraftReopen {
		/// Draft path.
		path:   PathBuf,
		/// Underlying operating-system failure.
		#[source]
		source: io::Error,
	},
	/// Reading the edited draft failed.
	#[error("external editor could not read temporary draft {path}: {source}")]
	DraftRead {
		/// Draft path.
		path:   PathBuf,
		/// Underlying operating-system failure.
		#[source]
		source: io::Error,
	},
}

/// Resolves `VISUAL`, then `EDITOR`, then Windows' baseline editor.
///
/// Environment values are trimmed and otherwise handed verbatim to the
/// user's shell: `code --wait`, `emacsclient -nw -a ""`,
/// a shell function, or `$MY_EDITOR` all work exactly as they do from git.
/// POSIX deliberately has no fallback: launching `vi` unexpectedly would
/// consume the user's terminal when they have not configured this feature.
pub fn resolve_editor_command() -> Option<String> {
	resolve_editor_command_from(
		env::var("VISUAL").ok().as_deref(),
		env::var("EDITOR").ok().as_deref(),
	)
}

/// Deterministic resolution helper used by settings and tests.
pub fn resolve_editor_command_from(visual: Option<&str>, editor: Option<&str>) -> Option<String> {
	visual
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.or_else(|| editor.map(str::trim).filter(|value| !value.is_empty()))
		.or_else(|| cfg!(windows).then_some("notepad"))
		.map(str::to_owned)
}

/// Resolves the editor before the host releases terminal ownership.
pub(crate) fn configured_editor_command() -> Result<omp_core::Str, EditorError> {
	resolve_editor_command()
		.map(omp_core::Str::new)
		.ok_or(EditorError::NotConfigured)
}

/// Opens a draft after the caller has restored terminal modes.
///
/// Terminal ownership has one lifecycle owner: [`crate::host::Host`] leaves
/// before calling this function and reconstructs after it returns. Keeping
/// that boundary outside the editor runner guarantees every launch, child
/// exit, and read failure follows the same terminal restoration path.
pub fn edit_draft(
	editor: &str,
	content: &str,
	options: EditorOptions<'_>,
) -> Result<Option<String>, EditorError> {
	let mut draft = prepared_draft(content, options.extension)?;
	let status = launch_editor(editor, draft.path())?;
	finish_draft(&mut draft, status, options.trim_trailing_newline)
}

fn prepared_draft(content: &str, extension: &str) -> Result<DraftFile, EditorError> {
	let mut draft = DraftFile::create(extension)?;
	draft.write_all(content.as_bytes())?;
	Ok(draft)
}

/// The configured command line runs through
/// the platform shell with the draft path appended as a quoted positional,
/// never re-split by us — `sh -c '<editor> "$1"' sh <draft>` on POSIX,
/// `cmd.exe /d /s /c "<editor> "<draft>""` on Windows.
fn launch_editor(editor: &str, path: &Path) -> Result<ExitStatus, EditorError> {
	let mut child = shell_command(editor, path);
	child
		.stdin(Stdio::inherit())
		.stdout(Stdio::inherit())
		.stderr(Stdio::inherit());
	child
		.status()
		.map_err(|source| EditorError::Launch { command: omp_core::Str::new(editor), source })
}

#[cfg(not(windows))]
fn shell_command(editor: &str, path: &Path) -> Command {
	let mut command = Command::new("sh");
	command
		.arg("-c")
		.arg(format!("{editor} \"$1\""))
		.arg("sh")
		.arg(path);
	command
}

#[cfg(windows)]
fn shell_command(editor: &str, path: &Path) -> Command {
	use std::os::windows::process::CommandExt as _;
	let mut command = Command::new("cmd.exe");
	// `/s` strips the outer quote pair; the embedded editor and path quotes
	// must reach cmd.exe verbatim instead of being argv-escaped.
	command
		.args(["/d", "/s", "/c"])
		.raw_arg(format!("\"{editor} \"{}\"\"", path.display()));
	command
}

fn finish_draft(
	draft: &mut DraftFile,
	status: ExitStatus,
	trim_trailing_newline: bool,
) -> Result<Option<String>, EditorError> {
	if !status.success() {
		return Ok(None);
	}
	let mut edited = draft.read_to_string()?;
	if trim_trailing_newline && edited.ends_with('\n') {
		edited.pop();
	}
	Ok(Some(edited))
}

#[must_use]
struct DraftFile {
	path: PathBuf,
	file: File,
}

impl DraftFile {
	fn create(extension: &str) -> Result<Self, EditorError> {
		let extension = extension.trim().trim_start_matches('.');
		if extension.is_empty()
			|| extension.split('.').any(|segment| {
				segment.is_empty()
					|| !segment
						.bytes()
						.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
			}) {
			return Err(EditorError::InvalidExtension);
		}
		let directory = env::temp_dir();
		for _ in 0..16 {
			let path =
				directory.join(format!("omp-editor-{}.{}", omp_core::Ulid::generate(), extension));
			let mut options = OpenOptions::new();
			options.write(true).read(true).create_new(true);
			#[cfg(unix)]
			{
				use std::os::unix::fs::OpenOptionsExt as _;
				options.mode(0o600);
			}
			match options.open(&path) {
				Ok(file) => return Ok(Self { path, file }),
				Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
				Err(source) => return Err(EditorError::TemporaryCreate { path, source }),
			}
		}
		Err(EditorError::TemporaryNameExhausted { directory })
	}

	fn path(&self) -> &Path {
		&self.path
	}

	fn write_all(&mut self, bytes: &[u8]) -> Result<(), EditorError> {
		self
			.file
			.write_all(bytes)
			.map_err(|source| EditorError::DraftWrite { path: self.path.clone(), source })?;
		self
			.file
			.sync_all()
			.map_err(|source| EditorError::DraftSync { path: self.path.clone(), source })
	}

	fn read_to_string(&mut self) -> Result<String, EditorError> {
		self.file = File::open(&self.path)
			.map_err(|source| EditorError::DraftReopen { path: self.path.clone(), source })?;
		let mut output = String::new();
		self
			.file
			.read_to_string(&mut output)
			.map_err(|source| EditorError::DraftRead { path: self.path.clone(), source })?;
		Ok(output)
	}
}

impl Drop for DraftFile {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.path);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn resolution_prefers_visual_then_editor_then_windows_default() {
		assert_eq!(
			resolve_editor_command_from(Some(" code --wait "), Some("vim")).as_deref(),
			Some("code --wait")
		);
		assert_eq!(resolve_editor_command_from(Some(" "), Some("vim")).as_deref(), Some("vim"));
		assert_eq!(
			resolve_editor_command_from(None, None).as_deref(),
			cfg!(windows).then_some("notepad")
		);
	}

	#[test]
	fn omp_markdown_suffix_is_accepted_and_temporary_draft_is_removed() {
		let draft = DraftFile::create(".omp.md").expect("multi-segment extension");
		let path = draft.path().to_owned();
		assert!(path.to_string_lossy().ends_with(".omp.md"));
		assert!(path.exists());
		drop(draft);
		assert!(!path.exists(), "draft teardown removes the temporary file");

		for extension in ["", ".", "..", "../md", "omp/.md", "omp..md"] {
			assert!(
				matches!(DraftFile::create(extension), Err(EditorError::InvalidExtension)),
				"unsafe extension accepted: {extension:?}"
			);
		}
	}

	#[cfg(unix)]
	#[test]
	fn successful_round_trip_replaces_draft_and_trims_one_newline() {
		use std::os::unix::fs::PermissionsExt as _;
		let directory = tempfile::tempdir().unwrap();
		let executable = directory.path().join("editor");
		fs::write(&executable, "#!/bin/sh\nprintf 'edited\\n' > \"$1\"\n").unwrap();
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
		let editor = executable.to_string_lossy().into_owned();
		let result = edit_draft(&editor, "initial", EditorOptions::default()).unwrap();
		assert_eq!(result.as_deref(), Some("edited"));
	}

	#[cfg(unix)]
	#[test]
	fn deleted_editor_draft_returns_a_typed_read_failure() {
		let error = edit_draft("rm", "draft", EditorOptions {
			extension:             "omp.md",
			trim_trailing_newline: true,
		})
		.expect_err("editor removed its draft");
		assert!(matches!(error, EditorError::DraftReopen { .. }));
	}

	/// `$EDITOR` is a shell command line, not
	/// argv — environment expansion, quoting, and operators all belong to
	/// `sh`, and the draft path arrives as the quoted `"$1"` positional even
	/// when it contains spaces.
	#[cfg(unix)]
	#[test]
	fn editor_command_runs_through_the_posix_shell() {
		let directory = tempfile::tempdir().unwrap();
		let log = directory.path().join("seen args");
		let editor = format!(
			concat!(
				"omp_editor_probe() {{ OMP_EDITOR_PROBE=1; ",
				"printf '%s\n' \"$OMP_EDITOR_PROBE\" 'two words' > '{}'; }}; omp_editor_probe"
			),
			log.display()
		);
		let result = edit_draft(&editor, "kept", EditorOptions::default()).unwrap();
		assert_eq!(result.as_deref(), Some("kept"), "the draft survives an editor that leaves it");
		assert_eq!(fs::read_to_string(&log).unwrap(), "1\ntwo words\n");

		let editor = format!("cp \"$1\" '{}' && printf 'replaced\\n' >", log.display());
		let result = edit_draft(&editor, "draft body", EditorOptions::default()).unwrap();
		assert_eq!(result.as_deref(), Some("replaced"), "`\"$1\"` is the draft path");
		assert_eq!(fs::read_to_string(&log).unwrap(), "draft body");

		let failing = edit_draft("false", "draft", EditorOptions::default());
		assert!(
			matches!(failing, Ok(None)),
			"a non-zero shell exit keeps the original draft: {failing:?}"
		);
	}
}
