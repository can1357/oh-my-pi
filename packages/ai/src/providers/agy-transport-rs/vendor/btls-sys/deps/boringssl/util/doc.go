//go:build ignore

// doc generates HTML files from the comments in header files.
//
// doc expects to be given the path to a JSON file via the --config option.
// From that JSON (which is defined by the Config struct) it reads a list of
// header file locations and generates HTML files for each in the current
// directory.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Config describes the structure of the config JSON file.
type Config struct {
	// BaseDirectory is a path to which other paths in the file are
	// relative.
	BaseDirectory string
	Sections      []ConfigSection
}

type ConfigSection struct {
	Name string
	// Headers is a list of paths to header files.
	Headers []string
}

// HeaderFile is the internal representation of a header file.
type HeaderFile struct {
	// Name is the basename of the header file (e.g. "ex_data.html").
	Name string
	// Preamble contains a comment for the file as a whole. Each string
	// is a separate paragraph.
	Preamble []CommentBlock
	Sections []HeaderSection
	// AllDecls maps all decls to their URL fragments.
	AllDecls map[string]string
}

type HeaderSection struct {
	// Preamble contains a comment for a group of functions.
	Preamble []CommentBlock
	Decls    []HeaderDecl
	// Anchor, if non-empty, is the URL fragment to use in anchor tags.
	Anchor string
	// IsPrivate is true if the section contains private functions (as
	// indicated by its name).
	IsPrivate bool
}

type HeaderDecl struct {
	// Comment contains a comment for a specific function. Each string is a
	// paragraph. Some paragraph may contain \n runes to indicate that they
	// are preformatted.
	Comment []CommentBlock
	// Name contains the name of the function, if it could be extracted.
	Name string
	// Decl contains the preformatted C declaration itself.
	Decl string
	// Anchor, if non-empty, is the URL fragment to use in anchor tags.
	Anchor string
}

type CommentBlockType int

const (
	CommentParagraph CommentBlockType = iota
	CommentOrderedListItem
	CommentBulletListItem
	CommentCode
)

type CommentBlock struct {
	Type      CommentBlockType
	Paragraph string
}

const (
	cppGuard     = "#if defined(__cplusplus)"
	commentStart = "/* "
	commentEnd   = " */"
	lineComment  = "// "
)

func isComment(line string) bool {
	return strings.HasPrefix(line, commentStart) || strings.HasPrefix(line, lineComment)
}

func commentSubject(line string) string {
	if strings.HasPrefix(line, "A ") {
		line = line[len("A "):]
	} else if strings.HasPrefix(line, "An ") {
		line = line[len("An "):]
	}
	idx := strings.IndexAny(line, " ,")
	if idx < 0 {
		return line
	}
	return line[:idx]
}

func extractCommentLines(lines []string, lineNo int) (comment []string, rest []string, restLineNo int, err error) {
	if len(lines) == 0 {
		return nil, lines, lineNo, nil
	}

	restLineNo = lineNo
	rest = lines

	var isBlock bool
	if strings.HasPrefix(rest[0], commentStart) {
		isBlock = true
	} else if !strings.HasPrefix(rest[0], lineComment) {
		panic("extractComment called on non-comment")
	}
	comment = []string{rest[0][len(commentStart):]}
	rest = rest[1:]
	restLineNo++

	for len(rest) > 0 {
		if isBlock {
			last := &comment[len(comment)-1]
			if i := strings.Index(*last, commentEnd); i >= 0 {
				if i != len(*last)-len(commentEnd) {
					err = fmt.Errorf("garbage after comment end on line %d", restLineNo)
					return
				}
				*last = (*last)[:i]
				return
			}
		}

		line := rest[0]
		if isBlock {
			if !strings.HasPrefix(line, " *") {
				err = fmt.Errorf("comment doesn't start with block prefix on line %d: %s", restLineNo, line)
				return
			}
		} else if !strings.HasPrefix(line, "//") {
			return
		}
		comment = append(comment, line[2:])
		rest = rest[1:]
		restLineNo++
	}

	err = errors.New("hit EOF in comment")
	return
}

