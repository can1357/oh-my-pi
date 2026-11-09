//! Precedence climbing for parsing expressions with binary operators.
//!
//! This allows you to parse expressions that are
//! separated by binary operators with precedence and associativity.
//! For example, in the expression `1 + 2 * 3`, we usually want to
//! parse this into `1 + (2 * 3)`, not `(1 + 2) * 3`.
//! This is handled by saying that `*` has higher *precedence* than `+`.
//! Also, when we have a power operator `^`, we want
//! `2 ^ 3 ^ 4` to mean `(2 ^ 3) ^ 4`, not `2 ^ (3 ^ 4)`.
//! This is handled by saying that `^` is *left-associative*.
//!
//! This was adapted from
//! <https://ycpcs.github.io/cs340-fall2017/lectures/lecture06.html#implementation>.

use core::iter::Peekable;

/// Associativity of an operator.
pub enum Associativity {
    /// `(x + y) + z`
    Left,
    /// `x + (y + z)`
    Right,
}

/// Binary operator.
pub trait Op {
    /// "Stickiness" of the operator
    fn precedence(&self) -> usize;
    /// Is the operator left- or right-associative?
    fn associativity(&self) -> Associativity;
}

/// An expression that can be built from other expressions with some operator.
pub trait Expr<O: Op> {
    /// Combine two expressions with an operator.
    fn from_op(lhs: Self, op: O, rhs: Self) -> Self;
}

/// Perform precedence climbing.
pub fn climb<O: Op, T: Expr<O>>(head: T, iter: impl IntoIterator<Item = (O, T)>) -> T {
    climb1(head, &mut iter.into_iter().peekable(), 0)
}

fn climb1<O: Op, T: Expr<O>, I>(mut x: T, iter: &mut Peekable<I>, min_prec: usize) -> T
where
    I: Iterator<Item = (O, T)>,
{
    while let Some((op, mut rhs)) = iter.next_if(|(op, _)| op.precedence() >= min_prec) {
        let right_assoc = matches!(op.associativity(), Associativity::Right);
        let this_prec = op.precedence();

        while let Some(next) = iter.peek() {
            let next_prec = next.0.precedence();

            if next_prec > this_prec || (right_assoc && next_prec == this_prec) {
                rhs = climb1(rhs, iter, next_prec);
            } else {
                break;
            }
        }
        x = T::from_op(x, op, rhs);
    }
    x
}

/// Simple arithmetic expressions
#[test]
fn test() {
    enum Arith {
        Add,
        Sub,
        Mul,
        Div,
    }

    impl Op for Arith {
        fn precedence(&self) -> usize {
            match self {
                Arith::Add | Arith::Sub => 0,
                Arith::Mul | Arith::Div => 1,
            }
        }

        fn associativity(&self) -> Associativity {
            Associativity::Right
        }
    }

    impl Expr<Arith> for isize {
        fn from_op(lhs: Self, op: Arith, rhs: Self) -> Self {
            match op {
                Arith::Add => lhs + rhs,
                Arith::Sub => lhs - rhs,
                Arith::Mul => lhs * rhs,
                Arith::Div => lhs / rhs,
            }
        }
    }

    use Arith::{Add, Div, Mul, Sub};
    // 1 + 2 * 3 - 6 / 2 =
    // 1 +   6   -   3   = 4
    let head: isize = 1;
    let tail = [(Add, 2), (Mul, 3), (Sub, 6), (Div, 2)];
    let out = climb(head, tail);
    assert_eq!(out, 4);
}
