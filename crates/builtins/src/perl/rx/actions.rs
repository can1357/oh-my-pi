//! Perl regex actions and dynamic subpatterns (`perlre`).

use std::rc::Rc;

use super::{Flow, Interp, InterpMode, MatchState, Operation, PResult, PStr, QuotePart, Regex,
	Sv, Value, coerce_regexp, text};
use crate::perl::{ast::{ExprKind, Sigil, StmtKind}, interp::{Cx, Ret}, value::Ref, regex::{Action, ActionPhase, Captures, Codeset, CompileContext, ExecOpts, RxFlags}, value::new_sv};

pub(super) fn interpolate(interp: &mut Interp<'_>, parts: &[QuotePart]) -> PResult<(PStr, Vec<Action>)> {
	let mut result = PStr::default();
	let mut actions = Vec::new();
	let mut first = 0;
	let mut case = false;
	for (i, part) in parts.iter().enumerate() {
		match part {
			QuotePart::RegexCode(block, dynamic, spelling) => {
				append(&mut result, &mut actions, &interp.interpolate(&parts[first..i], InterpMode::Regex)?);
				let at = append(&mut result, &mut actions, spelling);
				actions.push(Action { at, len: spelling.bytes.len() + if result.utf8 && !spelling.utf8 {
					spelling.bytes.iter().filter(|b| !b.is_ascii()).count()
				} else { 0 }, code: interp.regex_code(block.clone()), dynamic: *dynamic });
				first = i + 1;
				case = false;
			}
			QuotePart::Case(_) => case = true,
			QuotePart::Expr(expr, false) if !case => {
				append(&mut result, &mut actions, &interp.interpolate(&parts[first..i], InterpMode::Regex)?);
				let value = interp.eval_scalar(expr)?;
				append_value(interp, &mut result, &mut actions, value, Some(expr))?;
				first = i + 1;
			}
			// An interpolated array keeps the code blocks of its qr elements
			// trusted, as a scalar does (perl #115004).
			QuotePart::Expr(expr, true) if !case => {
				append(&mut result, &mut actions, &interp.interpolate(&parts[first..i], InterpMode::Regex)?);
				let values = interp.eval_list(expr)?;
				let separator = interp.list_sep();
				let array = match &expr.kind { ExprKind::Variable(Sigil::Array, name) => Some(name.clone()), _ => None };
				for (n, value) in values.into_iter().enumerate() {
					if n != 0 { append(&mut result, &mut actions, &separator); }
					if value.is_undef() {
						if interp.warn_on("uninitialized") {
							let element = array.as_ref().map_or_else(String::new, |name| format!("${name}[{n}] "));
							interp.warn_category("uninitialized", format!("Use of uninitialized value {element}in regexp compilation"));
						}
						continue;
					}
					append_value(interp, &mut result, &mut actions, value, None)?;
				}
				first = i + 1;
			}
			_ => {}
		}
	}
	let tail = interp.interpolate(&parts[first..], InterpMode::Regex)?;
	append(&mut result, &mut actions, &tail);
	// Under `use bytes` the pattern is its encoded bytes, one character each
	// (`bytes`); action offsets are byte offsets, so they stay valid.
	if interp.hints().bytes { result.utf8 = false; }
	Ok((result, actions))
}

/// Append one interpolated value: a qr object (or a `""` overload returning
/// one, possibly through further overloaded objects) as its spelling with
/// its trusted code blocks (`overload` "qr"), anything else as its string.
fn append_value(interp: &mut Interp<'_>, result: &mut PStr, actions: &mut Vec<Action>, mut value: Value, expr: Option<&crate::perl::ast::Expr>) -> PResult<()> {
	let mut conversions = 0;
	while conversions < 100
		&& let Value::Ref(reference) = &value
		&& !matches!(reference, Ref::Regexp(_))
		&& let Some(class) = reference.blessed()
		&& interp.overload_handler(&class, "qr").is_none()
		&& interp.overload_handler(&class, "\"\"").is_some()
		&& let Some(converted) = interp.overload_builtin("\"\"", &value, None, Cx::Scalar)?.map(Ret::scalar)
	{
		value = converted;
		conversions += 1;
	}
	if let Some(regex) = coerce_regexp(interp, &value)? {
		let spelling = regex.stringify();
		let at = append(result, actions, &spelling);
		let prefix = spelling.bytes.iter().position(|b| *b == b':').map_or(0, |i| i + 1);
		let source = regex.source();
		let upgrade = result.utf8 && !source.utf8;
		for action in regex.actions() {
			let (mut off, mut len) = (action.at, action.len);
			if upgrade {
				off += source.bytes[..action.at].iter().filter(|b| !b.is_ascii()).count();
				len += source.bytes[action.at..action.at + action.len].iter().filter(|b| !b.is_ascii()).count();
			}
			actions.push(Action { at: at + prefix + off, len, code: action.code.clone(), dynamic: action.dynamic });
		}
	} else {
		let spelling = text(interp, value, expr, Operation::Compile)?;
		append(result, actions, &spelling);
	}
	Ok(())
}

