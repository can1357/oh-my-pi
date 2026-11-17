//! zsh/deltochar (zsh 5.9 `Src/Zle/deltochar.c`): the `delete-to-char`
//! and `zap-to-char` widgets, added when the module is loaded.

use std::sync::Arc;

use super::{
	exec::{Await, Got, WResult, Zw, then},
	thingy::{Kind, Widget},
	utils::{self, cutflags},
	wflags,
};
use crate::bash::vm::{Cx, Kernel, proc::Vproc};

/// zsh `deltochar`: kill up to (`delete-to-char`) or through
/// (`zap-to-char`) the `NUMERIC`-th next occurrence of the character typed
/// (backwards for a negative count).
pub fn deltochar(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Char, |zw, got| {
		let Got::Char(c) = got else {
			return WResult::Done(1);
		};
		let zap = zw
			.ed
			.bindk
			.as_deref()
			.is_some_and(|b| b.as_slice() == b"zap-to-char");
		let ll = zw.ed.line.len();
		let mut dest = zw.ed.cs;
		let mut ok = false;
		let mut n = zw.mult();
		let is = |ed: &super::Editor, at: usize| c.is_some_and(|c| ed.line.get(at) == Some(&c));
		if n > 0 {
			while n > 0 && dest != ll {
				n -= 1;
				while dest != ll && !is(zw.ed, dest) {
					utils::incpos(zw.ed, &mut dest);
				}
				if dest != ll {
					if !zap || n > 0 {
						utils::incpos(zw.ed, &mut dest);
					}
					if n == 0 {
						let ct = dest - zw.ed.cs;
						utils::forekill(zw.zle, zw.ed, ct, cutflags::RAW);
						ok = true;
					}
				}
			}
		} else {
			// The character under the cursor does not count going backwards.
			if dest > 0 {
				utils::decpos(zw.ed, &mut dest);
			}
			while n != 0 && dest != 0 {
				n += 1;
				while dest != 0 && !is(zw.ed, dest) {
					utils::decpos(zw.ed, &mut dest);
				}
				if is(zw.ed, dest) {
					if n == 0 {
						let ct = zw.ed.cs - dest - usize::from(zap);
						utils::backkill(zw.zle, zw.ed, ct, cutflags::RAW | cutflags::FRONT);
						ok = true;
					}
					if dest > 0 {
						utils::decpos(zw.ed, &mut dest);
					}
				}
			}
		}
		WResult::Done(i32::from(!ok))
	})
}

/// zsh/deltochar's `boot_`: the two widgets (named also with a dot,
/// immortal, as zsh's `addzlefunction`).
pub fn boot(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	let zle = super::zle_mut(k, cx, vp);
	let widgets = Arc::make_mut(&mut zle.widgets);
	for name in ["delete-to-char", "zap-to-char"] {
		let w = Widget {
			flags: wflags::INT | wflags::KILL | wflags::KEEPSUFFIX,
			kind:  Kind::Native(deltochar),
		};
		widgets.add_internal(name.as_bytes(), w);
	}
}

/// zsh/deltochar's `cleanup_`: the widgets go.
pub fn cleanup(vp: &mut Vproc) {
	let Some(zle) = vp.zle.as_deref_mut() else {
		return;
	};
	let widgets = Arc::make_mut(&mut zle.widgets);
	for name in ["delete-to-char", "zap-to-char", ".delete-to-char", ".zap-to-char"] {
		widgets.remove_internal(name.as_bytes());
	}
}
