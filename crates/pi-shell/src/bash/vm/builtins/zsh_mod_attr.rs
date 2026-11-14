//! zsh/attr: `zgetattr`, `zsetattr`, `zdelattr`, `zlistattr` over extended
//! attributes (`-h`: of a symbolic link itself).
//!
//! Ported from zsh 5.9 `Src/Modules/attr.c` (MIT-style licence, Copyright
//! (c) 2009 Mikael Magnusson and the zsh development group).

use bstr::BString;

use super::{
	Ctx, R, done,
	zsh_args::{Ops, zerr, zx},
	zsh_mod_files::{Fsq, errmsg, host_path, nice},
	zsh_print::charset,
};
use crate::bash::{
	ids::IntrinsicId,
	vm::{
		fsprobe::FsReq,
		zsh::params::{self, ASSPM_WARN},
	},
};

/// Run zsh/attr builtin `id`.
pub fn run(ctx: &mut Ctx<'_, '_>, id: IntrinsicId, ops: &Ops, args: &[BString]) -> R {
	use IntrinsicId as I;
	let cs = charset(ctx)?;
	let follow = !ops.isset(b'h');
	let mut q = Fsq::new(ctx);
	let file = &args[0];
	let path = host_path(ctx, file);
	match id {
		// zsh `bin_getattr`.
		I::Zgetattr => {
			let param = args.get(2);
			match q.bytes(FsReq::GetXattr { path, name: args[1].clone(), follow })? {
				Ok(value) if value.is_empty() => {
					if let Some(p) = param {
						return unset(ctx, p);
					}
					done(0)
				},
				Ok(value) => {
					if let Some(p) = param {
						let value = value.clone();
						return match zx(ctx, |ex| params::assignsparam(ex, p, &value, ASSPM_WARN))? {
							Ok(()) => done(0),
							Err(d) => zerr(ctx, d),
						};
					}
					// `printf("%s\n")`: up to the first NUL.
					let shown = value.split(|&c| c == 0).next().unwrap_or_default();
					ctx.out(shown);
					ctx.out(b"\n");
					done(0)
				},
				Err(e) => {
					ctx.usage(format!("{}: {}", nice(cs, file), errmsg(&e)));
					done(1)
				},
			}
		},
		// zsh `bin_setattr`.
		I::Zsetattr => {
			let req = FsReq::SetXattr { path, name: args[1].clone(), value: args[2].clone(), follow };
			match q.op(req)? {
				Ok(()) => done(0),
				Err(e) => {
					ctx.usage(format!("{}: {}", nice(cs, file), errmsg(&e)));
					done(1)
				},
			}
		},
		// zsh `bin_delattr`: stops at the first failure.
		I::Zdelattr => {
			for name in &args[1..] {
				let req = FsReq::RemoveXattr { path: path.clone(), name: name.clone(), follow };
				if let Err(e) = q.op(req)? {
					ctx.usage(format!("{}: {}", nice(cs, file), errmsg(&e)));
					return done(1);
				}
			}
			done(0)
		},
		// zsh `bin_listattr`.
		I::Zlistattr => {
			let param = args.get(1);
			match q.names(FsReq::ListXattr { path, follow })? {
				Ok([]) => {
					if let Some(p) = param {
						return unset(ctx, p);
					}
					done(0)
				},
				Ok(names) => {
					if let Some(p) = param {
						let names = names.to_vec();
						return match zx(ctx, |ex| params::assignaparam(ex, p, names, ASSPM_WARN))? {
							Ok(()) => done(0),
							Err(d) => zerr(ctx, d),
						};
					}
					for n in names {
						ctx.out(n);
						ctx.out(b"\n");
					}
					done(0)
				},
				Err(e) => {
					ctx.usage(format!("{}: {}", nice(cs, file), errmsg(&e)));
					// zsh's `1 + (list_len > val_len || …)` with `list_len` still
					// 0 and `val_len` -1.
					done(2)
				},
			}
		},
		_ => done(1),
	}
}

/// zsh `unsetparam` from the builtin.
fn unset(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> R {
	match zx(ctx, |ex| params::unsetparam(ex, name))? {
		Ok(()) => done(0),
		Err(d) => zerr(ctx, d),
	}
}
