//! Binary operations.

use core::ops::{Add, Div, Mul, Rem, Sub};

/// Arithmetic operation, such as `+`, `-`, `*`, `/`, `%`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Math {
    /// Addition
    Add,
    /// Subtraction
    Sub,
    /// Multiplication
    Mul,
    /// Division
    Div,
    /// Remainder
    Rem,
}

impl Math {
    /// Perform the arithmetic operation on the given inputs.
    pub fn run<I, O>(&self, l: I, r: I) -> O
    where
        I: Add<Output = O> + Sub<Output = O> + Mul<Output = O> + Div<Output = O> + Rem<Output = O>,
    {
        match self {
            Self::Add => l + r,
            Self::Sub => l - r,
            Self::Mul => l * r,
            Self::Div => l / r,
            Self::Rem => l % r,
        }
    }
}

impl Math {
    /// String representation of an arithmetic operation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Sub => "-",
            Self::Mul => "*",
            Self::Div => "/",
            Self::Rem => "%",
        }
    }
}

/// An operation that orders two values, such as `<`, `<=`, `>`, `>=`, `==`, `!=`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Cmp {
    /// Less-than (<).
    Lt,
    /// Less-than or equal (<=).
    Le,
    /// Greater-than (>).
    Gt,
    /// Greater-than or equal (>=).
    Ge,
    /// Equals (=).
    Eq,
    /// Not equals (!=).
    Ne,
}

impl Cmp {
    /// Perform the ordering operation on the given inputs.
    pub fn run<I: PartialOrd + PartialEq>(&self, l: &I, r: &I) -> bool {
        match self {
            Self::Gt => l > r,
            Self::Ge => l >= r,
            Self::Lt => l < r,
            Self::Le => l <= r,
            Self::Eq => l == r,
            Self::Ne => l != r,
        }
    }
}

impl Cmp {
    /// String representation of a comparison operation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Gt => ">",
            Self::Le => "<=",
            Self::Ge => ">=",
            Self::Eq => "==",
            Self::Ne => "!=",
        }
    }
}
