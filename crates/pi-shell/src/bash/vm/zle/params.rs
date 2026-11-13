//! The ZLE special parameters (zsh 5.9 `zle_params.c`): `BUFFER`,
//! `CURSOR`, `KEYS`, `WIDGET`, `killring`, `region_highlight`, … as views
//! of the editor, and zsh/zleparameter's `widgets` and `keymaps`.
//!
//! zsh makes the editor's parameters (`makezleparams`) as locals of each
//! widget function it runs: they exist only while shell code runs for the
//! line editor ([`visible`]); otherwise the names are ordinary parameters.

use bstr::{BString, ByteSlice};

use super::{Editor, Zle, from_line, modflags, thingy::Kind, to_line, wflags};
use crate::bash::vm::{
	expand::{Expander, Stop, X},
	proc::Vproc,
	zsh::params::{PValue, PmFlags, parse_int},
};

/// One ZLE special (zsh `zleparams[]`), plus zsh/zleparameter's two.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Zp {
	/// `BUFFER`.
	Buffer,
	/// `BUFFERLINES`.
	Bufferlines,
	/// `CONTEXT`.
	Context,
	/// `CURSOR`.
	Cursor,
	/// `CUTBUFFER`.
	Cutbuffer,
	/// `HISTNO`.
	Histno,
	/// `KEYMAP`.
	Keymap,
	/// `KEYS`.
	Keys,
	/// `KEYS_QUEUED_COUNT`.
	KeysQueuedCount,
	/// `killring`.
	Killring,
	/// `LASTABORTEDSEARCH`.
	LastAbortedSearch,
	/// `LASTSEARCH`.
	LastSearch,
	/// `LASTWIDGET`.
	LastWidget,
	/// `LBUFFER`.
	Lbuffer,
	/// `MARK`.
	Mark,
	/// `NUMERIC`.
	Numeric,
	/// `PENDING`.
	Pending,
	/// `POSTDISPLAY`.
	Postdisplay,
	/// `PREBUFFER`.
	Prebuffer,
	/// `PREDISPLAY`.
	Predisplay,
	/// `RBUFFER`.
	Rbuffer,
	/// `REGION_ACTIVE`.
	RegionActive,
	/// `region_highlight`.
	RegionHighlight,
	/// `registers`.
	Registers,
	/// `UNDO_CHANGE_NO`.
	UndoChangeNo,
	/// `UNDO_LIMIT_NO`.
	UndoLimitNo,
	/// `WIDGET`.
	Widget,
	/// `WIDGETFUNC`.
	WidgetFunc,
	/// `WIDGETSTYLE`.
	WidgetStyle,
	/// `YANK_START`.
	YankStart,
	/// `YANK_END`.
	YankEnd,
	/// `YANK_ACTIVE`.
	YankActive,
	/// `ISEARCHMATCH_START`.
	IsearchStart,
	/// `ISEARCHMATCH_END`.
	IsearchEnd,
	/// `ISEARCHMATCH_ACTIVE`.
	IsearchActive,
	/// `SUFFIX_START`.
	SuffixStart,
	/// `SUFFIX_END`.
	SuffixEnd,
	/// `SUFFIX_ACTIVE`.
	SuffixActive,
	/// `ZLE_RECURSIVE`.
	Recursive,
	/// `ZLE_STATE`.
	State,
	/// zsh/zleparameter `widgets`.
	Widgets,
	/// zsh/zleparameter `keymaps`.
	Keymaps,
}

/// The names [`lookup`] knows.
pub(crate) const NAMES: &[&[u8]] = &[
	b"BUFFER",
	b"BUFFERLINES",
	b"CONTEXT",
	b"CURSOR",
	b"CUTBUFFER",
	b"HISTNO",
	b"KEYMAP",
	b"KEYS",
	b"KEYS_QUEUED_COUNT",
	b"killring",
	b"LASTABORTEDSEARCH",
	b"LASTSEARCH",
	b"LASTWIDGET",
	b"LBUFFER",
	b"MARK",
	b"NUMERIC",
	b"PENDING",
	b"POSTDISPLAY",
	b"PREBUFFER",
	b"PREDISPLAY",
	b"RBUFFER",
	b"REGION_ACTIVE",
	b"region_highlight",
	b"registers",
	b"UNDO_CHANGE_NO",
	b"UNDO_LIMIT_NO",
	b"WIDGET",
	b"WIDGETFUNC",
	b"WIDGETSTYLE",
	b"YANK_START",
	b"YANK_END",
	b"YANK_ACTIVE",
	b"ISEARCHMATCH_START",
	b"ISEARCHMATCH_END",
	b"ISEARCHMATCH_ACTIVE",
	b"SUFFIX_START",
	b"SUFFIX_END",
	b"SUFFIX_ACTIVE",
	b"ZLE_RECURSIVE",
	b"ZLE_STATE",
	b"widgets",
	b"keymaps",
];

