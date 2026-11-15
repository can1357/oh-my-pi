// Copyright 2017 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//go:build ignore

package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"
)

// convert_comments.go converts C-style block comments to C++-style line
// comments. A block comment is converted if all of the following are true:
//
//   * The comment begins after the first blank line, to leave the license
//     blocks alone.
//
//   * There are no characters between the '*/' and the end of the line.
//
//   * Either one of the following are true:
//
//     - The comment fits on one line.
//
//     - Each line the comment spans begins with N spaces, followed by '/*' for
//       the initial line or ' *' for subsequent lines, where N is the same for
//       each line.
//
// This tool is a heuristic. While it gets almost all cases correct, the final
// output should still be looked over and fixed up as needed.

// allSpaces returns true if |s| consists entirely of spaces.
func allSpaces(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return r != ' ' }) == -1
}

// isContinuation returns true if |s| is a continuation line for a multi-line
// comment indented to the specified column.
func isContinuation(s string, column int) bool {
	if len(s) < column+2 {
		return false
	}
	if !allSpaces(s[:column]) {
		return false
	}
	return s[column:column+2] == " *"
}

// indexFrom behaves like strings.Index but only reports matches starting at
// |idx|.
func indexFrom(s, sep string, idx int) int {
	ret := strings.Index(s[idx:], sep)
	if ret < 0 {
		return -1
	}
	return idx + ret
}

// A lineGroup is a contiguous group of lines with an eligible comment at the
// same column. Any trailing '*/'s will already be removed.
type lineGroup struct {
	// column is the column where the eligible comment begins. line[column]
	// and line[column+1] will both be replaced with '/'. It is -1 if this
	// group is not to be converted.
	column int
	lines  []string
}

func addLine(groups *[]lineGroup, line string, column int) {
	if len(*groups) == 0 || (*groups)[len(*groups)-1].column != column {
		*groups = append(*groups, lineGroup{column, nil})
	}
	(*groups)[len(*groups)-1].lines = append((*groups)[len(*groups)-1].lines, line)
}

// writeLine writes |line| to |out|, followed by a newline.
func writeLine(out *bytes.Buffer, line string) {
	out.WriteString(line)
	out.WriteByte('\n')
}

func convertComments(path string, in []byte) []byte {
	lines := strings.Split(string(in), "\n")

	// Account for the trailing newline.
	if len(lines) > 0 && len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}

	// First pass: identify all comments to be converted. Group them into
	// lineGroups with the same column.
	var groups []lineGroup

	// Find the license block separator.
	for len(lines) > 0 {
		line := lines[0]
		lines = lines[1:]
		addLine(&groups, line, -1)
		if len(line) == 0 {
			break
		}
	}

	// inComment is true if we are in the middle of a comment.
	var inComment bool
	// comment is the currently buffered multi-line comment to convert. If
	// |inComment| is true and it is nil, the current multi-line comment is
	// not convertible and we copy lines to |out| as-is.
	var comment []string
	// column is the column offset of |comment|.
	var column int
	for len(lines) > 0 {
		line := lines[0]
		lines = lines[1:]

		var idx int
		if inComment {
			// Stop buffering if this comment isn't eligible.
			if comment != nil && !isContinuation(line, column) {
				for _, l := range comment {
					addLine(&groups, l, -1)
				}
				comment = nil
			}

			// Look for the end of the current comment.
			idx = strings.Index(line, "*/")
			if idx < 0 {
				if comment != nil {
					comment = append(comment, line)
				} else {
					addLine(&groups, line, -1)
				}
				continue
			}

			inComment = false
			if comment != nil {
				if idx == len(line)-2 {
					// This is a convertible multi-line comment.
					if idx >= column+2 {
						// |idx| may be equal to
						// |column| + 1, if the line is
						// a '*/' on its own. In that
						// case, we discard the line.
						comment = append(comment, line[:idx])
					}
					for _, l := range comment {
						addLine(&groups, l, column)
					}
					comment = nil
					continue
				}

				// Flush the buffered comment unmodified.
				for _, l := range comment {
					addLine(&groups, l, -1)
				}
				comment = nil
			}
			idx += 2
		}

		// Parse starting from |idx|, looking for either a convertible
		// line comment or a multi-line comment.
		for {
			idx = indexFrom(line, "/*", idx)
			if idx < 0 {
				addLine(&groups, line, -1)
				break
			}

			endIdx := indexFrom(line, "*/", idx)
			if endIdx < 0 {
				// The comment is, so far, eligible for conversion.
				inComment = true
				column = idx
				comment = []string{line}
				break
			}

			if endIdx != len(line)-2 {
				// Continue parsing for more comments in this line.
				idx = endIdx + 2
				continue
			}

			addLine(&groups, line[:endIdx], idx)
			break
		}
	}

	// Second pass: convert the lineGroups, adjusting spacing as needed.
	var out bytes.Buffer
	var lineNo int
	for _, group := range groups {
		if group.column < 0 {
			for _, line := range group.lines {
				writeLine(&out, line)
			}
		} else {
			// Google C++ style prefers two spaces before a comment
			// if it is on the same line as code, but clang-format
			// has been placing one space for block comments. All
			// comments within a group should be adjusted by the
			// same amount.
			var adjust string
			for _, line := range group.lines {
				if !allSpaces(line[:group.column]) && line[group.column-1] != '(' {
					if line[group.column-1] != ' ' {
						if len(adjust) < 2 {
							adjust = "  "
						}
					} else if line[group.column-2] != ' ' {
						if len(adjust) < 1 {
							adjust = " "
						}
					}
				}
			}

			for i, line := range group.lines {
				// The OpenSSL style writes multiline block comments with a
				// blank line at the top and bottom, like so:
				//
				//   /*
				//    * Some multi-line
				//    * comment
				//    */
				//
				// The trailing lines are already removed above, when buffering.
				// Remove the leading lines here. (The leading lines cannot be
				// removed when buffering because we may discover the comment is
				// not convertible in later lines.)
				//
				// Note the leading line cannot be easily removed if there is
				// code before it, such as the following. Skip those cases.
				//
				//   foo(); /*
				//           * Some multi-line
				//           * comment
				//           */
				if i == 0 && allSpaces(line[:group.column]) && len(line) == group.column+2 {
					continue
				}
				newLine := fmt.Sprintf("%s%s//%s", line[:group.column], adjust, strings.TrimRight(line[group.column+2:], " "))
				if len(newLine) > 80 {
					fmt.Fprintf(os.Stderr, "%s:%d: Line is now longer than 80 characters\n", path, lineNo+i+1)
				}
				writeLine(&out, newLine)
			}

		}
		lineNo += len(group.lines)
	}
	return out.Bytes()
}

func main() {
	for _, arg := range os.Args[1:] {
		in, err := os.ReadFile(arg)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(arg, convertComments(arg, in), 0666); err != nil {
			panic(err)
		}
	}
}
