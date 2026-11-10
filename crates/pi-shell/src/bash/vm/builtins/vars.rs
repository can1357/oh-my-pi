//! Variables, functions and options: assignment semantics and the
//! `declare` family, `unset`, `shift`, `set`, `shopt`, `let`.

use std::fmt::NumBuffer;

use bstr::{BStr, BString, ByteSlice};

use super::{Ctx, Need, R, done, number, opts};
use crate::bash::{
	diag::Diag,
	event::{ASSIGN_PREVIEW_BYTES, AssignScope, EventData, EventKind, assign_preview},
	ids::IntrinsicId,
	ir::{self, FuncIr},
	store::{
		Attrs, Elem, Key, KeyBuf, MiscKey, OptId, OptKind, Record, StoreError, Table, VarValue,
	},
	text,
	vm::{
		Cx, Kernel,
		exec::{self, Flow},
		expand::{self, arith_value, attr_letters},
		is_ident,
		proc::{AssignValue, Vproc},
		quote,
		state::{self, Level, Var, VarEdit},
	},
};

/// Emit a successful setter's actual stored value, using the current
/// executable op (or its current explicit assignment node) as its source.
/// No store lookup, value copy or scope work occurs with Assign disabled.
pub fn emit_assignment(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8], level: Level) {
	if !k.mask.contains(EventKind::Assign) {
		return;
	}
	let Some(frame) = vp.frames.last() else {
		return;
	};
	let Some(unit) = frame.unit.as_ref() else {
		return;
	};
	let Some(op) = unit.ops.get(frame.pc as usize) else {
		return;
	};
	let node = if op.code == ir::Opcode::Exec
		&& let Some(exec) = frame
			.scratch
			.as_ref()
			.and_then(|scratch| scratch.exec.as_ref())
		&& exec.stage == crate::bash::vm::proc::Stage::Expand
		&& let Some(assign) = unit
			.cmds
			.get(op.a as usize)
			.and_then(|command| command.assigns.get(exec.values.len()))
		&& assign.name.as_slice() == name
	{
		assign.node
	} else {
		op.node
	};
	emit_assignment_at(k, cx, vp, name, level, node);
}

/// Like [`emit_assignment`], with an explicit IR setter node. The binding
/// is read only after a real successful mutation; this is not a state diff.
pub fn emit_assignment_at(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	name: &[u8],
	level: Level,
	node: u32,
) {
	if !k.mask.contains(EventKind::Assign) {
		return;
	}
	let read = (|| -> Result<Option<(BString, usize, AssignScope)>, StoreError> {
		let scope = match level {
			Level::Global => None,
			Level::Local => state::func_scope(&k.root, cx.store, vp)?,
			Level::Dynamic => state::binding_scope(&k.root, cx.store, vp, name)?,
		};
		let scope = if let Some(index) = scope {
			if state::scope_func(cx.store, vp, index)?.is_some() {
				AssignScope::Local
			} else {
				AssignScope::Env
			}
		} else if vp.overlay.is_some() {
			AssignScope::Subshell
		} else {
			AssignScope::Global
		};
		let Some(var) = state::binding(&k.root, cx.store, vp, name, level)? else {
			return Ok(None);
		};
		let (value, full_len) = match &var.value {
			VarValue::Str(value) => (BString::from(assign_preview(value)), value.len()),
			VarValue::Indexed(values) => {
				assignment_preview(values.iter().map(|(_, value)| value.as_slice()))
			},
			VarValue::Assoc(values) => {
				assignment_preview(values.iter().map(|(_, value)| value.as_slice()))
			},
		};
		Ok(Some((value, full_len, scope)))
	})();
	match read {
		Ok(Some((value, full_len, scope))) => {
			k.emit_op(cx, vp, node, EventData::Assign {
				name: BStr::new(name),
				value: value.as_bstr(),
				full_len,
				scope,
			});
		},
		Ok(None) => {},
		Err(error) => k.fail(error),
	}
}

/// The engine's array assignment display, bounded before any copying.
fn assignment_preview<'a>(values: impl Iterator<Item = &'a [u8]>) -> (BString, usize) {
	// One byte past the preview tells `text::cut` whether the join was cut.
	const KEEP: usize = ASSIGN_PREVIEW_BYTES + 1;
	let mut shown = BString::default();
	let mut full_len = 0usize;
	for (index, value) in values.enumerate() {
		if index != 0 {
			full_len = full_len.saturating_add(1);
			if shown.len() < KEEP {
				shown.push(b' ');
			}
		}
		full_len = full_len.saturating_add(value.len());
		let kept = value.len().min(KEEP - shown.len());
		shown.extend_from_slice(&value[..kept]);
	}
	let end = text::cut(&shown, ASSIGN_PREVIEW_BYTES).len();
	shown.truncate(end);
	(shown, full_len)
}

/// Left-hand side of an assignment.
#[derive(Clone, Copy)]
pub struct Lhs<'a> {
	/// Variable name.
	pub name:   &'a [u8],
	/// `name[index]=` subscript text (not yet evaluated).
	pub index:  Option<&'a [u8]>,
	/// `+=`.
	pub append: bool,
}

/// The variable `name` as an assignment at `level` sees it: the innermost
/// function scope's own variable for `Local`, the global one for `Global`.
fn current(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	name: &[u8],
	level: Level,
) -> Result<Option<Var>, Diag> {
	let res = match level {
		Level::Dynamic => state::lookup_declared(&k.root, cx.store, vp, name).map(|v| v.cloned()),
		Level::Local => match state::func_scope(&k.root, cx.store, vp) {
			Ok(Some(i)) => state::scope_var(cx.store, vp, i, name).map(Option::flatten),
			Ok(None) => Ok(None),
			Err(e) => Err(e),
		},
		Level::Global => {
			state::binding(&k.root, cx.store, vp, name, Level::Global).map(|v| v.cloned())
		},
	};
	res.map_err(|e| {
		k.fail(e);
		Diag::StoreFailed
	})
}

/// A value as stored under `attrs`: integer evaluation (`+=` adds),
/// otherwise concatenation for `+=`, then case conversion.
fn convert(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	attrs: Attrs,
	value: &[u8],
	old: Option<&[u8]>,
) -> Result<BString, Diag> {
	let mut v = if attrs.contains(Attrs::INTEGER) {
		let mut n = arith_value(k, cx, vp, value)?;
		if let Some(old) = old {
			n = n.wrapping_add(arith_value(k, cx, vp, old)?);
		}
		BString::from(n.format_into(&mut NumBuffer::new()))
	} else {
		let mut v = BString::from(old.unwrap_or_default());
		v.extend_from_slice(value);
		v
	};
	if attrs.contains(Attrs::UPPER) {
		v = v.to_uppercase().into();
	} else if attrs.contains(Attrs::LOWER) {
		v = v.to_lowercase().into();
	} else if attrs.contains(Attrs::CAPITALIZE) {
		let lower = v.to_lowercase();
		let mut chars = lower.chars();
		let mut s = String::new();
		if let Some(c) = chars.next() {
			s.extend(c.to_uppercase());
		}
		s.extend(chars);
		v = s.into();
	}
	Ok(v)
}

/// An indexed-array subscript: arithmetic, negative counts back from
/// `next` (the highest index + 1).
///
/// `shown` names the element in bash's "bad array subscript" message
/// (`a[-9]` for `a[-9]=x`, `[-9]=x` for a compound element). `@`/`*` are
/// bad for a single element. Both kinds of error print without the
/// builtin's name, as bash's (`array_expand_index` clears
/// `this_command_name`; `err_badarraysub` is no builtin error).
fn index_of(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	next: i64,
	text: &[u8],
	shown: &dyn Fn() -> BString,
) -> Result<i64, Diag> {
	let bad = || Diag::BadSubscript { shown: shown() };
	// (An empty subscript written as `b[]` is the caller's to reject: an
	// expanded empty one, `a[""]`, is element 0.)
	if matches!(text, b"@" | b"*") {
		return Err(bad());
	}
	let i = subscript_value(k, cx, vp, text)?;
	if i < 0 {
		let j = next + i;
		if j < 0 {
			return Err(bad());
		}
		return Ok(j);
	}
	Ok(i)
}

/// The value of the indexed-array subscript `text`; an arithmetic error
/// in it prints without the command's name (bash's `array_expand_index`
/// clears `this_command_name`). Builtins evaluating a subscript (`unset`,
/// `test -v`, assignments) use it.
pub fn subscript_value(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	text: &[u8],
) -> Result<i64, Diag> {
	arith_value(k, cx, vp, text).map_err(|d| match d {
		Diag::Arith { expr, msg, token } => Diag::ArithSubscript { expr, msg, token },
		d => d,
	})
}

/// `name[index]` as bash shows it in messages.
fn element_text(name: &[u8], index: &[u8]) -> BString {
	let mut s = BString::from(name);
	s.push(b'[');
	s.extend_from_slice(index);
	s.push(b']');
	s
}

/// Assign `value` to `lhs` at `level` with bash's attribute semantics.
pub fn set_value(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	lhs: Lhs<'_>,
	value: AssignValue,
	level: Level,
) -> Result<(), Diag> {
	let name = lhs.name;
	// bash's `FUNCNAME` and `GROUPS` are `noassign`: assignments are silently
	// ignored.
	if name == b"FUNCNAME" || name == b"GROUPS" {
		return Ok(());
	}
	// An assignment to a set name reference assigns its target.
	let target = match state::deref(&k.root, cx.store, vp, name) {
		Ok(d) => d,
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	match target {
		state::Deref::Plain => {
			let compound = matches!(value, AssignValue::Array(_));
			if (lhs.index.is_some() || compound) && state::may_be_nameref(&k.root, vp) {
				let is_ref = match state::lookup_declared(&k.root, cx.store, vp, name) {
					Ok(v) => v.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)),
					Err(e) => {
						k.fail(e);
						return Err(Diag::StoreFailed);
					},
				};
				// An element of an unset reference names an element of the
				// empty name (`declare -n r; r[0]=x`): bash reports it.
				if is_ref && lhs.index.is_some() {
					return Err(Diag::InvalidIdent { name: BString::default() });
				}
				// A compound value makes an unset reference an empty array
				// first (`declare -n r; r+=(a)`), with a warning.
				if is_ref {
					let line = exec::current_line(vp);
					let msg = format!("warning: {}: removing nameref attribute", name.as_bstr());
					k.diag(cx, vp, line, Diag::Warning { msg: msg.into() });
					drop_nameref(k, cx, vp, name, VarValue::Indexed(Vec::new()))?;
				}
			}
			// The first assignment to an unset reference names its target,
			// which must be a variable name (`declare -n r; r=/`).
			if lhs.index.is_none()
				&& let AssignValue::Scalar(v) = &value
				&& state::may_be_nameref(&k.root, vp)
				&& !valid_ref_target(v)
			{
				let is_ref = match state::lookup_declared(&k.root, cx.store, vp, name) {
					Ok(v) => v.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)),
					Err(e) => {
						k.fail(e);
						return Err(Diag::StoreFailed);
					},
				};
				if is_ref {
					return Err(Diag::InvalidIdent { name: v.clone() });
				}
			}
		},
		state::Deref::To { name: target, index } => {
			// An element reference whose array is itself a reference would
			// lead back here: bash reports it as circular.
			let target_is_ref = index.is_some()
				&& match state::lookup_declared(&k.root, cx.store, vp, &target) {
					Ok(v) => v.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)),
					Err(e) => {
						k.fail(e);
						return Err(Diag::StoreFailed);
					},
				};
			// `declare -n a=b b; b=a[1]; a=foo`: the element's array is
			// itself a reference; bash makes it a plain variable (with a
			// warning, dropping its value) and assigns the element.
			if target_is_ref {
				let line = exec::current_line(vp);
				let msg = format!("warning: {}: removing nameref attribute", target.as_bstr());
				k.diag(cx, vp, line, Diag::Warning { msg: msg.into() });
				drop_nameref(k, cx, vp, &target, VarValue::Str(BString::default()))?;
			}
			// A reference to an element takes neither a list nor another
			// subscript: bash reports its value as no identifier
			// (`declare -n r=x[0]; r+=(y)`, `read -a r`).
			if let Some(idx) = &index
				&& (lhs.index.is_some() || matches!(value, AssignValue::Array(_)))
			{
				return Err(Diag::InvalidIdent { name: element_text(&target, idx) });
			}
			let index = index.as_ref().map(|i| i.as_slice()).or(lhs.index);
			let lhs = Lhs { name: &target, index, append: lhs.append };
			return set_value(k, cx, vp, lhs, value, Level::Dynamic);
		},
		state::Deref::Circular => {
			let line = exec::current_line(vp);
			// A local reference to its own name (`typeset -n v=v` in a
			// function): bash gives up after its depth limit and assigns
			// the global variable of that name.
			let ref_value = match state::lookup_declared(&k.root, cx.store, vp, name) {
				Ok(v) => v.and_then(Var::as_scalar).map(BString::from),
				Err(e) => {
					k.fail(e);
					return Err(Diag::StoreFailed);
				},
			};
			let self_ref = ref_value.as_ref().is_some_and(|t| t == name);
			// `declare -n a=b b; b=a[1]; a=foo`: the chain comes back to an
			// element of `a` through another reference; bash makes `a` a
			// plain variable (with a warning) and assigns that element.
			if let Some(idx) = element_of_chain_start(k, cx, vp, name)? {
				let line = exec::current_line(vp);
				let msg = format!("warning: {}: removing nameref attribute", name.as_bstr());
				k.diag(cx, vp, line, Diag::Warning { msg: msg.into() });
				drop_nameref(k, cx, vp, name, VarValue::Str(BString::default()))?;
				let lhs = Lhs { name, index: Some(idx.as_slice()), append: lhs.append };
				return set_value_plain(k, cx, vp, lhs, value, Level::Dynamic);
			}
			let in_func_scope = match func_binds(k, cx, vp, name) {
				Ok(b) => b,
				Err(e) => {
					k.fail(e);
					return Err(Diag::StoreFailed);
				},
			};
			if self_ref && in_func_scope {
				k.diag(cx, vp, line, Diag::NamerefDepth { name: name.into() });
				return set_value_plain(k, cx, vp, lhs, value, Level::Global);
			}
			k.diag(cx, vp, line, Diag::CircularNameref { name: name.into() });
			// A reference to an element of its own name (`local -n a=a[0]`)
			// then names no variable bash can assign.
			if let Some(v) = ref_value
				&& v
					.strip_prefix(name)
					.is_some_and(|rest| rest.starts_with(b"["))
			{
				return Err(Diag::InvalidIdent { name: v });
			}
			return Ok(());
		},
	}
	set_value_plain(k, cx, vp, lhs, value, level)
}