fn append(result: &mut PStr, actions: &mut [Action], text: &PStr) -> usize {
	if text.utf8 && !result.utf8 {
		let mut previous = 0;
		let mut expanded = 0;
		for action in actions {
			let start = action.at;
			let end = start + action.len;
			expanded += result.bytes[previous..start].iter().filter(|b| !b.is_ascii()).count();
			action.at += expanded;
			let extra = result.bytes[start..end].iter().filter(|b| !b.is_ascii()).count();
			action.len += extra;
			expanded += extra;
			previous = end;
		}
		result.upgrade();
	}
	let start = result.bytes.len();
	result.push(text);
	start
}

pub(super) fn compile(interp: &mut Interp<'_>, source: &PStr, flags: RxFlags, actions: Vec<Action>) -> PResult<Regex> {
	// Searches outside rx (modules, smartmatch) run compiled patterns too.
	super::install_cancel(interp);
	// `${^UTF8LOCALE}` is the interpreter's read-only record of whether the
	// shell environment selected a UTF-8 locale (LC_ALL, LC_CTYPE, LANG).
	let codeset = if interp.sv("main::^UTF8LOCALE").get().truthy() { Codeset::Utf8 } else { Codeset::Bytes };
	let properties = if source.bytes.windows(3).any(|w| w[0] == b'\\' && matches!(w[1], b'p' | b'P') && w[2] == b'{') {
		super::props::resolve(interp, source, flags.i)?
	} else { Vec::new() };
	let context = CompileContext { codeset, properties };
	let compiled = Regex::with_actions(source, flags, actions, context.clone());
	if let Ok(regex) = &compiled {
		for (category, message) in regex.warnings() {
			// Experimental-feature warnings are on by default (perldiag "S experimental").
			if category.starts_with("experimental::") || *category == "deprecated" { interp.warn_category_default(category, message.clone()); }
			else { interp.warn_category(category, message.clone()); }
		}
	}
	match compiled {
		Err(error) if error.starts_with("Eval-group not allowed at runtime") && interp.hints().re_eval => {
			// Parse balanced Perl action blocks without interpolating the surrounding regex a second time.
			let program = interp.compile_regex_text(source, flags.x || flags.xx)?;
			let Some(StmtKind::Expr(expr)) = program.body.stmts.first().map(|s| &s.kind) else { return Err(interp.die_msg(error)); };
			let ExprKind::Regex(re) = &expr.kind else { return Err(interp.die_msg(error)); };
			let (pattern, actions) = interpolate(interp, &re.pattern)?;
			Regex::with_actions(&pattern, flags, actions, context).map_err(|m| interp.die_msg(m))
		}
		Err(error) => Err(interp.die_msg(error)),
		Ok(regex) => Ok(regex),
	}
}

#[derive(Clone)]
struct Dynamic {
	regex: Rc<Regex>,
	start: usize,
	first_end: usize,
}

pub(super) fn exec(interp: &mut Interp<'_>, regex: &Rc<Regex>, source: &Rc<PStr>, cell: Option<&Sv>, start: usize, opts: ExecOpts) -> PResult<Option<Captures>> {
	let resolved;
	let regex = if regex.deferred_properties().is_empty() { regex } else {
		resolved = resolve_deferred(interp, regex)?;
		&resolved
	};
	let opts = ExecOpts { utf8_valid: interp.rx.utf8_valid(source), ..opts };
	super::install_cancel(interp);
	if regex.actions().is_empty() {
		return regex.exec(source, start, opts).map_err(|m| super::search_error(interp, m));
	}
	let depth = interp.rx.action_depth;
	if depth >= 128 { return Err(interp.die_msg("Infinite recursion in regex")); }
	interp.rx.action_depth = depth + 1;
	let out = stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || exec_inner(interp, regex, source, cell, start, opts));
	interp.rx.action_depth = depth;
	out
}

/// Recompile a pattern whose user-defined properties were not defined when it
/// was compiled (`perlunicode`: such properties are looked up at first match).
fn resolve_deferred(interp: &mut Interp<'_>, regex: &Rc<Regex>) -> PResult<Rc<Regex>> {
	let key = Rc::as_ptr(regex) as usize;
	if let Some((original, resolved)) = interp.rx.deferred.get(&key)
		&& original.as_ptr() == Rc::as_ptr(regex)
	{
		return Ok(resolved.clone());
	}
	let recompiled = Rc::new(compile(interp, regex.source(), regex.flags(), regex.actions().to_vec())?);
	if let Some(error) = recompiled.deferred_properties().first() {
		return Err(interp.die_msg(error.clone()));
	}
	interp.rx.deferred.retain(|_, (original, _)| original.strong_count() != 0);
	interp.rx.deferred.insert(key, (Rc::downgrade(regex), recompiled.clone()));
	Ok(recompiled)
}

