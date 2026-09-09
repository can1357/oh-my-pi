//! Link-time declaration macros: [`var!`](crate::var), [`cmd!`](crate::cmd),
//! [`action!`](crate::action).
//!
//! Each expands to `'static` specs plus a [`REGISTRY`](crate::REGISTRY)
//! entry; every [`Ctx`](crate::Ctx) built without
//! [`isolated`](crate::CtxBuilder::isolated) picks them up automatically —
//! registration is linking, not a call site.

/// Joins `::`-separated ident segments into the console name literal.
#[doc(hidden)]
#[macro_export]
macro_rules! __con_name {
	($name:literal) => {
		$name
	};
	($first:ident $($rest:ident)*) => {
		concat!(stringify!($first) $(, "::", stringify!($rest))*)
	};
}

/// Maps a lowercase flag keyword to its [`VarFlags`](crate::VarFlags) const.
#[doc(hidden)]
#[macro_export]
macro_rules! __var_flag {
	(archive) => {
		$crate::VarFlags::ARCHIVE
	};
	(unsafe) => {
		$crate::VarFlags::UNSAFE
	};
	(readonly) => {
		$crate::VarFlags::READONLY
	};
	(notify) => {
		$crate::VarFlags::NOTIFY
	};
	(replicated) => {
		$crate::VarFlags::REPLICATED
	};
	(session) => {
		$crate::VarFlags::SESSION
	};
}