/// bash's "removing nameref attribute": the reference `name` becomes a
/// declared-but-unset plain variable holding the empty `value`.
fn drop_nameref(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	value: VarValue,
) -> Result<(), Diag> {
	let attrs = match state::binding(&k.root, cx.store, vp, name, Level::Dynamic) {
		Ok(v) => v.map(|v| v.attrs),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	let Some(attrs) = attrs else {
		return Ok(());
	};
	let var = Var { attrs: attrs.without(Attrs::NAMEREF).with(Attrs::INVISIBLE), value };
	let edit = VarEdit::Replace(var);
	if let Err(e) = state::edit_var(&mut k.root, cx.store, vp, name, Level::Dynamic, edit) {
		k.fail(e);
		return Err(Diag::StoreFailed);
	}
	Ok(())
}

/// Whether a function scope (not a temporary environment) of `vp` binds
/// `name`.
fn func_binds(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> Result<bool, StoreError> {
	for i in 0..state::scope_count(&k.root, vp) {
		if state::scope_binds(cx.store, vp, i, name)? && state::scope_func(cx.store, vp, i)?.is_some()
		{
			return Ok(true);
		}
	}
	Ok(false)
}

/// The subscript where the name-reference chain from `name` ends, when it
/// ends at an element of `name` itself after at least one other reference
/// (`a` → `b` → `a[1]`); `None` otherwise.
fn element_of_chain_start(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<BString>, Diag> {
	let mut cur = BString::from(name);
	// bash's `NAMEREF_MAX`.
	for hop in 0..8 {
		let target = match state::lookup_declared(&k.root, cx.store, vp, &cur) {
			Ok(v) => v
				.filter(|v| v.attrs.contains(Attrs::NAMEREF) && !v.attrs.contains(Attrs::INVISIBLE))
				.and_then(Var::as_scalar)
				.map(BString::from),
			Err(e) => {
				k.fail(e);
				return Err(Diag::StoreFailed);
			},
		};
		let Some(target) = target.filter(|t| !t.is_empty()) else {
			return Ok(None);
		};
		if let Some(open) = target.iter().position(|&c| c == b'[')
			&& target.ends_with(b"]")
		{
			let hit = hop > 0 && &target[..open] == name;
			return Ok(hit.then(|| BString::from(&target[open + 1..target.len() - 1])));
		}
		if target == name {
			return Ok(None);
		}
		cur = target;
	}
	Ok(None)
}

/// bash code wrote `name`, which has zsh-only attributes: the lossy
/// crossing's report (once per kind per crossing). Out of line, off the
/// assignment path.
#[cold]
#[inline(never)]
fn report_zsh_attrs(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, name: &[u8]) {
	let line = exec::current_line(vp);
	let what = format!("zsh attributes of `{}'", name.as_bstr());
	crate::bash::vm::mode::report_lossy(
		k,
		cx,
		vp,
		line,
		crate::bash::store::LossyKind::ZshAttrs,
		what,
	);
}

/// [`set_value`] once name references are resolved.
fn set_value_plain(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	lhs: Lhs<'_>,
	value: AssignValue,
	level: Level,
) -> Result<(), Diag> {
	let name = lhs.name;
	// `BASH_CMDS[name]=path` adds to the command hash table.
	if name == b"BASH_CMDS"
		&& let (Some(cmd), AssignValue::Scalar(v)) = (lhs.index, &value)
	{
		state::store_record(
			&mut k.root,
			cx.store,
			vp,
			KeyBuf::CmdHash(BString::from(cmd)),
			Some(Record::CmdHash { path: v.clone(), hits: 0 }),
		);
		return Ok(());
	}
	// `DIRSTACK[i]=dir` replaces an entry of the directory stack.
	if name == b"DIRSTACK"
		&& let (Some(idx), AssignValue::Scalar(v)) = (lhs.index, &value)
	{
		let i = arith_value(k, cx, vp, idx)?;
		if let Err(e) = super::dirstack::set_element(k, cx.store, vp, i, v.clone()) {
			k.fail(e);
			return Err(Diag::StoreFailed);
		}
		return Ok(());
	}
	// bash's `RANDOM` is an integer variable whose assignment reseeds the
	// generator (`assign_random`); reads are always fresh values.
	if name == b"RANDOM"
		&& lhs.index.is_none()
		&& let AssignValue::Scalar(v) = &value
	{
		let seed = arith_value(k, cx, vp, v)?;
		k.seed_random(cx.store, seed);
		return Ok(());
	}
	let Some(value) = assign_in_place(k, cx, vp, lhs, value, level)? else {
		return Ok(());
	};
	let cur = current(k, cx, vp, name, level)?;
	// bash code writing a variable zsh code gave zsh-only attributes
	// (float, padding, unique, hide): stored as bash writes it, the
	// attributes not applied. `ZSH_ONLY` lies within the flag
	// bits: no mask first.
	if let Some(v) = cur.as_ref()
		&& v.attrs.bits() & Attrs::ZSH_ONLY.bits() != 0
		&& vp.mode.dialect() == crate::bash::ids::Dialect::Bash
	{
		report_zsh_attrs(k, cx, vp, name);
	}
	if let Some(v) = cur.as_ref().filter(|v| v.attrs.contains(Attrs::READONLY)) {
		// bash checks an indexed element's subscript first (`c[-2]=4` on
		// an empty readonly array is a bad subscript).
		if let (Some(idx), AssignValue::Scalar(_)) = (lhs.index, &value)
			&& !matches!(v.value, VarValue::Assoc(_))
			&& !v.attrs.contains(Attrs::ASSOC)
		{
			index_of(k, cx, vp, v.next_index(), idx, &|| element_text(name, idx))?;
		}
		return Err(Diag::Readonly { name: name.into() });
	}
	let assoc = cur
		.as_ref()
		.is_some_and(|v| matches!(v.value, VarValue::Assoc(_)) || v.attrs.contains(Attrs::ASSOC));
	// Element errors of a compound assignment: reported after the rest is
	// assigned.
	let mut deferred: Vec<Diag> = Vec::new();
	// An arithmetic error in a compound element's subscript: the elements
	// before it are assigned, then the whole command is abandoned.
	let mut aborted: Option<Diag> = None;
	let existed = cur.is_some();
	let mut var = cur.unwrap_or_else(|| Var::scalar("", Attrs::NONE));
	let attrs = var.attrs;
	if let (AssignValue::Array(_), Some(idx)) = (&value, lhs.index) {
		return Err(Diag::Usage {
			msg: format!("{}: cannot assign list to array member", element_text(name, idx).as_bstr())
				.into(),
		});
	}
	match (value, lhs.index) {
		(AssignValue::Scalar(v), None) => {
			let old = lhs
				.append
				.then(|| var.as_scalar().map_or_default(BString::from));
			let v = convert(k, cx, vp, attrs, &v, old.as_deref().map(|o| o.as_slice()))?;
			match &mut var.value {
				VarValue::Str(s) => *s = v,
				VarValue::Indexed(_) => var.set_index(0, v),
				VarValue::Assoc(_) => var.set_key(BString::from("0"), v),
			}
		},
		(AssignValue::Scalar(v), Some(idx)) => {
			if assoc {
				if idx.is_empty() {
					return Err(Diag::BadSubscript { shown: element_text(name, idx) });
				}
				if matches!(var.value, VarValue::Str(_)) {
					var.value = VarValue::Assoc(Default::default());
				}
				let old = lhs
					.append
					.then(|| var.key(idx).map_or_default(BString::from));
				let v = convert(k, cx, vp, attrs, &v, old.as_deref().map(|o| o.as_slice()))?;
				var.set_key(BString::from(idx), v);
			} else {
				// A new (or declared-but-unset) variable becomes an empty
				// array: `a[5]=x` has no element 0.
				if matches!(var.value, VarValue::Str(_))
					&& (!existed || var.attrs.contains(Attrs::INVISIBLE))
				{
					var.value = VarValue::Indexed(Vec::new());
				}
				let i = index_of(k, cx, vp, var.next_index(), idx, &|| element_text(name, idx))?;
				let old = lhs
					.append
					.then(|| var.index(i).map_or_default(BString::from));
				let v = convert(k, cx, vp, attrs, &v, old.as_deref().map(|o| o.as_slice()))?;
				var.set_index(i, v);
			}
		},
		(AssignValue::Array(elems), _) => {
			if assoc || attrs.contains(Attrs::ASSOC) {
				let mut items = match (&var.value, lhs.append) {
					(VarValue::Assoc(items), true) => items.clone(),
					_ => Default::default(),
				};
				let mut tmp = Var { attrs, value: VarValue::Assoc(std::mem::take(&mut items)) };
				let mut pending_key: Option<BString> = None;
				// bash pairs up unkeyed words only when the first word has no
				// `[key]=`; otherwise an unkeyed word is an error (reported
				// after the rest is assigned).
				let kvpair = elems.first().is_some_and(|(key, ..)| key.is_none());
				for (key, eappend, v) in elems {
					let key = if let Some(key) = key {
						key
					} else if !kvpair {
						deferred.push(Diag::Usage {
							msg: format!(
								"{}: {}: must use subscript when assigning associative array",
								name.as_bstr(),
								v.as_bstr()
							)
							.into(),
						});
						continue;
					} else {
						let Some(key) = pending_key.take() else {
							pending_key = Some(v);
							continue;
						};
						// `declare -A a=("" v)`: bash reports the key as
						// `declare` got it (single-quoted), drops the pair
						// and goes on.
						if key.is_empty() {
							k.diag(cx, vp, exec::current_line(vp), Diag::Usage {
								msg: "'': bad array subscript".into(),
							});
							continue;
						}
						key
					};
					let old = eappend.then(|| tmp.key(&key).map_or_default(BString::from));
					let v = convert(k, cx, vp, attrs, &v, old.as_deref().map(|o| o.as_slice()))?;
					tmp.set_key(key, v);
				}
				if let Some(key) = pending_key {
					tmp.set_key(key, BString::default());
				}
				var.value = tmp.value;
			} else {
				// Appending to a set scalar keeps it as element 0; a new (or
				// declared-but-unset) variable has none (`unset a; a+=([3]=x)`).
				let set = existed && !var.attrs.contains(Attrs::INVISIBLE);
				let mut tmp = match (&var.value, lhs.append) {
					(VarValue::Indexed(items), true) => {
						Var { attrs, value: VarValue::Indexed(items.clone()) }
					},
					(VarValue::Str(s), true) if set => {
						Var { attrs, value: VarValue::Indexed(vec![(0, s.clone())]) }
					},
					_ => Var { attrs, value: VarValue::Indexed(Vec::new()) },
				};
				let mut i = if lhs.append { tmp.next_index() } else { 0 };
				for (key, eappend, v) in elems {
					if let Some(mut key) = key {
						// bash evaluates the subscript with its quoting
						// markers (`CTLESC`, 0x01) removed: `[$'x\001y']=v`
						// evaluates `xy`.
						key.retain(|&c| c != 0x01);
						// An empty subscript ends the assignment there.
						if key.is_empty() {
							deferred.push(Diag::Usage {
								msg: format!("[]={}: bad array subscript", v.as_bstr()).into(),
							});
							break;
						}
						// A bad element is reported and skipped.
						let shown = || {
							let mut s = BString::from("[");
							s.extend_from_slice(&key);
							s.extend_from_slice(if eappend { b"]+=" } else { b"]=" });
							s.extend_from_slice(&v);
							s
						};
						if matches!(key.as_slice(), b"@" | b"*") {
							deferred.push(Diag::Usage {
								msg: format!("{}: cannot assign to non-numeric index", shown().as_bstr())
									.into(),
							});
							continue;
						}
						match index_of(k, cx, vp, tmp.next_index(), &key, &shown) {
							Ok(n) => i = n,
							// An arithmetic error abandons the rest of the
							// assignment (bash longjmps out of
							// `array_expand_index` after emptying the array and
							// assigning the elements before it).
							Err(d @ Diag::ArithSubscript { .. }) => {
								aborted = Some(d);
								break;
							},
							Err(d) => {
								deferred.push(d);
								continue;
							},
						}
					}
					let old = eappend.then(|| tmp.index(i).map_or_default(BString::from));
					let v = convert(k, cx, vp, attrs, &v, old.as_deref().map(|o| o.as_slice()))?;
					tmp.set_index(i, v);
					i += 1;
				}
				var.value = tmp.value;
			}
		},
	}
	var.attrs = var.attrs.without(Attrs::INVISIBLE);
	// `set -a`: every assignment exports.
	match state::option(&mut k.root, cx.store, vp, OptId::Allexport) {
		Ok(true) => var.attrs = var.attrs.with(Attrs::EXPORT),
		Ok(false) => {},
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	}
	// bash's `BASH_ARGV0` sets `$0` when assigned (a function-local or
	// temporary one does not).
	let dollar0 = if name == b"BASH_ARGV0" {
		match state::binding_scope(&k.root, cx.store, vp, name) {
			Ok(None) => var.as_scalar().map(BString::from),
			Ok(Some(_)) => None,
			Err(e) => {
				k.fail(e);
				return Err(Diag::StoreFailed);
			},
		}
	} else {
		None
	};
	// bash's `sv_xtracefd`: a value naming no open descriptor is reported
	// (the trace stays on standard error); empty resets it quietly.
	let bad_tracefd = (name == b"BASH_XTRACEFD")
		.then(|| var.as_scalar().map(BString::from))
		.flatten()
		.filter(|v| {
			!v.is_empty()
				&& !std::str::from_utf8(v)
					.ok()
					.and_then(|s| s.trim().parse::<i32>().ok())
					.is_some_and(|fd| vp.fds.get(fd).is_some_and(|h| h.is_open()))
		});
	if let Some(v) = bad_tracefd {
		let line = exec::current_line(vp);
		let msg = format!("BASH_XTRACEFD: {}: invalid value for trace file descriptor", v.as_bstr());
		k.diag(cx, vp, line, Diag::Usage { msg: msg.into() });
	}
	state::store_var(&mut k.root, cx.store, vp, name, Some(var), level);
	emit_assignment(k, cx, vp, name, level);
	if super::names::resets_hash(k.engine.config().platform, name)
		&& let Err(e) = super::names::flush_hash(&mut k.root, cx.store, vp)
	{
		k.fail(e);
		return Err(Diag::StoreFailed);
	}
	if let Some(v) = dollar0 {
		let rec = Some(Record::Misc(v));
		state::store_record(&mut k.root, cx.store, vp, KeyBuf::Misc(MiscKey::Dollar0), rec);
	}
	if is_posix_var(name) {
		let set = match var_option(name) {
			OptId::Posix => state::set_posix(&mut k.root, cx.store, vp, true),
			opt => {
				state::store_record(
					&mut k.root,
					cx.store,
					vp,
					KeyBuf::Opt(opt),
					Some(Record::Opt(true)),
				);
				Ok(())
			},
		};
		if let Err(e) = set.and_then(|()| state::sync_option_vars(&mut k.root, cx.store, vp)) {
			k.fail(e);
			return Err(Diag::StoreFailed);
		}
	}
	if let Some(d) = aborted {
		return Err(d);
	}
	match deferred.len() {
		0 => Ok(()),
		1 => Err(deferred.remove(0)),
		_ => Err(Diag::Several { diags: deferred }),
	}
}

/// A posix-mode special builtin's prefix assignment, which persists like
/// a plain one (`a=3 readonly a`) and, as bash's temporary-environment
/// variable it was, leaves the variable exported (`foo=abc :` →
/// `declare -x foo="abc"`, also on a function's local). When it lands on
/// a function call's prefix variable ([`Attrs::TEMP`], `a=7 f1`), bash
/// also copies the value out to the global variable (without attributes).
pub fn assign_special_prefix(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	lhs: Lhs<'_>,
	value: AssignValue,
) -> Result<(), Diag> {
	set_value(k, cx, vp, lhs, value, Level::Dynamic)?;
	let target = match state::deref(&k.root, cx.store, vp, lhs.name) {
		Ok(state::Deref::To { name, index: None }) => name,
		Ok(state::Deref::Plain) => BString::from(lhs.name),
		Ok(_) => return Ok(()),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	// `Some(Some(value))`: a temporary binding's value to copy out;
	// `Some(None)`: a plain binding to export.
	let bound = match state::binding(&k.root, cx.store, vp, &target, Level::Dynamic) {
		Ok(v) => v.map(|v| v.attrs.contains(Attrs::TEMP).then(|| v.value.clone())),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	match bound {
		Some(Some(value)) => {
			let var = Var { attrs: Attrs::NONE, value };
			state::store_var(&mut k.root, cx.store, vp, lhs.name, Some(var), Level::Global);
			emit_assignment(k, cx, vp, lhs.name, Level::Global);
		},
		Some(None) => {
			let edit = VarEdit::AddAttrs(Attrs::EXPORT);
			if let Err(e) = state::edit_var(&mut k.root, cx.store, vp, &target, Level::Dynamic, edit) {
				k.fail(e);
				return Err(Diag::StoreFailed);
			}
		},
		None => {},
	}
	Ok(())
}

/// The common assignments, done on the bound variable in place so that
/// `a+=(x)`, `a[i]=x` and `s+=x` cost the element, not a copy of the
/// array: an existing plain variable (no `-i`/case/readonly attributes,
/// no special name, no `set -a`) assigned a scalar, an element of an
/// indexed array, or appended unkeyed elements. Anything else comes back
/// for the general path.
fn assign_in_place(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	lhs: Lhs<'_>,
	value: AssignValue,
	level: Level,
) -> Result<Option<AssignValue>, Diag> {
	const SPECIAL: Attrs = Attrs::READONLY
		.with(Attrs::INTEGER)
		.with(Attrs::UPPER)
		.with(Attrs::LOWER)
		.with(Attrs::CAPITALIZE)
		.with(Attrs::NAMEREF)
		.with(Attrs::ZSH_ONLY);
	let name = lhs.name;
	// A name whose assignment flushes the command hash table takes the
	// general path, which does.
	if name == b"BASH_ARGV0"
		|| name == b"BASH_XTRACEFD"
		|| is_posix_var(name)
		|| super::names::resets_hash(k.engine.config().platform, name)
	{
		return Ok(Some(value));
	}
	match state::option(&mut k.root, cx.store, vp, OptId::Allexport) {
		Ok(false) => {},
		Ok(true) => return Ok(Some(value)),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	}
	// What the general path would decide on, read without copying.
	let (next, indexed, assoc, seen) = match state::binding(&k.root, cx.store, vp, name, level) {
		// Any one of the special attributes sends it to the general path.
		Ok(Some(v)) if v.attrs.bits() & SPECIAL.bits() == 0 => match &v.value {
			VarValue::Str(_) if v.attrs.contains(Attrs::ASSOC) => return Ok(Some(value)),
			VarValue::Str(_) => (1, false, false, state::Seen::of(v)),
			VarValue::Indexed(_) => (v.next_index(), true, false, state::Seen::of(v)),
			VarValue::Assoc(_) => (0, false, true, state::Seen::of(v)),
		},
		Ok(_) => return Ok(Some(value)),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	let elem = match (&value, lhs.index) {
		(AssignValue::Scalar(_), index) if assoc => {
			let key = index.unwrap_or(b"0");
			if key.is_empty() {
				return Err(Diag::BadSubscript { shown: element_text(name, key) });
			}
			Some(Elem::Key(BStr::new(key)))
		},
		(AssignValue::Scalar(_), Some(idx)) => {
			Some(Elem::Index(index_of(k, cx, vp, next, idx, &|| element_text(name, idx))?))
		},
		(AssignValue::Scalar(_), None) => None,
		(AssignValue::Array(elems), _)
			if lhs.append
				&& indexed
				&& elems
					.iter()
					.all(|(key, eappend, _)| key.is_none() && !eappend) =>
		{
			None
		},
		_ => return Ok(Some(value)),
	};
	// A subscript ran arithmetic since the binding was read (`a[i++]=x`,
	// `a[(a=1)]=x`): what it showed may be stale.
	let seen = seen.filter(|_| assoc || lhs.index.is_none());
	// `VarEdit::Set` also gives a declared-but-unset scalar no element 0
	// (`local z; z[3]=1`) and clears `INVISIBLE`.
	let edited = match value {
		AssignValue::Scalar(v) => {
			let edit = VarEdit::Set { elem, value: &v, append: lhs.append };
			state::edit_seen(&mut k.root, cx.store, vp, name, level, edit, seen)
				.map(|bound| (!bound).then_some(AssignValue::Scalar(v)))
		},
		// Nothing ran since the binding was read: it is still bound.
		AssignValue::Array(elems) => {
			let edit = VarEdit::Push(elems.into_iter().map(|(_, _, v)| v).collect());
			state::edit_seen(&mut k.root, cx.store, vp, name, level, edit, seen).map(|_| None)
		},
	};
	match edited {
		Ok(rest) => {
			if rest.is_none() {
				emit_assignment(k, cx, vp, name, level);
			}
			Ok(rest)
		},
		Err(e) => {
			k.fail(e);
			Err(Diag::StoreFailed)
		},
	}
}

/// bash's `sv_strict_posix` variables: setting one turns POSIX mode on,
/// unsetting it turns it off.
const fn is_posix_var(name: &[u8]) -> bool {
	matches!(name, b"POSIXLY_CORRECT" | b"POSIX_PEDANTIC" | b"IGNOREEOF")
}

/// The option a variable named by [`is_posix_var`] turns on when bound
/// and off when unset (bash's `sv_strict_posix` / `sv_ignoreeof`).
const fn var_option(name: &[u8]) -> OptId {
	match name {
		b"IGNOREEOF" => OptId::Ignoreeof,
		_ => OptId::Posix,
	}
}

/// The running function's own variable `name` (`None`: not bound in the
/// innermost function scope, or no function runs).
fn func_local(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<Var>, Need> {
	Ok(match state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)? {
		Some(i) => state::scope_var(ctx.cx.store, ctx.vp, i, name)?.flatten(),
		None => None,
	})
}

/// Whether the innermost function scope binds `name` (declared but unset
/// included).
fn func_binds_local(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<bool, Need> {
	Ok(match state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)? {
		Some(i) => state::scope_binds(ctx.cx.store, ctx.vp, i, name)?,
		None => false,
	})
}

/// The top scope when it is a temporary environment (a command's prefix
/// assignments), not a function's.
fn temp_scope(ctx: &mut Ctx<'_, '_>) -> Result<Option<usize>, StoreError> {
	let Some(top) = state::scope_count(&ctx.k.root, ctx.vp).checked_sub(1) else {
		return Ok(None);
	};
	Ok(state::scope_func(ctx.cx.store, ctx.vp, top)?
		.is_none()
		.then_some(top))
}

/// The variable `name` including a declared-but-unset one (`declare -i x`).
fn declared(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<Var>, Need> {
	Ok(state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, name)?.cloned())
}

/// The value a prefix assignment `name=value cmd` / `name+=value cmd`
/// puts in the command's environment (bash's `assign_in_env` through
/// `make_variable_value`): the visible variable's attributes apply, so
/// `-i` evaluates (and `+=` adds), otherwise `+=` concatenates, then case
/// conversion.
pub fn prefix_value(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	value: &[u8],
	append: bool,
) -> Result<BString, Diag> {
	let Some(var) = current(k, cx, vp, name, Level::Dynamic)? else {
		return Ok(BString::from(value));
	};
	let old = append.then(|| var.as_scalar().map_or_default(BString::from));
	convert(k, cx, vp, var.attrs, value, old.as_deref().map(|o| o.as_slice()))
}

/// Assign a scalar (`for` variables, `select`, `read`).
pub fn assign(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	value: BString,
	level: Level,
) -> Result<(), Diag> {
	set_value(k, cx, vp, Lhs { name, index: None, append: false }, AssignValue::Scalar(value), level)
}

/// Assign a `for` loop's control variable: when it is a name reference,
/// each word becomes its new target (bash: "a name reference will be
/// established for each word"); otherwise a plain [`assign`].
pub fn assign_loop_var(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	value: BString,
) -> Result<(), Diag> {
	if !state::may_be_nameref(&k.root, vp) {
		return assign(k, vp, cx, name, value, Level::Dynamic);
	}
	let is_ref = match state::lookup_declared(&k.root, cx.store, vp, name) {
		Ok(v) => v.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF)),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	if !is_ref {
		return assign(k, vp, cx, name, value, Level::Dynamic);
	}
	// bash `execute_for_command`: `sh_invalidid` with no command name.
	if !valid_ref_target(&value) {
		return Err(Diag::InvalidIdent { name: value });
	}
	let attrs = match state::binding(&k.root, cx.store, vp, name, Level::Dynamic) {
		Ok(v) => v.map(|v| v.attrs),
		Err(e) => {
			k.fail(e);
			return Err(Diag::StoreFailed);
		},
	};
	let Some(attrs) = attrs else {
		return Ok(());
	};
	let var = Var { attrs: attrs.without(Attrs::INVISIBLE), value: VarValue::Str(value) };
	let edit = VarEdit::Replace(var);
	match state::edit_var(&mut k.root, cx.store, vp, name, Level::Dynamic, edit) {
		Ok(_) => {
			emit_assignment(k, cx, vp, name, Level::Dynamic);
			Ok(())
		},
		Err(e) => {
			k.fail(e);
			Err(Diag::StoreFailed)
		},
	}
}

/// `FuncDef`: intern the body and store the function record.
pub fn define_function(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	f: &FuncIr,
	line: u32,
	traced: bool,
) -> Flow {
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	// bash's `valid_function_word`: no `$`, process substitution or quoting
	// in the name as written; in POSIX mode no special builtin's name, and
	// a rejected name is fatal (status 2).
	let rejected = if func_name_quoted(&f.name) {
		Some(Diag::InvalidIdent { name: f.name.clone() })
	} else if posix
		&& IntrinsicId::from_name(&f.name).is_some_and(crate::bash::vm::command::is_special)
	{
		Some(Diag::Usage { msg: format!("`{}': is a special builtin", f.name.as_bstr()).into() })
	} else {
		None
	};
	if let Some(d) = rejected {
		k.diag(cx, vp, line, d);
		if posix {
			return Flow::Exit(2);
		}
		vp.status = 1;
		return Flow::Next;
	}
	// Uncalled bodies need only their persistent descriptor, not a second
	// copy in the executable-unit cache.
	let compiled = f
		.body
		.deferred
		.is_none()
		.then(|| k.engine.intern((*f.body).clone()));
	let unit = compiled.as_deref().unwrap_or(&f.body);
	k.persist_unit(cx.store, unit);
	// Deferred bodies are announced after lowering, before their first op.
	if compiled.is_some() {
		exec::announce(k, cx, vp.vpid, vp.runs.front(), unit, unit.line);
	}
	let mode = exec::mode_of(vp);
	let attrs = match state::record(cx.store, vp, Key::Func(BStr::new(&f.name))) {
		Ok(Some(Record::Func { attrs, .. })) => *attrs,
		Ok(_) => Attrs::NONE,
		Err(e) => {
			k.fail(e);
			return Flow::Discard(1);
		},
	};
	if attrs.contains(Attrs::READONLY) {
		let msg = format!("{}: readonly function", f.name.as_bstr());
		k.diag(cx, vp, line, Diag::Usage { msg: msg.into() });
		vp.status = 1;
		return Flow::Next;
	}
	// zsh `execfuncdef`: a new definition has only `function -T`'s flag;
	// a function redefining itself while it runs keeps its tracing.
	let attrs = if mode.dialect() == crate::bash::ids::Dialect::Zsh {
		let mut fresh = if traced {
			Attrs::ZSH_TRACE_ONCE
		} else {
			Attrs::NONE
		};
		use crate::bash::vm::proc::{FrameKind, ScriptKind};
		let innermost = vp.frames.iter().rev().find_map(|fr| match &fr.kind {
			FrameKind::Function { name, .. } => Some(Some(name)),
			FrameKind::Script { what: ScriptKind::Source | ScriptKind::Eval, .. } => Some(None),
			_ => None,
		});
		if innermost.flatten().is_some_and(|n| *n == f.name) {
			for bit in [Attrs::TRACE, Attrs::ZSH_TRACE_ONCE] {
				if attrs.contains(bit) {
					fresh = fresh.with(bit);
				}
			}
		}
		fresh
	} else {
		attrs
	};
	// zsh records its `scriptfilename` (a `-c` string's functions are
	// `zsh`'s, not `$0`'s), bash `BASH_SOURCE[0]`.
	let file = if mode.dialect() == crate::bash::ids::Dialect::Zsh {
		super::zsh_print::scriptfilename(k, cx.store, vp)
	} else {
		crate::bash::vm::callstack::definition_file(k, cx.store, vp)
	};
	let file = match file {
		Ok(file) => file,
		Err(e) => {
			k.fail(e);
			return Flow::Discard(1);
		},
	};
	let sticky = vp.sticky().cloned().map(Box::new);
	let rec = Record::Func {
		mode,
		sticky,
		source: crate::bash::ir::FuncText::of(f),
		unit: unit.id,
		attrs,
		file,
	};
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Func(f.name.clone()), Some(rec));
	vp.status = 0;
	Flow::Next
}

/// Whether a function name as written has what bash flags `W_HASDOLLAR`
/// or `W_QUOTED`: `$`, a process substitution, quotes or a backslash.
fn func_name_quoted(name: &[u8]) -> bool {
	name
		.iter()
		.any(|c| matches!(c, b'$' | b'\'' | b'"' | b'\\' | b'`'))
		|| name.windows(2).any(|w| matches!(w, b"<(" | b">("))
}

/// `declare -p` text of one variable (no newline).
pub fn declare_line(name: &[u8], var: Option<&Var>, out: &mut Vec<u8>) {
	out.extend_from_slice(b"declare -");
	let letters = var.map_or_default(attr_letters);
	if letters.is_empty() {
		out.push(b'-');
	} else {
		out.extend_from_slice(&letters);
	}
	out.push(b' ');
	out.extend_from_slice(name);
	let Some(var) = var.filter(|v| !v.attrs.contains(Attrs::INVISIBLE)) else {
		return;
	};
	out.push(b'=');
	match &var.value {
		VarValue::Str(s) => out.extend_from_slice(&quote::declare(s)),
		VarValue::Indexed(items) => {
			out.push(b'(');
			for (n, (i, v)) in items.iter().enumerate() {
				if n > 0 {
					out.push(b' ');
				}
				out.push(b'[');
				out.extend_from_slice(i.format_into(&mut NumBuffer::new()).as_bytes());
				out.extend_from_slice(b"]=");
				out.extend_from_slice(&quote::declare(v));
			}
			out.push(b')');
		},
		VarValue::Assoc(items) => {
			out.push(b'(');
			for (key, v) in state::assoc_order_sized(items, var.attrs) {
				out.push(b'[');
				out.extend_from_slice(&quote::assoc_key(key));
				out.extend_from_slice(b"]=");
				out.extend_from_slice(&quote::declare(v));
				out.push(b' ');
			}
			out.push(b')');
		},
	}
}

/// `name=value` as `set` prints it.
fn set_line(name: &[u8], var: &Var, out: &mut Vec<u8>) {
	out.extend_from_slice(name);
	out.push(b'=');
	if let VarValue::Str(s) = &var.value {
		// bash's `print_var_value`: `$'…'` for control bytes, `'…'` (a
		// lone quote as `\'`) for shell metacharacters, else as is.
		if s.iter().any(|&c| c < 0x20 || c == 0x7f) {
			out.extend_from_slice(&quote::single(s));
		} else if s.as_slice() == b"'" {
			out.extend_from_slice(b"\\'");
		} else if has_shell_metas(s) {
			out.extend_from_slice(&quote::single(s));
		} else {
			out.extend_from_slice(s);
		}
	} else {
		let mut line = Vec::new();
		declare_line(b"", Some(var), &mut line);
		if let Some(eq) = line.iter().position(|&c| c == b'=') {
			out.extend_from_slice(&line[eq + 1..]);
		}
	}
	out.push(b'\n');
}

/// bash's `sh_contains_shell_metas`: blanks, quotes, metacharacters,
/// glob and expansion characters, `~` at a word or assignment start, `#`
/// at the start.
fn has_shell_metas(s: &[u8]) -> bool {
	s.iter().enumerate().any(|(i, &c)| match c {
		b' ' | b'\t' | b'\n' | b'\'' | b'"' | b'\\' | b'|' | b'&' | b';' | b'(' | b')' | b'<'
		| b'>' | b'!' | b'{' | b'}' | b'*' | b'[' | b'?' | b']' | b'^' | b'$' | b'`' => true,
		b'~' => i == 0 || matches!(s[i - 1], b'=' | b':'),
		b'#' => i == 0,
		_ => false,
	})
}

/// Which builtin of the `declare` family runs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DeclareKind {
	/// `declare` / `typeset`.
	Declare,
	/// `local`.
	Local,
	/// `export`.
	Export,
	/// `readonly`.
	Readonly,
}

/// Attribute letters of `declare`.
const ATTR_FLAGS: [(u8, Attrs); 9] = [
	(b'a', Attrs::INDEXED),
	(b'A', Attrs::ASSOC),
	(b'i', Attrs::INTEGER),
	(b'l', Attrs::LOWER),
	(b'u', Attrs::UPPER),
	(b'c', Attrs::CAPITALIZE),
	(b'n', Attrs::NAMEREF),
	(b'r', Attrs::READONLY),
	(b'x', Attrs::EXPORT),
];

/// Every variable visible to the vproc, sorted by name; `declared` keeps
/// declared-but-unset ones (`declare -p` lists them, `set` does not).
fn all_vars(ctx: &mut Ctx<'_, '_>, declared: bool) -> Result<Vec<(BString, Var)>, Need> {
	let scan = if declared {
		state::scan_declared
	} else {
		state::scan
	};
	let mut vars: Vec<(BString, Var)> = scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Var)?
		.into_iter()
		.filter_map(|(k, r)| match (k, r) {
			(KeyBuf::Var(n), Record::Var(v)) => Some((n, v)),
			_ => None,
		})
		.collect();
	// bash lists its alias and command-hash tables as the associative
	// arrays `BASH_ALIASES` and `BASH_CMDS`.
	for (name, table) in [(&b"BASH_ALIASES"[..], Table::Alias), (b"BASH_CMDS", Table::CmdHash)] {
		if vars.iter().any(|(n, _)| n.as_slice() == name) {
			continue;
		}
		let items = state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, table)?
			.into_iter()
			.filter_map(|(k, r)| match (k, r) {
				(KeyBuf::Alias(n), Record::Alias(v))
				| (KeyBuf::CmdHash(n), Record::CmdHash { path: v, .. }) => Some((n, v)),
				_ => None,
			})
			.collect();
		vars.push((BString::from(name), Var { attrs: Attrs::NONE, value: VarValue::Assoc(items) }));
	}
	// bash's call-stack arrays and `DIRSTACK` are real arrays there.
	for (name, var) in crate::bash::vm::callstack::listed(ctx.k, ctx.cx.store, ctx.vp)? {
		if !vars.iter().any(|(n, _)| *n == name) {
			vars.push((name, var));
		}
	}
	vars.sort_by(|a, b| a.0.cmp(&b.0));
	Ok(vars)
}

/// Every function visible to the vproc, sorted by name: `(name, source,
/// attrs)`.
pub fn all_functions(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(BString, BString, Attrs)>, Need> {
	Ok(state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Func)?
		.into_iter()
		.filter_map(|(k, r)| match (k, r) {
			(KeyBuf::Func(n), Record::Func { source, attrs, .. }) => {
				Some((n, (*source).clone(), attrs))
			},
			_ => None,
		})
		.collect())
}

/// The parts of `name[idx]+=value`: name, index, whether `+=`, value.
type AssignParts<'a> = (&'a [u8], Option<&'a [u8]>, bool, Option<&'a [u8]>);

