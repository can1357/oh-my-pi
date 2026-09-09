//! Jinja-flavored prompt template engine with layered props.
//!
//! `omp-scribe` renders the nested markdown/XML prompts omp composes: a
//! small deterministic template language (`{{ }}`, `{% %}`, `{# #}`) over an
//! O(1)-clone [`Props`] bag, plus the post-render prompt canonicalization
//! pass in [`canon`]. See the crate README for the full grammar table and
//! undefined-value semantics.
//!
//! # Example
//! ```
//! use omp_scribe::{Engine, Props};
//!
//! let engine = Engine::new();
//! let template = engine
//! 	.compile("greet", "{% if name %}Hello {{ name }}!{% endif %}")
//! 	.unwrap();
//! let mut props = Props::new();
//! props.set("name", "omp");
//! assert_eq!(template.render_str(&engine, &props).unwrap(), "Hello omp!");
//! ```

pub mod canon;
mod error;
mod filters;
mod lex;
mod parse;
mod props;
mod render;
mod value;

pub use error::{Error, HelperError, SyntaxErrorKind, TypeErrorKind};
pub use props::{Props, ScopedProps};
pub use render::{Engine, Template};
pub use value::Value;

/// Implementation details used by the [`list!`] and [`map!`] macros.
#[doc(hidden)]
pub mod __private {
	use omp_core::{IntoStr, Str};

	use crate::Value;

	#[doc(hidden)]
	pub fn list<const N: usize>(items: [Value; N]) -> Value {
		Value::List(items.into_iter().collect())
	}

	#[doc(hidden)]
	pub fn map<const N: usize>(entries: [(Str, Value); N]) -> Value {
		Value::Map(entries.into_iter().collect())
	}

	#[doc(hidden)]
	pub fn key(key: impl IntoStr) -> Str {
		key.into_str()
	}
}

/// Builds a [`Value::List`] from element expressions.
///
/// Every element goes through [`Value::from`], so mixed scalar types work:
/// `omp_scribe::list!["a", 1, true]`.
#[macro_export]
macro_rules! list {
	[$($item:expr),* $(,)?] => {
		$crate::__private::list([$($crate::Value::from($item)),*])
	};
}

/// Builds a [`Value::Map`] from `key => value` pairs.
///
/// Keys convert via `IntoStr`, values via [`Value::from`]:
/// `omp_scribe::map! { "name" => "omp", "count" => 3 }`.
#[macro_export]
macro_rules! map {
	{$($key:expr => $value:expr),* $(,)?} => {
		$crate::__private::map([$(($crate::__private::key($key), $crate::Value::from($value))),*])
	};
}