/// zsh `makezleparams(1)` (compcore.c `callcompfunc`): while a completion
/// function runs the editor's parameters are read-only.
fn in_compfunc_readonly(ex: &Expander<'_, '_>, zp: Zp) -> X<()> {
	if matches!(zp, Zp::Widgets | Zp::Keymaps)
		|| ex.vp.zle.as_deref().is_none_or(|z| z.comp.incompfunc != 1)
	{
		return Ok(());
	}
	let name = NAMES
		.iter()
		.find(|n| lookup(n) == Some(zp))
		.copied()
		.unwrap_or(b"?");
	Err(crate::bash::vm::expand::Stop::Fail(crate::bash::diag::Diag::Readonly { name: name.into() }))
}

/// The ZLE special `name` names, if any.
pub const fn lookup(name: &[u8]) -> Option<Zp> {
	Some(match name {
		b"BUFFER" => Zp::Buffer,
		b"BUFFERLINES" => Zp::Bufferlines,
		b"CONTEXT" => Zp::Context,
		b"CURSOR" => Zp::Cursor,
		b"CUTBUFFER" => Zp::Cutbuffer,
		b"HISTNO" => Zp::Histno,
		b"KEYMAP" => Zp::Keymap,
		b"KEYS" => Zp::Keys,
		b"KEYS_QUEUED_COUNT" => Zp::KeysQueuedCount,
		b"killring" => Zp::Killring,
		b"LASTABORTEDSEARCH" => Zp::LastAbortedSearch,
		b"LASTSEARCH" => Zp::LastSearch,
		b"LASTWIDGET" => Zp::LastWidget,
		b"LBUFFER" => Zp::Lbuffer,
		b"MARK" => Zp::Mark,
		b"NUMERIC" => Zp::Numeric,
		b"PENDING" => Zp::Pending,
		b"POSTDISPLAY" => Zp::Postdisplay,
		b"PREBUFFER" => Zp::Prebuffer,
		b"PREDISPLAY" => Zp::Predisplay,
		b"RBUFFER" => Zp::Rbuffer,
		b"REGION_ACTIVE" => Zp::RegionActive,
		b"region_highlight" => Zp::RegionHighlight,
		b"registers" => Zp::Registers,
		b"UNDO_CHANGE_NO" => Zp::UndoChangeNo,
		b"UNDO_LIMIT_NO" => Zp::UndoLimitNo,
		b"WIDGET" => Zp::Widget,
		b"WIDGETFUNC" => Zp::WidgetFunc,
		b"WIDGETSTYLE" => Zp::WidgetStyle,
		b"YANK_START" => Zp::YankStart,
		b"YANK_END" => Zp::YankEnd,
		b"YANK_ACTIVE" => Zp::YankActive,
		b"ISEARCHMATCH_START" => Zp::IsearchStart,
		b"ISEARCHMATCH_END" => Zp::IsearchEnd,
		b"ISEARCHMATCH_ACTIVE" => Zp::IsearchActive,
		b"SUFFIX_START" => Zp::SuffixStart,
		b"SUFFIX_END" => Zp::SuffixEnd,
		b"SUFFIX_ACTIVE" => Zp::SuffixActive,
		b"ZLE_RECURSIVE" => Zp::Recursive,
		b"ZLE_STATE" => Zp::State,
		b"widgets" => Zp::Widgets,
		b"keymaps" => Zp::Keymaps,
		_ => return None,
	})
}

