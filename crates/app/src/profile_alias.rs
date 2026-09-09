//! Idempotent shell wrapper installation for named OMP profiles.

use std::{
	env,
	path::{Path, PathBuf},
};

use omp_core::Str;
use strum::{Display, EnumString};
use thiserror::Error;

/// Supported profile wrapper shells.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, PartialEq)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ProfileShell {
	/// Bourne Again Shell.
	Bash,
	/// Z shell.
	Zsh,
	/// Fish shell.
	Fish,
	/// Windows PowerShell or PowerShell Core.
	#[strum(serialize = "powershell", serialize = "pwsh")]
	PowerShell,
}

/// Installed wrapper details.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AliasInstall {
	/// Detected shell.
	pub shell:   ProfileShell,
	/// Updated shell configuration path.
	pub path:    PathBuf,
	/// Wrapper name.
	pub name:    Str,
	/// Profile selected by the wrapper.
	pub profile: Str,
}

/// Profile wrapper installation failure.
#[derive(Debug, Error)]
pub enum AliasError {
	/// HOME is unavailable.
	#[error("HOME must be set to install a profile alias")]
	MissingHome,
	/// The launching shell is unsupported.
	#[error("unsupported shell; expected bash, zsh, fish, or PowerShell")]
	UnsupportedShell,
	/// A name is syntactically unsafe or reserved.
	#[error("invalid profile alias name `{0}`")]
	InvalidName(Str),
	/// A profile name is syntactically unsafe.
	#[error("invalid profile name `{0}`")]
	InvalidProfile(Str),
	/// A managed block has no closing marker.
	#[error("managed profile alias block for `{0}` is malformed")]
	MalformedBlock(Str),
	/// Atomic profile update failed with path and operation attribution.
	#[error(transparent)]
	Config(#[from] omp_con::ConError),
}

/// Installs or replaces one marked shell wrapper.
pub fn install(
	name: &str,
	profile: &str,
	shell: Option<ProfileShell>,
) -> Result<AliasInstall, AliasError> {
	let shell = shell.map_or_else(detect_shell, Ok)?;
	validate_name(name, shell)?;
	let profile = normalize_profile(profile)?;
	let home = env::var_os("HOME")
		.map(PathBuf::from)
		.ok_or(AliasError::MissingHome)?;
	let path = config_path(shell, &home);
	install_at(&path, shell, name, profile.as_str())?;
	Ok(AliasInstall { shell, path, name: Str::new(name), profile })
}

/// Installs into an explicit path; useful for deterministic operator tooling.
pub fn install_at(
	path: &Path,
	shell: ProfileShell,
	name: &str,
	profile: &str,
) -> Result<(), AliasError> {
	validate_name(name, shell)?;
	let profile = normalize_profile(profile)?;
	let transaction = omp_driver::cfg::ConfigFileLock::acquire(path.to_path_buf())?;
	let current = transaction.read()?.unwrap_or_default();
	let block = render(shell, name, profile.as_str());
	let updated = upsert(&current, name, &block)?;
	if updated != current {
		transaction.replace_raw(updated.as_bytes())?;
	}
	Ok(())
}

fn detect_shell() -> Result<ProfileShell, AliasError> {
	if cfg!(windows) {
		return Ok(ProfileShell::PowerShell);
	}
	let shell =
		env::var_os("SHELL").and_then(|value| PathBuf::from(value).file_stem().map(|v| v.to_owned()));
	match shell.as_deref().and_then(|value| value.to_str()) {
		Some("bash") => Ok(ProfileShell::Bash),
		Some("zsh") => Ok(ProfileShell::Zsh),
		Some("fish") => Ok(ProfileShell::Fish),
		Some("pwsh" | "powershell") => Ok(ProfileShell::PowerShell),
		_ => Err(AliasError::UnsupportedShell),
	}
}

fn config_path(shell: ProfileShell, home: &Path) -> PathBuf {
	match shell {
		ProfileShell::Bash if cfg!(target_os = "macos") => home.join(".bash_profile"),
		ProfileShell::Bash => home.join(".bashrc"),
		ProfileShell::Zsh => env::var_os("ZDOTDIR")
			.map_or_else(|| home.to_path_buf(), PathBuf::from)
			.join(".zshrc"),
		ProfileShell::Fish => env::var_os("XDG_CONFIG_HOME")
			.map_or_else(|| home.join(".config"), PathBuf::from)
			.join("fish/conf.d/omp-profiles.fish"),
		ProfileShell::PowerShell if cfg!(windows) => {
			home.join("Documents/PowerShell/Microsoft.PowerShell_profile.ps1")
		},
		ProfileShell::PowerShell => home.join(".config/powershell/Microsoft.PowerShell_profile.ps1"),
	}
}

fn normalize_profile(value: &str) -> Result<Str, AliasError> {
	match omp_core::dirs::normalize_profile_name(value) {
		Ok(Some(profile)) => Ok(profile),
		Ok(None) | Err(_) => Err(AliasError::InvalidProfile(Str::new(value))),
	}
}

fn validate_name(value: &str, shell: ProfileShell) -> Result<(), AliasError> {
	const RESERVED: &[&str] = &[
		"case", "do", "done", "else", "end", "for", "function", "if", "in", "return", "switch",
		"then", "while",
	];
	if !safe_name(value)
		|| value.eq_ignore_ascii_case("omp")
		|| RESERVED.iter().any(|word| word.eq_ignore_ascii_case(value))
	{
		return Err(AliasError::InvalidName(Str::new(value)));
	}
	if shell == ProfileShell::PowerShell && value.contains('-') {
		return Err(AliasError::InvalidName(Str::new(value)));
	}
	Ok(())
}

fn safe_name(value: &str) -> bool {
	let mut bytes = value.bytes();
	matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
		&& value.len() <= 64
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn render(shell: ProfileShell, name: &str, profile: &str) -> String {
	let start = format!("# >>> omp profile alias: {name} >>>");
	let end = format!("# <<< omp profile alias: {name} <<<");
	let body = match shell {
		ProfileShell::Bash | ProfileShell::Zsh => {
			format!("{name}() {{\n\tcommand omp --profile={profile} \"$@\"\n}}")
		},
		ProfileShell::Fish => format!(
			"function {name} --wraps omp --description 'OMP profile {profile}'\n\tcommand omp \
			 --profile={profile} $argv\nend"
		),
		ProfileShell::PowerShell => {
			format!("function {name} {{\n\t& omp --profile={profile} @args\n}}")
		},
	};
	format!("{start}\n{body}\n{end}")
}

fn upsert(current: &str, name: &str, block: &str) -> Result<String, AliasError> {
	let start = format!("# >>> omp profile alias: {name} >>>");
	let end = format!("# <<< omp profile alias: {name} <<<");
	if let Some(begin) = current.find(&start) {
		let relative_end = current[begin + start.len()..]
			.find(&end)
			.ok_or_else(|| AliasError::MalformedBlock(Str::new(name)))?;
		let after = begin + start.len() + relative_end + end.len();
		let prefix = current[..begin].trim_end();
		let suffix = current[after..].trim_start_matches(['\r', '\n']);
		return Ok(match (prefix.is_empty(), suffix.is_empty()) {
			(true, true) => format!("{block}\n"),
			(false, true) => format!("{prefix}\n\n{block}\n"),
			(true, false) => format!("{block}\n\n{suffix}"),
			(false, false) => format!("{prefix}\n\n{block}\n\n{suffix}"),
		});
	}
	let trimmed = current.trim_end();
	Ok(if trimmed.is_empty() {
		format!("{block}\n")
	} else {
		format!("{trimmed}\n\n{block}\n")
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn wrappers_are_idempotent_for_every_shell() {
		for shell in
			[ProfileShell::Bash, ProfileShell::Zsh, ProfileShell::Fish, ProfileShell::PowerShell]
		{
			let dir = tempfile::tempdir().expect("temp");
			let path = dir.path().join("profile");
			install_at(&path, shell, "omp_work", "work").expect("first");
			let first = std::fs::read_to_string(&path).expect("read");
			install_at(&path, shell, "omp_work", "work").expect("second");
			assert_eq!(std::fs::read_to_string(&path).expect("read"), first);
		}
	}

	#[test]
	fn profile_validation_matches_bootstrap_resolution() {
		assert_eq!(normalize_profile(" 2.work_profile ").unwrap().as_str(), "2.work_profile");
		for invalid in ["default", "Work", "../work", "con.txt"] {
			assert!(normalize_profile(invalid).is_err(), "{invalid}");
		}
	}

	#[test]
	fn concurrent_alias_installs_preserve_both_blocks() {
		let dir = tempfile::tempdir().expect("temp");
		let path = dir.path().join("profile");
		let first_path = path.clone();
		let first = std::thread::spawn(move || {
			install_at(&first_path, ProfileShell::Zsh, "omp_work", "work").unwrap();
		});
		let second_path = path.clone();
		let second = std::thread::spawn(move || {
			install_at(&second_path, ProfileShell::Zsh, "omp_personal", "personal").unwrap();
		});
		first.join().unwrap();
		second.join().unwrap();
		let text = std::fs::read_to_string(path).unwrap();
		assert!(text.contains("omp profile alias: omp_work"), "{text}");
		assert!(text.contains("omp profile alias: omp_personal"), "{text}");
	}
}
