//! Defines the Abstract Syntax Tree (ast) for shell programs. Includes types and utilities
//! for manipulating the AST.

use std::fmt::{Display, Write};

use crate::{SourceSpan, tokenizer};

const DISPLAY_INDENT: &str = "    ";

/// Trait implemented by all AST nodes. Used to aggregate traits expected
/// to be implemented.
pub trait Node: Display + SourceLocation {}

/// Provides the source location for the syntax item
pub trait SourceLocation {
    /// The location of the syntax item, when known
    fn location(&self) -> Option<SourceSpan>;
}

pub(crate) fn maybe_location(
    start: Option<&SourceSpan>,
    end: Option<&SourceSpan>,
) -> Option<SourceSpan> {
    if let (Some(s), Some(e)) = (start, end) {
        Some(SourceSpan::within(s, e))
    } else {
        None
    }
}

/// Represents a complete shell program.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct Program {
    /// A sequence of complete shell commands.
    pub complete_commands: Vec<CompleteCommand>,
}

impl Node for Program {}

impl SourceLocation for Program {
    fn location(&self) -> Option<SourceSpan> {
        let start = self
            .complete_commands
            .first()
            .and_then(SourceLocation::location);
        let end = self
            .complete_commands
            .last()
            .and_then(SourceLocation::location);
        maybe_location(start.as_ref(), end.as_ref())
    }
}

impl Display for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for complete_command in &self.complete_commands {
            write!(f, "{complete_command}")?;
        }
        Ok(())
    }
}

/// Represents a complete shell command.
pub type CompleteCommand = CompoundList;

/// Represents a complete shell command item.
pub type CompleteCommandItem = CompoundListItem;

// TODO(tracing): decide if we want to trace this location or consider it a whitespace separator
/// Indicates whether the preceding command is executed synchronously or asynchronously.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum SeparatorOperator {
    /// The preceding command is executed asynchronously.
    Async,
    /// The preceding command is executed synchronously.
    Sequence,
}

impl Display for SeparatorOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Async => write!(f, "&"),
            Self::Sequence => write!(f, ";"),
        }
    }
}

/// Represents a sequence of command pipelines connected by boolean operators.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct AndOrList {
    /// The first command pipeline.
    pub first: Pipeline,
    /// Any additional command pipelines, in sequence order.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Vec::is_empty", default)
    )]
    pub additional: Vec<AndOr>,
}

impl Node for AndOrList {}

impl SourceLocation for AndOrList {
    fn location(&self) -> Option<SourceSpan> {
        let start = self.first.location();
        let last = self.additional.last();
        let end = last.and_then(SourceLocation::location);

        match (start, end) {
            (Some(s), Some(e)) => Some(SourceSpan::within(&s, &e)),
            (start, _) => start,
        }
    }
}

impl Display for AndOrList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.first)?;
        for item in &self.additional {
            write!(f, "{item}")?;
        }

        Ok(())
    }
}

/// Represents a boolean operator used to connect command pipelines in an [`AndOrList`]
#[derive(PartialEq, Eq)]
pub enum PipelineOperator {
    /// The command pipelines are connected by a boolean AND operator.
    And,
    /// The command pipelines are connected by a boolean OR operator.
    Or,
}

impl PartialEq<AndOr> for PipelineOperator {
    fn eq(&self, other: &AndOr) -> bool {
        matches!(
            (self, other),
            (Self::And, AndOr::And(_)) | (Self::Or, AndOr::Or(_))
        )
    }
}

// We cannot losslessly convert into `AndOr`, hence we can only do `Into`.
#[expect(clippy::from_over_into)]
impl Into<PipelineOperator> for AndOr {
    fn into(self) -> PipelineOperator {
        match self {
            Self::And(_) => PipelineOperator::And,
            Self::Or(_) => PipelineOperator::Or,
        }
    }
}

/// An iterator over the pipelines in an [`AndOrList`].
pub struct AndOrListIter<'a> {
    first: Option<&'a Pipeline>,
    additional_iter: std::slice::Iter<'a, AndOr>,
}

impl<'a> Iterator for AndOrListIter<'a> {
    type Item = (PipelineOperator, &'a Pipeline);

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(first) = self.first.take() {
            Some((PipelineOperator::And, first))
        } else {
            self.additional_iter.next().map(|and_or| match and_or {
                AndOr::And(pipeline) => (PipelineOperator::And, pipeline),
                AndOr::Or(pipeline) => (PipelineOperator::Or, pipeline),
            })
        }
    }
}

impl<'a> IntoIterator for &'a AndOrList {
    type Item = (PipelineOperator, &'a Pipeline);
    type IntoIter = AndOrListIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        AndOrListIter {
            first: Some(&self.first),
            additional_iter: self.additional.iter(),
        }
    }
}

impl<'a> From<(PipelineOperator, &'a Pipeline)> for AndOr {
    fn from(value: (PipelineOperator, &'a Pipeline)) -> Self {
        match value.0 {
            PipelineOperator::Or => Self::Or(value.1.to_owned()),
            PipelineOperator::And => Self::And(value.1.to_owned()),
        }
    }
}

impl AndOrList {
    /// Returns an iterator over the pipelines in this `AndOrList`.
    pub fn iter(&self) -> AndOrListIter<'_> {
        self.into_iter()
    }
}

/// Represents a boolean operator used to connect command pipelines, along with the
/// succeeding pipeline.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum AndOr {
    /// Boolean AND operator; the embedded pipeline is only to be executed if the
    /// preceding command has succeeded.
    And(Pipeline),
    /// Boolean OR operator; the embedded pipeline is only to be executed if the
    /// preceding command has not succeeded.
    Or(Pipeline),
}

impl Node for AndOr {}

// TODO(source-location): add a loc to account for the operator
impl SourceLocation for AndOr {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::And(p) => p.location(),
            Self::Or(p) => p.location(),
        }
    }
}

impl Display for AndOr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::And(pipeline) => write!(f, " && {pipeline}"),
            Self::Or(pipeline) => write!(f, " || {pipeline}"),
        }
    }
}

/// The type of timing requested for a pipeline.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum PipelineTimed {
    /// The pipeline should be timed with bash-like output.
    Timed(SourceSpan),
    /// The pipeline should be timed with POSIX-like output.
    TimedWithPosixOutput(SourceSpan),
}

impl Node for PipelineTimed {}

impl SourceLocation for PipelineTimed {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::Timed(t) => Some(t.to_owned()),
            Self::TimedWithPosixOutput(t) => Some(t.to_owned()),
        }
    }
}

impl Display for PipelineTimed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timed(_) => write!(f, "time"),
            Self::TimedWithPosixOutput(_) => write!(f, "time -p"),
        }
    }
}

impl PipelineTimed {
    /// Returns true if the pipeline should be timed with POSIX-like output.
    pub const fn is_posix_output(&self) -> bool {
        matches!(self, Self::TimedWithPosixOutput(_))
    }
}

/// A pipeline of commands, where each command's output is passed as standard input
/// to the command that follows it.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct Pipeline {
    /// Indicates whether the pipeline's execution should be timed with reported
    /// timings in output.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub timed: Option<PipelineTimed>,
    /// Indicates whether the result of the overall pipeline should be the logical
    /// negation of the result of the pipeline.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "<&bool as std::ops::Not>::not", default)
    )]
    pub bang: bool,
    /// The sequence of commands in the pipeline.
    pub seq: Vec<Command>,
}

