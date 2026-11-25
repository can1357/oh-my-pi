//! Lexical and package reference aliases (`perlref`, `feature 'refaliasing'`).

use super::{vars::Slot, *};

#[derive(Clone)]
pub(super) enum RefPlace {
	Pad { scope: usize, index: usize, pending: bool },
	Glob(Gv, Sigil),
	Array(Av, usize),
	Hash(Hv, HKey),
	Topic(usize),
}

pub(super) struct RefTarget { place: RefPlace, sigil: Sigil }

impl Interp<'_> {
	pub(super) fn aliasing_enabled(&mut self) -> PResult<()> {
		if !self.hints().features.refaliasing { return Err(self.die_msg("Experimental aliasing via reference not enabled")); }
		self.warn_category_default("experimental::refaliasing", "Aliasing via reference is experimental");
		if let Some(flow) = self.take_pending() { return Err(flow); }
		Ok(())
	}

	pub(super) fn ref_target(&mut self, e: &Expr) -> PResult<RefTarget> {
		let e = ungroup(e);
		if let ExprKind::Declare(kind, _, variable, _) = &e.kind {
			self.declare_targets(*kind, variable, e as *const Expr as usize)?;
			if let ExprKind::Variable(sigil, name) = &ungroup(variable).kind {
				return self.ref_variable(*sigil, name, *kind != DeclKind::Local);
			}
			return self.ref_target(variable);
		}
		if let ExprKind::Variable(sigil, name) = &e.kind { return self.ref_variable(*sigil, name, false); }
		if let ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. }) = &e.kind {
			return self.ref_variable(Sigil::Code, name, false);
		}
		if let ExprKind::Conditional(cond, yes, no) = &e.kind {
			let value = self.eval_scalar(cond)?;
			let branch = if self.truthy(&value)? { yes } else { no };
			return self.ref_target(branch);
		}
		self.ref_element_target(e)
	}

	fn ref_variable(&mut self, sigil: Sigil, name: &str, pending: bool) -> PResult<RefTarget> {
		if !matches!(sigil, Sigil::Scalar | Sigil::Array | Sigil::Hash | Sigil::Code) {
			return Err(self.die_msg("Can't modify reference constructor in assignment"));
		}
		let binding = if !pending {
			self.pad_position(sigil, name).map(|(scope, offset)| {
				let our = match &self.scopes[scope].pad[offset].2 { Slot::Our(name) => Some(name.clone()), _ => None };
				(scope, offset, false, our)
			})
		} else { self.scopes.iter().enumerate().rev().find_map(|(scope_ix, scope)| {
			[(true, &scope.declarations), (false, &scope.pad)].into_iter().find_map(|(is_pending, pad)| {
				let (index, (_, _, slot)) = pad.iter().enumerate().rfind(|(_, (s, n, _))| *s == sigil && n.as_ref() == name)?;
				let our = if let Slot::Our(name) = slot { Some(name.clone()) } else { None };
				Some((scope_ix, index, is_pending, our))
			})
		}) };
		if let Some((scope, index, pending, our)) = binding {
			let place = if let Some(name) = our { RefPlace::Glob(self.glob(&name), sigil) }
			else { RefPlace::Pad { scope, index, pending } };
			return Ok(RefTarget { place, sigil });
		}
		if sigil == Sigil::Scalar && matches!(name, "_" | "main::_") && !self.topics.is_empty() {
			return Ok(RefTarget { place: RefPlace::Topic(self.topics.len() - 1), sigil });
		}
		self.variable_slot(sigil, name)?;
		Ok(RefTarget { place: RefPlace::Glob(self.glob(name), sigil), sigil })
	}

	pub(super) fn pending_ref_target(&mut self, e: &Expr) -> PResult<RefTarget> {
		if let ExprKind::Variable(sigil, name) = &ungroup(e).kind { self.ref_variable(*sigil, name, true) }
		else { self.ref_target(e) }
	}

	pub(super) fn element_ref_target(place: RefPlace) -> RefTarget { RefTarget { place, sigil: Sigil::Scalar } }

	pub(super) fn ref_value(&mut self, sigil: Sigil, value: Value) -> PResult<Slot> {
		let Value::Ref(reference) = value else { return Err(self.die_msg("Assigned value is not a reference")); };
		Ok(match (sigil, reference) {
			(Sigil::Scalar, Ref::Scalar(sv)) => Slot::Scalar(sv),
			// A glob is a scalar too: `\$foo = \*bar` makes `$foo` that glob.
			(Sigil::Scalar, Ref::Glob(gv)) => Slot::Scalar(new_sv(Value::Glob(gv))),
			(Sigil::Array, Ref::Array(av)) => Slot::Array(av),
			(Sigil::Hash, Ref::Hash(hv)) => Slot::Hash(hv),
			(Sigil::Code, Ref::Code(cv)) => Slot::Code(cv),
			(sigil, _) => {
				let ty = match sigil { Sigil::Array => "an ARRAY", Sigil::Hash => "a HASH", Sigil::Code => "a CODE", _ => "a SCALAR" };
				return Err(self.die_msg(format!("Assigned value is not {ty} reference")));
			}
		})
	}

	pub(super) fn store_ref_target(&mut self, target: RefTarget, value: Value) -> PResult<()> {
		let slot = self.ref_value(target.sigil, value)?;
		match (target.place, slot) {
			(RefPlace::Pad { scope, index, pending }, slot) => {
				if let Some(scope) = self.scopes.get_mut(scope) {
					let pad = if pending { &mut scope.declarations } else { &mut scope.pad };
					if let Some((_, _, alias)) = pad.get_mut(index) { *alias = slot; }
				}
			}
			(RefPlace::Glob(glob, Sigil::Scalar), Slot::Scalar(sv)) => { glob.scalar.replace(sv); }
			(RefPlace::Glob(glob, Sigil::Array), Slot::Array(av)) => { glob.array.replace(av); }
			(RefPlace::Glob(glob, Sigil::Hash), Slot::Hash(hv)) => { glob.hash.replace(hv); }
			(RefPlace::Glob(glob, Sigil::Code), Slot::Code(cv)) => { glob.code.replace(Some(cv)); self.mark_package_changed(&glob.pkg); }
			(RefPlace::Array(av, index), Slot::Scalar(sv)) => {
				if let Some(place) = av.elems_mut().get_mut(index) { *place = sv; }
			}
			(RefPlace::Hash(hv, key), Slot::Scalar(sv)) => { hv.entries_mut().insert(key, sv); }
			(RefPlace::Topic(index), Slot::Scalar(sv)) => {
				if let Some(topic) = self.topics.get_mut(index) { *topic = sv; }
			}
			_ => return Err(self.die_msg("Can't modify reference constructor in assignment")),
		}
		Ok(())
	}
}
