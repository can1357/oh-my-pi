//! `vared` (zsh 5.9 `zle_main.c` `bin_vared`): edit a parameter's value
//! with the line editor, and the buffer-stack builtins and options that
//! feed the editor's next line (`print -z`, `pushln`, `read -z`,
//! `getln`).

use bstr::{BString, ByteSlice};

use super::{
	Context, Editor,
	exec::{self, Drive, Got, ReadTask, Task},
	keymap::KmId,
	readflags,
	tty::Tty,
	zle_mut,
};
use crate::bash::{
	diag::Diag,
	syntax::zsh::tok,
	vm::{
		builtins::{
			Control, Ctx, Need, Outcome, R, done,
			zsh_args::{Ops, isset, zx},
		},
		state::Level,
		zsh::params::{self, PmFlags, SCANPM_MATCHMANY, SCANPM_WANTKEYS, SCANPM_WANTVALS},
	},
	zshopt::ZshOpt,
};

/// What `vared` restores when the edit ends (kept on the editor across
/// the builtin's re-runs).
pub struct VaredState {
	/// `-M`: the keymap `main` named before, to link back (`None`: nothing
	/// to restore).
	main:    Option<KmId>,
	/// `-m`: the keymap `vicmd` named before, to link back.
	vicmd:   Option<KmId>,
	/// The parameter's type for the assignment (`-a`, `-A`).
	pm_type: PmFlags,
}

/// The characters `vared` quotes in array elements and splits on: zsh's
/// `ISEP` set, the `IFS` characters.
fn ifs(ctx: &mut Ctx<'_, '_>) -> Result<BString, Need> {
	Ok(zx(ctx, |ex| params::getsparam(ex, b"IFS"))?
		.ok()
		.flatten()
		.unwrap_or_else(|| BString::from(" \t\n\0")))
}