impl Node for Pipeline {}

// TODO(source-location): Handle the case where `self.timed` is `None` but there is a bang.
impl SourceLocation for Pipeline {
    fn location(&self) -> Option<SourceSpan> {
        let start = self
            .timed
            .as_ref()
            .and_then(SourceLocation::location)
            .or_else(|| self.seq.first().and_then(SourceLocation::location));
        let end = self.seq.last().and_then(SourceLocation::location);

        maybe_location(start.as_ref(), end.as_ref())
    }
}

impl Display for Pipeline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(timed) = &self.timed {
            write!(f, "{timed} ")?;
        }

        if self.bang {
            write!(f, "! ")?;
        }
        for (i, command) in self.seq.iter().enumerate() {
            if i > 0 {
                write!(f, " |")?;
            }
            write!(f, "{command}")?;
        }

        Ok(())
    }
}

/// Represents a shell command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum Command {
    /// A simple command, directly invoking an external command, a built-in command,
    /// a shell function, or similar.
    Simple(SimpleCommand),
    /// A compound command, composed of multiple commands.
    Compound(CompoundCommand, Option<RedirectList>),
    /// A command whose side effect is to define a shell function.
    Function(FunctionDefinition),
    /// A command that evaluates an extended test expression.
    ExtendedTest(ExtendedTestExprCommand, Option<RedirectList>),
}

impl Node for Command {}

impl SourceLocation for Command {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::Simple(s) => s.location(),
            Self::Compound(c, r) => {
                match (c.location(), r.as_ref().and_then(SourceLocation::location)) {
                    (Some(s), Some(e)) => Some(SourceSpan::within(&s, &e)),
                    (s, _) => s,
                }
            }
            Self::Function(f) => f.location(),
            Self::ExtendedTest(e, _) => e.location(),
        }
    }
}

impl Display for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Simple(simple_command) => write!(f, "{simple_command}"),
            Self::Compound(compound_command, redirect_list) => {
                write!(f, "{compound_command}")?;
                if let Some(redirect_list) = redirect_list {
                    write!(f, "{redirect_list}")?;
                }
                Ok(())
            }
            Self::Function(function_definition) => write!(f, "{function_definition}"),
            Self::ExtendedTest(extended_test_expr, redirect_list) => {
                write!(f, "[[ {extended_test_expr} ]]")?;
                if let Some(redirect_list) = redirect_list {
                    write!(f, "{redirect_list}")?;
                }
                Ok(())
            }
        }
    }
}

/// Represents a compound command, potentially made up of multiple nested commands.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum CompoundCommand {
    /// An arithmetic command, evaluating an arithmetic expression.
    Arithmetic(ArithmeticCommand),
    /// An arithmetic for clause, which loops until an arithmetic condition is reached.
    ArithmeticForClause(ArithmeticForClauseCommand),
    /// A brace group, which groups commands together.
    BraceGroup(BraceGroupCommand),
    /// A subshell, which executes commands in a subshell.
    Subshell(SubshellCommand),
    /// A for clause, which loops over a set of values.
    ForClause(ForClauseCommand),
    /// A case clause, which selects a command based on a value and a set of
    /// pattern-based filters.
    CaseClause(CaseClauseCommand),
    /// An if clause, which conditionally executes a command.
    IfClause(IfClauseCommand),
    /// A while clause, which loops while a condition is met.
    WhileClause(WhileOrUntilClauseCommand),
    /// An until clause, which loops until a condition is met.
    UntilClause(WhileOrUntilClauseCommand),
    /// A coprocess, which runs a command asynchronously in a subshell.
    Coprocess(CoprocessCommand),
}

impl Node for CompoundCommand {}

impl SourceLocation for CompoundCommand {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::Arithmetic(a) => a.location(),
            Self::ArithmeticForClause(a) => a.location(),
            Self::BraceGroup(b) => b.location(),
            Self::Subshell(s) => s.location(),
            Self::ForClause(f) => f.location(),
            Self::CaseClause(c) => c.location(),
            Self::IfClause(i) => i.location(),
            Self::WhileClause(w) => w.location(),
            Self::UntilClause(u) => u.location(),
            Self::Coprocess(c) => c.location(),
        }
    }
}

impl Display for CompoundCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Arithmetic(arithmetic_command) => write!(f, "{arithmetic_command}"),
            Self::ArithmeticForClause(arithmetic_for_clause_command) => {
                write!(f, "{arithmetic_for_clause_command}")
            }
            Self::BraceGroup(brace_group_command) => {
                write!(f, "{brace_group_command}")
            }
            Self::Subshell(subshell_command) => write!(f, "{subshell_command}"),
            Self::ForClause(for_clause_command) => write!(f, "{for_clause_command}"),
            Self::CaseClause(case_clause_command) => {
                write!(f, "{case_clause_command}")
            }
            Self::IfClause(if_clause_command) => write!(f, "{if_clause_command}"),
            Self::WhileClause(while_or_until_clause_command) => {
                write!(f, "while {while_or_until_clause_command}")
            }
            Self::UntilClause(while_or_until_clause_command) => {
                write!(f, "until {while_or_until_clause_command}")
            }
            Self::Coprocess(coproc_clause_command) => {
                write!(f, "{coproc_clause_command}")
            }
        }
    }
}

/// An arithmetic command, evaluating an arithmetic expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct ArithmeticCommand {
    /// The raw, unparsed and unexpanded arithmetic expression.
    pub expr: UnexpandedArithmeticExpr,
    /// Location of the command
    pub loc: SourceSpan,
}

impl Node for ArithmeticCommand {}

impl SourceLocation for ArithmeticCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for ArithmeticCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "(({}))", self.expr)
    }
}

/// A subshell, which executes commands in a subshell.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct SubshellCommand {
    /// Command list in the subshell
    pub list: CompoundList,
    /// Location of the subshell
    pub loc: SourceSpan,
}

impl Node for SubshellCommand {}

impl SourceLocation for SubshellCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for SubshellCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "( ")?;
        write!(f, "{}", self.list)?;
        write!(f, " )")
    }
}

/// A for clause, which loops over a set of values.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct ForClauseCommand {
    /// The name of the iterator variable.
    pub variable_name: String,
    /// The values being iterated over.
    pub values: Option<Vec<Word>>,
    /// The command to run for each iteration of the loop.
    pub body: DoGroupCommand,
    /// Location of the for command.
    pub loc: SourceSpan,
}

impl Node for ForClauseCommand {}

impl SourceLocation for ForClauseCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for ForClauseCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "for {} in ", self.variable_name)?;

        if let Some(values) = &self.values {
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    write!(f, " ")?;
                }

                write!(f, "{value}")?;
            }
        }

        writeln!(f, ";")?;

        write!(f, "{}", self.body)
    }
}

/// An arithmetic for clause, which loops until an arithmetic condition is reached.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct ArithmeticForClauseCommand {
    /// Optionally, the initializer expression evaluated before the first iteration of the loop.
    pub initializer: Option<UnexpandedArithmeticExpr>,
    /// Optionally, the expression evaluated as the exit condition of the loop.
    pub condition: Option<UnexpandedArithmeticExpr>,
    /// Optionally, the expression evaluated after each iteration of the loop.
    pub updater: Option<UnexpandedArithmeticExpr>,
    /// The command to run for each iteration of the loop.
    pub body: DoGroupCommand,
    /// Location of the clause
    pub loc: SourceSpan,
}

