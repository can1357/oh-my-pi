//! zsh/param/private: `private`, and `local -P` once the module is loaded
//! (zsh's module swaps `local`'s handler and option string for its own).
//!
//! A private parameter is a local of the declaring function's scope
//! carrying [`Attrs::ZSH_PRIVATE`]. The engine applies the module's
//! wrappers where zsh installs them:
//! - `vm/state.rs` lookups skip a private while a function scope lies above it
//!   (zsh `getprivatenode`/`scopeprivate`): functions the declaring one calls
//!   see, assign and unset the next outer parameter of the name, and listings
//!   show that one; the environment of external commands keeps an exported
//!   private (zsh never takes it out of the environment).
//! - `vm/zsh/params.rs` gives a private zsh's `makeprivate` flags
//!   (`PM_HIDE|PM_SPECIAL|PM_REMOVABLE|PM_RO_BY_DESIGN`): its type cannot
//!   change, `typeset -p` does not list it, and creating a global of its name
//!   over it fails (`NAME: can't change parameter attribute`,
//!   `params::refuse_private`).
//!
//! While the module is loaded, `private` is also a `typeset`-like reserved
//! word (`private a=(…)`): the zsh alias table the parser reads
//! (`names::Aliases`) carries the module's state.
//!
//! Ported from zsh 5.9 `Src/Modules/param_private.c` (Copyright (c) 2015
//! Barton E. Schaefer; MIT-style licence as the rest of zsh, Copyright (c)
//! 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{
	Control, Ctx, Outcome, R, done,
	zsh_args::{Func, Ops, zx},
	zsh_typeset::typeset,
};
use crate::bash::{
	diag::Diag,
	store::Attrs,
	vm::{
		expand::{Expander, X},
		state::{self, Var},
		zsh::{
			params::{self, PmFlags},
			specials,
		},
	},
	zshopt::ZshOpt,
};

/// zsh `bin_private` (the handler of `private`, and of `local` while the
/// module is loaded). `base` is the argv index of `args[0]` (array
/// assignment words).
pub fn private(ctx: &mut Ctx<'_, '_>, ops: &mut Ops, args: &[BString], base: usize) -> R {
	// `local` without `-P`: plain `bin_typeset`.
	if !ops.isset(b'P') {
		return typeset(ctx, ops, args, base, Func::None);
	}
	if ops.isset(b'T') {
		// zsh `zwarn`: no builtin name.
		ctx.diag(Diag::Warning { msg: BString::from("bad option: -T") });
		return done(1);
	}
	// zsh calls `bin_typeset("private", …)` for `local -P` too.
	let name = ctx.name;
	ctx.name = "private";
	let r = declare(ctx, ops, args, base);
	ctx.name = name;
	r
}

/// What [`declare`] does with one argument.
enum Plan {
	/// Declare it (with the others) and make what it creates private.
	Keep,
	/// zsh `makeprivate`'s `can't change scope of existing param`: a
	/// parameter of the name already exists in the function's scope, or
	/// it is a special one (without `-h`).
	Refuse,
	/// An element of a parameter of the function's scope: zsh creates the
	/// private in a scope of its own, so `can't create local array
	/// elements`.
	Element,
}

