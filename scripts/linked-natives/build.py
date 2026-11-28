"""Link this checkout's pi-natives into the pinned Bun runtime for one release target.

Usage: python3 scripts/linked-natives/build.py <target-id>

Prints the runtime template for `Bun.build`'s `compile.executablePath` (and records it as
`executable` in $GITHUB_OUTPUT). Build steps log to stderr. A missing or invalid kit fails the build;
it never compiles Bun.
"""

import os
import sys

import archive
import kit
from link import link
from pins import Target


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: build.py <release-target-id>")
    target = Target.parse(sys.argv[1])
    executable = link(target, kit.resolve(target), archive.build(target))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"executable={executable}\n")
    print(executable)


if __name__ == "__main__":
    main()