impl Zp {
	/// zsh's type flags of it (`zleparams[].type`; the zleparameter
	/// hashes are read-only).
	pub const fn flags(self) -> PmFlags {
		const RO: u32 = PmFlags::READONLY.0;
		const I: u32 = PmFlags::INTEGER.0;
		const S: u32 = PmFlags::SCALAR.0;
		const A: u32 = PmFlags::ARRAY.0;
		const H: u32 = PmFlags::HASHED.0;
		PmFlags(match self {
			Self::Buffer
			| Self::Cutbuffer
			| Self::Lbuffer
			| Self::Postdisplay
			| Self::Predisplay
			| Self::Rbuffer => S,
			Self::Context
			| Self::Keymap
			| Self::Keys
			| Self::LastAbortedSearch
			| Self::LastSearch
			| Self::LastWidget
			| Self::Prebuffer
			| Self::Widget
			| Self::WidgetFunc
			| Self::WidgetStyle
			| Self::State => S | RO,
			Self::Bufferlines
			| Self::KeysQueuedCount
			| Self::Pending
			| Self::UndoChangeNo
			| Self::YankActive
			| Self::IsearchActive
			| Self::SuffixActive
			| Self::Recursive => I | RO,
			Self::Cursor
			| Self::Histno
			| Self::Mark
			| Self::Numeric
			| Self::RegionActive
			| Self::UndoLimitNo
			| Self::YankStart
			| Self::YankEnd
			| Self::IsearchStart
			| Self::IsearchEnd
			| Self::SuffixStart
			| Self::SuffixEnd => I,
			Self::Killring | Self::RegionHighlight => A,
			Self::Registers => H,
			Self::Widgets => H | RO,
			// zleparameter's `keymaps` is an array of the names.
			Self::Keymaps => A | RO,
		})
	}

	/// The module whose feature it is (`zmodload -F`): zsh/zleparameter's
	/// hashes; the editor's own parameters are no module feature.
	pub const fn module(self) -> Option<&'static str> {
		match self {
			Self::Widgets | Self::Keymaps => Some("zsh/zleparameter"),
			_ => None,
		}
	}
}

/// Whether the editor's parameters exist in `vp` now: shell code runs for
/// the line editor (a widget function, zsh `makezleparams`).
pub fn visible(vp: &Vproc, zp: Zp) -> bool {
	match zp {
		Zp::Widgets | Zp::Keymaps => true,
		_ => super::editor(vp).is_some_and(|ed| ed.in_widget > 0),
	}
}

fn num(n: impl std::fmt::Display) -> PValue {
	PValue::Scalar(BString::from(n.to_string()))
}

fn text(s: impl Into<BString>) -> PValue {
	PValue::Scalar(s.into())
}

/// zsh `get_zle_state`.
fn zle_state(ed: &Editor) -> BString {
	let mut parts = [
		if ed.insmode { "insert" } else { "overwrite" },
		if ed.ls.localhistory {
			"localhistory"
		} else {
			"globalhistory"
		},
	];
	parts.sort_unstable();
	BString::from(parts.join(" "))
}