func removeBulletListMarker(line string) (string, bool) {
	orig := line
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "+ ") && !strings.HasPrefix(line, "- ") && !strings.HasPrefix(line, "* ") {
		return orig, false
	}
	return line[2:], true
}

func removeOrderedListMarker(line string) (rest string, num int, ok bool) {
	orig := line
	line = strings.TrimSpace(line)
	if len(line) == 0 || !unicode.IsDigit(rune(line[0])) {
		return orig, -1, false
	}

	l := 0
	for l < len(line) && unicode.IsDigit(rune(line[l])) {
		l++
	}
	num, err := strconv.Atoi(line[:l])
	if err != nil {
		return orig, -1, false
	}

	line = line[l:]
	if line, ok := strings.CutPrefix(line, ". "); ok {
		return line, num, true
	}
	if line, ok := strings.CutPrefix(line, ") "); ok {
		return line, num, true
	}

	return orig, -1, false
}

func removeCodeIndent(line string) (string, bool) {
	return strings.CutPrefix(line, "   ")
}

func extractComment(lines []string, lineNo int) (comment []CommentBlock, rest []string, restLineNo int, err error) {
	commentLines, rest, restLineNo, err := extractCommentLines(lines, lineNo)
	if err != nil {
		return
	}

	// This syntax and parsing algorithm is loosely inspired by CommonMark,
	// but reduced to a small subset with no nesting. Blocks being open vs.
	// closed can be tracked implicitly. We're also much slopplier about how
	// indentation. Additionally, rather than grouping list items into
	// lists, our parser just emits a list items, which are grouped later at
	// rendering time.
	//
	// If we later need more features, such as nested lists, this can evolve
	// into a more complex implementation.
	var numBlankLines int
	for _, line := range commentLines {
		// Defer blank lines until we know the next element.
		if len(strings.TrimSpace(line)) == 0 {
			numBlankLines++
			continue
		}

		blankLinesSkipped := numBlankLines
		numBlankLines = 0

		// Attempt to continue the previous block.
		if len(comment) > 0 {
			last := &comment[len(comment)-1]
			if last.Type == CommentCode {
				l, ok := removeCodeIndent(line)
				if ok {
					for i := 0; i < blankLinesSkipped; i++ {
						last.Paragraph += "\n"
					}
					last.Paragraph += l + "\n"
					continue
				}
			} else if blankLinesSkipped == 0 {
				_, isBulletList := removeBulletListMarker(line)
				_, num, isOrderedList := removeOrderedListMarker(line)
				if isOrderedList && last.Type == CommentParagraph && num != 1 {
					// A list item can only interrupt a paragraph if the number is one.
					// See the discussion in https://spec.commonmark.org/0.30/#lists.
					// This avoids wrapping like "(See RFC\n5280)" turning into a list.
					isOrderedList = false
				}
				if !isBulletList && !isOrderedList {
					// This is a continuation line of the previous paragraph.
					last.Paragraph += " " + strings.TrimSpace(line)
					continue
				}
			}
		}

		// Make a new block.
		if line, ok := removeBulletListMarker(line); ok {
			comment = append(comment, CommentBlock{
				Type:      CommentBulletListItem,
				Paragraph: strings.TrimSpace(line),
			})
		} else if line, _, ok := removeOrderedListMarker(line); ok {
			comment = append(comment, CommentBlock{
				Type:      CommentOrderedListItem,
				Paragraph: strings.TrimSpace(line),
			})
		} else if line, ok := removeCodeIndent(line); ok {
			comment = append(comment, CommentBlock{
				Type:      CommentCode,
				Paragraph: line + "\n",
			})
		} else {
			comment = append(comment, CommentBlock{
				Type:      CommentParagraph,
				Paragraph: strings.TrimSpace(line),
			})
		}
	}

	return
}