/// Split `name[idx]+=value` into its parts.
///
/// A subscript runs to its matching `]` (bash's `skipsubscript`), so it
/// may hold `=` and nested brackets; one that does not close where the
/// name ends leaves the whole word as the (invalid) name. Without `=`,
/// `name[sub]` declares `name` (bash ignores the subscript there).
fn split_assignment(arg: &[u8], flat: bool) -> AssignParts<'_> {
	let eq = arg.find_byte(b'=');
	let open = arg.find_byte(b'[').filter(|&b| eq.is_none_or(|e| b < e));
	let Some(open) = open else {
		let Some(eq) = eq else {
			return (arg, None, false, None);
		};
		let (lhs, value) = (&arg[..eq], &arg[eq + 1..]);
		return match lhs.strip_suffix(b"+") {
			Some(lhs) => (lhs, None, true, Some(value)),
			None => (lhs, None, false, Some(value)),
		};
	};
	let mut depth = 0usize;
	let close = arg[open..].iter().position(|&c| {
		match c {
			// bash's `skipsubscript` with `assoc_expand_once` on an
			// associative array does not count nested brackets.
			b'[' if flat && depth > 0 => {},
			b'[' => depth += 1,
			b']' => depth -= 1,
			_ => {},
		}
		depth == 0
	});
	let Some(close) = close.map(|c| open + c) else {
		return (arg, None, false, None);
	};
	let (name, index) = (&arg[..open], &arg[open + 1..close]);
	match &arg[close + 1..] {
		[] => (name, None, false, None),
		[b'=', value @ ..] => (name, Some(index), false, Some(value)),
		[b'+', b'=', value @ ..] => (name, Some(index), true, Some(value)),
		_ => (arg, None, false, None),
	}
}

