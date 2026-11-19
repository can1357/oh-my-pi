//! The `caller` builtin (bash `builtins/caller.def`).

use bstr::BString;

use super::{Ctx, R, done, number, opts};
use crate::bash::{diag::Diag, vm::callstack};

/// `caller [expr]`: without `expr`, `LINE FILE` of the current call
/// (`BASH_LINENO[0]`, `BASH_SOURCE[1]`, `NULL` when missing); with it,
/// `LINE FUNCNAME FILE` of frame `expr`. Fails silently outside any call
/// level or past the stack; a non-number is a usage error.
pub fn caller(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let array = |ctx: &mut Ctx<'_, '_>, name: &[u8]| {
		callstack::array(ctx.k, ctx.cx.store, ctx.vp, name).map(Option::unwrap_or_default)
	};
	let lines = array(ctx, b"BASH_LINENO")?;
	let files = array(ctx, b"BASH_SOURCE")?;
	if lines.is_empty() || files.is_empty() {
		return done(1);
	}
	let rest = match opts(ctx, args, b"", b"", false) {
		Ok(o) => o.rest,
		Err(st) => return done(st),
	};
	let Some(expr) = rest.first() else {
		let mut out = lines[0].to_vec();
		out.push(b' ');
		out.extend_from_slice(files.get(1).map_or(&b"NULL"[..], |f| f.as_slice()));
		out.push(b'\n');
		ctx.out(&out);
		return done(0);
	};
	// FUNCNAME's array, `main` included, whether or not it is visible.
	let mut names: Vec<BString> = ctx
		.vp
		.calls
		.iter()
		.rev()
		.filter_map(|c| match &c.kind {
			callstack::CallKind::Function { name, .. } => Some(name.clone()),
			callstack::CallKind::Source { .. } => Some(BString::from("source")),
			callstack::CallKind::Args(_) => None,
		})
		.collect();
	if files.len() > names.len() {
		names.push(BString::from("main"));
	}
	if names.is_empty() {
		return done(1);
	}
	let Some(n) = number(expr) else {
		ctx.err(Diag::Usage { msg: format!("{}: invalid number", bstr::BStr::new(expr)).into() });
		ctx.builtin_usage();
		return done(2);
	};
	let at = |v: &[BString], i: i64| usize::try_from(i).ok().and_then(|i| v.get(i)).cloned();
	let (Some(line), Some(func), Some(file)) =
		(at(&lines, n), at(&names, n.saturating_add(1)), at(&files, n.saturating_add(1)))
	else {
		return done(1);
	};
	let mut out = line.to_vec();
	for part in [&func, &file] {
		out.push(b' ');
		out.extend_from_slice(part);
	}
	out.push(b'\n');
	ctx.out(&out);
	done(0)
}