/// `vared` (zsh `bin_vared`).
pub fn vared(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let owner = ctx.vp.frames.len();
	if let Some(ed) = super::editor(ctx.vp) {
		if exec::resume_base(ed, owner).is_some() {
			return run(ctx, args);
		}
		ctx.usage("ZLE cannot be used recursively (yet)");
		return done(1);
	}
	let term = zx(ctx, |ex| params::getsparam(ex, b"TERM"))?
		.ok()
		.flatten()
		.unwrap_or_default();
	let interactive = isset(ctx, ZshOpt::Interactive)?;
	if (interactive && !isset(ctx, ZshOpt::Zle)?) || term.as_slice() == b"emacs" {
		ctx.usage("ZLE not enabled");
		return done(1);
	}
	let mut pm_type = PmFlags::SCALAR;
	if ops.isset(b'A') {
		if ops.isset(b'a') {
			ctx.usage("specify only one of -a and -A");
			return done(1);
		}
		pm_type = PmFlags::HASHED;
	} else if ops.isset(b'a') {
		pm_type = PmFlags::ARRAY;
	}
	if pm_type != PmFlags::SCALAR && !ops.isset(b'c') {
		ctx.usage(format!("-{} ignored", if pm_type == PmFlags::ARRAY { "a" } else { "A" }));
	}
	let name = args[0].clone();
	let create = ops.isset(b'c');
	let meta = tok::metafy(&name);
	let fetched = zx(ctx, |ex| {
		let mut pos = 0;
		let v = params::fetchvalue(
			ex,
			&meta,
			&mut pos,
			i32::from(!create || pm_type == PmFlags::SCALAR),
			SCANPM_WANTKEYS | SCANPM_WANTVALS | SCANPM_MATCHMANY,
		)?;
		match v {
			None => Ok(None),
			Some(mut v) => {
				let rest = meta.len() > pos;
				if v.isarr != 0 {
					let arr = v.getarrvalue(ex)?;
					Ok(Some((rest, Some(arr), Vec::new())))
				} else {
					let s = v.getstrvalue(ex)?;
					Ok(Some((rest, None, s)))
				}
			},
		}
	})?;
	let fetched = match fetched {
		Ok(f) => f,
		Err(d) => {
			ctx.diag(d);
			return done(1);
		},
	};
	let sep = ifs(ctx)?;
	let value: BString = match fetched {
		None if !create => {
			ctx.usage(format!("no such variable: {}", name.as_bstr()));
			return done(1);
		},
		Some((true, ..)) => {
			ctx.usage(format!("not an identifier: `{}'", name.as_bstr()));
			return done(1);
		},
		Some((false, Some(arr), _)) => {
			// Separators and backslashes in elements are quoted.
			let mut words = Vec::with_capacity(arr.len());
			for a in arr {
				let a = tok::unmetafy(&a);
				let mut w = BString::default();
				for ch in a.chars() {
					if ch == '\\' || (ch.is_ascii() && sep.contains(&(ch as u8))) {
						w.push(b'\\');
					}
					let mut buf = [0; 4];
					w.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
				}
				words.push(w);
			}
			BString::from(words.join(&b" "[..]))
		},
		Some((false, None, s)) => BString::from(tok::unmetafy(&s)),
		None => {
			if !params::isident(&name, params::wide_idents_ctx(ctx)) {
				ctx.usage(format!("invalid parameter name: {}", name.as_bstr()));
				return done(1);
			}
			BString::default()
		},
	};
	if ops.isset(b't') {
		ctx.diag(Diag::Unsupported { what: "`vared -t' (editing on another terminal)".into() });
		return done(1);
	}
	let prompt_l = BString::from(ops.arg(b'p').unwrap_or_default());
	let prompt_r = BString::from(ops.arg(b'r').unwrap_or_default());
	let init = BString::from(ops.arg(b'i').unwrap_or(b"zle-line-init"));
	let finish = BString::from(ops.arg(b'f').unwrap_or(b"zle-line-finish"));
	let main_km = ops.arg(b'M').map(BString::from);
	let vicmd_km = ops.arg(b'm').map(BString::from);
	let keytimeout = zx(ctx, |ex| params::getsparam(ex, b"KEYTIMEOUT"))?
		.ok()
		.flatten()
		.map_or(40, |v| params::parse_int(&v));
	let overstrike = isset(ctx, ZshOpt::Overstrike)?;
	let status = ctx.vp.status;
	let (lp, rp) = {
		let lp = zx(ctx, |ex| super::display::expand_prompt(ex, &prompt_l, status, &[]))?;
		let rp = zx(ctx, |ex| super::display::expand_prompt(ex, &prompt_r, status, &[]))?;
		(lp.unwrap_or_default(), rp.unwrap_or_default())
	};
	let curhist = super::hist::curhist(ctx.cx.store, ctx.vp);
	Tty::attach(ctx.k, ctx.cx, ctx.vp);
	let Some(z) = ctx.vp.zle.as_deref_mut() else {
		return done(1);
	};
	if z.tty.is_none() {
		ctx.usage("can't access terminal");
		return done(1);
	}
	let km = std::sync::Arc::make_mut(&mut z.keymaps);
	let mut save = |slot: &[u8], new: Option<&BString>| -> Result<Option<KmId>, BString> {
		let Some(new) = new else {
			return Ok(None);
		};
		let Some(id) = km.open(new) else {
			return Err(new.clone());
		};
		let old = km.open(slot);
		if old == Some(id) {
			return Ok(None);
		}
		if let Some(o) = old {
			km.ref_keymap(o);
		}
		let _ = km.link(id, slot, false);
		Ok(old)
	};
	let mut missing = Vec::new();
	let main = save(b"main", main_km.as_ref()).unwrap_or_else(|n| {
		missing.push(n);
		None
	});
	let vicmd = save(b"vicmd", vicmd_km.as_ref()).unwrap_or_else(|n| {
		missing.push(n);
		None
	});
	let mut ed = Editor::new(
		Context::Vared,
		if ops.isset(b'h') {
			readflags::HISTORY
		} else {
			0
		},
	);
	ed.unget = std::mem::take(&mut z.kunget);
	if let Some(t) = z.tty.as_mut() {
		t.fetch = false;
	}
	ed.isfirstln = ops.isset(b'e');
	ed.varedarg = Some(name);
	ed.pre_zle_status = status;
	ed.keytimeout = keytimeout;
	ed.insmode = !overstrike;
	ed.raw_lp = prompt_l;
	ed.raw_rp = prompt_r;
	ed.lprompt = lp.text;
	ed.lprompt_attr = lp.txtattr;
	ed.rprompt = rp.text;
	ed.rprompt_attr = rp.txtattr;
	ed.histline = curhist;
	ed.vared = Some(Box::new(VaredState { main, vicmd, pm_type }));
	let _ = exec::selectkeymap(&z.keymaps, &mut ed, b"main", true);
	ed.hooks.clear();
	ed.undo = super::undo::Undo::new(&ed.line, ed.cs);
	// zsh pushes the value on the buffer stack for `zleread` to start with.
	super::utils::setline(&mut ed, &value, super::utils::ZSL_TOEND);
	super::undo::handleundo(&mut ed);
	// WidgetsVi: zsh `zleread`'s vi set-up (`viinsert_init`).
	super::widgets::vi::line_init(z, &mut ed);
	z.display.resetneeded = true;
	z.display.trashedzle = false;
	if let Some(t) = z.tty.as_mut() {
		t.put(b"\r");
	}
	exec::push_root(&mut ed, Task::Read(ReadTask::new(&init, &finish)), owner);
	z.ed = Some(Box::new(ed));
	for n in missing {
		ctx.usage(format!("no such keymap: {}", n.as_bstr()));
	}
	run(ctx, args)
}

