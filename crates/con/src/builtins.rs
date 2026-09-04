//! Console-core built-ins.
//!
//! Bare (segment-less) names are reserved for this module — the root
//! domain belongs to the console engine itself, mirroring how `bind`,
//! `exec`, and `alias` live outside any subsystem prefix in the Source
//! lineage. Everything here registers through the same public macros host
//! code uses.
//!
//! One exception: `con::unsafe` is declared by hand because `unsafe` is a
//! Rust keyword and cannot appear as a `var!` path segment.

use std::fmt::Write as _;

use omp_core::{Str, StrMut};

use crate::{
	CVar, ConError, RegItem, SetSource, Severity, Value, ValueKind, VarFlags, VarSpec,
	ctx::UNSAFE_NAME, script::coerce_one,
};

static UNSAFE_SPEC: VarSpec = VarSpec::new(
	UNSAFE_NAME,
	" Enables writes to unsafe-gated variables. Replicated: only the authority decides whether \
	 unsafe features are allowed.\n",
	crate::TypeSpec::BOOL,
	|| Value::Bool(false),
)
.flag(VarFlags::REPLICATED.with(VarFlags::NOTIFY));

#[linkme::distributed_slice(crate::REGISTRY)]
static UNSAFE_REG: RegItem = RegItem::Var(&UNSAFE_SPEC);

/// Gate for `UNSAFE`-flagged variables (`sv_cheats`). Replicated: only
/// the authority decides whether unsafe features are allowed.
pub static SV_CHEATS: CVar<bool> = CVar::new(&UNSAFE_SPEC);