func extractDecl(lines []string, lineNo int) (decl string, rest []string, restLineNo int, err error) {
	if len(lines) == 0 || len(lines[0]) == 0 {
		return "", lines, lineNo, nil
	}

	rest = lines
	restLineNo = lineNo

	var stack []rune
	for len(rest) > 0 {
		line := rest[0]
		for _, c := range line {
			switch c {
			case '(', '{', '[':
				stack = append(stack, c)
			case ')', '}', ']':
				if len(stack) == 0 {
					err = fmt.Errorf("unexpected %c on line %d", c, restLineNo)
					return
				}
				var expected rune
				switch c {
				case ')':
					expected = '('
				case '}':
					expected = '{'
				case ']':
					expected = '['
				default:
					panic("internal error")
				}
				if last := stack[len(stack)-1]; last != expected {
					err = fmt.Errorf("found %c when expecting %c on line %d", c, last, restLineNo)
					return
				}
				stack = stack[:len(stack)-1]
			}
		}
		if len(decl) > 0 {
			decl += "\n"
		}
		decl += line
		rest = rest[1:]
		restLineNo++

		if len(stack) == 0 && (len(decl) == 0 || decl[len(decl)-1] != '\\') {
			break
		}
	}

	return
}

func skipLine(s string) string {
	i := strings.Index(s, "\n")
	if i > 0 {
		return s[i:]
	}
	return ""
}

var stackOfRegexp = regexp.MustCompile(`STACK_OF\(([^)]*)\)`)
var lhashOfRegexp = regexp.MustCompile(`LHASH_OF\(([^)]*)\)`)

func getNameFromDecl(decl string) (string, bool) {
	for strings.HasPrefix(decl, "#if") || strings.HasPrefix(decl, "#elif") {
		decl = skipLine(decl)
	}

	if strings.HasPrefix(decl, "typedef ") {
		return "", false
	}

	for _, prefix := range []string{"struct ", "enum ", "#define "} {
		if !strings.HasPrefix(decl, prefix) {
			continue
		}

		decl = strings.TrimPrefix(decl, prefix)

		for len(decl) > 0 && decl[0] == ' ' {
			decl = decl[1:]
		}

		// struct and enum types can be the return type of a
		// function.
		if prefix[0] != '#' && strings.Index(decl, "{") == -1 {
			break
		}

		i := strings.IndexAny(decl, "( ")
		if i < 0 {
			return "", false
		}
		return decl[:i], true
	}
	decl = strings.TrimPrefix(decl, "OPENSSL_EXPORT ")
	decl = strings.TrimPrefix(decl, "const ")
	decl = stackOfRegexp.ReplaceAllString(decl, "STACK_OF_$1")
	decl = lhashOfRegexp.ReplaceAllString(decl, "LHASH_OF_$1")
	i := strings.Index(decl, "(")
	if i < 0 {
		return "", false
	}
	j := strings.LastIndex(decl[:i], " ")
	if j < 0 {
		return "", false
	}
	for j+1 < len(decl) && decl[j+1] == '*' {
		j++
	}
	return decl[j+1 : i], true
}

func sanitizeAnchor(name string) string {
	return strings.Replace(name, " ", "-", -1)
}

func isPrivateSection(name string) bool {
	return strings.HasPrefix(name, "Private functions") || strings.HasPrefix(name, "Private structures") || strings.Contains(name, "(hidden)")
}

func isCollectiveComment(line string) bool {
	return strings.HasPrefix(line, "The ") || strings.HasPrefix(line, "These ")
}

