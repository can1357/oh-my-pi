//! File-or-inline prompt customization resolution.

use std::{
	fs, io,
	path::{Path, PathBuf},
};

use omp_core::Str;
use thiserror::Error;

/// A prompt customization file could not be read.
#[derive(Debug, Error)]
pub enum PromptInputError {
	/// Reading an existing candidate failed for a reason other than absence or
	/// an overlong path.
	#[error("failed to read prompt input {path}")]
	Read {
		/// Candidate path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
}

/// Resolves a value as inline text or a readable file.
///
/// Values containing a newline are always inline. Missing and overlong paths
/// are treated as literal text at the command boundary.
pub fn resolve_prompt_input(input: Option<&str>) -> Result<Option<Str>, PromptInputError> {
	let Some(input) = input else {
		return Ok(None);
	};
	if input.contains('\n') {
		return Ok(Some(Str::new(input)));
	}
	match fs::read_to_string(input) {
		Ok(content) => Ok(Some(content.into())),
		Err(source) if tolerant_literal_error(&source) => Ok(Some(Str::new(input))),
		Err(source) => Err(PromptInputError::Read { path: input.into(), source }),
	}
}

/// Discovers one native Markdown prompt with project-over-user precedence.
pub fn discover_prompt_file(
	cwd: &Path,
	home: &Path,
	name: &str,
) -> Result<Option<Str>, PromptInputError> {
	for path in [cwd.join(".omp").join(name), home.join(".omp").join(name)] {
		match fs::read_to_string(&path) {
			Ok(content) => return Ok(Some(content.into())),
			Err(source) if tolerant_literal_error(&source) => {},
			Err(source) => return Err(PromptInputError::Read { path, source }),
		}
	}
	Ok(None)
}

/// Discovers one prompt only in the native user configuration root.
pub fn discover_user_prompt_file(
	cwd: &Path,
	home: &Path,
	name: &str,
) -> Result<Option<Str>, PromptInputError> {
	let _ = cwd;
	let path = home.join(".omp").join(name);
	match fs::read_to_string(&path) {
		Ok(content) if !content.trim().is_empty() => Ok(Some(content.into())),
		Ok(_) => Ok(None),
		Err(source) if tolerant_literal_error(&source) => Ok(None),
		Err(source) => Err(PromptInputError::Read { path, source }),
	}
}

/// Resolves CLI customization ahead of project/user `SYSTEM.md` discovery and
/// resolves append guidance independently.
pub fn resolve_system_inputs(
	cwd: &Path,
	home: &Path,
	custom: Option<&str>,
	append: Option<&str>,
) -> Result<(Option<Str>, Option<Str>), PromptInputError> {
	let custom = match resolve_prompt_input(custom)? {
		Some(custom) => Some(custom),
		None => discover_prompt_file(cwd, home, "SYSTEM.md")?,
	};
	let append = resolve_prompt_input(append)?;
	Ok((custom, append))
}
/// Resolves the title-generation system prompt with project-over-user
/// `TITLE_SYSTEM.md` precedence and the embedded native prompt as fallback.
pub fn resolve_title_system_prompt(cwd: &Path, home: &Path) -> Result<Str, PromptInputError> {
	Ok(discover_prompt_file(cwd, home, "TITLE_SYSTEM.md")?
		.unwrap_or_else(|| Str::new_static("Generate a concise title for this coding session.")))
}

fn tolerant_literal_error(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::NotFound || matches!(error.raw_os_error(), Some(36 | 63))
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn missing_path_is_literal_and_project_system_wins() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let home = scratch.path().join("home");
		let project = scratch.path().join("repo");
		fs::create_dir_all(home.join(".omp")).expect("user config directory");
		fs::create_dir_all(project.join(".omp")).expect("project config directory");
		fs::write(home.join(".omp/SYSTEM.md"), "user").expect("user system prompt");
		fs::write(project.join(".omp/SYSTEM.md"), "project").expect("project system prompt");

		assert_eq!(
			resolve_prompt_input(Some("not-a-real-prompt-file"))
				.expect("literal fallback")
				.as_deref(),
			Some("not-a-real-prompt-file")
		);
		assert_eq!(
			discover_prompt_file(&project, &home, "SYSTEM.md")
				.expect("system discovery")
				.as_deref(),
			Some("project")
		);
		assert_eq!(
			resolve_title_system_prompt(&project, &home)
				.expect("embedded title prompt fallback")
				.as_str(),
			"Generate a concise title for this coding session."
		);

		fs::write(project.join(".omp/TITLE_SYSTEM.md"), "project title")
			.expect("project title system prompt");
		assert_eq!(
			resolve_title_system_prompt(&project, &home)
				.expect("project title prompt")
				.as_str(),
			"project title"
		);
	}
}
