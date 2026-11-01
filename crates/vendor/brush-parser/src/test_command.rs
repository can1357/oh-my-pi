//! Parser for shell test commands.

use crate::nesting::NestingGuard;
use crate::{ast, error};

/// Parses a test command expression.
///
/// # Arguments
///
/// * `input` - The test command expression to parse, in string form.
pub fn parse<S: AsRef<str>>(input: &[S]) -> Result<ast::TestExpr, error::TestCommandParseError> {
    let nesting = NestingGuard::default();
    let result = test_command::full_expression(
        &input.iter().map(AsRef::as_ref).collect::<Vec<&str>>(),
        &nesting,
    );
    if let Some((exceeded, _)) = nesting.exceeded() {
        return Err(exceeded.into());
    }

    Ok(result?)
}

peg::parser! {
    grammar test_command<'a>(nesting: &NestingGuard) for [&'a str] {
        pub(crate) rule full_expression() -> ast::TestExpr =
            end() { ast::TestExpr::False } /
            e:one_arg_expr() end() { e } /
            e:two_arg_expr() end()  { e } /
            e:three_arg_expr() end()  { e } /
            e:four_arg_expr() end()  { e } /
            expression()

        rule one_arg_expr() -> ast::TestExpr =
            [s] { ast::TestExpr::Literal(s.to_owned()) }

        rule two_arg_expr() -> ast::TestExpr =
            ["!"] e:one_arg_expr() { ast::TestExpr::Not(Box::from(e)) } /
            op:unary_op() [s] { ast::TestExpr::UnaryTest(op, s.to_owned()) }

        rule three_arg_expr() -> ast::TestExpr =
            [left] ["-a"] [right] { ast::TestExpr::And(Box::from(ast::TestExpr::Literal(left.to_owned())), Box::from(ast::TestExpr::Literal(right.to_owned()))) } /
            [left] ["-o"] [right] { ast::TestExpr::Or(Box::from(ast::TestExpr::Literal(left.to_owned())), Box::from(ast::TestExpr::Literal(right.to_owned()))) } /
            [left] op:binary_op() [right] { ast::TestExpr::BinaryTest(op, left.to_owned(), right.to_owned()) } /
            ["!"] e:two_arg_expr() { ast::TestExpr::Not(Box::from(e)) } /
            ["("] e:one_arg_expr() [")"] { e }

        rule four_arg_expr() -> ast::TestExpr =
            ["!"] e:three_arg_expr() { ast::TestExpr::Not(Box::from(e)) }

        rule expression() -> ast::TestExpr = precedence! {
            left:(@) ["-a"] right:@ { ast::TestExpr::And(Box::from(left), Box::from(right)) }
            left:(@) ["-o"] right:@ { ast::TestExpr::Or(Box::from(left), Box::from(right)) }
            --
            e:unary() { e }
        }

        // `(`, `!` and the primaries, in the order the table above used to try them. They are a
        // rule of their own so that every nested `(` and `!` passes the nesting guard.
        rule unary() -> ast::TestExpr =
            ["("] e:nested("(", <expression()>) [")"] { ast::TestExpr::Parenthesized(Box::from(e)) } /
            ["!"] e:nested("!", <unary()>) { ast::TestExpr::Not(Box::from(e)) } /
            [left] op:binary_op() [right] { ast::TestExpr::BinaryTest(op, left.to_owned(), right.to_owned()) } /
            op:unary_op() [operand] { ast::TestExpr::UnaryTest(op, operand.to_owned()) } /
            [s] { ast::TestExpr::Literal(s.to_owned()) }

        rule unary_op() -> ast::UnaryPredicate =
            ["-a"] { ast::UnaryPredicate::FileExists } /
            ["-b"] { ast::UnaryPredicate::FileExistsAndIsBlockSpecialFile } /
            ["-c"] { ast::UnaryPredicate::FileExistsAndIsCharSpecialFile } /
            ["-d"] { ast::UnaryPredicate::FileExistsAndIsDir } /
            ["-e"] { ast::UnaryPredicate::FileExists } /
            ["-f"] { ast::UnaryPredicate::FileExistsAndIsRegularFile } /
            ["-g"] { ast::UnaryPredicate::FileExistsAndIsSetgid } /
            ["-h"] { ast::UnaryPredicate::FileExistsAndIsSymlink } /
            ["-k"] { ast::UnaryPredicate::FileExistsAndHasStickyBit } /
            ["-n"] { ast::UnaryPredicate::StringHasNonZeroLength } /
            ["-o"] { ast::UnaryPredicate::ShellOptionEnabled } /
            ["-p"] { ast::UnaryPredicate::FileExistsAndIsFifo } /
            ["-r"] { ast::UnaryPredicate::FileExistsAndIsReadable } /
            ["-s"] { ast::UnaryPredicate::FileExistsAndIsNotZeroLength } /
            ["-t"] { ast::UnaryPredicate::FdIsOpenTerminal } /
            ["-u"] { ast::UnaryPredicate::FileExistsAndIsSetuid } /
            ["-v"] { ast::UnaryPredicate::ShellVariableIsSetAndAssigned } /
            ["-w"] { ast::UnaryPredicate::FileExistsAndIsWritable } /
            ["-x"] { ast::UnaryPredicate::FileExistsAndIsExecutable } /
            ["-z"] { ast::UnaryPredicate::StringHasZeroLength } /
            ["-G"] { ast::UnaryPredicate::FileExistsAndOwnedByEffectiveGroupId } /
            ["-L"] { ast::UnaryPredicate::FileExistsAndIsSymlink } /
            ["-N"] { ast::UnaryPredicate::FileExistsAndModifiedSinceLastRead } /
            ["-O"] { ast::UnaryPredicate::FileExistsAndOwnedByEffectiveUserId } /
            ["-R"] { ast::UnaryPredicate::ShellVariableIsSetAndNameRef } /
            ["-S"] { ast::UnaryPredicate::FileExistsAndIsSocket }

        rule binary_op() -> ast::BinaryPredicate =
            ["=="]  { ast::BinaryPredicate::StringExactlyMatchesString } /
            ["-ef"] { ast::BinaryPredicate::FilesReferToSameDeviceAndInodeNumbers } /
            ["-eq"] { ast::BinaryPredicate::ArithmeticEqualTo } /
            ["-ge"] { ast::BinaryPredicate::ArithmeticGreaterThanOrEqualTo } /
            ["-gt"] { ast::BinaryPredicate::ArithmeticGreaterThan } /
            ["-le"] { ast::BinaryPredicate::ArithmeticLessThanOrEqualTo } /
            ["-lt"] { ast::BinaryPredicate::ArithmeticLessThan } /
            ["-ne"] { ast::BinaryPredicate::ArithmeticNotEqualTo } /
            ["-nt"] { ast::BinaryPredicate::LeftFileIsNewerOrExistsWhenRightDoesNot } /
            ["-ot"] { ast::BinaryPredicate::LeftFileIsOlderOrDoesNotExistWhenRightDoes } /
            ["="]   { ast::BinaryPredicate::StringExactlyMatchesString } /
            ["!="]  { ast::BinaryPredicate::StringDoesNotExactlyMatchString } /
            ["<"]   { ast::BinaryPredicate::LeftSortsBeforeRight } /
            [">"]   { ast::BinaryPredicate::LeftSortsAfterRight }

        rule end() = ![_]

        // Parses `r` one nesting level deeper, as the operand of `construct`. Fails, without
        // trying `r`, once that would go past the nesting limit.
        rule nested<T>(construct: &'static str, r: rule<T>) -> T =
            enter(construct) v:r()? leave() {? v.ok_or("nested expression") }

        rule enter(construct: &'static str) = #{|_input, pos| {
            if nesting.enter(construct, pos) {
                peg::RuleResult::Matched(pos, ())
            } else {
                peg::RuleResult::Failed
            }
        }}

        rule leave() = #{|_input, pos| {
            nesting.leave();
            peg::RuleResult::Matched(pos, ())
        }}
    }
}