/// Parse the text of a compound value `(…)` (as rebuilt by the expander,
/// or written literally): `[key]=value` and plain elements, shell-quoted.
pub fn parse_compound(text: &[u8]) -> Vec<(Option<BString>, bool, BString)> {
	let mut out = Vec::new();
	let mut i = 0;
	while i < text.len() {
		while i < text.len() && text[i].is_ascii_whitespace() {
			i += 1;
		}
		if i >= text.len() {
			break;
		}
		let mut key = None;
		let mut append = false;
		if text[i] == b'[' {
			// `[key]=` with the key itself possibly quoted.
			let (k, next) = unquote_until(text, i + 1, b"]");
			if text.get(next) == Some(&b']') {
				let after = next + 1;
				if text.get(after) == Some(&b'=') {
					key = Some(k);
					i = after + 1;
				} else if text.get(after..after + 2) == Some(b"+=") {
					key = Some(k);
					append = true;
					i = after + 2;
				}
			}
		}
		let (v, next) = unquote_until(text, i, b" \t\n");
		out.push((key, append, v));
		i = next;
	}
	out
}

/// Unquote shell text from `i` until an unquoted byte of `stop`.
fn unquote_until(text: &[u8], mut i: usize, stop: &[u8]) -> (BString, usize) {
	let mut out = Vec::new();
	while i < text.len() && !stop.contains(&text[i]) {
		match text[i] {
			b'\'' => {
				let end = text[i + 1..]
					.find_byte(b'\'')
					.map_or(text.len(), |e| i + 1 + e);
				out.extend_from_slice(&text[i + 1..end]);
				i = end + 1;
			},
			b'$' if text.get(i + 1) == Some(&b'\'') => {
				let mut j = i + 2;
				while j < text.len() && text[j] != b'\'' {
					if text[j] == b'\\' {
						j += 1;
					}
					j += 1;
				}
				out.extend_from_slice(&ir::ansi_c(&text[i + 2..j.min(text.len())]));
				i = j + 1;
			},
			b'"' => {
				i += 1;
				while i < text.len() && text[i] != b'"' {
					if text[i] == b'\\' && matches!(text.get(i + 1), Some(b'"' | b'\\' | b'$' | b'`')) {
						i += 1;
					}
					out.push(text[i]);
					i += 1;
				}
				i += 1;
			},
			b'\\' if i + 1 < text.len() => {
				out.push(text[i + 1]);
				i += 2;
			},
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	(BString::from(out), i.min(text.len()))
}

/// `declare`, `typeset`, `local`, `export`, `readonly`.
pub fn declare(ctx: &mut Ctx<'_, '_>, args: &[BString], kind: DeclareKind) -> R {
	let (allowed, plus): (&[u8], bool) = match kind {
		DeclareKind::Declare | DeclareKind::Local => (b"aAcfFgilnprtuxI", true),
		DeclareKind::Export | DeclareKind::Readonly => (b"aAfnp", false),
	};
	let o = match opts(ctx, args, allowed, b"", plus) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let in_function = state::in_function(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	if kind == DeclareKind::Local && !in_function {
		ctx.usage("can only be used in a function");
		return done(1);
	}
	let mut on = Attrs::NONE;
	let mut off = Attrs::NONE;
	for &(f, set, _) in &o.flags {
		// `export -n` removes the export attribute (below); `readonly -n`
		// is accepted and changes nothing. Neither makes a nameref.
		if matches!(kind, DeclareKind::Export | DeclareKind::Readonly) && f == b'n' {
			continue;
		}
		// `-t`: the trace attribute (a function inherits DEBUG and RETURN).
		let attr = if f == b't' {
			Some(Attrs::TRACE)
		} else {
			ATTR_FLAGS.iter().find(|(c, _)| *c == f).map(|&(_, a)| a)
		};
		if let Some(a) = attr {
			if set {
				on = on.with(a);
			} else {
				off = off.with(a);
			}
		}
	}
	match kind {
		DeclareKind::Export => {
			if o.has(b'n') {
				off = off.with(Attrs::EXPORT);
			} else {
				on = on.with(Attrs::EXPORT);
			}
		},
		DeclareKind::Readonly => on = on.with(Attrs::READONLY),
		_ => {},
	}
	let functions = o.has(b'f') || o.has(b'F');
	let print = o.has(b'p') || (o.rest.is_empty() && kind != DeclareKind::Local);
	if functions {
		return declare_functions(ctx, &o, kind, on, off);
	}
	if o.rest.is_empty() && kind == DeclareKind::Local {
		// `local` / `local -p`: the current function's own variables.
		let mut vars: Vec<(BString, Option<Var>)> =
			match state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)? {
				Some(i) => state::scope_vars(ctx.cx.store, ctx.vp, i)?,
				None => Vec::new(),
			};
		vars.sort_by(|a, b| a.0.cmp(&b.0));
		let mut out = Vec::new();
		for (name, var) in &vars {
			if name.as_slice() == b"-" {
				out.extend_from_slice(b"local -\n");
				continue;
			}
			declare_line(name, var.as_ref(), &mut out);
			out.push(b'\n');
		}
		ctx.out(&out);
		return done(0);
	}
	if o.rest.is_empty() {
		let vars = all_vars(ctx, true)?;
		let mut out = Vec::new();
		let filter = on.with(off);
		// In POSIX mode `readonly`/`export` list as `readonly -a a=(…)`.
		let posix_verb: Option<(&[u8], u8)> = match kind {
			DeclareKind::Readonly if ctx.option(OptId::Posix)? => Some((b"readonly", b'r')),
			DeclareKind::Export if ctx.option(OptId::Posix)? => Some((b"export", b'x')),
			_ => None,
		};
		for (name, var) in &vars {
			if filter != Attrs::NONE && !has_every_attr(&attr_letters(var), filter) {
				continue;
			}
			if let Some((verb, own)) = posix_verb {
				let mut line = Vec::new();
				declare_line(name, Some(var), &mut line);
				// `declare -LETTERS rest`: drop the builtin's own letter.
				let rest_at = line
					.iter()
					.skip(9)
					.position(|&c| c == b' ')
					.map_or(line.len(), |p| p + 9);
				let letters: Vec<u8> = line[9..rest_at]
					.iter()
					.copied()
					.filter(|&c| c != own && c != b'-')
					.collect();
				out.extend_from_slice(verb);
				if !letters.is_empty() {
					out.extend_from_slice(b" -");
					out.extend_from_slice(&letters);
				}
				out.extend_from_slice(&line[rest_at..]);
				out.push(b'\n');
			} else if o.has(b'p') || filter != Attrs::NONE || kind != DeclareKind::Declare {
				declare_line(name, Some(var), &mut out);
				out.push(b'\n');
			} else if !var.attrs.contains(Attrs::INVISIBLE) {
				set_line(name, var, &mut out);
			}
		}
		if kind == DeclareKind::Declare && !o.has(b'p') && filter == Attrs::NONE {
			for (_, source, _) in all_functions(ctx)? {
				out.extend_from_slice(&source);
				out.push(b'\n');
			}
		}
		ctx.out(&out);
		return done(0);
	}
	let level = match kind {
		DeclareKind::Local => Level::Local,
		DeclareKind::Declare if o.has(b'g') => Level::Global,
		DeclareKind::Declare if in_function => Level::Local,
		DeclareKind::Declare => Level::Global,
		DeclareKind::Export | DeclareKind::Readonly => Level::Dynamic,
	};
	let mut status = 0;
	if print && !args.iter().any(|a| a.contains(&b'=')) {
		let mut out = Vec::new();
		for name in o.rest {
			// `local -p NAME` reports the running function's own variable.
			let var = if kind == DeclareKind::Local {
				func_local(ctx, name)?
			} else {
				declared(ctx, name)?
			};
			if let Some(var) = var {
				declare_line(name, Some(&var), &mut out);
				out.push(b'\n');
			} else {
				ctx.out(&std::mem::take(&mut out));
				ctx.err(Diag::NotFound { name: name.clone() });
				status = 1;
			}
		}
		ctx.out(&out);
		return done(status);
	}
	let first = args.len() - o.rest.len();
	for (j, arg) in o.rest.iter().enumerate() {
		let compound_word = ctx.compound.contains(&((1 + first + j) as u32));
		if kind == DeclareKind::Local && arg.as_slice() == b"-" {
			// `local -`: the `set` options, restored when the function
			// returns.
			let saved = state::set_options_on(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
			ctx.set_var(b"-", Some(Var::scalar(saved, Attrs::NONE)), Level::Local);
			super::emit_assignment(ctx.k, ctx.cx, ctx.vp, b"-", Level::Local);
			continue;
		}
		let flat = match arg.find_byte(b'[') {
			Some(open) if ctx.option(OptId::AssocExpandOnce)? => {
				on.contains(Attrs::ASSOC)
					|| declared(ctx, &arg[..open])?.is_some_and(|v| {
						matches!(v.value, VarValue::Assoc(_)) || v.attrs.contains(Attrs::ASSOC)
					})
			},
			_ => false,
		};
		let (name, index, append, value) = split_assignment(arg, flat);
		if on.contains(Attrs::NAMEREF)
			&& (index.is_some() || (value.is_none() && arg.contains(&b'[')))
		{
			let shown = match index {
				Some(i) => element_text(name, i),
				None => arg.clone(),
			};
			ctx.usage(format!("{}: reference variable cannot be an array", shown.as_bstr()));
			status = 1;
			continue;
		}
		// `declare -n a=(…)` written as a compound: bash reports the
		// reference as an array and assigns the array.
		let on = if on.contains(Attrs::NAMEREF)
			&& compound_word
			&& value.is_some_and(|v| v.starts_with(b"("))
		{
			ctx.usage(format!("{}: reference variable cannot be an array", name.as_bstr()));
			status = 1;
			on.without(Attrs::NAMEREF)
		} else {
			on
		};
		// bash checks a reference's new value before the variable it
		// changes (`declare -n array='(one)'` on an array).
		if on.contains(Attrs::NAMEREF)
			&& !append
			&& let Some(v) = value
			&& !v.is_empty()
			&& !valid_ref_target(v)
		{
			ctx.usage(format!("`{}': invalid variable name for name reference", v.as_bstr()));
			status = 1;
			continue;
		}
		// `declare -r c[100]` declares an indexed array; `readonly a[5]`
		// and `export a[5]` are no names.
		let subscripted = value.is_none() && name.len() < arg.len();
		let special = matches!(kind, DeclareKind::Readonly | DeclareKind::Export);
		if subscripted && special {
			ctx.err(Diag::InvalidIdent { name: arg.clone() });
			// A POSIX shell exits on a special builtin's usage error.
			ctx.usage_error = true;
			status = 1;
			// A posix shell stops (and exits) at the first one.
			if ctx.option(OptId::Posix)? {
				break;
			}
			continue;
		}
		let on = if subscripted && !on.contains(Attrs::ASSOC) {
			on.with(Attrs::INDEXED)
		} else {
			on
		};
		if !is_ident(name) {
			ctx.usage_error |= special;
			ctx.err(Diag::InvalidIdent { name: arg.clone() });
			status = 1;
			if special && ctx.option(OptId::Posix)? {
				break;
			}
			continue;
		}
		// The binding this declaration acts on: a new local shadows rather
		// than follows an outer reference.
		let new_local = level == Level::Local && !func_binds_local(ctx, name)?;
		// `declare -g` acts on the global variable, past a function's own
		// reference of that name.
		let global = level == Level::Global && o.has(b'g');
		let mut raw = if new_local {
			None
		} else if global {
			state::binding(&ctx.k.root, ctx.cx.store, ctx.vp, name, Level::Global)?.cloned()
		} else {
			state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, name)?.cloned()
		};
		let mut raw_ref = raw
			.as_ref()
			.is_some_and(|v| v.attrs.contains(Attrs::NAMEREF));
		// `declare -n xref; declare -a xref[1]=one`: an element assignment
		// to a reference whose target does not exist makes the reference
		// a plain array (bash warns and drops its value); so does a
		// compound value to a reference naming no target (`declare -n b;
		// declare b=(y)`). A compound value to a named but unset target
		// assigns the target (`declare -n ref=var; declare ref=(X)`).
		let element_or_compound =
			index.is_some() || (compound_word && value.is_some_and(|v| v.starts_with(b"(")));
		if raw_ref && element_or_compound && value.is_some() && !on.contains(Attrs::NAMEREF) {
			let target_set = match state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)? {
				state::Deref::To { name: t, index: None } => {
					index.is_none()
						|| declared(ctx, &t)?.is_some_and(|v| !v.attrs.contains(Attrs::INVISIBLE))
				},
				_ => false,
			};
			if !target_set && let Some(mut r) = raw.clone() {
				ctx.diag(Diag::Warning {
					msg: format!("warning: {}: removing nameref attribute", name.as_bstr()).into(),
				});
				r.attrs = r.attrs.without(Attrs::NAMEREF).with(Attrs::INVISIBLE);
				r.value = VarValue::Str(BString::default());
				ctx.set_var(name, Some(r.clone()), Level::Dynamic);
				super::emit_assignment(ctx.k, ctx.cx, ctx.vp, name, Level::Dynamic);
				raw = Some(r);
				raw_ref = false;
			}
		}
		if on.contains(Attrs::NAMEREF)
			&& raw
				.as_ref()
				.is_some_and(|v| !matches!(v.value, VarValue::Str(_)))
		{
			ctx.usage(format!("{}: reference variable cannot be an array", name.as_bstr()));
			status = 1;
			continue;
		}
		// A readonly reference with a target keeps being one (bash
		// `sh_readonly`); `+r` on one without a target follows it to
		// nothing and changes nothing.
		let raw_unset = raw
			.as_ref()
			.is_some_and(|v| v.attrs.contains(Attrs::INVISIBLE));
		let raw_readonly = raw
			.as_ref()
			.is_some_and(|v| v.attrs.contains(Attrs::READONLY));
		if off.contains(Attrs::NAMEREF) && raw_ref && raw_readonly && !raw_unset {
			ctx.err(Diag::Readonly { name: BString::from(name) });
			status = 1;
			continue;
		}
		if off.contains(Attrs::READONLY)
			&& !off.contains(Attrs::NAMEREF)
			&& raw_ref
			&& raw_unset
			&& value.is_none()
		{
			continue;
		}
		if off.contains(Attrs::NAMEREF) && raw_ref {
			// `declare +n ref=v`: the value goes to the target first, then
			// `ref` stops being a reference (keeping the target's name).
			// The other attributes given apply to the target too
			// (`declare +n -i foo=7+4` makes the target 11).
			let mut ref_on = on;
			if let Some(value) = value {
				if let state::Deref::To { name: t, index: None } =
					state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)?
				{
					let mut target =
						declared(ctx, &t)?.unwrap_or_else(|| Var::scalar("", Attrs::INVISIBLE));
					target.attrs = target
						.attrs
						.without(off.without(Attrs::NAMEREF))
						.with(on.without(Attrs::READONLY));
					ctx.set_var(&t, Some(target), Level::Dynamic);
					ref_on = Attrs::NONE;
				}
				let lhs = Lhs { name, index, append };
				if let Err(d) = set_value(
					ctx.k,
					ctx.cx,
					ctx.vp,
					lhs,
					AssignValue::Scalar(BString::from(value)),
					level,
				) {
					ctx.err(d);
					status = 1;
					continue;
				}
			}
			if let Some(mut v) = raw {
				v.attrs = v.attrs.without(Attrs::NAMEREF).without(off).with(ref_on);
				ctx.set_var(name, Some(v), Level::Dynamic);
			}
			continue;
		}
		// Other attributes given to a reference act on its target. A
		// reference to an element (`declare -n r=a[0]`) is no name for
		// `readonly`/`export`; `declare -r r` makes its array `a`.
		let target_name;
		let mut on = on;
		let name = if raw_ref && !on.contains(Attrs::NAMEREF) && index.is_none() {
			let target = if global {
				// One step from the global reference.
				match raw
					.as_ref()
					.and_then(Var::as_scalar)
					.map(super::split_subscript)
				{
					Some((t, i)) => state::Deref::To { name: t.into(), index: i.map(BString::from) },
					None => state::Deref::Plain,
				}
			} else {
				state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)?
			};
			match target {
				state::Deref::To { name: t, index: None } => {
					target_name = t;
					target_name.as_slice()
				},
				state::Deref::To { name: t, index: Some(i) } if value.is_none() => {
					if special {
						ctx.err(Diag::InvalidIdent { name: element_text(&t, &i) });
						status = 1;
						continue;
					}
					if !on.contains(Attrs::ASSOC) {
						on = on.with(Attrs::INDEXED);
					}
					target_name = t;
					target_name.as_slice()
				},
				_ => name,
			}
		} else {
			name
		};
		// Outside a function, a variable of this command's temporary
		// environment is the one acted on (then copied out, see
		// `propagate_temp`).
		let in_temp = match temp_scope(ctx)? {
			Some(top) => state::scope_binds(ctx.cx.store, ctx.vp, top, name)?,
			None => false,
		};
		let level = if in_temp && level == Level::Global && !o.has(b'g') {
			Level::Dynamic
		} else {
			level
		};
		let mut cur = match current(ctx.k, ctx.cx, ctx.vp, name, level) {
			Ok(v) => v,
			Err(d) => {
				ctx.err(d);
				status = 1;
				continue;
			},
		};
		let mut binds_value = false;
		if cur.is_none() && level == Level::Local && in_function {
			// bash will not shadow a readonly global with a local one
			// (`old_var->context == 0`).
			let in_scope = state::binding_scope(&ctx.k.root, ctx.cx.store, ctx.vp, name)?.is_some();
			let global = state::binding(&ctx.k.root, ctx.cx.store, ctx.vp, name, Level::Global)?
				.is_some_and(|v| v.attrs.contains(Attrs::READONLY));
			if !in_scope && global {
				if compound_word {
					// The array assignment fails first, bare.
					ctx.diag(Diag::Readonly { name: name.into() });
				}
				ctx.err(Diag::Readonly { name: name.into() });
				status = 1;
				continue;
			}
			cur = new_local_start(ctx, name, o.has(b'I'))?;
			binds_value = cur
				.as_ref()
				.is_some_and(|v| !v.attrs.contains(Attrs::INVISIBLE));
		} else if level == Level::Local
			&& in_function
			&& value.is_none()
			&& let Some(top) = temp_scope(ctx)?
			&& let Some(Some(temp)) = state::scope_var(ctx.cx.store, ctx.vp, top, name)?
		{
			// `z=y typeset z` in a function whose own call bound `z`: the
			// innermost temporary value wins.
			cur =
				Some(Var { attrs: cur.as_ref().map_or(Attrs::NONE, |v| v.attrs), value: temp.value });
			binds_value = true;
		}
		if cur
			.as_ref()
			.is_some_and(|v| v.attrs.contains(Attrs::READONLY))
			&& (value.is_some() || off.contains(Attrs::READONLY))
		{
			let d = Diag::Readonly { name: name.into() };
			let array_flag = on.contains(Attrs::INDEXED) || on.contains(Attrs::ASSOC);
			if compound_word {
				// bash reports a compound word's failed array assignment
				// bare, or, with `-a`/`-A` inside a function, under the
				// function's name.
				let func = state::func_name(&ctx.k.root, ctx.cx.store, ctx.vp)?;
				match func.filter(|_| array_flag) {
					Some(f) => {
						let f = String::from_utf8_lossy(&f).into_owned();
						ctx.diag(d.by(f));
					},
					None => ctx.diag(d),
				}
			} else if value.is_some()
				&& matches!(kind, DeclareKind::Readonly | DeclareKind::Export)
				&& !array_flag
			{
				// A plain value through `readonly`/`export` fails as an
				// assignment would.
				ctx.diag(d);
			} else {
				ctx.err(d);
			}
			status = 1;
			continue;
		}
		if (off.contains(Attrs::INDEXED) || off.contains(Attrs::ASSOC))
			&& cur
				.as_ref()
				.is_some_and(|v| !matches!(v.value, VarValue::Str(_)))
		{
			// A readonly array reports that first.
			if cur
				.as_ref()
				.is_some_and(|v| v.attrs.contains(Attrs::READONLY))
			{
				ctx.err(Diag::Readonly { name: BString::from(name) });
			} else {
				ctx.usage(format!("{}: cannot destroy array variables in this way", name.as_bstr()));
			}
			status = 1;
			continue;
		}
		let conversion = match cur.as_ref().map(|v| &v.value) {
			Some(VarValue::Indexed(_)) if on.contains(Attrs::ASSOC) => {
				Some("cannot convert indexed to associative array")
			},
			Some(VarValue::Assoc(_)) if on.contains(Attrs::INDEXED) => {
				Some("cannot convert associative to indexed array")
			},
			_ => None,
		};
		if let Some(msg) = conversion {
			let msg = format!("{}: {msg}", name.as_bstr());
			if compound_word {
				// bash reports a failed compound assignment bare at top
				// level, and in a function under the function's name and
				// again under `declare`'s.
				let func = state::func_name(&ctx.k.root, ctx.cx.store, ctx.vp)?;
				match func.map(|f| String::from_utf8_lossy(&f).into_owned()) {
					Some(f) => {
						ctx.diag(Diag::Usage { msg: msg.clone().into() }.by(f));
						ctx.err(Diag::Usage { msg: msg.into() });
					},
					None => ctx.diag(Diag::Usage { msg: msg.into() }),
				}
			} else {
				ctx.err(Diag::Usage { msg: msg.into() });
			}
			// The (inherited) local still comes into being.
			if let Some(var) = cur
				&& level == Level::Local
				&& current(ctx.k, ctx.cx, ctx.vp, name, level)
					.ok()
					.flatten()
					.is_none()
			{
				ctx.set_var(name, Some(var), level);
				if binds_value {
					super::emit_assignment(ctx.k, ctx.cx, ctx.vp, name, level);
				}
			}
			status = 1;
			continue;
		}
		let exists = cur.is_some();
		let mut var = cur.unwrap_or_else(|| {
			let value = if on.contains(Attrs::ASSOC) {
				VarValue::Assoc(Default::default())
			} else if on.contains(Attrs::INDEXED) {
				VarValue::Indexed(Vec::new())
			} else {
				VarValue::Str(BString::default())
			};
			Var { attrs: Attrs::NONE, value }
		});
		// A declared local is no longer the call's prefix variable.
		if level == Level::Local {
			var.attrs = var.attrs.without(Attrs::TEMP);
		}
		let on_value = on.without(Attrs::READONLY);
		// ksh93: turning a variable into a reference turns off the `-ilu`
		// it had (`declare -ni` keeps its own `-i`).
		if on.contains(Attrs::NAMEREF) {
			var.attrs = var
				.attrs
				.without(Attrs::INTEGER)
				.without(Attrs::UPPER)
				.without(Attrs::LOWER)
				.without(Attrs::CAPITALIZE);
		}
		var.attrs = var
			.attrs
			.without(off)
			.with(on_value.without(Attrs::INDEXED).without(Attrs::ASSOC));
		// An unset reference made an array stops being a reference
		// (`declare -n foo; declare -a foo`).
		if on.bits() & (Attrs::INDEXED.bits() | Attrs::ASSOC.bits()) != 0
			&& !on.contains(Attrs::NAMEREF)
		{
			var.attrs = var.attrs.without(Attrs::NAMEREF);
		}
		if on.contains(Attrs::INDEXED)
			&& let VarValue::Str(s) = &var.value
		{
			let items = if exists && !var.attrs.contains(Attrs::INVISIBLE) {
				vec![(0, s.clone())]
			} else {
				Vec::new()
			};
			var.value = VarValue::Indexed(items);
		}
		// `declare -A` on a scalar keeps its value as key `0`.
		if on.contains(Attrs::ASSOC)
			&& let VarValue::Str(s) = &var.value
		{
			let items = if exists && !var.attrs.contains(Attrs::INVISIBLE) {
				vec![(BString::from("0"), s.clone())]
			} else {
				Vec::new()
			};
			var.value = VarValue::Assoc(items.into());
			// bash's `convert_var_to_assoc` makes a default-size table.
			if exists {
				var.attrs = var.attrs.with(Attrs::SMALL_HASH);
			}
		}
		// `declare -n name` on a set variable: its value becomes the
		// target, so it must be a variable name; a readonly one stays.
		if value.is_none()
			&& on.contains(Attrs::NAMEREF)
			&& !raw_ref
			&& let Some(r) = raw.as_ref().filter(|r| !r.attrs.contains(Attrs::INVISIBLE))
		{
			if r.attrs.contains(Attrs::READONLY) {
				ctx.err(Diag::Readonly { name: BString::from(name) });
				status = 1;
				continue;
			}
			if let Some(s) = r.as_scalar()
				&& !valid_ref_target(s)
			{
				ctx.usage(format!("`{}': invalid variable name for name reference", s.as_bstr()));
				status = 1;
				continue;
			}
		}
		match value {
			None => {
				if !exists {
					// `declare -i x`, `local x`, `declare -a x`: declared
					// with attributes, unset.
					var.attrs = var.attrs.with(Attrs::INVISIBLE);
				}
				if on.contains(Attrs::READONLY) {
					var.attrs = var.attrs.with(Attrs::READONLY);
				}
				ctx.set_var(name, Some(var), level);
				if binds_value {
					super::emit_assignment(ctx.k, ctx.cx, ctx.vp, name, level);
				}
				propagate_temp(ctx, name, kind, on, level);
			},
			Some(value) if on.contains(Attrs::NAMEREF) && index.is_none() => {
				// `declare -n ref=target`: the reference itself, never its
				// old target.
				// `declare -n ref+=x` appends to the reference's own value;
				// bash checks the result as `bind_variable_value` does, with
				// messages that carry no builtin name.
				let joined;
				let value: &[u8] = if append {
					let mut j = var.as_scalar().map_or_else(BString::default, BString::from);
					j.extend_from_slice(value);
					joined = j;
					&joined
				} else {
					value
				};
				// bash `check_selfref`: the name itself, or an element of it
				// (`local -n a=a[0]`).
				let element_of_self = value
					.strip_prefix(name)
					.is_some_and(|rest| rest.starts_with(b"[") && rest.ends_with(b"]"));
				if append && (value == name || element_of_self) {
					if !in_function {
						ctx.diag(Diag::Usage {
							msg: format!(
								"{}: nameref variable self references not allowed",
								name.as_bstr()
							)
							.into(),
						});
						status = 1;
						continue;
					}
					ctx.diag(Diag::CircularNameref { name: name.into() });
				} else if value == name || element_of_self {
					if level != Level::Local || !in_function {
						ctx.usage(format!(
							"{}: nameref variable self references not allowed",
							name.as_bstr()
						));
						status = 1;
						continue;
					}
					// In a function bash warns and makes the reference (a
					// reference to the name itself warns twice, and later
					// resolves to the global of that name).
					ctx.err(Diag::CircularNameref { name: name.into() });
					if value == name {
						ctx.diag(Diag::CircularNameref { name: name.into() });
					}
				}
				if value.is_empty() {
					ctx.err(Diag::InvalidIdent { name: BString::default() });
					status = 1;
					continue;
				}
				// `declare -in b='a[0]'`: the integer attribute evaluates the
				// value first; a number names no variable, and bash drops
				// the reference it was making without a message.
				if var.attrs.contains(Attrs::INTEGER) {
					match arith_value(ctx.k, ctx.cx, ctx.vp, value) {
						Err(d) => ctx.err(d),
						Ok(_) if !exists => ctx.set_var(name, None, level),
						Ok(_) => {},
					}
					status = 1;
					continue;
				}
				if !valid_ref_target(value) {
					ctx.usage(format!(
						"`{}': invalid variable name for name reference",
						value.as_bstr()
					));
					status = 1;
					continue;
				}
				var.value = VarValue::Str(BString::from(value));
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
				if on.contains(Attrs::READONLY) {
					var.attrs = var.attrs.with(Attrs::READONLY);
				}
				ctx.set_var(name, Some(var), level);
				super::emit_assignment(ctx.k, ctx.cx, ctx.vp, name, level);
			},
			Some(value)
				if index.is_none()
					&& !valid_ref_target(value)
					&& raw.as_ref().is_some_and(|r| {
						r.attrs.contains(Attrs::NAMEREF) && r.attrs.contains(Attrs::INVISIBLE)
					}) =>
			{
				// An unset reference given a value that is no name: in the
				// function that declared it bash refuses it as a reference
				// target; elsewhere the variable bash made for the value is
				// deleted again with the reference (`declare -n x; declare
				// x=42` leaves no `x`).
				let own_local = level == Level::Local && func_binds_local(ctx, name)?;
				if own_local {
					ctx.usage(format!(
						"`{}': invalid variable name for name reference",
						value.as_bstr()
					));
				} else {
					ctx.err(Diag::InvalidIdent { name: BString::from(value) });
					ctx.set_var(name, None, level);
				}
				status = 1;
			},
			Some(value) => {
				// `declare -a e[10]='(test)'`: with an array attribute the
				// subscript is ignored and the value is a compound one.
				let array_flag = on.bits() & (Attrs::INDEXED.bits() | Attrs::ASSOC.bits()) != 0;
				let array_exists = exists && !matches!(var.value, VarValue::Str(_));
				let parens = value.starts_with(b"(") && value.ends_with(b")");
				let compound = parens
					&& (index.is_none() || array_flag)
					&& (compound_word
						|| on.contains(Attrs::INDEXED)
						|| on.contains(Attrs::ASSOC)
						// `declare a='(…)'` on an array is still compound;
						// `readonly`/`export` assign the text.
						|| (matches!(kind, DeclareKind::Declare | DeclareKind::Local)
							&& !matches!(var.value, VarValue::Str(_))));
				let assign_value = if !compound {
					AssignValue::Scalar(BString::from(value))
				} else if compound_word {
					// Expanded already, and rebuilt as quoted text.
					AssignValue::Array(parse_compound(&value[1..value.len() - 1]))
				} else {
					// A string: its words are expanded now (bash
					// `expand_compound_array_assignment`), before anything
					// changes, since a command substitution re-runs `declare`.
					let assoc = on.contains(Attrs::ASSOC) || matches!(var.value, VarValue::Assoc(_));
					match compound_from_string(ctx, &value[1..value.len() - 1], assoc)? {
						Ok(elems) => AssignValue::Array(elems),
						Err(d) => {
							ctx.err(d);
							status = 1;
							continue;
						},
					}
				};
				// `declare a[1]='(var)'` on no array: a plain element value,
				// with bash's warning naming the word.
				if parens && !compound_word && index.is_some() && !array_flag && !array_exists {
					ctx.diag(Diag::Warning {
						msg: format!(
							"warning: {}: quoted compound array assignment deprecated",
							arg.as_bstr()
						)
						.into(),
					});
				}
				// `declare a[1]=v` makes `a` an indexed array.
				if index.is_some()
					&& !array_flag
					&& let VarValue::Str(s) = &var.value
				{
					let items = if exists && !var.attrs.contains(Attrs::INVISIBLE) {
						vec![(0, s.clone())]
					} else {
						Vec::new()
					};
					var.value = VarValue::Indexed(items);
				}
				ctx.set_var(name, Some(var), level);
				// bash expands a `declare` argument's subscript again (quote
				// removal), unlike an assignment word's.
				let index = index
					.filter(|_| !compound)
					.map(|i| unquote_until(i, 0, b"").0);
				// `declare a[]=v` / `declare 'a[""]=v'`: the array is made,
				// the element is a bad subscript.
				if index.as_ref().is_some_and(|i| i.is_empty()) {
					ctx.err(Diag::BadSubscript { shown: element_text(name, b"") });
					status = 1;
					continue;
				}
				let lhs = Lhs { name, index: index.as_ref().map(|i| i.as_slice()), append };
				match set_value(ctx.k, ctx.cx, ctx.vp, lhs, assign_value, level) {
					Ok(()) => {},
					// An arithmetic error in a subscript abandons the rest of
					// the line (bash `jump_to_top_level (DISCARD)`).
					Err(d @ Diag::ArithSubscript { .. }) => {
						ctx.diag(d);
						return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
					},
					Err(d) => {
						ctx.err(d);
						status = 1;
						continue;
					},
				}
				if on.contains(Attrs::READONLY)
					&& let Some(mut v) = current(ctx.k, ctx.cx, ctx.vp, name, level).ok().flatten()
				{
					v.attrs = v.attrs.with(Attrs::READONLY);
					ctx.set_var(name, Some(v), level);
				}
				propagate_temp(ctx, name, kind, on, level);
			},
		}
	}
	done(status)
}