impl Node for ArithmeticForClauseCommand {}

impl SourceLocation for ArithmeticForClauseCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for ArithmeticForClauseCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "for ((")?;

        if let Some(initializer) = &self.initializer {
            write!(f, "{initializer}")?;
        }

        write!(f, "; ")?;

        if let Some(condition) = &self.condition {
            write!(f, "{condition}")?;
        }

        write!(f, "; ")?;

        if let Some(updater) = &self.updater {
            write!(f, "{updater}")?;
        }

        writeln!(f, "))")?;

        write!(f, "{}", self.body)
    }
}

/// A case clause, which selects a command based on a value and a set of
/// pattern-based filters.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CaseClauseCommand {
    /// The value being matched on.
    pub value: Word,
    /// The individual case branches.
    pub cases: Vec<CaseItem>,
    /// Location of the case command.
    pub loc: SourceSpan,
}

impl Node for CaseClauseCommand {}

impl SourceLocation for CaseClauseCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for CaseClauseCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "case {} in", self.value)?;
        for case in &self.cases {
            write!(indenter::indented(f).with_str(DISPLAY_INDENT), "{case}")?;
        }
        writeln!(f)?;
        write!(f, "esac")
    }
}

/// A sequence of commands.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CompoundList(pub Vec<CompoundListItem>);

impl Node for CompoundList {}

// TODO(source-location): Handle the optional trailing separator.
impl SourceLocation for CompoundList {
    fn location(&self) -> Option<SourceSpan> {
        let start = self.0.first().and_then(SourceLocation::location);
        let end = self.0.last().and_then(SourceLocation::location);

        if let (Some(s), Some(e)) = (start, end) {
            Some(SourceSpan::within(&s, &e))
        } else {
            None
        }
    }
}

impl Display for CompoundList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, item) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }

            // Write the and-or list.
            write!(f, "{}", item.0)?;

            // Write the separator... unless we're on the list item and it's a ';'.
            if i == self.0.len() - 1 && matches!(item.1, SeparatorOperator::Sequence) {
                // Skip
            } else {
                write!(f, "{}", item.1)?;
            }
        }

        Ok(())
    }
}

/// An element of a compound command list.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CompoundListItem(pub AndOrList, pub SeparatorOperator);

impl Node for CompoundListItem {}

// TODO(source-location): Account for the location of the separator operator.
impl SourceLocation for CompoundListItem {
    fn location(&self) -> Option<SourceSpan> {
        self.0.location()
    }
}

impl Display for CompoundListItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)?;
        write!(f, "{}", self.1)?;
        Ok(())
    }
}

/// An if clause, which conditionally executes a command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct IfClauseCommand {
    /// The command whose execution result is inspected.
    pub condition: CompoundList,
    /// The command to execute if the condition is true.
    pub then: CompoundList,
    /// Optionally, `else` clauses that will be evaluated if the condition is false.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub elses: Option<Vec<ElseClause>>,
    /// Location of the if clause
    pub loc: SourceSpan,
}

impl Node for IfClauseCommand {}

impl SourceLocation for IfClauseCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for IfClauseCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "if {}; then", self.condition)?;
        write!(
            indenter::indented(f).with_str(DISPLAY_INDENT),
            "{}",
            self.then
        )?;
        if let Some(elses) = &self.elses {
            for else_clause in elses {
                write!(f, "{else_clause}")?;
            }
        }

        writeln!(f)?;
        write!(f, "fi")?;

        Ok(())
    }
}

/// Represents the `else` clause of a conditional command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct ElseClause {
    /// If present, the condition that must be met for this `else` clause to be executed.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub condition: Option<CompoundList>,
    /// The commands to execute if this `else` clause is selected.
    pub body: CompoundList,
}

impl Display for ElseClause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f)?;
        if let Some(condition) = &self.condition {
            writeln!(f, "elif {condition}; then")?;
        } else {
            writeln!(f, "else")?;
        }

        write!(
            indenter::indented(f).with_str(DISPLAY_INDENT),
            "{}",
            self.body
        )
    }
}

/// A coprocess command, which runs a command asynchronously in a subshell.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CoprocessCommand {
    /// The optional name for the coprocess.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub name: Option<Word>,
    /// The command to run as a coprocess (can be simple or compound).
    pub body: Box<Command>,
    /// The location of this command in the source.
    #[cfg_attr(any(test, feature = "serde"), serde(skip_serializing, default))]
    pub loc: SourceSpan,
}

impl Node for CoprocessCommand {}

impl SourceLocation for CoprocessCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for CoprocessCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "coproc")?;
        if let Some(name) = &self.name {
            write!(f, " {name}")?;
        }
        write!(f, " {}", self.body)?;
        Ok(())
    }
}

/// An individual matching case item in a case clause.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CaseItem {
    /// The patterns that select this case branch.
    pub patterns: Vec<Word>,
    /// The commands to execute if this case branch is selected.
    pub cmd: Option<CompoundList>,
    /// When the case branch is selected, the action to take after the command is executed.
    pub post_action: CaseItemPostAction,
    /// Location of the item
    pub loc: Option<SourceSpan>,
}

impl Node for CaseItem {}

impl SourceLocation for CaseItem {
    fn location(&self) -> Option<SourceSpan> {
        self.loc.clone()
    }
}

impl Display for CaseItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f)?;
        for (i, pattern) in self.patterns.iter().enumerate() {
            if i > 0 {
                write!(f, "|")?;
            }
            write!(f, "{pattern}")?;
        }
        writeln!(f, ")")?;

        if let Some(cmd) = &self.cmd {
            write!(indenter::indented(f).with_str(DISPLAY_INDENT), "{cmd}")?;
        }
        writeln!(f)?;
        write!(f, "{}", self.post_action)
    }
}

/// Describes the action to take after executing the body command of a case clause.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum CaseItemPostAction {
    /// The containing case should be exited.
    ExitCase,
    /// If one is present, the command body of the succeeding case item should be
    /// executed (without evaluating its pattern).
    UnconditionallyExecuteNextCaseItem,
    /// The case should continue evaluating the remaining case items, as if this
    /// item had not been executed.
    ContinueEvaluatingCases,
}

impl Display for CaseItemPostAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ExitCase => write!(f, ";;"),
            Self::UnconditionallyExecuteNextCaseItem => write!(f, ";&"),
            Self::ContinueEvaluatingCases => write!(f, ";;&"),
        }
    }
}

/// A while or until clause, whose looping is controlled by a condition.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct WhileOrUntilClauseCommand(pub CompoundList, pub DoGroupCommand, pub SourceSpan);

impl Node for WhileOrUntilClauseCommand {}

impl SourceLocation for WhileOrUntilClauseCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.2.clone())
    }
}

impl Display for WhileOrUntilClauseCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}; {}", self.0, self.1)
    }
}

/// Encapsulates the definition of a shell function.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct FunctionDefinition {
    /// The name of the function.
    pub fname: Word,
    /// The body of the function.
    pub body: FunctionBody,
}

impl Node for FunctionDefinition {}