/// The value of `zp` (`None`: unset).
pub fn get(ex: &mut Expander<'_, '_>, zp: Zp) -> Option<PValue> {
	if let Zp::Widgets | Zp::Keymaps = zp {
		let zle = super::zle_mut(ex.k, ex.cx, ex.vp);
		return Some(match zp {
			Zp::Widgets => PValue::Hash(widgets_hash(zle)),
			_ => PValue::Array(zle.keymaps.names()),
		});
	}
	let zle = ex.vp.zle.as_deref_mut()?;
	let ed = zle.ed.as_deref_mut()?;
	// While completion code has the line metafied (zsh `zlemetaline !=
	// NULL`), the buffer and cursor are read from it.
	if let Some(s) = zle.comp.line.s.as_deref()
		&& matches!(zp, Zp::Buffer | Zp::Cursor | Zp::Lbuffer | Zp::Rbuffer)
	{
		use crate::bash::syntax::zsh::tok::unmetafy;
		let cs = zle.comp.line.cs.min(s.len());
		return Some(match zp {
			Zp::Buffer => text(unmetafy(s)),
			Zp::Cursor => num(to_line(&unmetafy(&s[..cs])).len()),
			Zp::Lbuffer => text(unmetafy(&s[..cs])),
			_ => text(unmetafy(&s[cs..])),
		});
	}
	match zp {
		Zp::Buffer => Some(text(from_line(&ed.line))),
		Zp::Bufferlines => Some(num(zle.display.nlnct)),
		Zp::Context => Some(text(ed.context.name())),
		Zp::Cursor => Some(num(ed.cs)),
		Zp::Cutbuffer => Some(text(zle.cutbuf.as_ref().map_or_default(|c| from_line(&c.buf)))),
		Zp::Histno => Some(num(ed.histline)),
		Zp::Keymap => Some(text(ed.keymap.clone())),
		Zp::Keys => Some(text(ed.keybuf.clone())),
		Zp::KeysQueuedCount => Some(num(ed.unget.len())),
		Zp::Killring => {
			let size = if zle.kring_size == 0 {
				8
			} else {
				zle.kring_size
			};
			let mut out: Vec<BString> = zle
				.kring
				.iter()
				.take(size)
				.map(|c| from_line(&c.buf))
				.collect();
			out.resize(size, BString::default());
			Some(PValue::Array(out))
		},
		Zp::LastAbortedSearch => Some(text(zle.last_aborted.clone())),
		Zp::LastSearch => Some(text(zle.last_search.clone())),
		Zp::LastWidget => Some(text(ed.lbindk.clone().unwrap_or_default())),
		Zp::Lbuffer => Some(text(from_line(&ed.line[..ed.cs.min(ed.line.len())]))),
		// WidgetsVi: zsh's `mark` is -1 while a vi operator reads its motion.
		Zp::Mark if ed.mark == super::widgets::vi::NOMARK => Some(num(-1)),
		Zp::Mark => Some(num(ed.mark)),
		Zp::Numeric => {
			if ed.zmod.flags & (modflags::MULT | modflags::TMULT) == 0 {
				None
			} else {
				Some(num(ed.zmod.mult))
			}
		},
		Zp::Pending => Some(num(ed.unget.len() + zle.tty.as_ref().map_or(0, |t| t.pending_input()))),
		Zp::Postdisplay => Some(text(from_line(&ed.postdisplay))),
		Zp::Prebuffer => Some(text(ed.hline.clone().unwrap_or_default())),
		Zp::Predisplay => Some(text(from_line(&ed.predisplay))),
		Zp::Rbuffer => Some(text(from_line(&ed.line[ed.cs.min(ed.line.len())..]))),
		Zp::RegionActive => Some(num(ed.region_active)),
		Zp::RegionHighlight => {
			Some(PValue::Array(super::refresh::get_region_highlight(&ed.region_highlights)))
		},
		Zp::Registers => {
			let mut out = Vec::with_capacity(36);
			for (i, r) in zle.vibuf.iter().enumerate() {
				let name = if i < 26 {
					b'a' + i as u8
				} else {
					b'0' + (i - 26) as u8
				};
				out.push((BString::from(vec![name]), r.as_ref().map_or_default(|c| from_line(&c.buf))));
			}
			Some(PValue::Hash(out))
		},
		Zp::UndoChangeNo => Some(num(super::undo::current_change(ed))),
		Zp::UndoLimitNo => Some(num(ed.undo.limitno)),
		Zp::Widget => Some(text(ed.bindk.clone().unwrap_or_default())),
		Zp::WidgetFunc | Zp::WidgetStyle => {
			let w = ed.bindk.as_ref().and_then(|b| zle.widgets.get(b));
			Some(text(match w.map(|w| &w.kind) {
				Some(Kind::Builtin(_) | Kind::Native(_)) | None => BString::from(".internal"),
				Some(Kind::Comp { base, func }) => {
					if zp == Zp::WidgetFunc {
						func.clone()
					} else {
						base.clone()
					}
				},
				Some(Kind::User(f)) => {
					if zp == Zp::WidgetFunc {
						f.clone()
					} else {
						BString::default()
					}
				},
			}))
		},
		Zp::YankStart => Some(num(ed.yank.0)),
		Zp::YankEnd => Some(num(ed.yank.1)),
		Zp::YankActive => Some(num(
			u8::from(ed.lastcmd & wflags::YANK != 0) + u8::from(ed.lastcmd & wflags::YANKAFTER != 0),
		)),
		Zp::IsearchStart => Some(num(ed.ls.isearch.0)),
		Zp::IsearchEnd => Some(num(ed.ls.isearch.1)),
		Zp::IsearchActive => Some(num(u8::from(ed.ls.isearch_active))),
		Zp::SuffixStart => Some(num(ed.cs.saturating_sub(ed.ls.suffixlen))),
		Zp::SuffixEnd => Some(num(ed.cs)),
		Zp::SuffixActive => Some(num(ed.ls.suffixlen)),
		Zp::Recursive => Some(num(ed.recursive)),
		Zp::State => Some(text(zle_state(ed))),
		Zp::Widgets | Zp::Keymaps => unreachable!("handled above"),
	}
}