fn exec_inner(interp: &mut Interp<'_>, regex: &Rc<Regex>, source: &Rc<PStr>, cell: Option<&Sv>, start: usize, opts: ExecOpts) -> PResult<Option<Captures>> {
	let old_match = interp.last_match();
	let topic = cell.cloned().unwrap_or_else(|| new_sv(Value::Str((**source).clone())));
	let pos = topic.pos.get();
	let r = interp.sv("main::^R");
	let prior = r.get();
	let mut attempt = None;
	let mut abort = None;
	let mut dynamic = vec![None::<Dynamic>; regex.actions().len()];
	let mut undo = Vec::new();
	let result = regex.exec_actions(source, start, opts, &mut |index, phase, at, captures| {
		if phase == ActionPhase::Rollback {
			if let Some((i, before, nested)) = undo.pop() {
				if i == index {
					r.set(before);
					dynamic[i] = nested;
				} else { undo.push((i, before, nested)); }
			}
			return 0;
		}
		if matches!(phase, ActionPhase::End | ActionPhase::RetryEnd) {
			let Some(Some(nested)) = dynamic.get(index) else { return 1; };
			if phase == ActionPhase::End { return i32::from(nested.first_end != at); }
			if nested.first_end == at { return 1; }
			if interp.is_cancelled() { abort = Some(Flow::Cancelled); return pcre2_sys::PCRE2_ERROR_CALLOUT; }
			let current_r = r.get();
			topic.pos.set(Some(nested.start));
			let result = exec(interp, &nested.regex, source, Some(&topic), nested.start, ExecOpts {
				g_anchor: Some(nested.start), anchored: true, required_end: Some(at), ..ExecOpts::default()
			});
			topic.pos.set(pos);
			r.set(current_r);
			return match result {
				Ok(found) => i32::from(found.is_none_or(|c| super::whole_span(&c).1 != at)),
				Err(flow) => { abort = Some(flow); pcre2_sys::PCRE2_ERROR_CALLOUT }
			};
		}
		let Some(action) = regex.actions().get(index) else { return 1; };
		let Some(captures) = captures else { return pcre2_sys::PCRE2_ERROR_CALLOUT; };
		let beginning = super::whole_span(&captures).0;
		if attempt != Some(beginning) {
			attempt = Some(beginning);
			undo.clear();
			dynamic.fill(None);
			r.set(prior.clone());
		}
		if interp.is_cancelled() { abort = Some(Flow::Cancelled); return pcre2_sys::PCRE2_ERROR_CALLOUT; }
		if phase != ActionPhase::Test { undo.push((index, r.get(), dynamic[index].take())); }
		interp.set_last_match(Some(Rc::new(MatchState::new(source.clone(), captures, regex.clone()))));
		topic.pos.set(Some(at));
		let found = stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || {
			interp.with_topic(topic.clone(), |interp| {
				// `return` leaves the code block with its value (`perlre` "(?{ code })").
				let value = match interp.run_regex_code(&action.code) {
					Err(Flow::Return(ret)) => ret.scalar(),
					other => other?,
				};
				match phase {
					ActionPhase::Eval => { r.set(value); return Ok((true, None)); }
					ActionPhase::Test => return Ok((interp.truthy(&value)?, None)),
					_ => {}
				}
				let sub = if let Some(sub) = coerce_regexp(interp, &value)? { sub } else {
					let pat = text(interp, value, None, Operation::Compile)?;
					Rc::new(compile(interp, &pat, regex.flags(), Vec::new())?)
				};
				let nested = exec(interp, &sub, source, Some(&topic), at, ExecOpts { g_anchor: Some(at), anchored: true, ..ExecOpts::default() })?;
				let nested = nested.map(|c| Dynamic { regex: sub, start: at, first_end: super::whole_span(&c).1 });
				Ok((nested.is_some(), nested))
			})
		});
		topic.pos.set(pos);
		interp.set_last_match(old_match.clone());
		match found {
			Ok((matched, nested)) => { dynamic[index] = nested; i32::from(!matched) }
			Err(flow) => { abort = Some(flow); pcre2_sys::PCRE2_ERROR_CALLOUT }
		}
	});
	topic.pos.set(pos);
	interp.set_last_match(old_match);
	if !matches!(result, Ok(Some(_))) { r.set(prior); }
	if let Some(flow) = abort { return Err(flow); }
	result.map_err(|m| super::search_error(interp, m))
}
