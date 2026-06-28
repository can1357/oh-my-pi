uniq-about = Report or omit repeated lines.
uniq-usage = uniq [OPTION]... [INPUT [OUTPUT]]
uniq-after-help = Filter adjacent matching lines from INPUT (or standard input),
  writing to OUTPUT (or standard output).

  Note: uniq does not detect repeated lines unless they are adjacent.
  You may want to sort the input first, or use sort -u without uniq.

# Help messages
uniq-help-all-repeated = print all duplicate lines. Delimiting is done with blank lines. [default: none]
uniq-help-group = show all items, separating groups with an empty line. [default: separate]
uniq-help-check-chars = compare no more than N characters in lines
uniq-help-count = prefix lines by the number of occurrences
uniq-help-ignore-case = ignore differences in case when comparing
uniq-help-repeated = only print duplicate lines
uniq-help-skip-chars = avoid comparing the first N characters
uniq-help-skip-fields = avoid comparing the first N fields
uniq-help-unique = only print unique lines
uniq-help-zero-terminated = end lines with 0 byte, not newline

# Error messages
uniq-error-write-line-terminator = Could not write line terminator
uniq-error-write-error = write error
uniq-error-read-error = read error
uniq-error-invalid-argument = Invalid argument for { $opt_name }: { $arg }
uniq-error-try-help = Try 'uniq --help' for more information.
uniq-error-group-mutually-exclusive = --group is mutually exclusive with -c/-d/-D/-u
uniq-error-group-badoption = invalid argument 'badoption' for '--group'
  Valid arguments are:
    - 'prepend'
    - 'append'
    - 'separate'
    - 'both'

uniq-error-all-repeated-badoption = invalid argument 'badoption' for '--all-repeated'
  Valid arguments are:
    - 'none'
    - 'prepend'
    - 'separate'

uniq-error-counts-and-repeated-meaningless = printing all duplicated lines and repeat counts is meaningless
  Try 'uniq --help' for more information.

uniq-error-could-not-open = Could not open { $path }
