Write a rule for a mistake the model will keep making here: reading the clock directly instead of through `src/clock.ts`.
`add a project rule .omp/rules/use-clock.md like no-console-log.md: condition Date\.now\( and new Date\(, scope .ts edits and writes, telling the model to use now() from src/clock.ts`
Keep the body short. The model reads it only when the rule fires.
