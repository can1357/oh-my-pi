//! zsh/newuser: the new-user check zsh runs at startup.
//!
//! zsh loads (and at once unloads) this module when an interactive shell
//! starts with `RCS` set and `PRIVILEGED` unset, after `/etc/zshenv` and
//! before `$ZDOTDIR/.zshenv` (`init.c` `run_init_scripts`). Its `boot_`
//! does nothing outside zsh emulation or when `$ZDOTDIR` (else `$HOME`)
//! holds any of [`DOTFILES`]; otherwise it sources the first `newuser`
//! script of [`SCRIPT_DIRS`] that exists. The process shell's startup
//! code asks [`startup_scripts`]; `zmodload zsh/newuser` runs the same
//! check through [`boot`].
//!
//! Ported from zsh 5.9 `Src/Modules/newuser.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{Ctx, Need};
use crate::bash::{
	diag::Diag,
	ids::ModeId,
	vm::{
		probe::absolute,
		proc::{Probe, ProbeResult},
	},
};

/// The startup files whose presence means the user is not new.
pub const DOTFILES: [&str; 4] = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];

/// zsh's `SITESCRIPT_DIR` and `SCRIPT_DIR`, where `newuser` is looked
/// for. macOS's `/bin/zsh` is built without either (the module then never
/// sources anything).
#[cfg(target_os = "macos")]
pub const SCRIPT_DIRS: &[&str] = &[];
/// zsh's `SITESCRIPT_DIR` and `SCRIPT_DIR` (configure's defaults under
/// the `/usr` prefix), where `newuser` is looked for.
#[cfg(not(target_os = "macos"))]
pub const SCRIPT_DIRS: &[&str] = &["/usr/share/zsh/scripts", "/usr/share/zsh/5.9/scripts"];

/// `dir/name`.
fn join(dir: &[u8], name: &str) -> BString {
	let mut p = BString::from(dir);
	p.push(b'/');
	p.extend_from_slice(name.as_bytes());
	p
}

/// Candidate `zsh-newuser-install` scripts for the process shell's startup.
///
/// For zsh `run_init_scripts`: call it for
/// an interactive shell in zsh emulation with `RCS` on and `PRIVILEGED`
/// off, after `/etc/zshenv` and before `$ZDOTDIR/.zshenv`, with the
/// startup directory (`$ZDOTDIR`, else `$HOME`; `None` when neither is
/// set: nothing to do) and an existence test (`access(F_OK)`). It returns
/// the candidate scripts in order: source the first that exists (as
/// `source` would, not an error when none does). Empty when the user has
/// a dotfile, or when the platform's zsh has no script directories.
pub fn startup_scripts(dotdir: Option<&[u8]>, exists: impl Fn(&[u8]) -> bool) -> Vec<BString> {
	let Some(dotdir) = dotdir else {
		return Vec::new();
	};
	if SCRIPT_DIRS.is_empty() || DOTFILES.iter().any(|f| exists(&join(dotdir, f))) {
		return Vec::new();
	}
	SCRIPT_DIRS
		.iter()
		.map(|d| join(d.as_bytes(), "newuser"))
		.collect()
}

/// zsh/newuser's `boot_` for `zmodload zsh/newuser`: the check of
/// [`startup_scripts`]. Sourcing the script from a module load is not
/// supported (a load hook cannot run shell code): it fails loudly.
///
/// # Errors
/// A probe to answer first, a store failure.
pub fn boot(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	if SCRIPT_DIRS.is_empty() || ctx.vp.mode != ModeId::Zsh {
		return Ok(());
	}
	let dotdir = match ctx.scalar(b"ZDOTDIR")? {
		Some(d) => Some(d),
		None => ctx.scalar(b"HOME")?,
	};
	let Some(dotdir) = dotdir else {
		return Ok(());
	};
	let mut candidates = Vec::new();
	for f in DOTFILES {
		if access(ctx, &join(&dotdir, f))? {
			return Ok(());
		}
	}
	for d in SCRIPT_DIRS {
		candidates.push(join(d.as_bytes(), "newuser"));
	}
	for script in candidates {
		if access(ctx, &script)? {
			ctx.diag(Diag::Unsupported {
				what: format!("sourcing {} from `zmodload zsh/newuser'", script.as_bstr()).into(),
			});
			return Ok(());
		}
	}
	Ok(())
}

/// `access(path, F_OK) == 0`.
fn access(ctx: &Ctx<'_, '_>, path: &[u8]) -> Result<bool, Need> {
	let path = absolute(&ctx.vp.cwd, path);
	Ok(matches!(ctx.probe(Probe::Access { path, mode: 0 })?, ProbeResult::Ok(true)))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_dotfile_means_no_newuser_script() {
		let none = startup_scripts(Some(b"/home/u"), |p| p == b"/home/u/.zlogin");
		assert!(none.is_empty());
		assert!(startup_scripts(None, |_| false).is_empty());
		let fresh = startup_scripts(Some(b"/home/u"), |_| false);
		let want: Vec<BString> = SCRIPT_DIRS
			.iter()
			.map(|d| join(d.as_bytes(), "newuser"))
			.collect();
		assert_eq!(fresh, want);
	}
}