/// The `(key, append, value)` elements of a compound value
/// ([`AssignValue::Array`]).
type Elems = Vec<(Option<BString>, bool, BString)>;

/// The elements of a compound value `declare` got as a string (`text`
/// inside the parentheses), expanded by [`expand::compound_string`]. A
/// command substitution parks the builtin ([`Need::Sub`]); `Err` inside is
/// the error to report.
fn compound_from_string(
	ctx: &mut Ctx<'_, '_>,
	text: &[u8],
	assoc: bool,
) -> Result<Result<Elems, Diag>, Need> {
	match expand::compound_string(
		ctx.k,
		ctx.cx,
		ctx.vp,
		ctx.line,
		&mut ctx.log,
		&mut ctx.log_cursor,
		text,
		assoc,
	) {
		Ok(elems) => Ok(Ok(elems
			.into_iter()
			.map(|e| (e.key, e.append, e.value))
			.collect())),
		Err(expand::Stop::Fail(d) | expand::Stop::Fatal(d)) => Ok(Err(d)),
		Err(expand::Stop::Store(e)) => Err(Need::Store(e)),
		// A substitution or probe to run first.
		Err(sub) => Err(Need::Sub(sub)),
	}
}

/// bash `builtin_find_indexed_array` for `read -a` and `mapfile`: whether
/// `name` can take an indexed array, reporting why not (`None`). An unset
/// name reference stops being one: bash warns `removing nameref
/// attribute`, and `Some(true)` asks the caller to [`strip_nameref`] once
/// it can no longer be re-run for a probe. A reference to an element
/// (`XXX[0]`) is no identifier; a readonly variable and an associative
/// array are refused. Changes no state.
///
/// # Errors
/// [`Need`] when a variable must be fetched first.
pub fn indexed_array_target(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<bool>, Need> {
	let mut target = BString::from(name);
	let mut strip = false;
	if let Some(raw) = declared(ctx, name)?
		&& raw.attrs.contains(Attrs::NAMEREF)
	{
		if raw.attrs.contains(Attrs::INVISIBLE) {
			ctx.diag(Diag::Warning {
				msg: format!("warning: {}: removing nameref attribute", name.as_bstr()).into(),
			});
			strip = true;
		} else {
			match state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)? {
				state::Deref::To { name: t, index: None } => target = t,
				state::Deref::To { name: t, index: Some(i) } => {
					ctx.err(Diag::InvalidIdent { name: element_text(&t, &i) });
					return Ok(None);
				},
				state::Deref::Plain | state::Deref::Circular => {},
			}
		}
	}
	let Some(var) = declared(ctx, &target)? else {
		return Ok(Some(strip));
	};
	if var.attrs.contains(Attrs::READONLY) {
		ctx.diag(Diag::Readonly { name: target });
		return Ok(None);
	}
	if !strip && (matches!(var.value, VarValue::Assoc(_)) || var.attrs.contains(Attrs::ASSOC)) {
		ctx.usage(format!("{}: not an indexed array", name.as_bstr()));
		return Ok(None);
	}
	Ok(Some(strip))
}