// TODO(source-location): Account for the optional 'function' keyword that may
// precede the function name.
impl SourceLocation for FunctionDefinition {
    fn location(&self) -> Option<SourceSpan> {
        let start = self.fname.location();
        let end = self.body.location();

        if let (Some(s), Some(e)) = (start, end) {
            Some(SourceSpan::within(&s, &e))
        } else {
            None
        }
    }
}

impl Display for FunctionDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "{} () ", self.fname.value)?;
        write!(f, "{}", self.body)?;
        Ok(())
    }
}

/// Encapsulates the body of a function definition.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct FunctionBody(pub CompoundCommand, pub Option<RedirectList>);

impl Node for FunctionBody {}

impl SourceLocation for FunctionBody {
    fn location(&self) -> Option<SourceSpan> {
        let cmd_span = self.0.location();
        let redirect_span = self.1.as_ref().and_then(SourceLocation::location);

        match (cmd_span, redirect_span) {
            // If there's a redirect, include it in the span.
            (Some(cmd_span), Some(redirect_span)) => {
                Some(SourceSpan::within(&cmd_span, &redirect_span))
            }
            // Otherwise, just return the command span.
            (Some(cmd_span), None) => Some(cmd_span),
            _ => None,
        }
    }
}

impl Display for FunctionBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)?;
        if let Some(redirect_list) = &self.1 {
            write!(f, "{redirect_list}")?;
        }

        Ok(())
    }
}

/// A brace group, which groups commands together.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct BraceGroupCommand {
    /// List of commands
    pub list: CompoundList,
    /// Location of the group
    pub loc: SourceSpan,
}

impl Node for BraceGroupCommand {}

impl SourceLocation for BraceGroupCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for BraceGroupCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "{{ ")?;
        write!(
            indenter::indented(f).with_str(DISPLAY_INDENT),
            "{}",
            self.list
        )?;
        writeln!(f)?;
        write!(f, "}}")?;

        Ok(())
    }
}

/// A do group, which groups commands together.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct DoGroupCommand {
    /// List of commands
    pub list: CompoundList,
    /// Location of the group
    pub loc: SourceSpan,
}

impl Display for DoGroupCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "do")?;
        write!(
            indenter::indented(f).with_str(DISPLAY_INDENT),
            "{}",
            self.list
        )?;
        writeln!(f)?;
        write!(f, "done")
    }
}

/// Represents the invocation of a simple command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct SimpleCommand {
    /// Optionally, a prefix to the command.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub prefix: Option<CommandPrefix>,
    /// The name of the command to execute.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub word_or_name: Option<Word>,
    /// Optionally, a suffix to the command.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "Option::is_none", default)
    )]
    pub suffix: Option<CommandSuffix>,
}

impl Node for SimpleCommand {}

impl SourceLocation for SimpleCommand {
    fn location(&self) -> Option<SourceSpan> {
        let mid = &self
            .word_or_name
            .as_ref()
            .and_then(SourceLocation::location);
        let start = self.prefix.as_ref().and_then(SourceLocation::location);
        let end = self.suffix.as_ref().and_then(SourceLocation::location);

        match (start, mid, end) {
            (Some(start), _, Some(end)) => Some(SourceSpan::within(&start, &end)),
            (Some(start), Some(mid), None) => Some(SourceSpan::within(&start, mid)),
            (Some(start), None, None) => Some(start),
            (None, Some(mid), Some(end)) => Some(SourceSpan::within(mid, &end)),
            (None, Some(mid), None) => Some(mid.clone()),
            _ => None,
        }
    }
}

impl Display for SimpleCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut wrote_something = false;

        if let Some(prefix) = &self.prefix {
            if wrote_something {
                write!(f, " ")?;
            }

            write!(f, "{prefix}")?;
            wrote_something = true;
        }

        if let Some(word_or_name) = &self.word_or_name {
            if wrote_something {
                write!(f, " ")?;
            }

            write!(f, "{word_or_name}")?;
            wrote_something = true;
        }

        if let Some(suffix) = &self.suffix {
            if wrote_something {
                write!(f, " ")?;
            }

            write!(f, "{suffix}")?;
        }

        Ok(())
    }
}

/// Represents a prefix to a simple command.
#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CommandPrefix(pub Vec<CommandPrefixOrSuffixItem>);

impl Node for CommandPrefix {}

impl SourceLocation for CommandPrefix {
    fn location(&self) -> Option<SourceSpan> {
        let start = self.0.first().and_then(SourceLocation::location);
        let end = self.0.last().and_then(SourceLocation::location);

        maybe_location(start.as_ref(), end.as_ref())
    }
}

impl Display for CommandPrefix {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, item) in self.0.iter().enumerate() {
            if i > 0 {
                write!(f, " ")?;
            }

            write!(f, "{item}")?;
        }
        Ok(())
    }
}

/// Represents a suffix to a simple command; a word argument, declaration, or I/O redirection.
#[derive(Clone, Default, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct CommandSuffix(pub Vec<CommandPrefixOrSuffixItem>);

impl Node for CommandSuffix {}

impl SourceLocation for CommandSuffix {
    fn location(&self) -> Option<SourceSpan> {
        let start = self.0.first().and_then(SourceLocation::location);
        let end = self.0.last().and_then(SourceLocation::location);

        maybe_location(start.as_ref(), end.as_ref())
    }
}

impl Display for CommandSuffix {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, item) in self.0.iter().enumerate() {
            if i > 0 {
                write!(f, " ")?;
            }

            write!(f, "{item}")?;
        }
        Ok(())
    }
}

/// Represents the I/O direction of a process substitution.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ProcessSubstitutionKind {
    /// The process is read from.
    Read,
    /// The process is written to.
    Write,
}

impl Display for ProcessSubstitutionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => write!(f, "<"),
            Self::Write => write!(f, ">"),
        }
    }
}

/// A prefix or suffix for a simple command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum CommandPrefixOrSuffixItem {
    /// An I/O redirection.
    IoRedirect(IoRedirect),
    /// A word.
    Word(Word),
    /// An assignment/declaration word.
    AssignmentWord(Assignment, Word),
    /// A process substitution.
    ProcessSubstitution(ProcessSubstitutionKind, SubshellCommand),
}

impl Node for CommandPrefixOrSuffixItem {}

impl SourceLocation for CommandPrefixOrSuffixItem {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::Word(w) => w.location(),
            Self::IoRedirect(io_redirect) => io_redirect.location(),
            Self::AssignmentWord(assignment, _word) => assignment.location(),
            // TODO(source-location): account for the kind token
            Self::ProcessSubstitution(_kind, cmd) => cmd.location(),
        }
    }
}

impl Display for CommandPrefixOrSuffixItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoRedirect(io_redirect) => write!(f, "{io_redirect}"),
            Self::Word(word) => write!(f, "{word}"),
            Self::AssignmentWord(_assignment, word) => write!(f, "{word}"),
            Self::ProcessSubstitution(kind, subshell_command) => {
                write!(f, "{kind}({subshell_command})")
            }
        }
    }
}

/// Encapsulates an assignment declaration.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct Assignment {
    /// Name being assigned to.
    pub name: AssignmentName,
    /// Value being assigned.
    pub value: AssignmentValue,
    /// Whether or not to append to the preexisting value associated with the named variable.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "<&bool as std::ops::Not>::not", default)
    )]
    pub append: bool,
    /// Location of the assignment
    pub loc: SourceSpan,
}

impl Node for Assignment {}