/// zsh/zleparameter `widgets`: each widget name with `builtin`,
/// `user:FUNC` or `completion:BASE:FUNC` (zsh `widgetstr`).
fn widgets_hash(zle: &Zle) -> Vec<(BString, BString)> {
	zle.widgets
		.iter()
		.map(|(name, w)| {
			let v = match &w.kind {
				Kind::Builtin(_) | Kind::Native(_) => BString::from("builtin"),
				Kind::User(f) => {
					let mut s = BString::from("user:");
					s.extend_from_slice(f);
					s
				},
				Kind::Comp { base, func } => {
					let mut s = BString::from("completion:");
					s.extend_from_slice(base);
					s.push(b':');
					s.extend_from_slice(func);
					s
				},
			};
			(name.clone(), v)
		})
		.collect()
}

fn as_scalar(v: &PValue) -> BString {
	match v {
		PValue::Scalar(s) => s.clone(),
		PValue::Array(a) => BString::from(a.join(&b" "[..])),
		PValue::Hash(_) => BString::default(),
	}
}

fn as_array(v: PValue) -> Vec<BString> {
	match v {
		PValue::Array(a) => a,
		PValue::Scalar(s) => vec![s],
		PValue::Hash(h) => h.into_iter().flat_map(|(k, v)| [k, v]).collect(),
	}
}

/// Clamp `x` to `0..=len` (zsh `set_cursor`, `set_mark`).
fn clamp(x: i64, len: usize) -> usize {
	usize::try_from(x.max(0)).unwrap_or(usize::MAX).min(len)
}

