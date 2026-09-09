//! Canonical native storage roots and the owner's private data directory.
//!
//! Configuration lives in the owner's `~/.o2` directory (`OMP_CONFIG_DIR`
//! overrides it; see [`config_dir`]); mutable application data is split by
//! XDG purpose so caches can be discarded without losing durable state.
//!
//! ```no_run
//! let data = omp_core::dirs::data_dir(None)?;
//! # Ok::<_, omp_core::dirs::DataDirError>(())
//! ```

use std::{
	env,
	ffi::OsStr,
	path::{Path, PathBuf},
	sync::OnceLock,
};

use thiserror::Error;

use crate::Str;

/// Canonical native storage roots.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeDirectories {
	/// Durable application data.
	pub data:  PathBuf,
	/// Durable runtime state.
	pub state: PathBuf,
	/// Re-creatable downloaded and derived data.
	pub cache: PathBuf,
}

/// Resolves the canonical native data, state, and cache roots.
///
/// Explicit OMP variables win. Otherwise the corresponding XDG variable is
/// used, followed by the XDG home-relative default.
#[must_use]
pub fn native_directories(home: &Path) -> NativeDirectories {
	fn root(omp: &str, xdg: &str, fallback: &Path) -> PathBuf {
		env::var_os(omp)
			.filter(|value| !value.is_empty())
			.map(PathBuf::from)
			.or_else(|| {
				env::var_os(xdg)
					.filter(|value| !value.is_empty())
					.map(|value| PathBuf::from(value).join("omp"))
			})
			.unwrap_or_else(|| fallback.join("omp"))
	}
	NativeDirectories {
		data:  root("OMP_DATA_DIR", "XDG_DATA_HOME", &home.join(".local/share")),
		state: root("OMP_STATE_DIR", "XDG_STATE_HOME", &home.join(".local/state")),
		cache: root("OMP_CACHE_DIR", "XDG_CACHE_HOME", &home.join(".cache")),
	}
}

static SELECTED_PROFILE: OnceLock<Option<Str>> = OnceLock::new();
/// Returns the process owner's home directory from the platform environment.
///
/// `HOME` is preferred for Unix-compatible environments. `USERPROFILE`
/// provides the native Windows fallback.
pub fn home_dir() -> Option<PathBuf> {
	env::var_os("HOME")
		.filter(|value| !value.is_empty())
		.or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
		.map(PathBuf::from)
}

/// Publishes the bootstrap-selected profile without mutating the environment.
///
/// The first call wins; later calls are ignored so every consumer observes one
/// immutable process-wide selection. `Some(None)` in the cell is meaningful:
/// an explicit `--profile default` outranks `OMP_PROFILE`.
pub fn set_selected_profile(profile: Option<Str>) {
	let _ = SELECTED_PROFILE.set(profile);
}

/// Returns the bootstrap-selected profile, if one was published.
#[must_use]
pub fn selected_profile() -> Option<&'static str> {
	SELECTED_PROFILE
		.get()
		.and_then(|profile| profile.as_deref())
}

/// Default configuration directory name under the owner's home.
///
/// Pinned by the owner: user configuration (`config.cfg`, agent assets, cfg
/// scripts) lives in `~/.o2`, never in the data or XDG config roots.
pub const CONFIG_DIR_NAME: &str = ".o2";

/// Resolves the owner's configuration directory.
///
/// `OMP_CONFIG_DIR` wins when set and non-empty; otherwise `<home>/.o2`.
#[must_use]
pub fn config_dir(home: &Path) -> PathBuf {
	env::var_os("OMP_CONFIG_DIR")
		.filter(|value| !value.is_empty())
		.map_or_else(|| home.join(CONFIG_DIR_NAME), PathBuf::from)
}

/// Invalid profile selection.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ProfileNameError {
	/// Profile text is not portable or could escape the profile root.
	#[error(
		"invalid OMP profile `{profile}`; expected `default` or 1-64 lowercase ASCII letters, \
		 digits, dots, underscores, or dashes, starting with a letter or digit"
	)]
	Invalid {
		/// Rejected profile text.
		profile: Str,
	},
	/// `OMP_PROFILE` was not Unicode.
	#[error("OMP_PROFILE must be valid Unicode")]
	NonUnicode,
}

/// Normalizes one profile selector.
///
/// Empty input and `default` select the base `~/.o2` root. Named profiles are
/// portable path components and can never escape `~/.o2/profiles`.
pub fn normalize_profile_name(profile: &str) -> Result<Option<Str>, ProfileNameError> {
	let profile = profile.trim();
	if profile.is_empty() || profile == "default" {
		return Ok(None);
	}
	let valid = profile.len() <= 64
		&& profile
			.bytes()
			.next()
			.is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
		&& profile.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
		});
	let basename = profile
		.split_once('.')
		.map_or(profile, |(basename, _)| basename);
	let reserved =
		matches!(
			basename.to_ascii_lowercase().as_str(),
			"con"
				| "prn" | "aux"
				| "nul" | "com0"
				| "com1" | "com2"
				| "com3" | "com4"
				| "com5" | "com6"
				| "com7" | "com8"
				| "com9" | "lpt0"
				| "lpt1" | "lpt2"
				| "lpt3" | "lpt4"
				| "lpt5" | "lpt6"
				| "lpt7" | "lpt8"
				| "lpt9"
		);
	if !valid || profile == "." || profile == ".." || profile.ends_with('.') || reserved {
		Err(ProfileNameError::Invalid { profile: Str::new(profile) })
	} else {
		Ok(Some(Str::new(profile)))
	}
}

