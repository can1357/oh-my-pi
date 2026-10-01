//! Backup control for `cp`, `ln`, and `mv` through the shell.
//!
//! `uucore::backup_control` reads `VERSION_CONTROL`/`SIMPLE_BACKUP_SUFFIX`
//! from the host process and probes numbered backups on the host filesystem;
//! these helpers read the shell's exported environment and probe the shell's
//! filesystem instead, keeping URL (`scheme://`) spellings intact.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use clap::ArgMatches;
use pi_vfs::{BlockingFs, child_path, file_name, parent_path, with_file_name};
use uucore::backup_control::BackupMode;
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use uucore::{backup_control, display::Quotable};

#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use crate::host::Host;

/// Resolves a `--backup` CONTROL word (unique prefixes allowed); the error is
/// the GNU diagnostic naming `origin`.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
fn match_backup_method(method: &str, origin: &str) -> Result<BackupMode, String> {
	let matches = backup_control::BACKUP_CONTROL_VALUES
		.iter()
		.filter(|value| value.starts_with(method))
		.collect::<Vec<_>>();
	if matches.len() == 1 {
		match *matches[0] {
			"simple" | "never" => Ok(BackupMode::Simple),
			"numbered" | "t" => Ok(BackupMode::Numbered),
			"existing" | "nil" => Ok(BackupMode::Existing),
			"none" | "off" => Ok(BackupMode::None),
			_ => unreachable!("matched value comes from BACKUP_CONTROL_VALUES"),
		}
	} else {
		let kind = if matches.is_empty() { "invalid" } else { "ambiguous" };
		Err(format!(
			"{kind} argument {} for '{origin}'\nValid arguments are:\n  - 'none', 'off'\n  - \
			 'simple', 'never'\n  - 'existing', 'nil'\n  - 'numbered', 't'",
			method.quote()
		))
	}
}

/// The backup mode selected by the `uucore::backup_control::arguments` flags,
/// falling back to the shell's `VERSION_CONTROL`.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
pub(crate) fn determine_backup_mode(matches: &ArgMatches, host: &Host) -> Result<BackupMode, String> {
	let cli_method = matches
		.get_one::<String>(backup_control::arguments::OPT_BACKUP)
		.map(String::as_str);
	if matches.contains_id(backup_control::arguments::OPT_BACKUP) {
		if let Some(method) = cli_method {
			match_backup_method(method, "backup type")
		} else if let Some(method) = host.var("VERSION_CONTROL") {
			match_backup_method(method, "$VERSION_CONTROL")
		} else {
			Ok(BackupMode::Existing)
		}
	} else if matches.get_flag(backup_control::arguments::OPT_BACKUP_NO_ARG)
		|| matches.contains_id(backup_control::arguments::OPT_SUFFIX)
	{
		host.var("VERSION_CONTROL").map_or(Ok(BackupMode::Existing), |method| {
			match_backup_method(method, "$VERSION_CONTROL")
		})
	} else {
		Ok(BackupMode::None)
	}
}

/// The backup suffix from `-S`, else the shell's `SIMPLE_BACKUP_SUFFIX`, else
/// `~`; a suffix containing `/` falls back to `~`.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
pub(crate) fn determine_backup_suffix(matches: &ArgMatches, host: &Host) -> String {
	let suffix = matches
		.get_one::<String>(backup_control::arguments::OPT_SUFFIX)
		.map(String::as_str)
		.or_else(|| host.var("SIMPLE_BACKUP_SUFFIX"))
		.unwrap_or(backup_control::DEFAULT_BACKUP_SUFFIX);
	if suffix.contains('/') {
		backup_control::DEFAULT_BACKUP_SUFFIX.to_string()
	} else {
		suffix.to_string()
	}
}

/// The backup name for `path` under `mode`, probing numbered backups through
/// `filesystem`.
pub(crate) fn backup_path(
	filesystem: &BlockingFs,
	mode: BackupMode,
	path: &Path,
	suffix: impl AsRef<OsStr>,
) -> Option<PathBuf> {
	let simple = |suffix: &OsStr| {
		let mut name = file_name(path).unwrap_or_default().into_owned();
		name.push(suffix);
		with_file_name(path, name)
	};
	let numbered = || {
		(1u64..)
			.map(|index| simple(OsStr::new(&format!(".~{index}~"))))
			.find(|candidate| !filesystem.exists(candidate))
			.expect("backup index space is unbounded")
	};
	match mode {
		BackupMode::None => None,
		BackupMode::Simple => Some(simple(suffix.as_ref())),
		BackupMode::Numbered => Some(numbered()),
		BackupMode::Existing => {
			if filesystem.exists(simple(OsStr::new(".~1~"))) {
				Some(numbered())
			} else {
				Some(simple(suffix.as_ref()))
			}
		},
	}
}

/// Rebuilds the operand-relative display form of `backup`, created beside
/// `operand`.
pub(crate) fn backup_display(operand: &Path, backup: &Path) -> PathBuf {
	match (parent_path(operand), file_name(backup)) {
		(Some(parent), Some(name)) if !parent.as_os_str().is_empty() => child_path(parent, &name),
		(_, Some(name)) => PathBuf::from(name.into_owned()),
		_ => backup.to_path_buf(),
	}
}