impl SourceLocation for Assignment {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for Assignment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name)?;
        if self.append {
            write!(f, "+")?;
        }
        write!(f, "={}", self.value)
    }
}

/// The target of an assignment.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum AssignmentName {
    /// A named variable.
    VariableName(String),
    /// An element in a named array.
    ArrayElementName(String, String),
}

impl Display for AssignmentName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::VariableName(name) => write!(f, "{name}"),
            Self::ArrayElementName(name, index) => {
                write!(f, "{name}[{index}]")
            }
        }
    }
}

/// A value being assigned to a variable.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum AssignmentValue {
    /// A scalar (word) value.
    Scalar(Word),
    /// An array of elements.
    Array(Vec<(Option<Word>, Word)>),
}

impl Node for AssignmentValue {}

impl SourceLocation for AssignmentValue {
    fn location(&self) -> Option<SourceSpan> {
        match self {
            Self::Scalar(word) => word.location(),
            Self::Array(words) => {
                // TODO(source-location): account for the surrounding parentheses
                let first = words.first().and_then(|(_key, value)| value.location());
                let last = words.last().and_then(|(_key, value)| value.location());
                maybe_location(first.as_ref(), last.as_ref())
            }
        }
    }
}

impl Display for AssignmentValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Scalar(word) => write!(f, "{word}"),
            Self::Array(words) => {
                write!(f, "(")?;
                for (i, value) in words.iter().enumerate() {
                    if i > 0 {
                        write!(f, " ")?;
                    }
                    match value {
                        (Some(key), value) => write!(f, "[{key}]={value}")?,
                        (None, value) => write!(f, "{value}")?,
                    }
                }
                write!(f, ")")
            }
        }
    }
}

/// A list of I/O redirections to be applied to a command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct RedirectList(pub Vec<IoRedirect>);

impl Node for RedirectList {}

impl SourceLocation for RedirectList {
    fn location(&self) -> Option<SourceSpan> {
        let first = self.0.first().and_then(SourceLocation::location);
        let last = self.0.last().and_then(SourceLocation::location);
        maybe_location(first.as_ref(), last.as_ref())
    }
}

impl Display for RedirectList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for item in &self.0 {
            write!(f, "{item}")?;
        }
        Ok(())
    }
}

/// A file descriptor number.
pub type IoFd = i32;

/// An I/O redirection.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum IoRedirect {
    /// Redirection to a file.
    File(Option<IoFd>, IoFileRedirectKind, IoFileRedirectTarget),
    /// Redirection from a here-document.
    HereDocument(Option<IoFd>, IoHereDocument),
    /// Redirection from a here-string.
    HereString(Option<IoFd>, Word),
    /// Redirection of both standard output and standard error (with optional append).
    OutputAndError(Word, bool),
}

impl Node for IoRedirect {}

impl SourceLocation for IoRedirect {
    fn location(&self) -> Option<SourceSpan> {
        // TODO(source-location): complete
        None
    }
}

impl Display for IoRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File(fd_num, kind, target) => {
                if let Some(fd_num) = fd_num {
                    write!(f, "{fd_num}")?;
                }

                write!(f, "{kind} {target}")?;
            }
            Self::OutputAndError(target, append) => {
                write!(f, "&>")?;
                if *append {
                    write!(f, ">")?;
                }
                write!(f, " {target}")?;
            }
            Self::HereDocument(fd_num, here_doc) => {
                if let Some(fd_num) = fd_num {
                    write!(f, "{fd_num}")?;
                }

                write!(f, "<<{here_doc}")?;
            }
            Self::HereString(fd_num, s) => {
                if let Some(fd_num) = fd_num {
                    write!(f, "{fd_num}")?;
                }

                write!(f, "<<< {s}")?;
            }
        }

        Ok(())
    }
}

/// Kind of file I/O redirection.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum IoFileRedirectKind {
    /// Read (`<`).
    Read,
    /// Write (`>`).
    Write,
    /// Append (`>>`).
    Append,
    /// Read and write (`<>`).
    ReadAndWrite,
    /// Clobber (`>|`).
    Clobber,
    /// Duplicate input (`<&`).
    DuplicateInput,
    /// Duplicate output (`>&`).
    DuplicateOutput,
}

impl Display for IoFileRedirectKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => write!(f, "<"),
            Self::Write => write!(f, ">"),
            Self::Append => write!(f, ">>"),
            Self::ReadAndWrite => write!(f, "<>"),
            Self::Clobber => write!(f, ">|"),
            Self::DuplicateInput => write!(f, "<&"),
            Self::DuplicateOutput => write!(f, ">&"),
        }
    }
}

/// Target for an I/O file redirection.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum IoFileRedirectTarget {
    /// Path to a file.
    Filename(Word),
    /// File descriptor number.
    Fd(IoFd),
    /// Process substitution: substitution with the results of executing the given
    /// command in a subshell.
    ProcessSubstitution(ProcessSubstitutionKind, SubshellCommand),
    /// Item to duplicate in a word redirection. After expansion, this could be a
    /// filename, a file descriptor, or a file descriptor and a "-" to indicate
    /// requested closure.
    Duplicate(Word),
}

impl Display for IoFileRedirectTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Filename(word) => write!(f, "{word}"),
            Self::Fd(fd) => write!(f, "{fd}"),
            Self::ProcessSubstitution(kind, subshell_command) => {
                write!(f, "{kind}{subshell_command}")
            }
            Self::Duplicate(word) => write!(f, "{word}"),
        }
    }
}

/// Represents an I/O here document.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct IoHereDocument {
    /// Whether to remove leading tabs from the here document.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "<&bool as std::ops::Not>::not", default)
    )]
    pub remove_tabs: bool,
    /// Whether to basic-expand the contents of the here document.
    #[cfg_attr(
        any(test, feature = "serde"),
        serde(skip_serializing_if = "<&bool as std::ops::Not>::not", default)
    )]
    pub requires_expansion: bool,
    /// The delimiter marking the end of the here document.
    pub here_end: Word,
    /// The contents of the here document.
    pub doc: Word,
}

impl Node for IoHereDocument {}

impl SourceLocation for IoHereDocument {
    fn location(&self) -> Option<SourceSpan> {
        // TODO(source-location): complete
        None
    }
}

impl Display for IoHereDocument {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.remove_tabs {
            write!(f, "-")?;
        }

        writeln!(f, "{}", self.here_end)?;
        write!(f, "{}", self.doc)?;
        writeln!(f, "{}", self.here_end)?;

        Ok(())
    }
}

/// A (non-extended) test expression.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum TestExpr {
    /// Always evaluates to false.
    False,
    /// A literal string.
    Literal(String),
    /// Logical AND operation on two nested expressions.
    And(Box<Self>, Box<Self>),
    /// Logical OR operation on two nested expressions.
    Or(Box<Self>, Box<Self>),
    /// Logical NOT operation on a nested expression.
    Not(Box<Self>),
    /// A parenthesized expression.
    Parenthesized(Box<Self>),
    /// A unary test operation.
    UnaryTest(UnaryPredicate, String),
    /// A binary test operation.
    BinaryTest(BinaryPredicate, String, String),
}

impl Node for TestExpr {}

impl SourceLocation for TestExpr {
    fn location(&self) -> Option<SourceSpan> {
        // TODO(source-location): complete
        None
    }
}

