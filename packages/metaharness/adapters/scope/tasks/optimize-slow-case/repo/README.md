# salesreport

Monthly revenue per region, built from the order export.

    bun run report --rows 60000

`--rows` sets how many export lines to read and `--seed` picks the data set (default 7). The
export is synthetic but shaped like production: about 3% of lines are re-exports of an earlier
order (dropped: the first line wins), and customer ids arrive in mixed case.

`buildReport` in `src/report.ts` is what the CLI and the tests share.

    bun test
