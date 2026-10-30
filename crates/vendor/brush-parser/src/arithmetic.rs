//! Parser for shell arithmetic expressions.

use crate::ast;
use crate::error;

/// Parses a shell arithmetic expression.
///
/// # Arguments
///
/// * `input` - The arithmetic expression to parse, in string form.
pub fn parse(input: &str) -> Result<ast::ArithmeticExpr, error::WordParseError> {
    cacheable_parse(input.to_owned())
}

#[cached::proc_macro::cached(size = 64, result = true)]
fn cacheable_parse(input: String) -> Result<ast::ArithmeticExpr, error::WordParseError> {
    tracing::debug!(target: "arithmetic", "parsing arithmetic expression: '{input}'");
    arithmetic::full_expression(input.as_str())
        .map_err(|e| error::WordParseError::ArithmeticExpression(e.into()))
}

peg::parser! {
    grammar arithmetic() for str {
        pub(crate) rule full_expression() -> ast::ArithmeticExpr =
            ![_] { ast::ArithmeticExpr::Literal(0) } /
            _ e:expression() _ { e }

        pub(crate) rule expression() -> ast::ArithmeticExpr = precedence!{
            x:(@) _ "," _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Comma, Box::new(x), Box::new(y)) }
            --
            x:lvalue() _ "*=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::Multiply, x, Box::new(y)) }
            x:lvalue() _ "/=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::Divide, x, Box::new(y)) }
            x:lvalue() _ "%=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::Modulo, x, Box::new(y)) }
            x:lvalue() _ "+=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::Add, x, Box::new(y)) }
            x:lvalue() _ "-=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::Subtract, x, Box::new(y)) }
            x:lvalue() _ "<<=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::ShiftLeft, x, Box::new(y)) }
            x:lvalue() _ ">>=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::ShiftRight, x, Box::new(y)) }
            x:lvalue() _ "&=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::BitwiseAnd, x, Box::new(y)) }
            x:lvalue() _ "|=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::BitwiseOr, x, Box::new(y)) }
            x:lvalue() _ "^=" _ y:(@) { ast::ArithmeticExpr::BinaryAssignment(ast::BinaryOperator::BitwiseXor, x, Box::new(y)) }
            x:lvalue() _ "=" _ y:(@) { ast::ArithmeticExpr::Assignment(x, Box::new(y)) }
            --
            x:@ _ "?" _ y:expression() _ ":" _ z:(@) { ast::ArithmeticExpr::Conditional(Box::new(x), Box::new(y), Box::new(z)) }
            --
            x:(@) _ "||" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::LogicalOr, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "&&" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::LogicalAnd, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "|" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::BitwiseOr, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "^" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::BitwiseXor, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "&" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::BitwiseAnd, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "==" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Equals, Box::new(x), Box::new(y)) }
            x:(@) _ "!=" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::NotEquals, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "<" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::LessThan, Box::new(x), Box::new(y)) }
            x:(@) _ ">" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::GreaterThan, Box::new(x), Box::new(y)) }
            x:(@) _ "<=" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::LessThanOrEqualTo, Box::new(x), Box::new(y)) }
            x:(@) _ ">=" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::GreaterThanOrEqualTo, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "<<" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::ShiftLeft, Box::new(x), Box::new(y)) }
            x:(@) _ ">>" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::ShiftRight, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "+" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Add, Box::new(x), Box::new(y)) }
            x:(@) _ "-" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Subtract, Box::new(x), Box::new(y)) }
            --
            x:(@) _ "*" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Multiply, Box::new(x), Box::new(y)) }
            x:(@) _ "%" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Modulo, Box::new(x), Box::new(y)) }
            x:(@) _ "/" _ y:@ { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Divide, Box::new(x), Box::new(y)) }
            --
            x:@ _ "**" _ y:(@) { ast::ArithmeticExpr::BinaryOp(ast::BinaryOperator::Power, Box::new(x), Box::new(y)) }
            --
            "!" _ x:(@) { ast::ArithmeticExpr::UnaryOp(ast::UnaryOperator::LogicalNot, Box::new(x)) }
            "~" _ x:(@) { ast::ArithmeticExpr::UnaryOp(ast::UnaryOperator::BitwiseNot, Box::new(x)) }
            --
            // NOTE: We add negative lookahead to avoid ambiguity with the pre-increment/pre-decrement operators.
            "+" !['+'] _ x:(@) { ast::ArithmeticExpr::UnaryOp(ast::UnaryOperator::UnaryPlus, Box::new(x)) }
            "-" !['-'] _ x:(@) { ast::ArithmeticExpr::UnaryOp(ast::UnaryOperator::UnaryMinus, Box::new(x)) }
            --
            "++" _ x:lvalue() { ast::ArithmeticExpr::UnaryAssignment(ast::UnaryAssignmentOperator::PrefixIncrement, x) }
            "--" _ x:lvalue() { ast::ArithmeticExpr::UnaryAssignment(ast::UnaryAssignmentOperator::PrefixDecrement, x) }
            --
            x:lvalue() _ "++" { ast::ArithmeticExpr::UnaryAssignment(ast::UnaryAssignmentOperator::PostfixIncrement, x) }
            x:lvalue() _ "--" { ast::ArithmeticExpr::UnaryAssignment(ast::UnaryAssignmentOperator::PostfixDecrement, x) }
            --
            n:literal_number() { ast::ArithmeticExpr::Literal(n) }
            l:lvalue() { ast::ArithmeticExpr::Reference(l) }
            "(" _ expr:expression() _ ")" { expr }
        }

        rule lvalue() -> ast::ArithmeticTarget =
            name:variable_name() "[" index:expression() "]" {
                ast::ArithmeticTarget::ArrayElement(name.to_owned(), Box::new(index))
            } /
            name:variable_name() {
                ast::ArithmeticTarget::Variable(name.to_owned())
            }

        rule variable_name() -> &'input str =
            $(['a'..='z' | 'A'..='Z' | '_'](['a'..='z' | 'A'..='Z' | '_' | '0'..='9']*))

        rule _() -> () = quiet!{[' ' | '\t' | '\n' | '\r']*} {}

        rule literal_number() -> i64 =
            // Literal with explicit radix (format: <base>#<literal>)
            radix:decimal_literal() "#" s:$(['0'..='9' | 'a'..='z' | 'A'..='Z' | '@' | '_']+) {?
                parse_shell_literal_number(s, radix.cast_unsigned())
            } /
            // Hex literal
            "0" ['x' | 'X'] s:$(['0'..='9' | 'a'..='f' | 'A'..='F']*) {?
                i64::from_str_radix(s, 16).or(Err("i64"))
            } /
            // Octal literal
            s:$("0" ['0'..='8']*) {?
                i64::from_str_radix(s, 8).or(Err("i64"))
            } /
            // Decimal literal
            decimal_literal()

        rule decimal_literal() -> i64 =
            s:$(['1'..='9'] ['0'..='9']*) {?
                // Parse as u64 first, then cast to i64. This handles values like
                // 9223372036854775808 (i64::MAX + 1) which is needed for INT64_MIN
                // when preceded by unary minus: -(9223372036854775808) wraps to i64::MIN.
                s.parse::<u64>().map(|v| v.cast_signed()).or(Err("i64"))
            }
    }
}

