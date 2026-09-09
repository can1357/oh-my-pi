//! `json!` construction macro, adapted from `serde_json`'s TT muncher.
//!
//! Upstream: <https://github.com/serde-rs/json>
//! Licensed under MIT.
//! See this package's `NOTICE` and `LICENSE`.

/// Build a [`Value`](crate::slopjson::Value) from a JSON-shaped literal.
///
/// Interpolates any expression whose type converts `Into<Value>`:
///
/// ```
/// use omp_core::slopjson::json;
///
/// let path = "a.ts";
/// let v = json!({ "path": path, "counts": [1, 2, 3], "meta": { "ok": true, "nil": null } });
/// assert_eq!(v["counts"][2].as_i64(), Some(3));
/// ```
#[macro_export]
macro_rules! json {
	($($json:tt)+) => {
		$crate::slopjson::json_internal!($($json)+)
	};
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_internal {
	// ── array munching: @array [built elems] (remaining tt) ────────────────

	// Done with trailing comma.
	(@array [$($elems:expr,)*]) => {
		::std::vec![$($elems,)*]
	};
	// Done without trailing comma.
	(@array [$($elems:expr),*]) => {
		::std::vec![$($elems),*]
	};
	// Next element is `null`.
	(@array [$($elems:expr,)*] null $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!(null)] $($rest)*)
	};
	// Next element is `true`.
	(@array [$($elems:expr,)*] true $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!(true)] $($rest)*)
	};
	// Next element is `false`.
	(@array [$($elems:expr,)*] false $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!(false)] $($rest)*)
	};
	// Next element is an array.
	(@array [$($elems:expr,)*] [$($array:tt)*] $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!([$($array)*])] $($rest)*)
	};
	// Next element is an object.
	(@array [$($elems:expr,)*] {$($map:tt)*} $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!({$($map)*})] $($rest)*)
	};
	// Next element is an expression followed by comma.
	(@array [$($elems:expr,)*] $next:expr, $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!($next),] $($rest)*)
	};
	// Last element is an expression with no trailing comma.
	(@array [$($elems:expr,)*] $last:expr) => {
		$crate::slopjson::json_internal!(@array [$($elems,)* $crate::slopjson::json_internal!($last)])
	};
	// Comma after the most recent element.
	(@array [$($elems:expr),*] , $($rest:tt)*) => {
		$crate::slopjson::json_internal!(@array [$($elems,)*] $($rest)*)
	};
	// Unexpected token after the most recent element.
	(@array [$($elems:expr),*] $unexpected:tt $($rest:tt)*) => {
		$crate::slopjson::json_unexpected!($unexpected)
	};

	// ── object munching: @object $map (key tts) (remaining tt) (copy) ──────

	// Done.
	(@object $object:ident () () ()) => {};
	// Insert the current entry followed by trailing comma.
	(@object $object:ident [$($key:tt)+] ($value:expr) , $($rest:tt)*) => {
		let _ = $object.insert(($($key)+).into(), $value);
		$crate::slopjson::json_internal!(@object $object () ($($rest)*) ($($rest)*));
	};
	// Current entry followed by unexpected token.
	(@object $object:ident [$($key:tt)+] ($value:expr) $unexpected:tt $($rest:tt)*) => {
		$crate::slopjson::json_unexpected!($unexpected);
	};
	// Insert the last entry without trailing comma.
	(@object $object:ident [$($key:tt)+] ($value:expr)) => {
		let _ = $object.insert(($($key)+).into(), $value);
	};
	// Next value is `null`.
	(@object $object:ident ($($key:tt)+) (: null $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!(null)) $($rest)*);
	};
	// Next value is `true`.
	(@object $object:ident ($($key:tt)+) (: true $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!(true)) $($rest)*);
	};
	// Next value is `false`.
	(@object $object:ident ($($key:tt)+) (: false $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!(false)) $($rest)*);
	};
	// Next value is an array.
	(@object $object:ident ($($key:tt)+) (: [$($array:tt)*] $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!([$($array)*])) $($rest)*);
	};
	// Next value is an object.
	(@object $object:ident ($($key:tt)+) (: {$($map:tt)*} $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!({$($map)*})) $($rest)*);
	};
	// Next value is an expression followed by comma.
	(@object $object:ident ($($key:tt)+) (: $value:expr , $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!($value)) , $($rest)*);
	};
	// Last value is an expression with no trailing comma.
	(@object $object:ident ($($key:tt)+) (: $value:expr) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object [$($key)+] ($crate::slopjson::json_internal!($value)));
	};
	// Missing value for last entry — "unexpected end of macro invocation".
	(@object $object:ident ($($key:tt)+) (:) $copy:tt) => {
		$crate::slopjson::json_internal!();
	};
	// Missing colon and value for last entry.
	(@object $object:ident ($($key:tt)+) () $copy:tt) => {
		$crate::slopjson::json_internal!();
	};
	// Misplaced colon — error on the colon token.
	(@object $object:ident () (: $($rest:tt)*) ($colon:tt $($copy:tt)*)) => {
		$crate::slopjson::json_unexpected!($colon);
	};
	// Found a comma inside a key — error on the comma token.
	(@object $object:ident ($($key:tt)*) (, $($rest:tt)*) ($comma:tt $($copy:tt)*)) => {
		$crate::slopjson::json_unexpected!($comma);
	};
	// Key is fully parenthesized: interpret as an expression.
	(@object $object:ident () (($key:expr) : $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object ($key) (: $($rest)*) (: $($rest)*));
	};
	// Refuse to absorb a colon token into the key expression.
	(@object $object:ident ($($key:tt)*) (: $($unexpected:tt)+) $copy:tt) => {
		$crate::slopjson::json_expect_expr_comma!($($unexpected)+);
	};
	// Munch a token into the current key.
	(@object $object:ident ($($key:tt)*) ($tt:tt $($rest:tt)*) $copy:tt) => {
		$crate::slopjson::json_internal!(@object $object ($($key)* $tt) ($($rest)*) ($($rest)*));
	};

	// ── primary entry points ────────────────────────────────────────────────

	(null) => {
		$crate::slopjson::Value::Null
	};
	(true) => {
		$crate::slopjson::Value::Bool(true)
	};
	(false) => {
		$crate::slopjson::Value::Bool(false)
	};
	([]) => {
		$crate::slopjson::Value::Array(::std::vec::Vec::new())
	};
	([ $($tt:tt)+ ]) => {
		$crate::slopjson::Value::Array($crate::slopjson::json_internal!(@array [] $($tt)+))
	};
	({}) => {
		$crate::slopjson::Value::Object($crate::slopjson::Object::new())
	};
	({ $($tt:tt)+ }) => {
		$crate::slopjson::Value::Object({
			let mut object = $crate::slopjson::Object::new();
			$crate::slopjson::json_internal!(@object object () ($($tt)+) ($($tt)+));
			object
		})
	};
	// Any Into<Value> expression: numbers, strings, variables, Value itself.
	($other:expr) => {
		$crate::slopjson::Value::from($other)
	};
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_unexpected {
	() => {};
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_expect_expr_comma {
	($e:expr, $($tt:tt)*) => {};
}