impl Display for TestExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::False => Ok(()),
            Self::Literal(s) => write!(f, "{s}"),
            Self::And(left, right) => write!(f, "{left} -a {right}"),
            Self::Or(left, right) => write!(f, "{left} -o {right}"),
            Self::Not(expr) => write!(f, "! {expr}"),
            Self::Parenthesized(expr) => write!(f, "( {expr} )"),
            Self::UnaryTest(pred, word) => write!(f, "{pred} {word}"),
            Self::BinaryTest(left, op, right) => write!(f, "{left} {op} {right}"),
        }
    }
}

/// An extended test expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ExtendedTestExpr {
    /// Logical AND operation on two nested expressions.
    And(Box<Self>, Box<Self>),
    /// Logical OR operation on two nested expressions.
    Or(Box<Self>, Box<Self>),
    /// Logical NOT operation on a nested expression.
    Not(Box<Self>),
    /// A parenthesized expression.
    Parenthesized(Box<Self>),
    /// A unary test operation.
    UnaryTest(UnaryPredicate, Word),
    /// A binary test operation.
    BinaryTest(BinaryPredicate, Word, Word),
}

impl Display for ExtendedTestExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::And(left, right) => {
                write!(f, "{left} && {right}")
            }
            Self::Or(left, right) => {
                write!(f, "{left} || {right}")
            }
            Self::Not(expr) => {
                write!(f, "! {expr}")
            }
            Self::Parenthesized(expr) => {
                write!(f, "( {expr} )")
            }
            Self::UnaryTest(pred, word) => {
                write!(f, "{pred} {word}")
            }
            Self::BinaryTest(pred, left, right) => {
                write!(f, "{left} {pred} {right}")
            }
        }
    }
}

/// An extended test expression command.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct ExtendedTestExprCommand {
    /// The extended test expression
    pub expr: ExtendedTestExpr,
    /// Location of the expression
    pub loc: SourceSpan,
}

impl Node for ExtendedTestExprCommand {}

impl SourceLocation for ExtendedTestExprCommand {
    fn location(&self) -> Option<SourceSpan> {
        Some(self.loc.clone())
    }
}

impl Display for ExtendedTestExprCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.expr.fmt(f)
    }
}

/// A unary predicate usable in an extended test expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum UnaryPredicate {
    /// Computes if the operand is a path to an existing file.
    FileExists,
    /// Computes if the operand is a path to an existing block device file.
    FileExistsAndIsBlockSpecialFile,
    /// Computes if the operand is a path to an existing character device file.
    FileExistsAndIsCharSpecialFile,
    /// Computes if the operand is a path to an existing directory.
    FileExistsAndIsDir,
    /// Computes if the operand is a path to an existing regular file.
    FileExistsAndIsRegularFile,
    /// Computes if the operand is a path to an existing file with the setgid bit set.
    FileExistsAndIsSetgid,
    /// Computes if the operand is a path to an existing symbolic link.
    FileExistsAndIsSymlink,
    /// Computes if the operand is a path to an existing file with the sticky bit set.
    FileExistsAndHasStickyBit,
    /// Computes if the operand is a path to an existing FIFO file.
    FileExistsAndIsFifo,
    /// Computes if the operand is a path to an existing file that is readable.
    FileExistsAndIsReadable,
    /// Computes if the operand is a path to an existing file with a non-zero length.
    FileExistsAndIsNotZeroLength,
    /// Computes if the operand is a file descriptor that is an open terminal.
    FdIsOpenTerminal,
    /// Computes if the operand is a path to an existing file with the setuid bit set.
    FileExistsAndIsSetuid,
    /// Computes if the operand is a path to an existing file that is writable.
    FileExistsAndIsWritable,
    /// Computes if the operand is a path to an existing file that is executable.
    FileExistsAndIsExecutable,
    /// Computes if the operand is a path to an existing file owned by the current context's
    /// effective group ID.
    FileExistsAndOwnedByEffectiveGroupId,
    /// Computes if the operand is a path to an existing file that has been modified since last
    /// being read.
    FileExistsAndModifiedSinceLastRead,
    /// Computes if the operand is a path to an existing file owned by the current context's
    /// effective user ID.
    FileExistsAndOwnedByEffectiveUserId,
    /// Computes if the operand is a path to an existing socket file.
    FileExistsAndIsSocket,
    /// Computes if the operand is a 'set -o' option that is enabled.
    ShellOptionEnabled,
    /// Computes if the operand names a shell variable that is set and assigned a value.
    ShellVariableIsSetAndAssigned,
    /// Computes if the operand names a shell variable that is set and of nameref type.
    ShellVariableIsSetAndNameRef,
    /// Computes if the operand is a string with zero length.
    StringHasZeroLength,
    /// Computes if the operand is a string with non-zero length.
    StringHasNonZeroLength,
}

impl Display for UnaryPredicate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileExists => write!(f, "-e"),
            Self::FileExistsAndIsBlockSpecialFile => write!(f, "-b"),
            Self::FileExistsAndIsCharSpecialFile => write!(f, "-c"),
            Self::FileExistsAndIsDir => write!(f, "-d"),
            Self::FileExistsAndIsRegularFile => write!(f, "-f"),
            Self::FileExistsAndIsSetgid => write!(f, "-g"),
            Self::FileExistsAndIsSymlink => write!(f, "-h"),
            Self::FileExistsAndHasStickyBit => write!(f, "-k"),
            Self::FileExistsAndIsFifo => write!(f, "-p"),
            Self::FileExistsAndIsReadable => write!(f, "-r"),
            Self::FileExistsAndIsNotZeroLength => write!(f, "-s"),
            Self::FdIsOpenTerminal => write!(f, "-t"),
            Self::FileExistsAndIsSetuid => write!(f, "-u"),
            Self::FileExistsAndIsWritable => write!(f, "-w"),
            Self::FileExistsAndIsExecutable => write!(f, "-x"),
            Self::FileExistsAndOwnedByEffectiveGroupId => write!(f, "-G"),
            Self::FileExistsAndModifiedSinceLastRead => write!(f, "-N"),
            Self::FileExistsAndOwnedByEffectiveUserId => write!(f, "-O"),
            Self::FileExistsAndIsSocket => write!(f, "-S"),
            Self::ShellOptionEnabled => write!(f, "-o"),
            Self::ShellVariableIsSetAndAssigned => write!(f, "-v"),
            Self::ShellVariableIsSetAndNameRef => write!(f, "-R"),
            Self::StringHasZeroLength => write!(f, "-z"),
            Self::StringHasNonZeroLength => write!(f, "-n"),
        }
    }
}