fn parse_shell_literal_number(s: &str, radix: u64) -> Result<i64, &'static str> {
    if !(2..=64).contains(&radix) {
        return Err("invalid base");
    }

    // For bases <= 36: case-insensitive (a-z and A-Z both map to 10-35)
    // For bases > 36 (bash extension):
    //   0-9 = 0-9, a-z = 10-35, A-Z = 36-61, @ = 62, _ = 63
    let mut result: i64 = 0;

    for ch in s.chars() {
        let digit_val = if radix <= 36 {
            match ch {
                '0'..='9' => (ch as u64) - ('0' as u64),
                'a'..='z' => (ch as u64) - ('a' as u64) + 10,
                'A'..='Z' => (ch as u64) - ('A' as u64) + 10,
                _ => return Err("invalid digit"),
            }
        } else {
            match ch {
                '0'..='9' => (ch as u64) - ('0' as u64),
                'a'..='z' => (ch as u64) - ('a' as u64) + 10,
                'A'..='Z' => (ch as u64) - ('A' as u64) + 36,
                '@' => 62,
                '_' => 63,
                _ => return Err("invalid digit"),
            }
        };

        if digit_val >= radix {
            return Err("value too great for base");
        }

        result = result
            .wrapping_mul(radix.cast_signed())
            .wrapping_add(digit_val.cast_signed());
    }

    Ok(result)
}
