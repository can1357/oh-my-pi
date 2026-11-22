//! `compquote`: quote parameter values for the current quoting context
//! (computil.c `bin_compquote`).

use bstr::{BStr, BString};

use super::{fin, gate, px, quote_opts};
use crate::bash::{
	syntax::zsh::tok::metafy,
	vm::{
		builtins::{Ctx, R, done, zsh_args::Ops},
		zsh::{
			params::{self, PmFlags},
			text::QuoteOpts,
		},
	},
};

/// zsh `comp_quote`: `s` (metafied) quoted for the innermost quoting
/// level `qt`; with `prefix`, a leading `=` stays unquoted.
fn comp_quote(s: &[u8], qt: u8, prefix: bool, o: QuoteOpts) -> Vec<u8> {
	if prefix && s.first() == Some(&b'=') {
		let mut t = s.to_vec();
		t[0] = b'x';
		let mut r = super::super::quotestring(&t, qt, o);
		if let Some(c) = r.first_mut() {
			*c = b'=';
		}
		r
	} else {
		super::super::quotestring(s, qt, o)
	}
}

/// zsh `bin_compquote`.
pub fn compquote(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	// zsh tests `*compqstack`: `QT_NONE` is the string's end.
	let qt = match super::super::compqstack(ctx.vp).first() {
		None | Some(0) => return done(0),
		Some(&q) => q,
	};
	let prefix = ops.isset(b'p');
	let o = quote_opts(ctx)?;
	let mut failed = false;
	for name in args {
		let meta = metafy(name);
		let mut pos = 0;
		let Some(v) = px(ctx, &mut failed, |ex| params::fetchvalue(ex, &meta, &mut pos, 0, 0))?
		else {
			continue;
		};
		let Some(mut v) = v else {
			ctx.usage(format!("unknown parameter: {}", BStr::new(name)));
			continue;
		};
		match v.pm.flags.type_bits() {
			PmFlags::SCALAR => {
				px(ctx, &mut failed, |ex| {
					let cur = v.getstrvalue(ex)?;
					v.assignstrvalue(ex, &comp_quote(&cur, qt, prefix, o), 0)
				})?;
			},
			PmFlags::ARRAY => {
				let whole = match &v.pm.value {
					params::PValue::Array(a) => a.clone(),
					_ => Vec::new(),
				};
				let new = whole
					.iter()
					.map(|e| comp_quote(&metafy(e), qt, prefix, o))
					.collect();
				let mut w = params::Value::of(v.pm.clone());
				px(ctx, &mut failed, |ex| w.setarrvalue(ex, new))?;
			},
			_ => ctx.usage(format!("invalid parameter type: {}", BStr::new(name))),
		}
	}
	fin(0, failed)
}
