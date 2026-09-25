Work only in the current temporary test directory. Perform these steps in order using actual tools:

1. Use read to read input.txt.
2. Use write to create output.txt containing exactly the input file contents, preserving the newline.
3. Use bash to execute `cmp input.txt output.txt && sh challenge.sh`.
4. End your answer with the exact stdout from challenge.sh.

Do not read challenge.sh; execute it. Do not use bash to substitute for read or write. Do not access files outside this directory. Do not claim a tool ran unless it actually ran.