/// Assign `value` to `zp` (zsh's set functions; read-only ones are
/// refused by the caller).
///
/// # Errors
/// [`Stop::Fail`] for `HISTNO` errors reported as zsh does (none today)
/// and invalid registers.
pub fn set(ex: &mut Expander<'_, '_>, zp: Zp, value: PValue) -> X<()> {
	in_compfunc_readonly(ex, zp)?;
	if zp == Zp::Histno {
		let n = parse_int(&as_scalar(&value));
		super::hist::set_histno(ex, n);
		return Ok(());
	}
	let nearcolor = if zp == Zp::RegionHighlight
		&& crate::bash::vm::builtins::zsh_module::loaded(ex.cx.store, ex.vp, b"zsh/nearcolor")?
	{
		Some(
			crate::bash::vm::builtins::zsh_mod_nearcolor::getnearestcolor
				as crate::bash::vm::builtins::zsh_prompt::NearColour,
		)
	} else {
		None
	};
	let Some(zle) = ex.vp.zle.as_deref_mut() else {
		return Ok(());
	};
	let Some(ed) = zle.ed.as_deref_mut() else {
		return Ok(());
	};
	match zp {
		Zp::Buffer => {
			let s = as_scalar(&value);
			super::utils::setline(ed, &s, 0);
		},
		Zp::Cursor => ed.cs = clamp(parse_int(&as_scalar(&value)), ed.line.len()),
		Zp::Mark => ed.mark = clamp(parse_int(&as_scalar(&value)), ed.line.len()),
		Zp::RegionActive => ed.region_active = u8::from(parse_int(&as_scalar(&value)) != 0),
		Zp::Lbuffer => {
			let y = to_line(&as_scalar(&value));
			let cs = ed.cs.min(ed.line.len());
			let len = y.len();
			ed.line.splice(..cs, y);
			ed.cs = len;
		},
		Zp::Rbuffer => {
			let y = to_line(&as_scalar(&value));
			let cs = ed.cs.min(ed.line.len());
			ed.line.truncate(cs);
			ed.line.extend(y);
		},
		Zp::Cutbuffer => {
			zle.cutbuf = Some(super::CutBuffer { buf: to_line(&as_scalar(&value)), flags: 0 });
		},
		Zp::Killring => {
			let v = as_array(value);
			zle.kring = v
				.iter()
				.map(|s| super::CutBuffer { buf: to_line(s), flags: 0 })
				.collect();
			zle.kring_size = zle.kring.len();
			zle.kct = None;
		},
		Zp::Numeric => {
			ed.zmod.mult = parse_int(&as_scalar(&value));
			ed.zmod.flags = modflags::MULT;
		},
		Zp::Postdisplay => ed.postdisplay = to_line(&as_scalar(&value)),
		Zp::Predisplay => ed.predisplay = to_line(&as_scalar(&value)),
		Zp::RegionHighlight => {
			let v = as_array(value);
			let caps = zle
				.tty
				.as_ref()
				.and_then(|t| t.caps.as_ref())
				.map_or_default(|(_, c)| std::sync::Arc::clone(c));
			let near = nearcolor;
			ed.region_highlights = super::refresh::set_region_highlight(Some(&v), &caps, near);
		},
		Zp::Registers => {
			let pairs: Vec<(BString, BString)> = match value {
				PValue::Hash(h) => h,
				other => {
					let a = as_array(other);
					a.chunks(2)
						.map(|p| (p[0].clone(), p.get(1).cloned().unwrap_or_default()))
						.collect()
				},
			};
			for (k, v) in pairs {
				set_register(zle, &k, &v)?;
			}
		},
		Zp::UndoLimitNo => ed.undo.limitno = parse_int(&as_scalar(&value)),
		Zp::YankStart => ed.yank.0 = clamp(parse_int(&as_scalar(&value)), usize::MAX),
		Zp::YankEnd => ed.yank.1 = clamp(parse_int(&as_scalar(&value)), usize::MAX),
		Zp::IsearchStart => ed.ls.isearch.0 = clamp(parse_int(&as_scalar(&value)), usize::MAX),
		Zp::IsearchEnd => ed.ls.isearch.1 = clamp(parse_int(&as_scalar(&value)), usize::MAX),
		Zp::SuffixStart | Zp::SuffixEnd => {},
		_ => {},
	}
	Ok(())
}

/// zsh `set_register`: register `name` (`a`–`z`, `0`–`9`) to `value`.
fn set_register(zle: &mut Zle, name: &[u8], value: &[u8]) -> X<()> {
	let idx = match name {
		[c @ b'a'..=b'z'] => usize::from(c - b'a'),
		[c @ b'0'..=b'9'] => 26 + usize::from(c - b'0'),
		_ => {
			let msg = format!("invalid zle register: {}", name.as_bstr());
			return Err(Stop::Fail(crate::bash::diag::Diag::Usage { msg: msg.into() }));
		},
	};
	zle.vibuf[idx] =
		(!value.is_empty()).then(|| super::CutBuffer { buf: to_line(value), flags: 0 });
	Ok(())
}

/// Unset `zp` (zsh `zleunsetfn` and the special unset functions): a
/// user's `unset` empties the editor's value where zsh does.
///
/// # Errors
/// None today; kept for the special-parameter interface.
pub fn unset(ex: &mut Expander<'_, '_>, zp: Zp) -> X<()> {
	in_compfunc_readonly(ex, zp)?;
	let Some(zle) = ex.vp.zle.as_deref_mut() else {
		return Ok(());
	};
	match zp {
		Zp::Cutbuffer => zle.cutbuf = None,
		Zp::Killring => {
			zle.kring.clear();
			zle.kring_size = 0;
			zle.kct = None;
		},
		Zp::Numeric => {
			if let Some(ed) = zle.ed.as_deref_mut() {
				ed.zmod.flags = 0;
				ed.zmod.mult = 1;
			}
		},
		Zp::Registers => {
			zle.vibuf.fill(None);
		},
		Zp::RegionHighlight => {
			if let Some(ed) = zle.ed.as_deref_mut() {
				ed.region_highlights.clear();
			}
		},
		_ => {},
	}
	Ok(())
}