func (config *Config) parseHeader(path string) (*HeaderFile, error) {
	headerPath := filepath.Join(config.BaseDirectory, path)

	headerFile, err := os.Open(headerPath)
	if err != nil {
		return nil, err
	}
	defer headerFile.Close()

	scanner := bufio.NewScanner(headerFile)
	var lines, oldLines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	lineNo := 1
	found := false
	for i, line := range lines {
		if line == cppGuard {
			lines = lines[i+1:]
			lineNo += i + 1
			found = true
			break
		}
	}

	if !found {
		return nil, errors.New("no C++ guard found")
	}

	if len(lines) == 0 || lines[0] != "extern \"C\" {" {
		return nil, errors.New("no extern \"C\" found after C++ guard")
	}
	lineNo += 2
	lines = lines[2:]

	header := &HeaderFile{
		Name:     filepath.Base(path),
		AllDecls: make(map[string]string),
	}

	for i, line := range lines {
		if len(line) > 0 {
			lines = lines[i:]
			lineNo += i
			break
		}
	}

	oldLines = lines
	if len(lines) > 0 && isComment(lines[0]) {
		comment, rest, restLineNo, err := extractComment(lines, lineNo)
		if err != nil {
			return nil, err
		}

		if len(rest) > 0 && len(rest[0]) == 0 {
			if len(rest) < 2 || len(rest[1]) != 0 {
				return nil, errors.New("preamble comment should be followed by two blank lines")
			}
			header.Preamble = comment
			lineNo = restLineNo + 2
			lines = rest[2:]
		} else {
			lines = oldLines
		}
	}

	allAnchors := make(map[string]struct{})

	for {
		// Start of a section.
		if len(lines) == 0 {
			return nil, errors.New("unexpected end of file")
		}
		line := lines[0]
		if line == cppGuard {
			break
		}

		if len(line) == 0 {
			return nil, fmt.Errorf("blank line at start of section on line %d", lineNo)
		}

		var section HeaderSection

		if isComment(line) {
			comment, rest, restLineNo, err := extractComment(lines, lineNo)
			if err != nil {
				return nil, err
			}
			if len(rest) > 0 && len(rest[0]) == 0 {
				heading := firstSentence(comment)
				anchor := sanitizeAnchor(heading)
				if len(anchor) > 0 {
					if _, ok := allAnchors[anchor]; ok {
						return nil, fmt.Errorf("duplicate anchor: %s", anchor)
					}
					allAnchors[anchor] = struct{}{}
				}

				section.Preamble = comment
				section.IsPrivate = isPrivateSection(heading)
				section.Anchor = anchor
				lines = rest[1:]
				lineNo = restLineNo + 1
			}
		}

		for len(lines) > 0 {
			line := lines[0]
			if len(line) == 0 {
				lines = lines[1:]
				lineNo++
				break
			}
			if line == cppGuard {
				return nil, fmt.Errorf("hit ending C++ guard while in section on line %d (possibly missing two empty lines ahead of guard?)", lineNo)
			}

			var comment []CommentBlock
			var decl string
			if isComment(line) {
				comment, lines, lineNo, err = extractComment(lines, lineNo)
				if err != nil {
					return nil, err
				}
			}
			if len(lines) == 0 {
				return nil, fmt.Errorf("expected decl at EOF on line %d", lineNo)
			}
			declLineNo := lineNo
			decl, lines, lineNo, err = extractDecl(lines, lineNo)
			if err != nil {
				return nil, err
			}
			name, ok := getNameFromDecl(decl)
			if !ok {
				name = ""
			}
			if last := len(section.Decls) - 1; len(name) == 0 && len(comment) == 0 && last >= 0 {
				section.Decls[last].Decl += "\n" + decl
			} else {
				// As a matter of style, comments should start
				// with the name of the thing that they are
				// commenting on. We make an exception here for
				// collective comments.
				sentence := firstSentence(comment)
				if len(comment) > 0 &&
					len(name) > 0 &&
					!isCollectiveComment(sentence) {
					subject := commentSubject(sentence)
					ok := subject == name
					if l := len(subject); l > 0 && subject[l-1] == '*' {
						// Groups of names, notably #defines, are often
						// denoted with a wildcard.
						ok = strings.HasPrefix(name, subject[:l-1])
					}
					if !ok {
						return nil, fmt.Errorf("comment for %q doesn't seem to match line %s:%d\n", name, path, declLineNo)
					}
				}
				anchor := sanitizeAnchor(name)
				// TODO(davidben): Enforce uniqueness. This is
				// skipped because #ifdefs currently result in
				// duplicate table-of-contents entries.
				allAnchors[anchor] = struct{}{}

				header.AllDecls[name] = anchor

				section.Decls = append(section.Decls, HeaderDecl{
					Comment: comment,
					Name:    name,
					Decl:    decl,
					Anchor:  anchor,
				})
			}

			if len(lines) > 0 && len(lines[0]) == 0 {
				lines = lines[1:]
				lineNo++
			}
		}

		header.Sections = append(header.Sections, section)
	}

	return header, nil
}

