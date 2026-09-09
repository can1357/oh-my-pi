#[cfg(windows)]
use std::ffi::OsString;
use std::{
	ffi::OsStr,
	fs, io,
	path::{Component, Path, PathBuf},
};

use crate::SandboxError;

pub fn canonicalize_existing(path: &Path) -> Result<PathBuf, SandboxError> {
	fs::canonicalize(path)
		.map(normalize_firmlink)
		.map_err(|source| SandboxError::Canonicalize { path: path.to_path_buf(), source })
}

pub fn canonicalize_deny(path: &Path) -> Result<PathBuf, SandboxError> {
	if let Ok(path) = fs::canonicalize(path) {
		return Ok(normalize_firmlink(path));
	}
	let absolute = absolute_lexical(path)?;
	let mut ancestor = absolute.as_path();
	let mut tail = Vec::new();
	loop {
		if let Ok(canonical) = fs::canonicalize(ancestor) {
			let mut result = normalize_firmlink(canonical);
			for component in tail.iter().rev() {
				result.push(component);
			}
			return Ok(result);
		}
		let Some(name) = ancestor.file_name() else {
			return Err(SandboxError::InvalidDenyPath { path: path.to_path_buf() });
		};
		tail.push(name.to_owned());
		let Some(parent) = ancestor.parent() else {
			return Err(SandboxError::InvalidDenyPath { path: path.to_path_buf() });
		};
		ancestor = parent;
	}
}

pub fn absolute_lexical(path: &Path) -> Result<PathBuf, SandboxError> {
	let absolute = if path.is_absolute() {
		path.to_path_buf()
	} else {
		std::env::current_dir()
			.map_err(|source| SandboxError::Canonicalize { path: path.to_path_buf(), source })?
			.join(path)
	};
	let mut normalized = PathBuf::new();
	for component in absolute.components() {
		match component {
			Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
			Component::RootDir => normalized.push(component.as_os_str()),
			Component::CurDir => {},
			Component::ParentDir => {
				if !normalized.pop() {
					return Err(SandboxError::InvalidDenyPath { path: path.to_path_buf() });
				}
			},
			Component::Normal(name) => normalized.push(name),
		}
	}
	Ok(normalize_firmlink(normalized))
}

#[cfg(target_os = "macos")]
fn normalize_firmlink(path: PathBuf) -> PathBuf {
	for (from, to) in [("/tmp", "/private/tmp"), ("/var", "/private/var"), ("/etc", "/private/etc")]
	{
		let from = Path::new(from);
		if path == from {
			return PathBuf::from(to);
		}
		if let Ok(suffix) = path.strip_prefix(from) {
			return Path::new(to).join(suffix);
		}
	}
	path
}

#[cfg(not(target_os = "macos"))]
const fn normalize_firmlink(path: PathBuf) -> PathBuf {
	path
}

pub fn insert_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
	match paths.binary_search(&path) {
		Ok(_) => {},
		Err(index) => paths.insert(index, path),
	}
}

pub fn path_under_scope(path: &Path, scope: &Path) -> bool {
	path == scope || path.starts_with(scope)
}

pub fn path_under_any(path: &Path, scopes: &[PathBuf]) -> bool {
	scopes.iter().any(|scope| path_under_scope(path, scope))
}

pub fn resolve_program(program: &OsStr) -> Result<PathBuf, SandboxError> {
	let path = Path::new(program);
	if has_path_syntax(program) {
		return match fs::canonicalize(path) {
			Ok(path) => Ok(normalize_firmlink(path)),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(clean_explicit(path)),
			Err(source) => Err(SandboxError::Canonicalize { path: path.to_path_buf(), source }),
		};
	}
	let Some(search) = std::env::var_os("PATH") else {
		return Err(SandboxError::ExecutableNotFound { program: program.to_owned() });
	};
	for directory in std::env::split_paths(&search) {
		for candidate in executable_candidates(&directory, program) {
			if is_executable(&candidate) {
				return canonicalize_existing(&candidate);
			}
		}
	}
	Err(SandboxError::ExecutableNotFound { program: program.to_owned() })
}

fn has_path_syntax(program: &OsStr) -> bool {
	let text = program.to_string_lossy();
	text.contains('/') || text.contains('\\')
}

fn clean_explicit(path: &Path) -> PathBuf {
	let mut clean = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				clean.pop();
			},
			_ => clean.push(component.as_os_str()),
		}
	}
	clean
}

#[cfg(windows)]
fn executable_candidates(directory: &Path, program: &OsStr) -> Vec<PathBuf> {
	let direct = directory.join(program);
	if direct.extension().is_some() {
		return vec![direct];
	}
	let extensions =
		std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
	extensions
		.to_string_lossy()
		.split(';')
		.map(|extension| {
			directory
				.join(program)
				.with_extension(extension.trim_start_matches('.'))
		})
		.collect()
}

#[cfg(not(windows))]
fn executable_candidates(directory: &Path, program: &OsStr) -> [PathBuf; 1] {
	[directory.join(program)]
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt as _;

	fs::metadata(path)
		.is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
	path.is_file()
}

#[cfg(not(any(unix, windows)))]
fn is_executable(path: &Path) -> bool {
	path.is_file()
}

pub fn temp_roots() -> Vec<PathBuf> {
	let mut roots = Vec::new();
	if let Ok(path) = canonicalize_existing(&std::env::temp_dir()) {
		insert_path(&mut roots, path);
	}
	#[cfg(target_os = "linux")]
	insert_path(&mut roots, PathBuf::from("/tmp"));
	#[cfg(target_os = "macos")]
	insert_path(&mut roots, PathBuf::from("/private/tmp"));
	roots
}

pub fn os_string_bytes(value: &OsStr) -> Vec<u8> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;
		value.as_bytes().to_vec()
	}
	#[cfg(windows)]
	{
		use std::os::windows::ffi::OsStrExt as _;
		return value.encode_wide().flat_map(u16::to_le_bytes).collect();
	}
	#[cfg(not(any(unix, windows)))]
	{
		value.to_string_lossy().as_bytes().to_vec()
	}
}