/// `bin_private` with `-P`: `ops` as given, the builtin named `private`.
fn declare(ctx: &mut Ctx<'_, '_>, ops: &mut Ops, args: &[BString], base: usize) -> R {
	let Some(level) = state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)? else {
		if ctx.zsh_option(ZshOpt::Warncreateglobal)? {
			ctx.usage("invalid local scope, using globals");
		}
		return typeset(ctx, ops, args, base, Func::None);
	};
	if !(ops.isset(b'm') || ops.isset(b'+')) {
		// `ops->ind['g'] = 2`: `bin_typeset` behaves as `local`.
		ops.set_plus(b'g');
	}
	if ops.isset(b'p') || ops.isset(b'm') || ops.isset(b'+') {
		return typeset(ctx, ops, args, base, Func::None);
	}
	let hide = ops.minus(b'h');
	let readonly = ops.minus(b'r');
	let mut plans = Vec::with_capacity(args.len());
	for arg in args {
		let pname = BString::from(arg.find_byte(b'=').map_or(arg.as_slice(), |eq| &arg[..eq]));
		let plan = match zx(ctx, |ex| plan_for(ex, &pname, level, hide, readonly))? {
			Ok(Ok(plan)) => plan,
			Ok(Err(what)) => {
				ctx.diag(Diag::Unsupported { what: what.into() });
				return done(1);
			},
			Err(d) => {
				ctx.diag(d);
				return Ok(Outcome { status: 1, control: Control::DiscardAll });
			},
		};
		plans.push((pname, plan));
	}
	// zsh runs `bin_typeset` over every argument, then `makeprivate`; an
	// element of a parameter of this scope ends `bin_typeset` with its
	// error, after the arguments before it.
	let stop = plans.iter().position(|(_, p)| matches!(p, Plan::Element));
	let upto = stop.unwrap_or(args.len());
	let kept: Vec<usize> = (0..upto)
		.filter(|&i| matches!(plans[i].1, Plan::Keep))
		.collect();
	let fresh: Vec<&BString> = kept
		.iter()
		.map(|&i| &plans[i].0)
		.filter(|n| !n.contains(&b'['))
		.collect();
	let outcome = match run_typeset(ctx, ops, args, base, &kept) {
		Ok(o) => o,
		Err(need) => {
			// Re-run from scratch: forget what this run declared.
			for name in &fresh {
				state::scope_unbind(&mut ctx.k.root, ctx.cx.store, ctx.vp, level, name.as_slice());
			}
			return Err(need);
		},
	};
	// `makeprivate`: what `bin_typeset` created in the function's scope
	// becomes private (also after an error, which only silences the
	// warnings).
	let mut failed = false;
	for name in &fresh {
		match state::scope_var(ctx.cx.store, ctx.vp, level, name.as_slice())? {
			Some(Some(var)) if !var.attrs.contains(Attrs::ZSH_PRIVATE) => {
				let attrs = var.attrs.with(Attrs::ZSH_PRIVATE).with(Attrs::ZSH_HIDE);
				let var = Var { attrs, ..var };
				state::scope_set(
					&mut ctx.k.root,
					ctx.cx.store,
					ctx.vp,
					level,
					name.as_slice(),
					Some(var),
				);
			},
			// A declaration without a variable: zsh's `makeprivate` of a
			// parameter of no known type (an error, no message).
			Some(None) => failed = true,
			Some(Some(_)) | None => {},
		}
	}
	if !matches!(outcome.control, Control::None) {
		return Ok(outcome);
	}
	if let Some(i) = stop {
		ctx.usage(format!("{}: can't create local array elements", BStr::new(&plans[i].0)));
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	}
	for (pname, plan) in &plans {
		if matches!(plan, Plan::Refuse) {
			ctx.usage(format!("can't change scope of existing param: {}", BStr::new(pname)));
			failed = true;
		}
	}
	Ok(Outcome { status: outcome.status | i32::from(failed), control: Control::None })
}

/// zsh `makeprivate`'s checks of argument `pname` (the name before any
/// `=`) against the function scope `level`, made before declaring it;
/// `Err` text for a corner this port does not implement.
fn plan_for(
	ex: &mut Expander<'_, '_>,
	pname: &[u8],
	level: usize,
	hide: bool,
	readonly: bool,
) -> X<Result<Plan, String>> {
	if let Some(open) = pname.find_byte(b'[') {
		// `bin_typeset` reports the other cases itself.
		let p = params::getparam(ex, &pname[..open])?;
		let here = !readonly && p.is_some_and(|p| p.scope == Some(level));
		return Ok(Ok(if here { Plan::Element } else { Plan::Keep }));
	}
	if pname.is_empty() {
		return Ok(Ok(Plan::Keep));
	}
	// A parameter of this scope (`pm->old->level == locallevel - 1`).
	if state::scope_var(ex.cx.store, ex.vp, level, pname)?.is_some() {
		return Ok(Ok(Plan::Refuse));
	}
	let Some(sp) = specials::lookup(pname) else {
		return Ok(Ok(Plan::Keep));
	};
	if hide {
		return Ok(Ok(Plan::Keep));
	}
	let p = params::getparam(ex, pname)?;
	// A local hiding the special (`typeset -h`) is no special here.
	if p
		.as_ref()
		.is_some_and(|p| p.special.is_none() && p.flags.contains(PmFlags::HIDE))
	{
		return Ok(Ok(Plan::Keep));
	}
	if sp.module().is_some() {
		// A module's parameter not provided now is no special.
		if p.as_ref().is_none_or(|p| p.special.is_none()) {
			return Ok(Ok(Plan::Keep));
		}
		// zsh makes a private copy of a removable (module) special.
		return Ok(Err(format!(
			"`private' of the module parameter `{}' (zsh/param/private)",
			BStr::new(pname)
		)));
	}
	// zsh makes a new special local (`newspecial`), which `makeprivate`
	// refuses.
	Ok(Ok(Plan::Refuse))
}

/// `bin_typeset` over the arguments `keep` (indexes into `args`), with the
/// array assignment words renumbered for them.
fn run_typeset(
	ctx: &mut Ctx<'_, '_>,
	ops: &mut Ops,
	args: &[BString],
	base: usize,
	keep: &[usize],
) -> R {
	if keep.is_empty() {
		return done(0);
	}
	let words: Vec<BString> = keep.iter().map(|&i| args[i].clone()).collect();
	let saved = ctx.compound.clone();
	ctx.compound = keep
		.iter()
		.enumerate()
		.filter(|&(_, &i)| saved.iter().any(|&c| c as usize == base + i))
		.filter_map(|(k, _)| u32::try_from(base + k).ok())
		.collect();
	let r = typeset(ctx, ops, &words, base, Func::None);
	ctx.compound = saved;
	r
}