func firstSentence(comment []CommentBlock) string {
	if len(comment) == 0 {
		return ""
	}
	s := comment[0].Paragraph
	i := strings.Index(s, ". ")
	if i >= 0 {
		return s[:i]
	}
	if lastIndex := len(s) - 1; s[lastIndex] == '.' {
		return s[:lastIndex]
	}
	return s
}

func markupComment(allDecls map[string]string, comment []CommentBlock) template.HTML {
	var b strings.Builder
	lastType := CommentParagraph
	closeList := func() {
		if lastType == CommentOrderedListItem {
			b.WriteString("</ol>")
		} else if lastType == CommentBulletListItem {
			b.WriteString("</ul>")
		}
	}

	for _, block := range comment {
		// Group consecutive list items of the same type into a list.
		if block.Type != lastType {
			closeList()
			if block.Type == CommentOrderedListItem {
				b.WriteString("<ol>")
			} else if block.Type == CommentBulletListItem {
				b.WriteString("<ul>")
			}
		}
		lastType = block.Type

		switch block.Type {
		case CommentParagraph:
			if strings.HasPrefix(block.Paragraph, "WARNING:") {
				b.WriteString("<p class=\"warning\">")
			} else {
				b.WriteString("<p>")
			}
			b.WriteString(string(markupParagraph(allDecls, block.Paragraph)))
			b.WriteString("</p>")
		case CommentOrderedListItem, CommentBulletListItem:
			b.WriteString("<li>")
			b.WriteString(string(markupParagraph(allDecls, block.Paragraph)))
			b.WriteString("</li>")
		case CommentCode:
			b.WriteString("<pre>")
			b.WriteString(block.Paragraph)
			b.WriteString("</pre>")
		default:
			panic(block.Type)
		}
	}

	closeList()
	return template.HTML(b.String())
}

func markupParagraph(allDecls map[string]string, s string) template.HTML {
	// TODO(davidben): Ideally the inline transforms would be unified into
	// one pass, so that the HTML output of one pass does not interfere with
	// the next.
	ret := markupPipeWords(allDecls, s, true /* linkDecls */)
	ret = markupFirstWord(ret)
	ret = markupRFC(ret)
	return ret
}

// markupPipeWords converts |s| into an HTML string, safe to be included outside
// a tag, while also marking up words surrounded by | or `.
func markupPipeWords(allDecls map[string]string, s string, linkDecls bool) template.HTML {
	// It is safe to look for '|' and '`' in the HTML-escaped version of |s|
	// below. The escaped version cannot include '|' or '`' inside tags because
	// there are no tags by construction.
	s = template.HTMLEscapeString(s)
	var ret strings.Builder

	for {
		i := strings.IndexAny(s, "|`")
		if i == -1 {
			ret.WriteString(s)
			break
		}
		c := s[i]
		ret.WriteString(s[:i])
		s = s[i+1:]

		i = strings.IndexByte(s, c)
		j := strings.Index(s, " ")
		if i > 0 && (j == -1 || j > i) {
			ret.WriteString("<tt>")
			anchor, isLink := allDecls[s[:i]]
			if linkDecls && isLink {
				fmt.Fprintf(&ret, "<a href=\"%s\">%s</a>", template.HTMLEscapeString(anchor), s[:i])
			} else {
				ret.WriteString(s[:i])
			}
			ret.WriteString("</tt>")
			s = s[i+1:]
		} else {
			ret.WriteByte(c)
		}
	}

	return template.HTML(ret.String())
}

