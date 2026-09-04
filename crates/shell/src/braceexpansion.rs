use std::iter;

use itertools::{Either, Itertools};

use crate::parser::{word, word::BraceExpressionOrText};

pub(crate) fn generate_and_combine_brace_expansions(
	pieces: Vec<BraceExpressionOrText>,
) -> impl Iterator<Item = String> {
	pieces
		.into_iter()
		.map(|piece| expand_brace_expr_or_text(piece).collect::<Vec<_>>())
		.multi_cartesian_product()
		.map(|v| v.join(""))
}

fn expand_brace_expr_or_text(beot: word::BraceExpressionOrText) -> impl Iterator<Item = String> {
	match beot {
		word::BraceExpressionOrText::Expr(members) => {
			Either::Left(members.into_iter().flat_map(expand_brace_expr_member))
		},
		word::BraceExpressionOrText::Text(text) => Either::Right(iter::once(text)),
	}
}

fn expand_brace_expr_member(bem: word::BraceExpressionMember) -> impl Iterator<Item = String> {
	match bem {
		word::BraceExpressionMember::NumberSequence { start, end, increment } => {
			Either::Left(expand_number_sequence(start, end, increment))
		},
		word::BraceExpressionMember::CharSequence { start, end, increment } => {
			Either::Right(Either::Left(expand_char_sequence(start, end, increment)))
		},
		word::BraceExpressionMember::Child(elements) => {
			// Recursive children are the uncommon fallback; common scalar sequences stay
			// statically dispatched and allocation-free.
			Either::Right(Either::Right(Box::new(generate_and_combine_brace_expansions(elements))
				as Box<dyn Iterator<Item = String>>))
		},
	}
}

#[expect(clippy::cast_possible_truncation, reason = "step_by requires usize increments")]
fn expand_number_sequence(start: i64, end: i64, increment: i64) -> impl Iterator<Item = String> {
	let increment = increment.unsigned_abs().max(1) as usize;
	if start <= end {
		Either::Left((start..=end).step_by(increment).map(|n| n.to_string()))
	} else {
		#[allow(
			clippy::cast_possible_wrap,
			reason = "the increment originated from an i64 magnitude"
		)]
		let increment = increment as i64;
		Either::Right(
			iter::successors(Some(start), move |&n| {
				let next = n - increment;
				(next >= end).then_some(next)
			})
			.map(|n| n.to_string()),
		)
	}
}

#[expect(clippy::cast_possible_truncation, reason = "step_by requires usize increments")]
fn expand_char_sequence(start: char, end: char, increment: i64) -> impl Iterator<Item = String> {
	let increment = increment.unsigned_abs().max(1) as usize;
	if start <= end {
		Either::Left((start..=end).step_by(increment).map(|c| c.to_string()))
	} else {
		let increment = increment as u32;
		Either::Right(
			iter::successors(Some(start), move |&c| {
				let next = char::from_u32(c as u32 - increment)?;
				(next >= end).then_some(next)
			})
			.map(|c| c.to_string()),
		)
	}
}
