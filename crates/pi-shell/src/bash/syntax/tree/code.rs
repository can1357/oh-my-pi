//! Small values stored in a node's `x` or `c` field: one list per type,
//! read in both directions ([`Code::code`] encodes, [`Code::of`] is the
//! entry of [`Code::ALL`] at a code).

use crate::bash::syntax::ast::{
	AndOrOp, CaseMode, CaseTerm, ComsubKind, RedirOp, ReplaceMode, Sep, Special,
};

/// A value kept in a node field as a small code.
pub(crate) trait Code: Copy + 'static {
	/// Every value, in code order.
	const ALL: &'static [Self];

	fn code(self) -> u16;

	fn of(c: u16) -> Self {
		Self::ALL[c as usize]
	}
}

/// An enum whose discriminant is its code.
macro_rules! code_enum {
	($(#[$m:meta])* pub enum $name:ident { $($v:ident),* $(,)? }) => {
		$(#[$m])*
		#[derive(Clone, Copy, Debug, PartialEq, Eq)]
		#[repr(u16)]
		pub enum $name { $($v),* }

		impl $crate::bash::syntax::tree::Code for $name {
			const ALL: &'static [Self] = &[$(Self::$v),*];

			fn code(self) -> u16 {
				self as u16
			}
		}
	};
}
pub(super) use code_enum;

/// An enum of another module, coded by its position in the list (an
/// exhaustive match: a new variant does not compile until listed). An
/// entry `Name = Variant { field: value }` codes one value of a variant
/// with a field.
macro_rules! codes {
	($ty:ident { $($o:ident $(= $v:ident { $f:ident: $b:literal })?),* $(,)? }) => {
		impl Code for $ty {
			const ALL: &'static [Self] = &[$(codes!(@val $ty $o $($v $f $b)?)),*];

			fn code(self) -> u16 {
				#[repr(u16)]
				enum Order { $($o),* }
				match self {
					$(codes!(@val $ty $o $($v $f $b)?) => Order::$o as u16),*
				}
			}
		}
	};
	(@val $ty:ident $o:ident) => { $ty::$o };
	(@val $ty:ident $o:ident $v:ident $f:ident $b:literal) => { $ty::$v { $f: $b } };
}

code_enum! {
	/// Word part kinds (`x` of a [`K::Part`](super::K::Part) node).
	pub enum Pk {
		Lit, Escaped, SQuote, DQuote, AnsiC, Locale, Param, Comsub, Arith, ProcSub, Compound,
		BadSubst, BadComsub, DroppedQuote, Zsh,
	}
}

code_enum! {
	/// `[[ ]]` expression kinds (`x` of a [`K::Cond`](super::K::Cond) node).
	pub enum Cx { Unary, Binary, Word, Not, And, Or, Group }
}

code_enum! {
	/// Parameter-name kinds (`x` of a [`K::Name`](super::K::Name) node).
	pub enum Nk { Var, Positional, Special }
}

code_enum! {
	/// Subscript kinds (`x` of a [`K::Sub`](super::K::Sub) node).
	pub enum Sk { At, Star, Expr }
}

code_enum! {
	/// Parameter operator kinds (in `c` of a parameter part).
	pub enum Ok_ {
		None, Length, Indirect, PrefixNames, Default, Assign, Error, Alt, Substr, Trim, Replace, Case,
		Transform,
	}
}

codes!(Sep { Semi, Amp, Newline, None, Disown });
codes!(AndOrOp { And, Or });
codes!(CaseTerm { Break, FallThrough, Continue });
codes!(ComsubKind { Dollar, Backtick, NoFork, ValueSub });
codes!(Special { At, Star, Count, Status, Flags, ShellPid, LastBg });
codes!(ReplaceMode { First, All, Prefix, Suffix });
codes!(CaseMode { Upper, Lower, Toggle });

codes!(RedirOp {
	In,
	Out,
	Append,
	Clobber,
	ReadWrite,
	DupIn,
	DupOut,
	OutErr,
	AppendErr,
	HereDoc = HereDoc { strip_tabs: false },
	HereString,
	AppendClobber,
	OutErrClobber,
	AppendErrClobber,
	StripHereDoc = HereDoc { strip_tabs: true },
});