func markupFirstWord(s template.HTML) template.HTML {
	if isCollectiveComment(string(s)) {
		return s
	}
	start := 0
again:
	end := strings.Index(string(s[start:]), " ")
	if end > 0 {
		end += start
		w := strings.ToLower(string(s[start:end]))
		// The first word was already marked up as an HTML tag. Don't
		// mark it up further.
		if strings.ContainsRune(w, '<') {
			return s
		}
		if w == "a" || w == "an" {
			start = end + 1
			goto again
		}
		return s[:start] + "<span class=\"first-word\">" + s[start:end] + "</span>" + s[end:]
	}
	return s
}

var rfcRegexp = regexp.MustCompile("RFC ([0-9]+)")

func markupRFC(html template.HTML) template.HTML {
	s := string(html)
	matches := rfcRegexp.FindAllStringSubmatchIndex(s, -1)
	if len(matches) == 0 {
		return html
	}

	var b strings.Builder
	var idx int
	for _, match := range matches {
		start, end := match[0], match[1]
		number := s[match[2]:match[3]]
		b.WriteString(s[idx:start])
		fmt.Fprintf(&b, "<a href=\"https://www.rfc-editor.org/rfc/rfc%s.html\">%s</a>", number, s[start:end])
		idx = end
	}
	b.WriteString(s[idx:])
	return template.HTML(b.String())
}

func generate(outPath string, config *Config) (map[string]string, error) {
	allDecls := make(map[string]string)

	headerTmpl := template.New("headerTmpl")
	headerTmpl.Funcs(template.FuncMap{
		"firstSentence":         firstSentence,
		"markupPipeWordsNoLink": func(s string) template.HTML { return markupPipeWords(allDecls, s, false /* linkDecls */) },
		"markupComment":         func(c []CommentBlock) template.HTML { return markupComment(allDecls, c) },
	})
	headerTmpl, err := headerTmpl.Parse(`<!DOCTYPE html>
<html>
  <head>
    <title>BoringSSL - {{.Name}}</title>
    <meta charset="utf-8">
    <link rel="stylesheet" type="text/css" href="doc.css">
  </head>

  <body>
    <div id="main">
    <div class="title">
      <h2>{{.Name}}</h2>
      <a href="headers.html">All headers</a>
    </div>

    {{if .Preamble}}<div class="comment">{{.Preamble | markupComment}}</div>{{end}}

    <ol class="toc">
      {{range .Sections}}
        {{if not .IsPrivate}}
          {{if .Anchor}}<li class="header"><a href="#{{.Anchor}}">{{.Preamble | firstSentence | markupPipeWordsNoLink}}</a></li>{{end}}
          {{range .Decls}}
            {{if .Anchor}}<li><a href="#{{.Anchor}}"><tt>{{.Name}}</tt></a></li>{{end}}
          {{end}}
        {{end}}
      {{end}}
    </ol>

    {{range .Sections}}
      {{if not .IsPrivate}}
        <div class="section" {{if .Anchor}}id="{{.Anchor}}"{{end}}>
        {{if .Preamble}}<div class="sectionpreamble comment">{{.Preamble | markupComment}}</div>{{end}}

        {{range .Decls}}
          <div class="decl" {{if .Anchor}}id="{{.Anchor}}"{{end}}>
            {{if .Comment}}<div class="comment">{{.Comment | markupComment}}</div>{{end}}
            {{if .Decl}}<pre class="code">{{.Decl}}</pre>{{end}}
          </div>
        {{end}}
        </div>
      {{end}}
    {{end}}
    </div>
  </body>
</html>`)
	if err != nil {
		return nil, err
	}

	headerDescriptions := make(map[string]string)
	var headers []*HeaderFile

	for _, section := range config.Sections {
		for _, headerPath := range section.Headers {
			header, err := config.parseHeader(headerPath)
			if err != nil {
				return nil, errors.New("while parsing " + headerPath + ": " + err.Error())
			}
			headerDescriptions[header.Name] = firstSentence(header.Preamble)
			headers = append(headers, header)

			for name, anchor := range header.AllDecls {
				allDecls[name] = fmt.Sprintf("%s#%s", header.Name+".html", anchor)
			}
		}
	}

	for _, header := range headers {
		filename := filepath.Join(outPath, header.Name+".html")
		file, err := os.OpenFile(filename, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0666)
		if err != nil {
			panic(err)
		}
		defer file.Close()
		if err := headerTmpl.Execute(file, header); err != nil {
			return nil, err
		}
	}

	return headerDescriptions, nil
}

