//! zsh/cap: `cap`, `getcap`, `setcap`.
//!
//! zsh builds these over libcap's POSIX.1e capabilities only where
//! `cap_get_proc` exists; elsewhere (macOS's `/bin/zsh`, and this engine,
//! which does not link libcap) each is `bin_notavail`: the module loads,
//! its argument counts are checked, and every call says `not available on
//! this system` with status 1.
//!
//! Ported from zsh 5.9 `Src/Modules/cap.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use super::{Ctx, R, done};

/// zsh `bin_notavail`, which `bin_cap`, `bin_getcap` and `bin_setcap`
/// are without libcap.
pub fn notavail(ctx: &mut Ctx<'_, '_>) -> R {
	ctx.usage("not available on this system");
	done(1)
}
