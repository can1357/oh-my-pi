//! Bootstrap-time extraction of profile and shell-alias flags.

use std::{env, ffi::OsString};

use omp_core::Str;
use thiserror::Error;

use super::{is_command, is_launch_command, launch_option};

/// Internal boundary marker preserving optional/string argument ownership.
pub const PROFILE_BOUNDARY: &str = "--omp-profile-boundary";

/// Result of extracting globals before strict subcommand parsing.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProfileBootstrap {
	/// Residual argv including argv[0].
	pub arguments: Vec<OsString>,
	/// Explicit profile, falling back to `OMP_PROFILE`.
	pub profile:   Option<Str>,
	/// Requested shell wrapper name.
	pub alias:     Option<Str>,
}

/// Profile bootstrap usage failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProfileBootstrapError {
	/// A global flag lacked a value.
	#[error("{0} requires a non-empty value")]
	MissingValue(&'static str),
	/// A profile name could escape its profile directory or is not portable.
	#[error(
		"Invalid OMP profile \"{profile}\". Profile names must start with a lowercase letter or \
		 digit, contain at most 64 lowercase letters, digits, dots, underscores, or dashes, cannot \
		 be \".\" or \"..\", cannot end with \".\", and cannot be a Windows reserved device name"
	)]
	InvalidProfile {
		/// Rejected operator input.
		profile: Str,
	},
	/// `OMP_PROFILE` was not Unicode.
	#[error("OMP_PROFILE must be valid Unicode")]
	NonUnicodeProfile,
}

/// Extracts global profile flags without stealing strict-subcommand arguments.
pub fn extract(
	arguments: impl IntoIterator<Item = OsString>,
) -> Result<ProfileBootstrap, ProfileBootstrapError> {
	let source = arguments.into_iter().collect::<Vec<_>>();
	let mut output = Vec::with_capacity(source.len());
	if let Some(program) = source.first() {
		output.push(program.clone());
	}
	let mut profile = None;
	let mut profile_set = false;
	let mut alias = None;
	let mut index = 1;
	let mut strict = false;
	let mut passthrough = false;
	while index < source.len() {
		let argument = &source[index];
		let text = argument.to_string_lossy();
		if strict || passthrough {
			output.push(argument.clone());
			index += 1;
			continue;
		}
		if text == "--" {
			passthrough = true;
			output.push(argument.clone());
			index += 1;
			continue;
		}
		if text == "--profile" || text == "--alias" {
			let flag = if text == "--profile" {
				"--profile"
			} else {
				"--alias"
			};
			let value = source
				.get(index + 1)
				.and_then(|value| value.to_str())
				.filter(|value| !value.is_empty() && !value.starts_with('-'))
				.ok_or(ProfileBootstrapError::MissingValue(flag))?;
			if needs_boundary(&output) {
				output.push(OsString::from(PROFILE_BOUNDARY));
			}
			if flag == "--profile" {
				profile = normalize_profile_name(value)?;
				profile_set = true;
			} else {
				alias = Some(Str::new(value));
			}
			index += 2;
			continue;
		}
		if let Some(value) = text.strip_prefix("--profile=") {
			if value.is_empty() {
				return Err(ProfileBootstrapError::MissingValue("--profile"));
			}
			profile = normalize_profile_name(value)?;
			profile_set = true;
			if needs_boundary(&output) {
				output.push(OsString::from(PROFILE_BOUNDARY));
			}
			index += 1;
			continue;
		}
		if let Some(value) = text.strip_prefix("--alias=") {
			if value.is_empty() {
				return Err(ProfileBootstrapError::MissingValue("--alias"));
			}
			alias = Some(Str::new(value));
			if needs_boundary(&output) {
				output.push(OsString::from(PROFILE_BOUNDARY));
			}
			index += 1;
			continue;
		}
		if is_command(argument) && !is_launch_command(argument) {
			strict = true;
			output.push(argument.clone());
			index += 1;
			continue;
		}
		output.push(argument.clone());
		let consumes = launch_option(argument) == Some(true)
			|| (text.starts_with("--")
				&& !text.contains('=')
				&& source
					.get(index + 1)
					.is_some_and(|next| !next.to_string_lossy().starts_with('-')));
		if consumes && index + 1 < source.len() {
			output.push(source[index + 1].clone());
			index += 1;
		}
		index += 1;
	}
	let profile = if profile_set {
		profile
	} else {
		env::var_os("OMP_PROFILE")
			.map(|value| {
				value
					.to_str()
					.ok_or(ProfileBootstrapError::NonUnicodeProfile)
					.and_then(normalize_profile_name)
			})
			.transpose()?
			.flatten()
	};
	Ok(ProfileBootstrap { arguments: output, profile, alias })
}

fn normalize_profile_name(value: &str) -> Result<Option<Str>, ProfileBootstrapError> {
	omp_core::dirs::normalize_profile_name(value)
		.map_err(|_| ProfileBootstrapError::InvalidProfile { profile: Str::new(value.trim()) })
}

fn needs_boundary(output: &[OsString]) -> bool {
	output.last().is_some_and(|previous| {
		matches!(previous.to_string_lossy().as_ref(), "--resume" | "--plan")
			|| (previous.to_string_lossy().starts_with("--") && launch_option(previous).is_none())
	})
}

/// Removes internal markers immediately before final clap parsing.
pub fn remove_boundaries(arguments: &mut Vec<OsString>) {
	arguments.retain(|argument| argument != PROFILE_BOUNDARY);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn preserves_separator_and_strict_subcommand_arguments() {
		let result =
			extract(["omp", "--profile", "work", "config", "get", "--profile"].map(OsString::from))
				.expect("extract");
		assert_eq!(result.profile.as_deref(), Some("work"));
		assert_eq!(result.arguments.last().and_then(|value| value.to_str()), Some("--profile"));
		let literal =
			extract(["omp", "--", "--profile", "literal"].map(OsString::from)).expect("literal");
		assert!(literal.profile.is_none());
	}

	#[test]
	fn explicit_default_profile_selects_the_default_root() {
		let result = extract(["omp", "--profile", "default", "--version"].map(OsString::from))
			.expect("explicit default profile");
		assert!(result.profile.is_none());
	}

	#[test]
	fn profile_names_are_portable_single_path_components() {
		for value in ["work", "team.one", "a_b-c9"] {
			assert_eq!(
				normalize_profile_name(value)
					.expect("valid profile")
					.as_deref(),
				Some(value)
			);
		}
		for value in ["..", "Team", "ends.", "two/slashes", "con", "lpt9.logs"] {
			assert!(matches!(
				normalize_profile_name(value),
				Err(ProfileBootstrapError::InvalidProfile { .. })
			));
		}
		assert!(
			normalize_profile_name(" default ")
				.expect("default profile")
				.is_none()
		);
	}
}