/// A binary predicate usable in an extended test expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum BinaryPredicate {
    /// Computes if two files refer to the same device and inode numbers.
    FilesReferToSameDeviceAndInodeNumbers,
    /// Computes if the left file is newer than the right, or exists when the right does not.
    LeftFileIsNewerOrExistsWhenRightDoesNot,
    /// Computes if the left file is older than the right, or does not exist when the right does.
    LeftFileIsOlderOrDoesNotExistWhenRightDoes,
    /// Computes if a string exactly matches a pattern.
    StringExactlyMatchesPattern,
    /// Computes if a string does not exactly match a pattern.
    StringDoesNotExactlyMatchPattern,
    /// Computes if a string matches a regular expression.
    StringMatchesRegex,
    /// Computes if a string exactly matches another string.
    StringExactlyMatchesString,
    /// Computes if a string does not exactly match another string.
    StringDoesNotExactlyMatchString,
    /// Computes if a string contains a substring.
    StringContainsSubstring,
    /// Computes if the left value sorts before the right.
    LeftSortsBeforeRight,
    /// Computes if the left value sorts after the right.
    LeftSortsAfterRight,
    /// Computes if two values are equal via arithmetic comparison.
    ArithmeticEqualTo,
    /// Computes if two values are not equal via arithmetic comparison.
    ArithmeticNotEqualTo,
    /// Computes if the left value is less than the right via arithmetic comparison.
    ArithmeticLessThan,
    /// Computes if the left value is less than or equal to the right via arithmetic comparison.
    ArithmeticLessThanOrEqualTo,
    /// Computes if the left value is greater than the right via arithmetic comparison.
    ArithmeticGreaterThan,
    /// Computes if the left value is greater than or equal to the right via arithmetic comparison.
    ArithmeticGreaterThanOrEqualTo,
}

impl Display for BinaryPredicate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FilesReferToSameDeviceAndInodeNumbers => write!(f, "-ef"),
            Self::LeftFileIsNewerOrExistsWhenRightDoesNot => write!(f, "-nt"),
            Self::LeftFileIsOlderOrDoesNotExistWhenRightDoes => write!(f, "-ot"),
            Self::StringExactlyMatchesPattern => write!(f, "=="),
            Self::StringDoesNotExactlyMatchPattern => write!(f, "!="),
            Self::StringMatchesRegex => write!(f, "=~"),
            Self::StringContainsSubstring => write!(f, "=~"),
            Self::StringExactlyMatchesString => write!(f, "=="),
            Self::StringDoesNotExactlyMatchString => write!(f, "!="),
            Self::LeftSortsBeforeRight => write!(f, "<"),
            Self::LeftSortsAfterRight => write!(f, ">"),
            Self::ArithmeticEqualTo => write!(f, "-eq"),
            Self::ArithmeticNotEqualTo => write!(f, "-ne"),
            Self::ArithmeticLessThan => write!(f, "-lt"),
            Self::ArithmeticLessThanOrEqualTo => write!(f, "-le"),
            Self::ArithmeticGreaterThan => write!(f, "-gt"),
            Self::ArithmeticGreaterThanOrEqualTo => write!(f, "-ge"),
        }
    }
}

/// Represents a shell word.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct Word {
    /// Raw text of the word.
    pub value: String,
    /// Location of the word
    pub loc: Option<SourceSpan>,
}

impl Node for Word {}

impl SourceLocation for Word {
    fn location(&self) -> Option<SourceSpan> {
        self.loc.clone()
    }
}

impl Display for Word {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.value)
    }
}

impl From<&tokenizer::Token> for Word {
    fn from(t: &tokenizer::Token) -> Self {
        match t {
            tokenizer::Token::Word(value, loc) => Self {
                value: value.clone(),
                loc: Some(loc.clone()),
            },
            tokenizer::Token::Operator(value, loc) => Self {
                value: value.clone(),
                loc: Some(loc.clone()),
            },
        }
    }
}

impl From<String> for Word {
    fn from(s: String) -> Self {
        Self {
            value: s,
            loc: None,
        }
    }
}

impl AsRef<str> for Word {
    fn as_ref(&self) -> &str {
        &self.value
    }
}

impl Word {
    /// Constructs a new `Word` from a given string.
    pub fn new(s: &str) -> Self {
        Self {
            value: s.to_owned(),
            loc: None,
        }
    }

    /// Constructs a new `Word` from a given string and location.
    pub fn with_location(s: &str, loc: &SourceSpan) -> Self {
        Self {
            value: s.to_owned(),
            loc: Some(loc.to_owned()),
        }
    }

    /// Returns the raw text of the word, consuming the `Word`.
    pub fn flatten(&self) -> String {
        self.value.clone()
    }
}

/// Encapsulates an unparsed arithmetic expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub struct UnexpandedArithmeticExpr {
    /// The raw text of the expression.
    pub value: String,
}

impl Display for UnexpandedArithmeticExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.value)
    }
}

/// An arithmetic expression.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ArithmeticExpr {
    /// A literal integer value.
    Literal(i64),
    /// A dereference of a variable or array element.
    Reference(ArithmeticTarget),
    /// A unary operation on an the result of a given nested expression.
    UnaryOp(UnaryOperator, Box<Self>),
    /// A binary operation on two nested expressions.
    BinaryOp(BinaryOperator, Box<Self>, Box<Self>),
    /// A ternary conditional expression.
    Conditional(Box<Self>, Box<Self>, Box<Self>),
    /// An assignment operation.
    Assignment(ArithmeticTarget, Box<Self>),
    /// A binary assignment operation.
    BinaryAssignment(BinaryOperator, ArithmeticTarget, Box<Self>),
    /// A unary assignment operation.
    UnaryAssignment(UnaryAssignmentOperator, ArithmeticTarget),
}

impl Node for ArithmeticExpr {}

impl SourceLocation for ArithmeticExpr {
    fn location(&self) -> Option<SourceSpan> {
        // TODO(source-location): complete and add loc for literal
        None
    }
}

#[cfg(feature = "arbitrary")]
impl<'a> arbitrary::Arbitrary<'a> for ArithmeticExpr {
    fn arbitrary(u: &mut arbitrary::Unstructured<'a>) -> arbitrary::Result<Self> {
        let variant = u.choose(&[
            "Literal",
            "Reference",
            "UnaryOp",
            "BinaryOp",
            "Conditional",
            "Assignment",
            "BinaryAssignment",
            "UnaryAssignment",
        ])?;

        match *variant {
            "Literal" => Ok(Self::Literal(i64::arbitrary(u)?)),
            "Reference" => Ok(Self::Reference(ArithmeticTarget::arbitrary(u)?)),
            "UnaryOp" => Ok(Self::UnaryOp(
                UnaryOperator::arbitrary(u)?,
                Box::new(Self::arbitrary(u)?),
            )),
            "BinaryOp" => Ok(Self::BinaryOp(
                BinaryOperator::arbitrary(u)?,
                Box::new(Self::arbitrary(u)?),
                Box::new(Self::arbitrary(u)?),
            )),
            "Conditional" => Ok(Self::Conditional(
                Box::new(Self::arbitrary(u)?),
                Box::new(Self::arbitrary(u)?),
                Box::new(Self::arbitrary(u)?),
            )),
            "Assignment" => Ok(Self::Assignment(
                ArithmeticTarget::arbitrary(u)?,
                Box::new(Self::arbitrary(u)?),
            )),
            "BinaryAssignment" => Ok(Self::BinaryAssignment(
                BinaryOperator::arbitrary(u)?,
                ArithmeticTarget::arbitrary(u)?,
                Box::new(Self::arbitrary(u)?),
            )),
            "UnaryAssignment" => Ok(Self::UnaryAssignment(
                UnaryAssignmentOperator::arbitrary(u)?,
                ArithmeticTarget::arbitrary(u)?,
            )),
            _ => unreachable!(),
        }
    }
}