/// Declares console variables and their typed handles.
///
/// ```ignore
/// omp_con::var! {
///     /// World gravity applied to entities (u/s²).
///     pub static SV_GRAVITY = sv::gravity: i32 {
///         default: 800,
///         min: 100,
///         max: 2000,
///         suggest: ["600", "800"],
///         validate: |_ctx, v| if *v == 0 { Err("zero gravity".into()) } else { Ok(()) },
///         on_change: |_ctx, old, new| println!("{old} -> {new}"),
///         flags: archive | replicated,
///         meta: {
///             "ui.tab": "model",
///             "legacy.path": "gravity",
///         },
///     };
/// }
/// ```
///
/// Fields after `default` are optional but order-fixed: `min`, `max`,
/// `suggest` *or* `complete`, `validate`, `on_change`, `flags`, `meta`. Hooks
/// are typed against the declared Rust type and must be non-capturing. The doc
/// comment becomes the console description.
#[macro_export]
macro_rules! var {
	($(
		$(#[doc = $doc:literal])*
		$vis:vis static $handle:ident = $($seg:ident)::+ : $ty:ty {
			default: $default:expr
			$(, min: $min:expr)?
			$(, max: $max:expr)?
			$(, suggest: [$($sug:literal),+ $(,)?])?
			$(, complete: $group:literal)?
			$(, validate: $validate:expr)?
			$(, on_change: $change:expr)?
			$(, flags: $($flag:tt)|+)?
			$(, meta: { $($mk:literal : $mv:literal),+ $(,)? })?
			$(,)?
		};
	)+) => {$(
		$(#[doc = $doc])*
		$vis static $handle: $crate::CVar<$ty> = $crate::CVar::new({
			static SPEC: $crate::VarSpec = $crate::VarSpec::new(
				$crate::__con_name!($($seg)+),
				concat!($($doc, "\n"),*),
				<$ty as $crate::ConType>::SPEC,
				{
					fn default_value() -> $crate::Value {
						<$ty as $crate::ConType>::into_value($default)
					}
					default_value
				},
			)
			$(.min($min as f64))?
			$(.max($max as f64))?
			$(.hint($crate::Hint::Suggest(&[$($sug),+])))?
			$(.hint($crate::Hint::Group($group)))?
			$(.validate({
				fn validate_shim(
					ctx: &$crate::Ctx,
					value: &$crate::Value,
				) -> Result<(), $crate::__private::Str> {
					let typed =
						<$ty as $crate::ConType>::from_value(value).expect("value conforms to spec");
					let hook: fn(&$crate::Ctx, &$ty) -> Result<(), $crate::__private::Str> = $validate;
					hook(ctx, &typed)
				}
				validate_shim
			}))?
			$(.on_change({
				fn change_shim(ctx: &$crate::Ctx, old: &$crate::Value, new: &$crate::Value) {
					let old = <$ty as $crate::ConType>::from_value(old).expect("value conforms to spec");
					let new = <$ty as $crate::ConType>::from_value(new).expect("value conforms to spec");
					let hook: fn(&$crate::Ctx, &$ty, &$ty) = $change;
					hook(ctx, &old, &new);
				}
				change_shim
			}))?
			$(.flag($crate::VarFlags::NONE $(.with($crate::__var_flag!($flag)))+))?
			$(.meta(&[$(($mk, $mv)),+]))?;
			#[$crate::__private::linkme::distributed_slice($crate::REGISTRY)]
			#[linkme(crate = $crate::__private::linkme)]
			static REG: $crate::RegItem = $crate::RegItem::Var(&SPEC);
			&SPEC
		});
	)+};
}

/// Accumulates [`ArgSpec`](crate::ArgSpec) array elements from a `cmd!`
/// argument list.
#[doc(hidden)]
#[macro_export]
macro_rules! __cmd_args {
	([$($acc:expr),*]) => { [$($acc),*] };
	([$($acc:expr),*] , $($rest:tt)*) => {
		$crate::__cmd_args!([$($acc),*] $($rest)*)
	};
	([$($acc:expr),*] ? $name:ident $(@ $group:literal)? : $ty:ty , $($rest:tt)*) => {
		$crate::__cmd_args!([$($acc,)*
			$crate::ArgSpec::new(stringify!($name), <$ty as $crate::ConType>::SPEC)
				.optional()
				$(.hint($crate::Hint::Group($group)))?
		] , $($rest)*)
	};
	([$($acc:expr),*] ? $name:ident $(@ $group:literal)? : $ty:ty) => {
		$crate::__cmd_args!([$($acc,)*
			$crate::ArgSpec::new(stringify!($name), <$ty as $crate::ConType>::SPEC)
				.optional()
				$(.hint($crate::Hint::Group($group)))?
		])
	};
	([$($acc:expr),*] $name:ident $(@ $group:literal)? : $ty:ty , $($rest:tt)*) => {
		$crate::__cmd_args!([$($acc,)*
			$crate::ArgSpec::new(stringify!($name), <$ty as $crate::ConType>::SPEC)
				$(.hint($crate::Hint::Group($group)))?
		] , $($rest)*)
	};
	([$($acc:expr),*] $name:ident $(@ $group:literal)? : $ty:ty) => {
		$crate::__cmd_args!([$($acc,)*
			$crate::ArgSpec::new(stringify!($name), <$ty as $crate::ConType>::SPEC)
				$(.hint($crate::Hint::Group($group)))?
		])
	};
}

/// Declares console commands.
///
/// ```ignore
/// omp_con::cmd! {
///     /// Kick a player by name.
///     sv::kick(player @ "sv::player": Str, ?reason: Str) = |ctx, args| {
///         let player: Str = args.get(0)?;
///         let reason = args.opt::<Str>(1)?;
///         // ...
///         Ok(())
///     };
/// }
/// ```
///
/// A leading `?` marks an argument optional; `@ "group"` attaches a
/// completion group. Declared arguments drive `help` and completion —
/// surplus trailing arguments still reach the handler via
/// [`Args::raw`](crate::Args::raw). Handlers must be non-capturing; state
/// comes from [`Ctx::user`](crate::Ctx::user).
///
/// A name that is not a Rust ident (`"plan-review"`) is written as a string
/// literal in place of the ident path.
#[macro_export]
macro_rules! cmd {
	() => {};
	(
		$(#[doc = $doc:literal])*
		$name:literal ( $($args:tt)* ) = $handler:expr;
		$($rest:tt)*
	) => {
		$crate::__cmd_one!($name; [$($doc)*]; [$($args)*]; $handler);
		$crate::cmd!($($rest)*);
	};
	(
		$(#[doc = $doc:literal])*
		$($seg:ident)::+ ( $($args:tt)* ) = $handler:expr;
		$($rest:tt)*
	) => {
		$crate::__cmd_one!($crate::__con_name!($($seg)+); [$($doc)*]; [$($args)*]; $handler);
		$crate::cmd!($($rest)*);
	};
}

/// Registers one command spec for [`cmd!`](crate::cmd).
#[doc(hidden)]
#[macro_export]
macro_rules! __cmd_one {
	($name:expr; [$($doc:literal)*]; [$($args:tt)*]; $handler:expr) => {
		const _: () = {
			static ARGS: &[$crate::ArgSpec] = &$crate::__cmd_args!([] $($args)*);
			static SPEC: $crate::CmdSpec = $crate::CmdSpec::new(
				$name,
				concat!($($doc, "\n"),*),
				ARGS,
				{
					let handler: $crate::CmdHandler = $handler;
					handler
				},
			);
			#[$crate::__private::linkme::distributed_slice($crate::REGISTRY)]
			#[linkme(crate = $crate::__private::linkme)]
			static REG: $crate::RegItem = $crate::RegItem::Cmd(&SPEC);
		};
	};
}

/// Declares held-input actions: each registers the `+name`/`-name` command
/// pair and a typed [`Action`](crate::Action) handle.
///
/// ```ignore
/// omp_con::action! {
///     /// Player jump intent.
///     pub static JUMP = cl::jump {
///         on_press: |_ctx| {},
///         on_release: |_ctx| {},
///     };
/// }
/// ```
///
/// The body (and both hooks) are optional; query held state with
/// [`Action::is_active`](crate::Action::is_active).
#[macro_export]
macro_rules! action {
	($(
		$(#[doc = $doc:literal])*
		$vis:vis static $handle:ident = $($seg:ident)::+ $({ $($body:tt)* })?;
	)+) => {$(
		$(#[doc = $doc])*
		$vis static $handle: $crate::Action = $crate::Action::new({
			static SPEC: $crate::ActionSpec = $crate::__action_body!(
				$crate::ActionSpec::new(
					$crate::__con_name!($($seg)+),
					concat!($($doc, "\n"),*),
				); $($($body)*)?
			);
			#[$crate::__private::linkme::distributed_slice($crate::REGISTRY)]
			#[linkme(crate = $crate::__private::linkme)]
			static REG: $crate::RegItem = $crate::RegItem::Action(&SPEC);
			&SPEC
		});
	)+};
}

/// Applies `on_press`/`on_release` body fields to an
/// [`ActionSpec`](crate::ActionSpec) builder expression.
#[doc(hidden)]
#[macro_export]
macro_rules! __action_body {
	($spec:expr;) => { $spec };
	($spec:expr; ,) => { $spec };
	($spec:expr; on_press: $hook:expr) => {
		$spec.on_press({
			let hook: $crate::ActionHook = $hook;
			hook
		})
	};
	($spec:expr; on_press: $hook:expr, $($rest:tt)*) => {
		$crate::__action_body!(
			$spec.on_press({
				let hook: $crate::ActionHook = $hook;
				hook
			}); $($rest)*
		)
	};
	($spec:expr; on_release: $hook:expr) => {
		$spec.on_release({
			let hook: $crate::ActionHook = $hook;
			hook
		})
	};
	($spec:expr; on_release: $hook:expr, $($rest:tt)*) => {
		$crate::__action_body!(
			$spec.on_release({
				let hook: $crate::ActionHook = $hook;
				hook
			}); $($rest)*
		)
	};
}