/// Drive the edit; at its end, restore the keymaps and assign the value.
fn run(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let owner = ctx.vp.frames.len();
	let Some(base) = super::editor(ctx.vp).and_then(|ed| exec::resume_base(ed, owner)) else {
		return done(1);
	};
	let got = match exec::drive(ctx.k, ctx.cx, ctx.vp, base) {
		Drive::Done(got) => got,
		Drive::Park(key) => return Err(Need::Park(key)),
		Drive::Frame => return Ok(Outcome { status: 0, control: Control::Resume }),
	};
	let Some(z) = ctx.vp.zle.as_deref_mut() else {
		return done(1);
	};
	let Some(mut ed) = z.ed.take() else {
		return done(1);
	};
	if let Some(t) = z.tty.as_mut() {
		let _ = t.flush(ctx.k);
	}
	if !ed.interrupted {
		z.kunget = std::mem::take(&mut ed.unget);
	}
	let st = ed.vared.take();
	if let Some(st) = st.as_deref() {
		let km = std::sync::Arc::make_mut(&mut z.keymaps);
		for (slot, saved) in [(&b"main"[..], st.main), (&b"vicmd"[..], st.vicmd)] {
			if let Some(old) = saved {
				let _ = km.link(old, slot, false);
				km.unref_keymap(old);
			}
		}
	}
	let ok = matches!(got, Got::Status(0)) && !ed.aborted && !ed.eofsent;
	if !ok {
		return done(1);
	}
	let text = super::from_line(&ed.line);
	let pm_type = st.as_deref().map_or(PmFlags::SCALAR, |s| s.pm_type);
	let name = args[0].clone();
	let create = pm_type != PmFlags::SCALAR || ctx.vp.zle.is_some();
	let sep = ifs(ctx)?;
	let r = zx(ctx, |ex| {
		if create && pm_type != PmFlags::SCALAR {
			params::unsetparam(ex, &name)?;
			params::createparam(ex, &name, pm_type, 0, 0, Level::Dynamic);
		}
		let is_arr = match params::getparam(ex, &name)? {
			Some(p) => p.flags.type_bits(),
			None => PmFlags::SCALAR,
		};
		if is_arr == PmFlags::ARRAY || is_arr == PmFlags::HASHED {
			let words = split_quoted(&text, &sep);
			if is_arr == PmFlags::ARRAY {
				params::assignaparam(ex, &name, words, params::ASSPM_WARN)
			} else {
				params::sethparam(ex, &name, &words)
			}
		} else {
			params::assignsparam(ex, &name, &text, params::ASSPM_WARN)
		}
	})?;
	match r {
		Ok(()) => done(0),
		Err(d) => {
			ctx.diag(d);
			done(1)
		},
	}
}

/// zsh `spacesplit(t, 1, 0, 1)`: words separated by `IFS` characters, a
/// backslash quoting the next character (and removed).
fn split_quoted(s: &[u8], sep: &[u8]) -> Vec<BString> {
	let mut out = Vec::new();
	let mut cur = BString::default();
	let mut have = false;
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if c == b'\\' && i + 1 < s.len() {
			cur.push(s[i + 1]);
			have = true;
			i += 2;
			continue;
		}
		if sep.contains(&c) {
			if have {
				out.push(std::mem::take(&mut cur));
				have = false;
			}
		} else {
			cur.push(c);
			have = true;
		}
		i += 1;
	}
	if have {
		out.push(cur);
	}
	out
}

/// `print -z` / `pushln` (zsh `zpushnode(bufstack, …)`): `line` becomes the
/// next line the editor starts with.
pub fn push_line(ctx: &mut Ctx<'_, '_>, line: BString) {
	zle_mut(ctx.k, ctx.cx, ctx.vp).bufstack.push(line);
}

/// `read -z` / `getln` (zsh `getlinknode(bufstack)`): the top of the
/// buffer stack, taken off it; `None` when it is empty.
pub fn pop_line(ctx: &mut Ctx<'_, '_>) -> Option<BString> {
	ctx.vp.zle.as_deref_mut()?.bufstack.pop()
}
