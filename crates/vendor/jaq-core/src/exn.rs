//! Exceptions and errors.

use crate::{compile::TermId, filter::Vars, RcList};
use alloc::{boxed::Box, string::String, string::ToString, vec::Vec};
use core::fmt::{self, Display};

/// Exception.
///
/// This is either an error, a runtime halt, or control flow data internal to jaq.
/// Users should only be able to observe the first two cases.
///
/// Use [`crate::unwrap_valr`] to convert a [`crate::ValX`] to an error.
#[derive(Clone, Debug)]
pub struct Exn<'a, V>(pub(crate) Inner<'a, V>);

#[derive(Clone, Debug)]
pub(crate) enum Inner<'a, V> {
    Err(Box<Error<V>>),
    /// Tail-recursive call.
    ///
    /// This is used internally to execute tail-recursive filters.
    /// If this can be observed by users, then this is a bug.
    TailCall(Box<(&'a TermId, Vars<V>, CallInput<V>)>),
    Break(usize),
    Halt(i32),
}

#[derive(Clone, Debug)]
pub(crate) enum CallInput<V> {
    Run(V),
    Paths((V, RcList<V>)),
}

impl<V> CallInput<V> {
    pub fn unwrap_run(self) -> V {
        match self {
            Self::Run(v) => v,
            _ => panic!(),
        }
    }

    pub fn unwrap_paths(self) -> (V, RcList<V>) {
        match self {
            Self::Paths(vp) => vp,
            _ => panic!(),
        }
    }
}

impl<V> Exn<'_, V> {
    /// If the exception is an error, yield it, else yield the exception.
    pub fn get_err(self) -> Result<Error<V>, Self> {
        match self.0 {
            Inner::Err(e) => Ok(*e),
            _ => Err(self),
        }
    }

    /// If the exception halts, yield the exit code, else yield the exception.
    pub fn get_halt(self) -> Result<i32, Self> {
        match self.0 {
            Inner::Halt(code) => Ok(code),
            _ => Err(self),
        }
    }

    /// Create an exception intended to halt filter execution.
    ///
    /// This is used by the `halt/1` filter.
    pub fn halt(exit_code: i32) -> Self {
        Self(Inner::Halt(exit_code))
    }
}

impl<V> From<Error<V>> for Exn<'_, V> {
    fn from(e: Error<V>) -> Self {
        Exn(Inner::Err(Box::new(e)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Part<V, S = &'static str> {
    Val(V),
    Str(S),
}

/// Error that occurred during filter execution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error<V>(Part<V, Vec<Part<V>>>);

impl<V> Error<V> {
    /// Create a new error from a value.
    pub fn new(v: V) -> Self {
        Self(Part::Val(v))
    }

    /// Create a path expression error.
    pub fn path_expr(v: V) -> Self {
        Self(Part::Str(Vec::from([
            Part::Str("invalid path expression with input "),
            Part::Val(v),
        ])))
    }

    /// Create a type error.
    pub fn typ(v: V, typ: &'static str) -> Self {
        use Part::{Str, Val};
        [Str("cannot use "), Val(v), Str(" as "), Str(typ)]
            .into_iter()
            .collect()
    }

    /// Create a math error.
    pub fn math(l: V, op: crate::ops::Math, r: V) -> Self {
        use Part::{Str, Val};
        [
            Str("cannot calculate "),
            Val(l),
            Str(" "),
            Str(op.as_str()),
            Str(" "),
            Val(r),
        ]
        .into_iter()
        .collect()
    }

    /// Create an indexing error.
    pub fn index(l: V, r: V) -> Self {
        use Part::{Str, Val};
        [Str("cannot index "), Val(l), Str(" with "), Val(r)]
            .into_iter()
            .collect()
    }
}

impl<V: From<String>> Error<V> {
    /// Build an error from something that can be converted to a string.
    pub fn str(s: impl ToString) -> Self {
        Self(Part::Val(V::from(s.to_string())))
    }
}

impl<V> FromIterator<Part<V>> for Error<V> {
    fn from_iter<T: IntoIterator<Item = Part<V>>>(iter: T) -> Self {
        Self(Part::Str(iter.into_iter().collect()))
    }
}

impl<V: From<String> + Display> Error<V> {
    /// Convert the error into a value to be used by `catch` filters.
    pub fn into_val(self) -> V {
        if let Part::Val(v) = self.0 {
            v
        } else {
            V::from(self.to_string())
        }
    }
}

impl<V: Display> Display for Error<V> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match &self.0 {
            Part::Val(v) => v.fmt(f),
            Part::Str(parts) => parts.iter().try_for_each(|part| match part {
                Part::Val(v) => v.fmt(f),
                Part::Str(s) => s.fmt(f),
            }),
        }
    }
}
