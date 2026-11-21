//! jq language parser, compiler, and interpreter.
//!
//! This crate allows you to parse, compile, and execute jq-like filters.
//!
//! The example below demonstrates how to use this crate.
//! See the implementation in the `jaq` crate if you are interested in
//! more complex use cases, such as lazy JSON file loading, error handling etc.
//!
//! ~~~
//! use jaq_core::{data, unwrap_valr, Compiler, Ctx, Vars};
//! use jaq_core::load::{Arena, File, Loader};
//! use jaq_json::{read, Val};
//!
//! let input = r#"["Hello", "world"]"#;
//! let input = read::parse_single(&input.as_bytes()).unwrap();
//! let program = File { code: ".[]", path: () };
//!
//! // named filters, such as `keys`, `map`, ...
//! let defs = jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs());
//! let funs = jaq_core::funs().chain(jaq_std::funs()).chain(jaq_json::funs());
//!
//! let loader = Loader::new(defs);
//! let arena = Arena::default();
//!
//! // parse the filter
//! let modules = loader.load(&arena, program).unwrap();
//!
//! // compile the filter
//! let filter = jaq_core::Compiler::default()
//!     .with_funs(funs)
//!     .compile(modules)
//!     .unwrap();
//!
//! // context for filter execution
//! let ctx = Ctx::<data::JustLut<Val>>::new(&filter.lut, Vars::new([]));
//! // iterator over the output values
//! let mut out = filter.id.run((ctx, input)).map(unwrap_valr);
//!
//! assert_eq!(out.next(), Some(Ok(Val::from("Hello".to_owned()))));;
//! assert_eq!(out.next(), Some(Ok(Val::from("world".to_owned()))));;
//! assert_eq!(out.next(), None);;
//! ~~~
#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

extern crate alloc;
#[cfg(feature = "std")]
extern crate std;

pub mod box_iter;
pub mod compile;
pub mod data;
mod exn;
mod filter;
mod fold;
mod funs;
mod into_iter;
pub mod load;
pub mod native;
pub mod ops;
pub mod path;
mod rc_lazy_list;
mod rc_list;
mod stack;
pub mod val;

pub use data::DataT;
pub use exn::{Error, Exn};
pub use filter::{Ctx, Cv, Native, PathsPtr, RunPtr, UpdatePtr, Vars};
pub use val::{unwrap_valr, ValR, ValT, ValX, ValXs};

use rc_list::List as RcList;
use stack::Stack;

/// Argument of a definition, such as `$v` or `f` in `def foo($v; f): ...`.
///
/// In jq, we can bind filters in three different ways:
///
/// 1. `f as $x | ...`
/// 2. `def g($x): ...; g(f)`
/// 3. `def g(fx): ...; g(f)`
///
/// In the first two cases, we bind the outputs of `f` to a variable `$x`.
/// In the third case, we bind `f` to a filter `fx`
///
/// When writing a native filter, this is used to declare its arguments.
/// It is passed to [`compile::Compiler::with_funs`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bind<V = (), F = V> {
    /// binding to a variable
    Var(V),
    /// binding to a filter
    Fun(F),
}

impl<V, F> Bind<V, F> {
    /// Move references inward.
    pub(crate) fn as_ref(&self) -> Bind<&V, &F> {
        match self {
            Self::Var(x) => Bind::Var(x),
            Self::Fun(x) => Bind::Fun(x),
        }
    }
}

impl<T> Bind<T, T> {
    /// Apply a function to both binding types.
    pub(crate) fn map<U>(self, f: impl FnOnce(T) -> U) -> Bind<U, U> {
        match self {
            Self::Var(x) => Bind::Var(f(x)),
            Self::Fun(x) => Bind::Fun(f(x)),
        }
    }
}

/// jq program compiler.
pub type Compiler<S, D> = compile::Compiler<S, Native<D>>;
/// Function from a value to a stream of value results.
pub type Filter<D> = compile::Filter<Native<D>>;
/// Lookup table for terms and functions.
pub type Lut<D> = compile::Lut<Native<D>>;

impl<V: ValT + 'static> Filter<data::JustLut<V>> {
    /// Run a filter on given input, panic if it does not yield the given output.
    ///
    /// This is for testing purposes.
    pub fn yields(&self, x: V, ys: impl Iterator<Item = ValR<V>>) {
        let ctx = Ctx::<data::JustLut<V>>::new(&self.lut, Vars::new([]));
        let out = self.id.run((ctx, x)).map(unwrap_valr);
        assert!(out.eq(ys));
    }
}

/// Minimal set of definitions.
///
/// This depends on [`funs()`] being loaded.
pub fn defs() -> impl Iterator<Item = load::parse::Def<&'static str>> {
    load::parse(include_str!("defs.jq"), |p| p.defs())
        .unwrap()
        .into_iter()
}

/// Minimal set of filters that are generic over the value type.
///
/// Return the minimal set of named filters available in jaq
/// which are implemented as native filters, such as `error`, `path`, ...
///
/// Does not return filters from the standard library, such as `map`.
pub fn funs<D: DataT>() -> impl Iterator<Item = native::Filter<Native<D>>>
where
    for<'a> D::V<'a>: ValT,
{
    let run = funs::run().into_vec().into_iter().map(native::run);
    let paths = funs::paths().into_vec().into_iter().map(native::paths);
    run.chain(paths)
}