/// Drop the name-reference attribute of the unset reference `name` (see
/// [`indexed_array_target`]).
///
/// # Errors
/// [`Need`] when the variable must be fetched first.
pub fn strip_nameref(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<(), Need> {
	if let Some(mut raw) = declared(ctx, name)? {
		raw.attrs = raw.attrs.without(Attrs::NAMEREF);
		ctx.set_var(name, Some(raw), Level::Dynamic);
	}
	Ok(())
}

/// A name a reference may hold: a variable name, optionally with a
/// subscript (`a[1]`).
fn valid_ref_target(value: &[u8]) -> bool {
	let base = match value.iter().position(|&c| c == b'[') {
		Some(open) if value.ends_with(b"]") => &value[..open],
		_ => value,
	};
	is_ident(base)
}

/// The variable a new local starts as (`local x` / `declare x` in a
/// function, before its own attributes and value): the innermost
/// temporary environment's value (`x=y local x`), else, with `shopt -s
/// localvar_inherit`, a copy of the variable the caller sees; else none.
fn new_local_start(ctx: &mut Ctx<'_, '_>, name: &[u8], inherit: bool) -> Result<Option<Var>, Need> {
	if let Some(top) = temp_scope(ctx)?
		&& let Some(Some(temp)) = state::scope_var(ctx.cx.store, ctx.vp, top, name)?
	{
		return Ok(Some(Var { attrs: Attrs::NONE, value: temp.value }));
	}
	if inherit || ctx.option(OptId::LocalvarInherit)? {
		// A declared-but-unset outer variable passes its attributes on.
		return Ok(declared(ctx, name)?
			.map(|v| Var { attrs: v.attrs.without(Attrs::READONLY), value: v.value }));
	}
	Ok(None)
}

/// bash copies a variable out of the temporary environment when
/// `export`/`readonly` (or `declare` with attributes) acts on it there:
/// `x=5 export x` leaves `x=5` exported after the command.
fn propagate_temp(ctx: &mut Ctx<'_, '_>, name: &[u8], kind: DeclareKind, on: Attrs, level: Level) {
	let applies = match kind {
		DeclareKind::Export => on.contains(Attrs::EXPORT),
		DeclareKind::Readonly => true,
		DeclareKind::Declare => on != Attrs::NONE && level != Level::Local,
		DeclareKind::Local => false,
	};
	if !applies {
		return;
	}
	let var = temp_scope(ctx).and_then(|top| match top {
		Some(top) => Ok(Some((top, state::scope_var(ctx.cx.store, ctx.vp, top, name)?))),
		None => Ok(None),
	});
	match var {
		Ok(Some((top, Some(Some(var))))) => {
			state::store_var_below(&mut ctx.k.root, ctx.cx.store, ctx.vp, name, Some(var), top);
		},
		Ok(_) => {},
		Err(e) => ctx.k.fail(e),
	}
}

/// Whether a variable with attribute `letters` has every attribute of
/// `filter` (`readonly -a` lists the readonly arrays).
fn has_every_attr(letters: &[u8], filter: Attrs) -> bool {
	ATTR_FLAGS
		.iter()
		.filter(|&&(_, a)| filter.contains(a))
		.all(|&(l, _)| letters.contains(&l))
}

/// `declare -f`/`-F`, `export -f`, `readonly -f`.
fn declare_functions(
	ctx: &mut Ctx<'_, '_>,
	o: &super::Opts<'_>,
	kind: DeclareKind,
	on: Attrs,
	off: Attrs,
) -> R {
	// bash rejects the value attributes on functions, reporting the first
	// of `-n`, `-i`, `-A`, `-a` given.
	if matches!(kind, DeclareKind::Declare | DeclareKind::Local)
		&& let Some(&(c, _)) = [
			(b'n', Attrs::NAMEREF),
			(b'i', Attrs::INTEGER),
			(b'A', Attrs::ASSOC),
			(b'a', Attrs::INDEXED),
		]
		.iter()
		.find(|&&(_, a)| on.contains(a))
	{
		ctx.usage(format!("-{}: invalid option", char::from(c)));
		return done(1);
	}
	let modify = !o.rest.is_empty()
		&& !o.has(b'p')
		&& (kind != DeclareKind::Declare || on != Attrs::NONE || off != Attrs::NONE);
	let names_only = o.has(b'F');
	let mut out = Vec::new();
	let mut status = 0;
	// `declare -f[rx] NAME`.
	let attr_line = |out: &mut Vec<u8>, name: &[u8], attrs: Attrs| {
		out.extend_from_slice(b"declare -f");
		for (a, c) in [(Attrs::READONLY, b'r'), (Attrs::EXPORT, b'x')] {
			if attrs.contains(a) {
				out.push(c);
			}
		}
		out.push(b' ');
		out.extend_from_slice(name);
		out.push(b'\n');
	};
	if o.rest.is_empty() {
		// Attribute flags (`-x`, `export -f`, `readonly -f`) filter the
		// listing, and each body is then followed by its attribute line.
		let filter = on.without(Attrs::INDEXED).without(Attrs::ASSOC);
		for (name, source, attrs) in all_functions(ctx)? {
			if !attrs.contains(filter) {
				continue;
			}
			if names_only {
				attr_line(&mut out, &name, attrs);
				continue;
			}
			out.extend_from_slice(&source);
			out.push(b'\n');
			if attrs.bits() & (Attrs::READONLY.bits() | Attrs::EXPORT.bits()) != 0 {
				attr_line(&mut out, &name, attrs);
			}
		}
		ctx.out(&out);
		return done(0);
	}
	for name in o.rest {
		// bash will not put a function whose name has `=` or `/` in the
		// environment.
		if kind == DeclareKind::Export && name.iter().any(|&c| matches!(c, b'=' | b'/')) {
			ctx.out(&std::mem::take(&mut out));
			ctx.usage(format!("{}: cannot export", name.as_bstr()));
			status = 1;
			continue;
		}
		if kind == DeclareKind::Declare && name.contains(&b'=') {
			ctx.out(&std::mem::take(&mut out));
			ctx.usage("cannot use `-f' to make functions");
			status = 1;
			continue;
		}
		if let Some(Record::Func { mode, sticky, source, unit, attrs, file }) = ctx.function(name)? {
			if modify && off.contains(Attrs::READONLY) && attrs.contains(Attrs::READONLY) {
				ctx.out(&std::mem::take(&mut out));
				ctx.usage(format!("{}: readonly function", name.as_bstr()));
				status = 1;
			} else if modify {
				let attrs = attrs
					.without(off)
					.with(on.without(Attrs::INDEXED).without(Attrs::ASSOC));
				ctx.store_record(
					KeyBuf::Func(name.clone()),
					Some(Record::Func { mode, sticky, source, unit, attrs, file }),
				);
			} else if names_only {
				out.extend_from_slice(name);
				// `extdebug`: the line and file it was defined in.
				if ctx.option(OptId::Extdebug)? {
					let line = crate::bash::vm::frames::load_unit(
						&ctx.k.engine,
						ctx.cx.store,
						unit,
						ctx.k
							.mask
							.contains(crate::bash::event::EventKind::UnitCompiled),
					)
					.map_or(0, |u| crate::bash::vm::callstack::definition_line(&u));
					out.push(b' ');
					out.extend_from_slice(line.to_string().as_bytes());
					out.push(b' ');
					out.extend_from_slice(&file);
				}
				out.push(b'\n');
			} else {
				out.extend_from_slice(&source);
				out.push(b'\n');
				if o.has(b'p') && attrs.bits() & (Attrs::READONLY.bits() | Attrs::EXPORT.bits()) != 0 {
					attr_line(&mut out, name, attrs);
				}
			}
		} else {
			if kind != DeclareKind::Declare {
				ctx.out(&std::mem::take(&mut out));
				ctx.err(Diag::Usage { msg: format!("{}: not a function", name.as_bstr()).into() });
			} else if o.has(b'p') {
				ctx.out(&std::mem::take(&mut out));
				ctx.err(Diag::NotFound { name: name.clone() });
			}
			status = 1;
		}
	}
	ctx.out(&out);
	done(status)
}

/// `unset -f name`: a readonly function stays (status 1).
fn unset_function(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<i32, Need> {
	match ctx.function(name)? {
		Some(Record::Func { attrs, .. }) if attrs.contains(Attrs::READONLY) => {
			ctx.usage(format!("{}: cannot unset: readonly function", name.as_bstr()));
			Ok(1)
		},
		Some(_) => {
			ctx.store_record(KeyBuf::Func(BString::from(name)), None);
			Ok(0)
		},
		None => Ok(0),
	}
}

/// `arg` as an array reference `name[sub]` (bash's
/// `tokenize_array_reference`): the offsets of its `[` and closing `]`,
/// which must end the word around a non-empty subscript. The `]` is
/// found as `skipsubscript` does: past quotes, escapes, substitutions and
/// nested brackets, except for an associative array named with
/// `noexpand`, where the first `]` closes it, or, for a word written as
/// a reference (`arrayref`), the last character.
pub fn array_reference(
	ctx: &mut Ctx<'_, '_>,
	arg: &[u8],
	noexpand: bool,
	arrayref: bool,
) -> Result<Option<(usize, usize)>, Need> {
	let Some(open) = arg.find_byte(b'[') else {
		return Ok(None);
	};
	if !is_ident(&arg[..open]) {
		return Ok(None);
	}
	let assoc = noexpand
		&& declared(ctx, &arg[..open])?.is_some_and(|v| matches!(v.value, VarValue::Assoc(_)));
	let close = if assoc && arrayref {
		Some(arg.len() - 1)
	} else {
		subscript_end(arg, open + 1, assoc)
	};
	Ok(close
		.filter(|&c| c == arg.len() - 1 && c > open + 1 && arg[c] == b']')
		.map(|c| (open, c)))
}

/// Whether a builtin may assign to `name` (`read`, `printf -v`): an
/// identifier, or an array reference as bash's `valid_array_reference`
/// checks it, with `assoc_expand_once` meaning an associative array's
/// subscript ends at its first `]` (`read 'a[80'"'"'s]'` is invalid
/// unless it is on), or, for a word written as an array reference
/// (argv index `at` in [`Ctx::arrayref`]), at the word's end
/// (`printf -v A[$rkey]` with `rkey=']'`; bash's `SET_VFLAGS`).
///
/// # Errors
/// [`Need`] when a variable or option must be fetched first.
pub fn assignable_name(ctx: &mut Ctx<'_, '_>, name: &[u8], at: usize) -> Result<bool, Need> {
	if is_ident(name) {
		return Ok(true);
	}
	let noexpand = ctx.option(OptId::AssocExpandOnce)?;
	let arrayref = noexpand && u32::try_from(at).is_ok_and(|at| ctx.arrayref.contains(&at));
	Ok(array_reference(ctx, name, noexpand, arrayref)?.is_some())
}

/// bash's `skip_matched_pair` for `[`/`]` from just after the `[`: the
/// index of the matching `]`. `flat` (its flag 1) ignores quoting and
/// nesting: the first `]` closes.
fn subscript_end(s: &[u8], mut i: usize, flat: bool) -> Option<usize> {
	if flat {
		return s[i..].find_byte(b']').map(|e| i + e);
	}
	let mut depth = 1usize;
	while let Some(&c) = s.get(i) {
		match c {
			b'\\' => i += 2,
			b'`' => i += s.get(i + 1..)?.find_byte(b'`')? + 2,
			b'\'' => i += s.get(i + 1..)?.find_byte(b'\'')? + 2,
			b'"' => {
				i += 1;
				loop {
					match *s.get(i)? {
						b'\\' => i += 2,
						b'"' => break,
						_ => i += 1,
					}
				}
				i += 1;
			},
			b'$' if matches!(s.get(i + 1), Some(b'(' | b'{')) => {
				let (open, close) = if s[i + 1] == b'(' {
					(b'(', b')')
				} else {
					(b'{', b'}')
				};
				let mut d = 1usize;
				i += 2;
				while d > 0 {
					let c = *s.get(i)?;
					if c == open {
						d += 1;
					} else if c == close {
						d -= 1;
					}
					i += 1;
				}
			},
			b'[' => {
				depth += 1;
				i += 1;
			},
			b']' => {
				depth -= 1;
				if depth == 0 {
					return Some(i);
				}
				i += 1;
			},
			_ => i += 1,
		}
	}
	None
}

/// `unset [-fvn] name …`.
pub fn unset(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"fvn", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if o.has(b'f') && o.has(b'v') {
		ctx.usage("cannot simultaneously unset a function and a variable");
		return done(1);
	}
	let mut status = 0;
	let first = args.len() - o.rest.len();
	let expand_once = ctx.option(OptId::AssocExpandOnce)?;
	for (j, arg) in o.rest.iter().enumerate() {
		// bash's variables with the `nounset` attribute.
		if !o.has(b'f')
			&& matches!(arg.as_slice(), b"BASH_LINENO" | b"BASH_SOURCE" | b"BASH_ARGC" | b"BASH_ARGV")
		{
			ctx.usage(format!("{}: cannot unset", arg.as_bstr()));
			status = 1;
			continue;
		}
		// A word written as an array reference (bash's `W_ARRAYREF`) names
		// its key verbatim; otherwise the key is expanded again unless
		// `assoc_expand_once`.
		let arrayref = ctx.arrayref.contains(&((1 + first + j) as u32));
		let noexpand = arrayref || expand_once;
		let (name, index) = if o.has(b'f') || o.has(b'n') {
			(arg.as_slice(), None)
		} else {
			match array_reference(ctx, arg, noexpand, arrayref)? {
				Some((open, close)) => (&arg[..open], Some(&arg[open + 1..close])),
				None => (arg.as_slice(), None),
			}
		};
		// Without `-v`, a name that cannot be a variable may still name a
		// function (`unset /bin/sh` is silent).
		if o.has(b'f') || (!is_ident(name) && !o.has(b'v') && index.is_none()) {
			status |= unset_function(ctx, arg)?;
			continue;
		}
		if !is_ident(name) {
			ctx.err(Diag::InvalidIdent { name: arg.clone() });
			ctx.usage_error = true;
			status = 1;
			continue;
		}
		// `unset ref` unsets the reference's target; `unset -n ref` the
		// reference itself.
		let deref_target;
		let mut via_ref = false;
		let (name, index) = if o.has(b'n') {
			(name, index)
		} else if index.is_some() {
			// `unset 'ref[1]'`: an element of the reference's target.
			match state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)? {
				state::Deref::To { name: target, index: None } => {
					deref_target = (target, None);
					(deref_target.0.as_slice(), index)
				},
				_ => (name, index),
			}
		} else {
			match state::deref(&ctx.k.root, ctx.cx.store, ctx.vp, name)? {
				state::Deref::To { name: target, index: tindex } => {
					via_ref = true;
					deref_target = (target, tindex);
					(deref_target.0.as_slice(), deref_target.1.as_ref().map(|i| i.as_slice()))
				},
				state::Deref::Plain | state::Deref::Circular => (name, index),
			}
		};
		let var = state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, name)?.map(|v| {
			(
				v.attrs,
				matches!(v.value, VarValue::Assoc(_)),
				matches!(v.value, VarValue::Str(_)),
				v.next_index(),
			)
		});
		if var.is_none() && !o.has(b'v') && !o.has(b'n') && index.is_none() {
			status |= unset_function(ctx, name)?;
			continue;
		}
		let Some((attrs, assoc, scalar, next)) = var else {
			continue;
		};
		// `unset -n` acts on a name reference only (bash
		// `find_variable_last_nameref`, `unbind_nameref`): any other
		// variable stays.
		if o.has(b'n') && !attrs.contains(Attrs::NAMEREF) {
			continue;
		}
		if attrs.contains(Attrs::READONLY) {
			ctx.err(Diag::Usage {
				msg: format!("{}: cannot unset: readonly variable", name.as_bstr()).into(),
			});
			// Fatal to a posix shell.
			ctx.usage_error = true;
			status = 1;
			continue;
		}
		match index {
			None => {
				let keep = ctx.option(OptId::LocalvarUnset)?;
				state::unset_var(&mut ctx.k.root, ctx.cx.store, ctx.vp, name, keep);
				if super::names::resets_hash(ctx.k.engine.config().platform, name) {
					super::names::flush_hash(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
				}
				if is_posix_var(name) {
					match var_option(name) {
						OptId::Posix => state::set_posix(&mut ctx.k.root, ctx.cx.store, ctx.vp, false)?,
						opt => ctx.set_option(opt, false),
					}
					state::sync_option_vars(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
				}
			},
			Some(idx) => {
				// Without `assoc_expand_once`, bash expands an associative
				// key again (`unset 'assoc[$var]'` removes `assoc[x123]`),
				// and an index's expansions before evaluating it
				// (`unset 'b[$(echo 1)]'`; a substitution may park).
				let expanded;
				let again = if assoc {
					!noexpand
				} else {
					!noexpand && idx.iter().any(|c| matches!(c, b'$' | b'`'))
				};
				let idx = if again {
					// An index is expanded as arithmetic text (bash's
					// `array_expand_index`).
					let res = if assoc {
						ctx.expand_subscript(idx)?
					} else {
						ctx.expand_index_subscript(idx)?
					};
					match res {
						Ok(k) => {
							expanded = k;
							expanded.as_slice()
						},
						Err(d) => {
							ctx.err(d);
							status = 1;
							continue;
						},
					}
				} else {
					idx
				};
				let elem = if assoc {
					Elem::Key(BStr::new(idx))
				} else {
					if matches!(idx, b"@" | b"*") && !scalar {
						// bash 5.3 empties the array (attributes kept);
						// `BASH_COMPAT` 5.1 and before unset it.
						let compat = ctx.var(b"BASH_COMPAT")?.and_then(|v| {
							let s = v.as_scalar()?;
							let digits: Vec<u8> = s.iter().copied().filter(|&c| c != b'.').collect();
							std::str::from_utf8(&digits).ok()?.parse::<u32>().ok()
						});
						if compat.is_some_and(|c| c <= 51) {
							ctx.set_var(name, None, Level::Dynamic);
							continue;
						}
						if let Some(mut var) = declared(ctx, name)? {
							if let VarValue::Indexed(items) = &mut var.value {
								items.clear();
							}
							ctx.set_var(name, Some(var), Level::Dynamic);
						}
						continue;
					}
					let i = match subscript_value(ctx.k, ctx.cx, ctx.vp, idx) {
						// Through a reference bash ignores it silently.
						Ok(i) if via_ref && scalar && i != 0 => continue,
						Ok(i) if scalar && (i != 0 || matches!(idx, b"@" | b"*")) => {
							ctx.err(Diag::Usage {
								msg: format!("{}: not an array variable", name.as_bstr()).into(),
							});
							status = 1;
							continue;
						},
						Ok(i) => i,
						Err(_) if scalar && matches!(idx, b"@" | b"*") => {
							ctx.err(Diag::Usage {
								msg: format!("{}: not an array variable", name.as_bstr()).into(),
							});
							status = 1;
							continue;
						},
						Err(d) => {
							ctx.err(d);
							status = 1;
							continue;
						},
					};
					let i = if i < 0 { next + i } else { i };
					if i < 0 {
						ctx.err(Diag::Usage {
							msg: format!("[{}]: bad array subscript", idx.as_bstr()).into(),
						});
						status = 1;
						continue;
					}
					if scalar && i == 0 {
						ctx.set_var(name, None, Level::Dynamic);
						continue;
					}
					Elem::Index(i)
				};
				state::edit_var(
					&mut ctx.k.root,
					ctx.cx.store,
					ctx.vp,
					name,
					Level::Dynamic,
					VarEdit::Remove(elem),
				)?;
			},
		}
	}
	done(status)
}

/// `shift [n]`.
pub fn shift(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let args = match args.split_first() {
		Some((first, rest)) if first.as_slice() == b"--" => rest,
		_ => args,
	};
	if args.len() > 1 {
		// Not fatal to a posix shell (errors10).
		ctx.diag(Diag::TooManyArgs { cmd: "shift".into() });
		return done(2);
	}
	let n = match args.first() {
		None => 1,
		Some(a) => match number(a) {
			Some(n) if n >= 0 => n as usize,
			Some(_) => {
				ctx.err(Diag::Usage {
					msg: format!("{}: shift count out of range", a.as_bstr()).into(),
				});
				return done(1);
			},
			None => {
				ctx.diag(Diag::NumericArg { cmd: "shift".into(), arg: a.clone() });
				ctx.usage_error = true;
				return done(2);
			},
		},
	};
	let mut params = ctx.positional()?;
	if n > params.len() {
		if ctx.option(OptId::ShiftVerbose)? {
			ctx.err(Diag::Usage { msg: format!("{n}: shift count out of range").into() });
		}
		return done(1);
	}
	params.drain(..n);
	state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, params);
	done(0)
}

/// `set` options and positional parameters.
pub fn set(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if args.is_empty() {
		let mut out = Vec::new();
		for (name, var) in all_vars(ctx, false)? {
			set_line(&name, &var, &mut out);
		}
		for (_, source, _) in all_functions(ctx)? {
			out.extend_from_slice(&source);
			out.push(b'\n');
		}
		ctx.out(&out);
		return done(0);
	}
	let mut i = 0;
	let mut changes: Vec<(OptId, bool)> = Vec::new();
	let mut positional = None;
	while let Some(a) = args.get(i) {
		let on = match a.first() {
			Some(b'-') => true,
			Some(b'+') => false,
			_ => {
				positional = Some(args[i..].to_vec());
				break;
			},
		};
		if a.as_slice() == b"--" {
			positional = Some(args[i + 1..].to_vec());
			break;
		}
		if a.as_slice() == b"-" {
			changes.push((OptId::Xtrace, false));
			changes.push((OptId::Verbose, false));
			if args.len() > i + 1 {
				positional = Some(args[i + 1..].to_vec());
			}
			break;
		}
		i += 1;
		for &c in &a[1..] {
			if c == b'o' {
				// A following option word is no option name: bash lists
				// the options, then goes on (`set -o -B`).
				if let Some(name) = args
					.get(i)
					.filter(|n| !matches!(n.first(), Some(b'-' | b'+')))
				{
					i += 1;
					let Some(opt) = OptId::from_name(name).filter(|o| o.kind() == OptKind::Set) else {
						ctx.err(Diag::Usage {
							msg: format!("{}: invalid option name", name.as_bstr()).into(),
						});
						return done(1);
					};
					changes.push((opt, on));
				} else {
					let mut out = Vec::new();
					list_set_options(ctx, on, &mut out)?;
					ctx.out(&out);
				}
				continue;
			}
			let Some(opt) = set_flag(c) else {
				let sign = if on { '-' } else { '+' };
				ctx.err(Diag::Usage { msg: format!("{sign}{}: invalid option", c as char).into() });
				ctx.builtin_usage();
				return done(2);
			};
			changes.push((opt, on));
		}
	}
	let changed = !changes.is_empty();
	for (opt, on) in changes {
		change_option(ctx, opt, on);
	}
	if changed {
		state::sync_option_vars(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
	}
	if let Some(p) = positional {
		state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, p);
	}
	done(0)
}

/// Set an option with bash's variable side effects: `ignoreeof` binds
/// `IGNOREEOF=10` (unbinds it when off), `posix` binds
/// `POSIXLY_CORRECT=y` and turns `expand_aliases` on (off sets it back
/// to the interactive shell's default).
fn change_option(ctx: &mut Ctx<'_, '_>, opt: OptId, on: bool) {
	ctx.set_option(opt, on);
	// bash 5.3's `array_expand_once` and `assoc_expand_once` are one
	// variable under two names.
	match opt {
		OptId::ArrayExpandOnce => ctx.set_option(OptId::AssocExpandOnce, on),
		OptId::AssocExpandOnce => ctx.set_option(OptId::ArrayExpandOnce, on),
		_ => {},
	}
	// POSIX mode reports shift errors (bash's `print_shift_error`).
	if opt == OptId::Posix {
		ctx.set_option(OptId::ShiftVerbose, on);
		if let Err(e) = state::set_posix(&mut ctx.k.root, ctx.cx.store, ctx.vp, on) {
			ctx.k.fail(e);
		}
	}
	let (name, value): (&[u8], &str) = match opt {
		OptId::Ignoreeof => (b"IGNOREEOF", "10"),
		OptId::Posix => (b"POSIXLY_CORRECT", "y"),
		_ => return,
	};
	let var = on.then(|| Var::scalar(value, Attrs::NONE));
	ctx.set_var(name, var, Level::Dynamic);
}

/// The option of a `set -X` letter.
fn set_flag(c: u8) -> Option<OptId> {
	use strum::IntoEnumIterator;
	OptId::iter().find(|o| o.flag() == Some(c))
}

/// `set -o` / `set +o` listings.
fn list_set_options(ctx: &mut Ctx<'_, '_>, minus: bool, out: &mut Vec<u8>) -> Result<(), Need> {
	use strum::IntoEnumIterator;
	let mut opts: Vec<OptId> = OptId::iter().filter(|o| o.kind() == OptKind::Set).collect();
	opts.sort_by_key(|o| <&'static str>::from(*o));
	for opt in opts {
		let on = ctx.option(opt)?;
		let name: &'static str = opt.into();
		if minus {
			out.extend_from_slice(
				format!("{name:<15}\t{}\n", if on { "on" } else { "off" }).as_bytes(),
			);
		} else {
			out.extend_from_slice(format!("set {}o {name}\n", if on { '-' } else { '+' }).as_bytes());
		}
	}
	Ok(())
}

/// `shopt [-pqsuo] [name …]`.
pub fn shopt(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"pqsuo", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (set, unset) = (o.has(b's'), o.has(b'u'));
	if set && unset {
		ctx.usage("cannot set and unset shell options simultaneously");
		return done(1);
	}
	let kind = if o.has(b'o') {
		OptKind::Set
	} else {
		OptKind::Shopt
	};
	let quiet = o.has(b'q');
	let mut status = 0;
	let mut named = Vec::with_capacity(o.rest.len());
	for name in o.rest {
		if let Some(opt) = OptId::from_name(name).filter(|opt| opt.kind() == kind) {
			named.push(opt);
		} else {
			let what = if kind == OptKind::Set {
				"invalid option name"
			} else {
				"invalid shell option name"
			};
			ctx.err(Diag::Usage { msg: format!("{}: {what}", name.as_bstr()).into() });
			status = 1;
		}
	}
	if (set || unset) && !o.rest.is_empty() {
		// `login_shell` and `restricted_shell` report the process; setting
		// them is silently ignored.
		for opt in named
			.into_iter()
			.filter(|o| !matches!(o, OptId::LoginShell | OptId::RestrictedShell))
		{
			change_option(ctx, opt, set);
			// bash's `shopt_set_debug_mode`: `extdebug` sets `errtrace` and
			// `functrace` with it, and on pushes the `BASH_ARGV` base.
			if opt == OptId::Extdebug {
				change_option(ctx, OptId::Errtrace, set);
				change_option(ctx, OptId::Functrace, set);
				if set {
					crate::bash::vm::callstack::read_base(ctx.k, ctx.cx.store, ctx.vp)?;
				}
			}
		}
		state::sync_option_vars(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
		return done(status);
	}
	// Listing: every option (filtered by state for `-s`/`-u`), or the
	// named ones (status 1 when one is off).
	let listed: Vec<OptId> = if o.rest.is_empty() {
		options_of(kind)
	} else {
		named
	};
	let mut out = Vec::new();
	for opt in listed {
		let on = ctx.option(opt)?;
		if (set || unset) && on != set {
			continue;
		}
		if !on && !o.rest.is_empty() {
			status = 1;
		}
		if !quiet {
			option_line(opt, on, o.has(b'p'), !o.rest.is_empty(), &mut out);
		}
	}
	ctx.out(&out);
	done(status)
}

/// Every option of `kind`, in bash's listing order (alphabetical).
fn options_of(kind: OptKind) -> Vec<OptId> {
	use strum::IntoEnumIterator;
	let mut all: Vec<OptId> = OptId::iter().filter(|opt| opt.kind() == kind).collect();
	all.sort_by_key(|opt| <&'static str>::from(*opt));
	all
}

/// One `shopt` listing line: `shopt -s NAME` / `set -o NAME` (`reusable`),
/// else `NAME<tab>on` padded as bash pads it: 20 columns, except 15 for
/// the full `set -o` option list (`named` is false).
fn option_line(opt: OptId, on: bool, reusable: bool, named: bool, out: &mut Vec<u8>) {
	let name: &'static str = opt.into();
	let state = if on { "on" } else { "off" };
	let text = match (opt.kind(), reusable) {
		(OptKind::Set, true) => format!("set {}o {name}\n", if on { '-' } else { '+' }),
		(OptKind::Shopt, true) => format!("shopt {} {name}\n", if on { "-s" } else { "-u" }),
		(OptKind::Set, false) if !named => format!("{name:<15}\t{state}\n"),
		(_, false) => format!("{name:<20}\t{state}\n"),
	};
	out.extend_from_slice(text.as_bytes());
}

/// `let expr …`.
pub fn let_(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash skips one leading `--`.
	let args = match args.split_first() {
		Some((first, rest)) if first.as_slice() == b"--" => rest,
		_ => args,
	};
	if args.is_empty() {
		ctx.usage("expression expected");
		return done(1);
	}
	// With `assoc_expand_once` bash treats `let`'s words as expanded
	// already: subscripts keep their quotes.
	let expanded = ctx.option(OptId::AssocExpandOnce)?;
	let mut last = 0;
	for a in args {
		match expand::arith_let(ctx.k, ctx.cx, ctx.vp, a, expanded) {
			Ok(v) => last = v,
			// An error in a subscript abandons the rest of the line, under
			// `bash -c` the whole string (bash's `top_level_cleanup` before
			// `jump_to_top_level (DISCARD)` in `array_expand_index`).
			Err(d @ Diag::ArithSubscript { .. }) => {
				ctx.diag(d);
				return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
			},
			// bash prints a readonly assignment without the `let: ` prefix.
			Err(d @ Diag::Readonly { .. }) => {
				ctx.diag(d);
				return done(1);
			},
			Err(d) => {
				ctx.err(d);
				return done(1);
			},
		}
	}
	done(i32::from(last == 0))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn compound_text_round_trips_the_expanders_quoting() {
		let elems = parse_compound(b"'a b' ['k']='v' [x]+=$'i\\n' \"q\\\"\" plain");
		assert_eq!(elems, vec![
			(None, false, BString::from("a b")),
			(Some(BString::from("k")), false, BString::from("v")),
			(Some(BString::from("x")), true, BString::from("i\n")),
			(None, false, BString::from("q\"")),
			(None, false, BString::from("plain")),
		]);
	}

	#[test]
	fn assignment_arguments_split_at_the_first_equals() {
		assert_eq!(
			split_assignment(b"a[1]+=x=y", false),
			(&b"a"[..], Some(&b"1"[..]), true, Some(&b"x=y"[..]))
		);
		assert_eq!(split_assignment(b"name", false), (&b"name"[..], None, false, None));
		assert_eq!(
			split_assignment(b"m[foo[bar]=bleh", true),
			(&b"m"[..], Some(&b"foo[bar"[..]), false, Some(&b"bleh"[..]))
		);
	}

	// Goldens: bash 5.3.20 `declare -p`.
	#[test]
	fn declare_p_formats_scalars_and_arrays() {
		let mut out = Vec::new();
		declare_line(b"x", Some(&Var::scalar("a\"b", Attrs::EXPORT)), &mut out);
		assert_eq!(out, b"declare -x x=\"a\\\"b\"");
		let uu = Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(vec![(0, "".into()), (1, "kghfjk".into()), (3, "i\n".into())]),
		};
		out.clear();
		declare_line(b"uu", Some(&uu), &mut out);
		assert_eq!(out, b"declare -a uu=([0]=\"\" [1]=\"kghfjk\" [3]=$'i\\n')");
		let m =
			Var { attrs: Attrs::NONE, value: VarValue::Assoc(vec![("k".into(), "v".into())].into()) };
		out.clear();
		declare_line(b"m", Some(&m), &mut out);
		assert_eq!(out, b"declare -A m=([k]=\"v\" )");
	}
}