crate::cmd! {
	/// Shows a name's description, type, arguments, default, and flags.
	help(?name @ "con::name": Str) = |ctx, args| {
		let Some(name) = args.opt::<Str>(0)? else {
			ctx.reply(
				Severity::Info,
				"help <name> — describe a var/command; `find <prefix>` lists names",
			);
			return Ok(());
		};
		let item = ctx.find(name.as_str()).ok_or(ConError::Unknown { name: name.clone() })?;
		let mut line = StrMut::new("");
		match item {
			RegItem::Var(spec) => {
				let _ = write!(line, "{} <{}>", spec.name, spec.ty.kind);
				if spec.ty.kind == ValueKind::Enum {
					let _ = write!(line, " {:?}", spec.ty.variants);
				}
				let _ = write!(line, " (default {})", (spec.default)());
				if let (Some(min), Some(max)) = (spec.min, spec.max) {
					let _ = write!(line, " [{min}, {max}]");
				}
			},
			RegItem::Cmd(spec) => {
				let _ = write!(line, "{}", spec.name);
				for arg in spec.args {
					if arg.required {
						let _ = write!(line, " <{}>", arg.name);
					} else {
						let _ = write!(line, " [{}]", arg.name);
					}
				}
			},
			RegItem::Action(spec) => {
				let _ = write!(line, "+{0} / -{0}", spec.name);
			},
		}
		let desc = item.desc().trim();
		if !desc.is_empty() {
			let _ = write!(line, " — {desc}");
		}
		ctx.reply(Severity::Info, line.as_str());
		Ok(())
	};

	/// Lists registered names matching a prefix.
	find(prefix @ "con::name": Str) = |ctx, args| {
		let prefix: Str = args.get(0)?;
		let mut found = 0usize;
		for item in ctx.items() {
			if item.name().starts_with(prefix.as_str()) {
				found += 1;
				let mut line = StrMut::new("");
				let _ = write!(line, "{}", item.name());
				let desc = item.desc().trim();
				if let Some(first) = desc.lines().next()
					&& !first.is_empty()
				{
					let _ = write!(line, " — {}", first.trim());
				}
				ctx.reply(Severity::Info, line.as_str());
			}
		}
		if found == 0 {
			ctx.reply(Severity::Info, "no matches");
		}
		Ok(())
	};

	/// Prints its arguments.
	echo(?text: Str) = |ctx, args| {
		ctx.reply(Severity::Info, args.join(0).as_str());
		Ok(())
	};

	/// Executes a named config through the installed loader.
	exec(cfg @ "con::cfg": Str) = |ctx, args| {
		let name: Str = args.get(0)?;
		ctx.exec_cfg(&name)
	};

	/// Defines an alias, shows one, or lists all.
	alias(?name @ "con::alias": Str, ?body @ "con::script": Str) = |ctx, args| {
		match args.len() {
			0 => {
				for (name, body) in ctx.aliases() {
					ctx.reply_fmt(Severity::Info, format_args!("alias {name} = {body}"));
				}
				Ok(())
			},
			1 => {
				let name: Str = args.get(0)?;
				match ctx.aliases().iter().find(|(n, _)| *n == name) {
					Some((_, body)) => {
						ctx.reply_fmt(Severity::Info, format_args!("alias {name} = {body}"));
						Ok(())
					},
					None => Err(ConError::Unknown { name }),
				}
			},
			_ => ctx.set_alias(args.atom(0)?, args.join(1)),
		}
	};

	/// Removes an alias.
	unalias(name @ "con::alias": Str) = |ctx, args| {
		let name: Str = args.get(0)?;
		if ctx.remove_alias(name.as_str()) { Ok(()) } else { Err(ConError::Unknown { name }) }
	};

	/// Removes every alias.
	unaliasall() = |ctx, _args| {
		ctx.clear_aliases();
		Ok(())
	};

	/// Binds a key to a script, shows one bind, or lists all.
	bind(?key @ "con::key": Str, ?script @ "con::script": Str) = |ctx, args| {
		match args.len() {
			0 => {
				for (key, script) in ctx.binds() {
					ctx.reply_fmt(Severity::Info, format_args!("bind {key} = {script}"));
				}
				Ok(())
			},
			1 => {
				let key: Str = args.get(0)?;
				let chord = crate::normalize_chord(key.as_str()).map_err(ConError::Chord)?;
				match ctx.bound(chord.as_str()) {
					Some(script) => {
						ctx.reply_fmt(Severity::Info, format_args!("bind {chord} = {script}"));
						Ok(())
					},
					None => Err(ConError::Unknown { name: chord }),
				}
			},
			_ => ctx.bind(args.atom(0)?, args.join(1)),
		}
	};

	/// Removes a bind.
	unbind(key @ "con::key": Str) = |ctx, args| {
		let key: Str = args.get(0)?;
		if ctx.unbind(key.as_str()) { Ok(()) } else { Err(ConError::Unknown { name: key }) }
	};

	/// Removes every bind.
	unbindall() = |ctx, _args| {
		ctx.unbind_all();
		Ok(())
	};

	/// Flips a bool var, cycles an enum var, or cycles explicit values.
	toggle(var @ "con::var": Str) = |ctx, args| {
		let name: Str = args.get(0)?;
		let Some(RegItem::Var(spec)) = ctx.find(name.as_str()) else {
			return Err(ConError::NotAVar { name });
		};
		let current = ctx.value(spec.name)?;
		let next = if args.len() > 1 {
			let values: Vec<_> = args.raw()[1..]
				.iter()
				.map(|arg| {
					coerce_one(arg, spec.ty).map_err(|_| ConError::TypeMismatch {
						name: Str::new_static(spec.name),
						expected: spec.ty.kind,
						got: arg.to_script(),
					})
				})
				.collect::<Result<_, _>>()?;
			cycle(&values, &current)
		} else {
			match &current {
				crate::Value::Bool(b) => crate::Value::Bool(!b),
				crate::Value::Enum(s) => {
					let variants = spec.ty.variants;
					let at = variants.iter().position(|v| *v == s.as_str());
					let next = at.map_or(0, |i| (i + 1) % variants.len());
					crate::Value::Enum(Str::new_static(variants[next]))
				},
				_ => return Err(ConError::Invalid { name: Str::new_static(spec.name) }),
			}
		};
		ctx.set_value(spec.name, next, SetSource::Script)
	};

	/// Restores a var to its default.
	reset(var @ "con::var": Str) = |ctx, args| {
		let name: Str = args.get(0)?;
		let Some(RegItem::Var(spec)) = ctx.find(name.as_str()) else {
			return Err(ConError::NotAVar { name });
		};
		ctx.set_value(spec.name, (spec.default)(), SetSource::Script)
	};

	/// Prints the persistence script (diff from defaults) `writecfg` would
	/// save. (`dump` itself is the product's transcript dump.)
	dumpcfg() = |ctx, _args| {
		ctx.reply(Severity::Info, ctx.dump().as_str());
		Ok(())
	};

	/// Writes the persistence script through the installed saver.
	writecfg(?cfg: Str) = |ctx, args| {
		let name = args.opt::<Str>(0)?.unwrap_or_else(|| Str::new_static("config"));
		ctx.write_cfg(name.as_str())
	};
}

/// Next value after `current` in `values`, wrapping; first when absent.
fn cycle(values: &[crate::Value], current: &crate::Value) -> crate::Value {
	let at = values.iter().position(|v| v == current);
	values[at.map_or(0, |i| (i + 1) % values.len())].clone()
}