fn resolve_profile(
	selected: Option<&Option<Str>>,
	environment: Option<&OsStr>,
) -> Result<Option<Str>, ProfileNameError> {
	if let Some(selected) = selected {
		return Ok(selected.clone());
	}
	match environment {
		Some(value) => value
			.to_str()
			.ok_or(ProfileNameError::NonUnicode)
			.and_then(normalize_profile_name),
		None => Ok(None),
	}
}

/// Resolves the configuration root the selected profile reads and writes:
/// [`config_dir`] itself, or `<config dir>/profiles/<profile>` once a
/// profile was published via [`set_selected_profile`] (or `OMP_PROFILE`).
///
/// `config.cfg`, cfg scripts (`subagent.cfg`, `<agent>.cfg`, profiles run
/// through `exec`), and the `agent/` asset tree all live under this root, so
/// `--profile work` selects its own configuration, not only its own data.
///
/// # Errors
///
/// Returns [`ProfileNameError`] when an unbootstrapped `OMP_PROFILE` is not a
/// valid contained profile component.
pub fn profile_config_dir(home: &Path) -> Result<PathBuf, ProfileNameError> {
	let base = config_dir(home);
	Ok(match resolve_profile(SELECTED_PROFILE.get(), env::var_os("OMP_PROFILE").as_deref())? {
		Some(profile) => base.join("profiles").join(profile.as_str()),
		None => base,
	})
}

/// [`profile_config_dir`] rooted at the process home directory.
///
/// # Errors
///
/// Returns an error when no home directory is set or the selected profile is
/// invalid.
pub fn user_config_root() -> Result<PathBuf, DataDirError> {
	let home = home_dir().ok_or(DataDirError::HomeUnset)?;
	Ok(profile_config_dir(&home)?)
}

/// Failure to resolve the owner's private data directory.
#[derive(Clone, Debug, Error)]
pub enum DataDirError {
	/// Neither an explicit path, `OMP_DATA_DIR`, `HOME`, nor `USERPROFILE` was
	/// available.
	#[error("HOME, USERPROFILE, or OMP_DATA_DIR must be set")]
	HomeUnset,
	/// Profile selection was invalid.
	#[error(transparent)]
	Profile(#[from] ProfileNameError),
}

/// Resolves the owner's private data directory, honoring the selected profile.
///
/// An `explicit` path is used verbatim. Otherwise `OMP_DATA_DIR` wins, then the
/// XDG data root; a selected profile appends `profiles/<profile>`.
///
/// # Errors
///
/// Returns an error when no root can be derived or the selected profile is
/// invalid.
pub fn data_dir(explicit: Option<PathBuf>) -> Result<PathBuf, DataDirError> {
	if let Some(path) = explicit {
		return Ok(path);
	}
	let base = if let Some(path) = env::var_os("OMP_DATA_DIR").filter(|value| !value.is_empty()) {
		PathBuf::from(path)
	} else {
		let home = home_dir().ok_or(DataDirError::HomeUnset)?;
		native_directories(&home).data
	};
	Ok(match resolve_profile(SELECTED_PROFILE.get(), env::var_os("OMP_PROFILE").as_deref())? {
		Some(profile) => base.join("profiles").join(profile.as_str()),
		None => base,
	})
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsStr, path::Path};

	use super::{CONFIG_DIR_NAME, config_dir, normalize_profile_name, resolve_profile};

	#[test]
	fn config_dir_defaults_to_dot_o2_under_home() {
		// The env override is process-global; this test only asserts the
		// pinned default when it is absent.
		if std::env::var_os("OMP_CONFIG_DIR").is_some_and(|value| !value.is_empty()) {
			return;
		}
		assert_eq!(CONFIG_DIR_NAME, ".o2");
		assert_eq!(config_dir(Path::new("/home/owner")), Path::new("/home/owner/.o2"));
	}

	#[test]
	fn profile_names_are_contained_portable_components() {
		assert_eq!(normalize_profile_name(" default ").unwrap(), None);
		assert_eq!(normalize_profile_name("work_2").unwrap().as_deref(), Some("work_2"));
		for invalid in ["../work", "Work", "con.txt", "trail.", "has/slash", ""] {
			if invalid.is_empty() {
				assert_eq!(normalize_profile_name(invalid).unwrap(), None);
			} else {
				assert!(normalize_profile_name(invalid).is_err(), "{invalid}");
			}
		}
	}

	#[test]
	fn explicit_default_profile_outranks_the_environment() {
		let selected = None;
		assert_eq!(resolve_profile(Some(&selected), Some(OsStr::new("work"))).unwrap(), None);
		assert_eq!(
			resolve_profile(None, Some(OsStr::new("work")))
				.unwrap()
				.as_deref(),
			Some("work")
		);
	}
}