impl Display for ArithmeticExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Literal(literal) => write!(f, "{literal}"),
            Self::Reference(target) => write!(f, "{target}"),
            Self::UnaryOp(op, operand) => write!(f, "{op}{operand}"),
            Self::BinaryOp(op, left, right) => {
                if matches!(op, BinaryOperator::Comma) {
                    write!(f, "{left}{op} {right}")
                } else {
                    write!(f, "{left} {op} {right}")
                }
            }
            Self::Conditional(condition, if_branch, else_branch) => {
                write!(f, "{condition} ? {if_branch} : {else_branch}")
            }
            Self::Assignment(target, value) => write!(f, "{target} = {value}"),
            Self::BinaryAssignment(op, target, operand) => {
                write!(f, "{target} {op}= {operand}")
            }
            Self::UnaryAssignment(op, target) => match op {
                UnaryAssignmentOperator::PrefixIncrement
                | UnaryAssignmentOperator::PrefixDecrement => write!(f, "{op}{target}"),
                UnaryAssignmentOperator::PostfixIncrement
                | UnaryAssignmentOperator::PostfixDecrement => write!(f, "{target}{op}"),
            },
        }
    }
}

/// A binary arithmetic operator.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum BinaryOperator {
    /// Exponentiation (e.g., `x ** y`).
    Power,
    /// Multiplication (e.g., `x * y`).
    Multiply,
    /// Division (e.g., `x / y`).
    Divide,
    /// Modulo (e.g., `x % y`).
    Modulo,
    /// Comma (e.g., `x, y`).
    Comma,
    /// Addition (e.g., `x + y`).
    Add,
    /// Subtraction (e.g., `x - y`).
    Subtract,
    /// Bitwise left shift (e.g., `x << y`).
    ShiftLeft,
    /// Bitwise right shift (e.g., `x >> y`).
    ShiftRight,
    /// Less than (e.g., `x < y`).
    LessThan,
    /// Less than or equal to (e.g., `x <= y`).
    LessThanOrEqualTo,
    /// Greater than (e.g., `x > y`).
    GreaterThan,
    /// Greater than or equal to (e.g., `x >= y`).
    GreaterThanOrEqualTo,
    /// Equals (e.g., `x == y`).
    Equals,
    /// Not equals (e.g., `x != y`).
    NotEquals,
    /// Bitwise AND (e.g., `x & y`).
    BitwiseAnd,
    /// Bitwise exclusive OR (xor) (e.g., `x ^ y`).
    BitwiseXor,
    /// Bitwise OR (e.g., `x | y`).
    BitwiseOr,
    /// Logical AND (e.g., `x && y`).
    LogicalAnd,
    /// Logical OR (e.g., `x || y`).
    LogicalOr,
}

impl Display for BinaryOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Power => write!(f, "**"),
            Self::Multiply => write!(f, "*"),
            Self::Divide => write!(f, "/"),
            Self::Modulo => write!(f, "%"),
            Self::Comma => write!(f, ","),
            Self::Add => write!(f, "+"),
            Self::Subtract => write!(f, "-"),
            Self::ShiftLeft => write!(f, "<<"),
            Self::ShiftRight => write!(f, ">>"),
            Self::LessThan => write!(f, "<"),
            Self::LessThanOrEqualTo => write!(f, "<="),
            Self::GreaterThan => write!(f, ">"),
            Self::GreaterThanOrEqualTo => write!(f, ">="),
            Self::Equals => write!(f, "=="),
            Self::NotEquals => write!(f, "!="),
            Self::BitwiseAnd => write!(f, "&"),
            Self::BitwiseXor => write!(f, "^"),
            Self::BitwiseOr => write!(f, "|"),
            Self::LogicalAnd => write!(f, "&&"),
            Self::LogicalOr => write!(f, "||"),
        }
    }
}

/// A unary arithmetic operator.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum UnaryOperator {
    /// Unary plus (e.g., `+x`).
    UnaryPlus,
    /// Unary minus (e.g., `-x`).
    UnaryMinus,
    /// Bitwise not (e.g., `~x`).
    BitwiseNot,
    /// Logical not (e.g., `!x`).
    LogicalNot,
}

impl Display for UnaryOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnaryPlus => write!(f, "+"),
            Self::UnaryMinus => write!(f, "-"),
            Self::BitwiseNot => write!(f, "~"),
            Self::LogicalNot => write!(f, "!"),
        }
    }
}

/// A unary arithmetic assignment operator.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum UnaryAssignmentOperator {
    /// Prefix increment (e.g., `++x`).
    PrefixIncrement,
    /// Prefix increment (e.g., `--x`).
    PrefixDecrement,
    /// Postfix increment (e.g., `x++`).
    PostfixIncrement,
    /// Postfix decrement (e.g., `x--`).
    PostfixDecrement,
}

impl Display for UnaryAssignmentOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PrefixIncrement => write!(f, "++"),
            Self::PrefixDecrement => write!(f, "--"),
            Self::PostfixIncrement => write!(f, "++"),
            Self::PostfixDecrement => write!(f, "--"),
        }
    }
}

/// Identifies the target of an arithmetic assignment expression.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum ArithmeticTarget {
    /// A named variable.
    Variable(String),
    /// An element in an array.
    ArrayElement(String, Box<ArithmeticExpr>),
}

impl Node for ArithmeticTarget {}

impl SourceLocation for ArithmeticTarget {
    fn location(&self) -> Option<SourceSpan> {
        // TODO(source-location): complete and add loc
        None
    }
}

impl Display for ArithmeticTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Variable(name) => write!(f, "{name}"),
            Self::ArrayElement(name, index) => write!(f, "{name}[{index}]"),
        }
    }
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::*;
    use crate::{ParserOptions, SourcePosition};
    use std::io::BufReader;

    fn parse(input: &str) -> Program {
        let reader = BufReader::new(input.as_bytes());
        let mut parser = crate::Parser::new(reader, &ParserOptions::default());
        parser.parse_program().unwrap()
    }

    #[test]
    fn program_source_loc() {
        const INPUT: &str = r"echo hi
echo there
";

        let loc = parse(INPUT).location().unwrap();

        assert_eq!(
            *(loc.start),
            SourcePosition {
                line: 1,
                column: 1,
                index: 0
            }
        );
        assert_eq!(
            *(loc.end),
            SourcePosition {
                line: 2,
                column: 11,
                index: 18
            }
        );
    }

    #[test]
    fn function_def_loc() {
        const INPUT: &str = r"my_func() {
  echo hi
  echo there
}

my_func
";

        let program = parse(INPUT);

        let Command::Function(func_def) = &program.complete_commands[0].0[0].0.first.seq[0] else {
            panic!("expected function definition");
        };

        let loc = func_def.location().unwrap();

        assert_eq!(
            *(loc.start),
            SourcePosition {
                line: 1,
                column: 1,
                index: 0
            }
        );
        assert_eq!(
            *(loc.end),
            SourcePosition {
                line: 4,
                column: 2,
                index: 36
            }
        );
    }

    #[test]
    fn simple_cmd_loc() {
        const INPUT: &str = r"var=value somecmd arg1 arg2
";

        let program = parse(INPUT);

        let Command::Simple(cmd) = &program.complete_commands[0].0[0].0.first.seq[0] else {
            panic!("expected function definition");
        };

        let loc = cmd.location().unwrap();

        assert_eq!(
            *(loc.start),
            SourcePosition {
                line: 1,
                column: 1,
                index: 0
            }
        );
        assert_eq!(
            *(loc.end),
            SourcePosition {
                line: 1,
                column: 28,
                index: 27
            }
        );
    }
}