func generateIndex(outPath string, config *Config, headerDescriptions map[string]string) error {
	indexTmpl := template.New("indexTmpl")
	indexTmpl.Funcs(template.FuncMap{
		"baseName": filepath.Base,
		"headerDescription": func(header string) string {
			return headerDescriptions[header]
		},
	})
	indexTmpl, err := indexTmpl.Parse(`<!DOCTYPE html5>

  <head>
    <title>BoringSSL - Headers</title>
    <meta charset="utf-8">
    <link rel="stylesheet" type="text/css" href="doc.css">
  </head>

  <body>
    <div id="main">
      <div class="title">
        <h2>BoringSSL Headers</h2>
      </div>
      <table>
        {{range .Sections}}
	  <tr class="header"><td colspan="2">{{.Name}}</td></tr>
	  {{range .Headers}}
	    <tr><td><a href="{{. | baseName}}.html">{{. | baseName}}</a></td><td>{{. | baseName | headerDescription}}</td></tr>
	  {{end}}
	{{end}}
      </table>
    </div>
  </body>
</html>`)

	if err != nil {
		return err
	}

	file, err := os.OpenFile(filepath.Join(outPath, "headers.html"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0666)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	if err := indexTmpl.Execute(file, config); err != nil {
		return err
	}

	return nil
}

func copyFile(outPath string, inFilePath string) error {
	bytes, err := os.ReadFile(inFilePath)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(outPath, filepath.Base(inFilePath)), bytes, 0666)
}

func main() {
	var (
		configFlag *string = flag.String("config", "doc.config", "Location of config file")
		outputDir  *string = flag.String("out", ".", "Path to the directory where the output will be written")
		config     Config
	)

	flag.Parse()

	if len(*configFlag) == 0 {
		fmt.Printf("No config file given by --config\n")
		os.Exit(1)
	}

	if len(*outputDir) == 0 {
		fmt.Printf("No output directory given by --out\n")
		os.Exit(1)
	}

	configBytes, err := os.ReadFile(*configFlag)
	if err != nil {
		fmt.Printf("Failed to open config file: %s\n", err)
		os.Exit(1)
	}

	if err := json.Unmarshal(configBytes, &config); err != nil {
		fmt.Printf("Failed to parse config file: %s\n", err)
		os.Exit(1)
	}

	headerDescriptions, err := generate(*outputDir, &config)
	if err != nil {
		fmt.Printf("Failed to generate output: %s\n", err)
		os.Exit(1)
	}

	if err := generateIndex(*outputDir, &config, headerDescriptions); err != nil {
		fmt.Printf("Failed to generate index: %s\n", err)
		os.Exit(1)
	}

	if err := copyFile(*outputDir, "doc.css"); err != nil {
		fmt.Printf("Failed to copy static file: %s\n", err)
		os.Exit(1)
	}
}
