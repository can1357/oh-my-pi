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

// delocate performs several transformations of textual assembly code. See
// crypto/fipsmodule/FIPS.md for an overview.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"boringssl.googlesource.com/boringssl.git/util/ar"
	"boringssl.googlesource.com/boringssl.git/util/fipstools/fipscommon"
)

// inputFile represents a textual assembly file.
type inputFile struct {
	path string
	// index is a unique identifier given to this file. It's used for
	// mapping local symbols.
	index int
	// isArchive indicates that the input should be processed as an ar
	// file.
	isArchive bool
	// contents contains the contents of the file.
	contents string
	// ast points to the head of the syntax tree.
	ast *node32
}

type stringWriter interface {
	io.Writer
	WriteString(string) (int, error)
}

type processorType int

const (
	x86_64 processorType = iota + 1
	aarch64
)

// delocation holds the state needed during a delocation operation.
type delocation struct {
	processor processorType
	output    stringWriter
	// commentIndicator starts a comment, e.g. "//" or "#"
	commentIndicator string

	// symbols is the set of symbols defined in the module.
	symbols map[string]struct{}
	// redirectors maps from out-call symbol name to the name of a
	// redirector function for that symbol. E.g. “memcpy” ->
	// “bcm_redirector_memcpy”.
	redirectors map[string]string
	// bssAccessorsNeeded maps from a BSS symbol name to the symbol that
	// should be used to reference it. E.g. “P384_data_storage” ->
	// “P384_data_storage”.
	bssAccessorsNeeded map[string]string
	// gotExternalsNeeded is a set of symbol names for which we need
	// “delta” symbols: symbols that contain the offset from their location
	// to the memory in question.
	gotExternalsNeeded map[string]struct{}
	// gotDeltaNeeded is true if the code needs to load the value of
	// _GLOBAL_OFFSET_TABLE_.
	gotDeltaNeeded bool
	// gotOffsetsNeeded contains the symbols whose @GOT offsets are needed.
	gotOffsetsNeeded map[string]struct{}
	// gotOffOffsetsNeeded contains the symbols whose @GOTOFF offsets are needed.
	gotOffOffsetsNeeded map[string]struct{}

	currentInput inputFile
}

func (d *delocation) contents(node *node32) string {
	return d.currentInput.contents[node.begin:node.end]
}

// writeNode writes out an AST node.
func (d *delocation) writeNode(node *node32) {
	if _, err := d.output.WriteString(d.contents(node)); err != nil {
		panic(err)
	}
}

func (d *delocation) writeCommentedNode(node *node32) {
	line := d.contents(node)
	if _, err := d.output.WriteString(d.commentIndicator + " WAS " + strings.TrimSpace(line) + "\n"); err != nil {
		panic(err)
	}
}

func locateError(err error, with *node32, in inputFile) error {
	posMap := translatePositions([]rune(in.contents), []int{int(with.begin)})
	var line int
	for _, pos := range posMap {
		line = pos.line
	}

	return fmt.Errorf("error while processing %q on line %d: %q", in.contents[with.begin:with.end], line, err)
}

func (d *delocation) processInput(input inputFile) (err error) {
	d.currentInput = input

	var origStatement *node32
	defer func() {
		if err := recover(); err != nil {
			panic(locateError(fmt.Errorf("%s", err), origStatement, input))
		}
	}()

	for statement := input.ast.up; statement != nil; statement = statement.next {
		assertNodeType(statement, ruleStatement)
		origStatement = statement

		node := skipWS(statement.up)
		if node == nil {
			d.writeNode(statement)
			continue
		}

		switch node.pegRule {
		case ruleGlobalDirective, ruleComment, ruleLocationDirective:
			d.writeNode(statement)
		case ruleDirective:
			statement, err = d.processDirective(statement, node.up)
		case ruleLabelContainingDirective:
			statement, err = d.processLabelContainingDirective(statement, node.up)
		case ruleSymbolDefiningDirective:
			statement, err = d.processSymbolDefiningDirective(statement, node.up)
		case ruleLabel:
			statement, err = d.processLabel(statement, node.up)
		case ruleInstruction:
			switch d.processor {
			case x86_64:
				statement, err = d.processIntelInstruction(statement, node.up)
			case aarch64:
				statement, err = d.processAarch64Instruction(statement, node.up)
			default:
				panic("unknown processor")
			}
		default:
			panic(fmt.Sprintf("unknown top-level statement type %q", rul3s[node.pegRule]))
		}

		if err != nil {
			return locateError(err, origStatement, input)
		}
	}

	return nil
}

func (d *delocation) processDirective(statement, directive *node32) (*node32, error) {
	assertNodeType(directive, ruleDirectiveName)
	directiveName := d.contents(directive)

	var args []string
	forEachPath(directive, func(arg *node32) {
		// If the argument is a quoted string, use the raw contents.
		// (Note that this doesn't unescape the string, but that's not
		// needed so far.
		if arg.up != nil {
			arg = arg.up
			assertNodeType(arg, ruleQuotedArg)
			if arg.up == nil {
				args = append(args, "")
				return
			}
			arg = arg.up
			assertNodeType(arg, ruleQuotedText)
		}
		args = append(args, d.contents(arg))
	}, ruleArgs, ruleArg)

	switch directiveName {
	case "comm", "lcomm":
		if len(args) < 1 {
			return nil, errors.New("comm directive has no arguments")
		}
		d.bssAccessorsNeeded[args[0]] = args[0]
		d.writeNode(statement)

	case "data":
		// ASAN and some versions of MSAN are adding a .data section,
		// and adding references to symbols within it to the code. We
		// will have to work around this in the future.
		return nil, errors.New(".data section found in module")

	case "bss":
		d.writeNode(statement)
		return d.handleBSS(statement)

	case "section":
		section := args[0]

		if section == ".data.rel.ro" {
			// In a normal build, this is an indication of a
			// problem but any references from the module to this
			// section will result in a relocation and thus will
			// break the integrity check. ASAN can generate these
			// sections and so we will likely have to work around
			// that in the future.
			return nil, errors.New(".data.rel.ro section found in module")
		}

		sectionType, ok := sectionType(section)
		if !ok {
			// Unknown sections are permitted in order to be robust
			// to different compiler modes.
			d.writeNode(statement)
			break
		}

		switch sectionType {
		case ".rodata", ".text":
			// Move .rodata to .text so it may be accessed without
			// a relocation. GCC with -fmerge-constants will place
			// strings into separate sections, so we move all
			// sections named like .rodata. Also move .text.startup
			// so the self-test function is also in the module.
			d.writeCommentedNode(statement)
			d.output.WriteString(".text\n")

		case ".data":
			// See above about .data
			return nil, errors.New(".data section found in module")

		case ".init_array", ".fini_array", ".ctors", ".dtors":
			// init_array/ctors/dtors contains function
			// pointers to constructor/destructor
			// functions. These contain relocations, but
			// they're in a different section anyway.
			d.writeNode(statement)
			break

		case ".debug", ".note":
			d.writeNode(statement)
			break

		case ".bss":
			d.writeNode(statement)
			return d.handleBSS(statement)
		}

	default:
		d.writeNode(statement)
	}

	return statement, nil
}

func (d *delocation) processSymbolExpr(expr *node32, b *strings.Builder) bool {
	changed := false
	assertNodeType(expr, ruleSymbolExpr)

	for expr != nil {
		atom := expr.up
		assertNodeType(atom, ruleSymbolAtom)

		for term := atom.up; term != nil; term = skipWS(term.next) {
			if term.pegRule == ruleSymbolExpr {
				changed = d.processSymbolExpr(term, b) || changed
				continue
			}

			if term.pegRule != ruleLocalSymbol {
				b.WriteString(d.contents(term))
				continue
			}

			oldSymbol := d.contents(term)
			newSymbol := d.mapLocalSymbol(oldSymbol)
			if newSymbol != oldSymbol {
				changed = true
			}

			b.WriteString(newSymbol)
		}

		next := skipWS(atom.next)
		if next == nil {
			break
		}
		assertNodeType(next, ruleSymbolOperator)
		b.WriteString(d.contents(next))
		next = skipWS(next.next)
		assertNodeType(next, ruleSymbolExpr)
		expr = next
	}
	return changed
}

func (d *delocation) processLabelContainingDirective(statement, directive *node32) (*node32, error) {
	// The symbols within directives need to be mapped so that local
	// symbols in two different .s inputs don't collide.
	changed := false
	assertNodeType(directive, ruleLabelContainingDirectiveName)
	name := d.contents(directive)

	node := directive.next
	assertNodeType(node, ruleWS)

	node = node.next
	assertNodeType(node, ruleSymbolArgs)

	var args []string
	for node = skipWS(node.up); node != nil; node = skipWS(node.next) {
		assertNodeType(node, ruleSymbolArg)
		arg := node.up
		assertNodeType(arg, ruleSymbolExpr)

		var b strings.Builder
		changed = d.processSymbolExpr(arg, &b) || changed

		args = append(args, b.String())
	}

	if !changed {
		d.writeNode(statement)
	} else {
		d.writeCommentedNode(statement)
		d.output.WriteString("\t" + name + "\t" + strings.Join(args, ", ") + "\n")
	}

	return statement, nil
}

func (d *delocation) processSymbolDefiningDirective(statement, directive *node32) (*node32, error) {
	changed := false
	assertNodeType(directive, ruleSymbolDefiningDirectiveName)
	name := d.contents(directive)

	node := directive.next
	assertNodeType(node, ruleWS)

	node = node.next
	symbol := d.contents(node)
	isLocal := node.pegRule == ruleLocalSymbol
	if isLocal {
		symbol = d.mapLocalSymbol(symbol)
		changed = true
	} else {
		assertNodeType(node, ruleSymbolName)
	}

	node = skipWS(node.next)
	assertNodeType(node, ruleSymbolArg)
	assertNodeType(node.up, ruleSymbolExpr)
	var b strings.Builder
	changed = d.processSymbolExpr(node.up, &b) || changed
	arg := b.String()

	if !changed {
		d.writeNode(statement)
	} else {
		d.writeCommentedNode(statement)
		fmt.Fprintf(d.output, "\t%s\t%s, %s\n", name, symbol, arg)
	}

	if !isLocal {
		fmt.Fprintf(d.output, "\t%s\t%s, %s\n", name, localTargetName(symbol), arg)
	}

	return statement, nil
}

func (d *delocation) processLabel(statement, label *node32) (*node32, error) {
	symbol := d.contents(label)

	switch label.pegRule {
	case ruleLocalLabel:
		d.output.WriteString(symbol + ":\n")
	case ruleLocalSymbol:
		// symbols need to be mapped so that local symbols from two
		// different .s inputs don't collide.
		d.output.WriteString(d.mapLocalSymbol(symbol) + ":\n")
	case ruleSymbolName:
		d.output.WriteString(localTargetName(symbol) + ":\n")
		d.writeNode(statement)
	default:
		return nil, fmt.Errorf("unknown label type %q", rul3s[label.pegRule])
	}

	return statement, nil
}

// instructionArgs collects all the arguments to an instruction.
func instructionArgs(node *node32) (argNodes []*node32) {
	for node = skipWS(node); node != nil; node = skipWS(node.next) {
		assertNodeType(node, ruleInstructionArg)
		argNodes = append(argNodes, node.up)
	}

	return argNodes
}

// Aarch64 support

// gotHelperName returns the name of a synthesised function that returns an
// address from the GOT.
func gotHelperName(symbol string) string {
	return ".Lboringssl_loadgot_" + symbol
}

// loadAarch64Address emits instructions to put the address of |symbol|
// (optionally adjusted by |offsetStr|) into |targetReg|.
func (d *delocation) loadAarch64Address(statement *node32, targetReg string, symbol string, offsetStr string) (*node32, error) {
	// There are two paths here: either the symbol is known to be local in which
	// case adr is used to get the address (within 1MiB), or a GOT reference is
	// really needed in which case the code needs to jump to a helper function.
	//
	// A helper function is needed because using code appears to be the only way
	// to load a GOT value. On other platforms we have ".quad foo@GOT" outside of
	// the module, but on Aarch64 that results in a "COPY" relocation and linker
	// comments suggest it's a weird hack. So, for each GOT symbol needed, we emit
	// a function outside of the module that returns the address from the GOT in
	// x0.

	d.writeCommentedNode(statement)

	_, isKnown := d.symbols[symbol]
	isLocal := strings.HasPrefix(symbol, ".L")
	if isKnown || isLocal || isSynthesized(symbol) {
		if isLocal {
			symbol = d.mapLocalSymbol(symbol)
		} else if isKnown {
			symbol = localTargetName(symbol)
		}

		d.output.WriteString("\tadr " + targetReg + ", " + symbol + offsetStr + "\n")

		return statement, nil
	}

	if len(offsetStr) != 0 {
		panic("non-zero offset for helper-based reference")
	}

	// GOT helpers also dereference the GOT entry, thus the subsequent ldr
	// instruction, which would normally do the dereferencing, needs to be
	// dropped. GOT helpers have to include the dereference because the
	// assembler doesn't support ":got_lo12:foo" offsets except in an ldr
	// instruction.
	d.gotExternalsNeeded[symbol] = struct{}{}
	helperFunc := gotHelperName(symbol)

	// Clear the red-zone. I can't find a definitive answer about whether Linux
	// Aarch64 includes a red-zone, but Microsoft has a 16-byte one and Apple a
	// 128-byte one. Thus conservatively clear a 128-byte red-zone.
	d.output.WriteString("\tsub sp, sp, 128\n")

	// Save x0 (which will be stomped by the return value) and the link register
	// to the stack. Then save the program counter into the link register and
	// jump to the helper function.
	d.output.WriteString("\tstp x0, lr, [sp, #-16]!\n")
	d.output.WriteString("\tbl " + helperFunc + "\n")

	if targetReg == "x0" {
		// If the target happens to be x0 then restore the link register from the
		// stack and send the saved value of x0 to the zero register.
		d.output.WriteString("\tldp xzr, lr, [sp], #16\n")
	} else {
		// Otherwise move the result into place and restore registers.
		d.output.WriteString("\tmov " + targetReg + ", x0\n")
		d.output.WriteString("\tldp x0, lr, [sp], #16\n")
	}

	// Revert the red-zone adjustment.
	d.output.WriteString("\tadd sp, sp, 128\n")

	return statement, nil
}

func (d *delocation) processAarch64Instruction(statement, instruction *node32) (*node32, error) {
	assertNodeType(instruction, ruleInstructionName)
	instructionName := d.contents(instruction)

	argNodes := instructionArgs(instruction.next)

	switch instructionName {
	case "ccmn", "ccmp", "cinc", "cinv", "cneg", "csel", "cset", "csetm", "csinc", "csinv", "csneg":
		// These functions are special because they take a condition-code name as
		// an argument and that looks like a symbol reference.
		d.writeNode(statement)
		return statement, nil

	case "mrs":
		// Functions that take special register names also look like a symbol
		// reference to the parser.
		d.writeNode(statement)
		return statement, nil

	case "adrp":
		// adrp always generates a relocation, even when the target symbol is in the
		// same segment, because the page-offset of the code isn't known until link
		// time. Thus adrp instructions are turned into either adr instructions
		// (limiting the module to 1MiB offsets) or calls to helper functions, both of
		// which load the full address. Later instructions, which add the low 12 bits
		// of offset, are tweaked to remove the offset since it's already included.
		// Loads of GOT symbols are slightly more complex because it's not possible to
		// avoid dereferencing a GOT entry with Clang's assembler. Thus the later ldr
		// instruction, which would normally do the dereferencing, is dropped
		// completely. (Or turned into a mov if it targets a different register.)
		assertNodeType(argNodes[0], ruleRegisterOrConstant)
		targetReg := d.contents(argNodes[0])
		if !strings.HasPrefix(targetReg, "x") {
			panic("adrp targeting register " + targetReg + ", which has the wrong size")
		}

		var symbol, offset string
		switch argNodes[1].pegRule {
		case ruleGOTSymbolOffset:
			symbol = d.contents(argNodes[1].up)
		case ruleMemoryRef:
			assertNodeType(argNodes[1].up, ruleSymbolRef)
			node, empty := d.gatherOffsets(argNodes[1].up.up, "")
			if len(empty) != 0 {
				panic("prefix offsets found for adrp")
			}
			symbol = d.contents(node)
			_, offset = d.gatherOffsets(node.next, "")
		default:
			panic("Unhandled adrp argument type " + rul3s[argNodes[1].pegRule])
		}

		return d.loadAarch64Address(statement, targetReg, symbol, offset)
	}

	var args []string
	changed := false

	for _, arg := range argNodes {
		fullArg := arg

		switch arg.pegRule {
		case ruleRegisterOrConstant, ruleLocalLabelRef, ruleARMConstantTweak:
			args = append(args, d.contents(fullArg))

		case ruleGOTSymbolOffset:
			// These should only be arguments to adrp and thus unreachable.
			panic("unreachable")

		case ruleMemoryRef:
			ref := arg.up

			switch ref.pegRule {
			case ruleSymbolRef:
				// This is a branch. Either the target needs to be written to a local
				// version of the symbol to ensure that no relocations are emitted, or
				// it needs to jump to a redirector function.
				symbol, offset, _, didChange, symbolIsLocal, _ := d.parseMemRef(arg.up)
				changed = didChange

				if _, knownSymbol := d.symbols[symbol]; knownSymbol {
					symbol = localTargetName(symbol)
					changed = true
				} else if !symbolIsLocal && !isSynthesized(symbol) {
					redirector := redirectorName(symbol)
					d.redirectors[symbol] = redirector
					symbol = redirector
					changed = true
				} else if didChange && symbolIsLocal && len(offset) > 0 {
					// didChange is set when the inputFile index is not 0; which is the index of the
					// first file copied to the output, which is the generated assembly of bcm.c.
					// In subsequently copied assembly files, local symbols are changed by appending (BCM_ + index)
					// in order to ensure they don't collide. `index` gets incremented per file.
					// If there is offset after the symbol, append the `offset`.
					symbol = symbol + offset
				}

				args = append(args, symbol)

			case ruleARMBaseIndexScale:
				parts := ref.up
				assertNodeType(parts, ruleARMRegister)
				baseAddrReg := d.contents(parts)
				parts = skipWS(parts.next)

				// Only two forms need special handling. First there's memory references
				// like "[x*, :got_lo12:foo]". The base register here will have been the
				// target of an adrp instruction to load the page address, but the adrp
				// will have turned into loading the full address *and dereferencing it*,
				// above. Thus this instruction needs to be dropped otherwise we'll be
				// dereferencing twice.
				//
				// Second there are forms like "[x*, :lo12:foo]" where the code has used
				// adrp to load the page address into x*. That adrp will have been turned
				// into loading the full address so just the offset needs to be dropped.

				if parts != nil {
					if parts.pegRule == ruleARMGOTLow12 {
						if instructionName != "ldr" {
							panic("Symbol reference outside of ldr instruction")
						}

						if skipWS(parts.next) != nil || parts.up.next != nil {
							panic("can't handle tweak or post-increment with symbol references")
						}

						// The GOT helper already dereferenced the entry so, at most, just a mov
						// is needed to put things in the right register.
						d.writeCommentedNode(statement)
						if baseAddrReg != args[0] {
							d.output.WriteString("\tmov " + args[0] + ", " + baseAddrReg + "\n")
						}
						return statement, nil
					} else if parts.pegRule == ruleLow12BitsSymbolRef {
						switch instructionName {
						case "ldr", "ldrh", "ldrb", "ldrsw", "ldrsh", "ldrsb":
						default:
							panic("Symbol reference outside of load instruction")
						}

						// Suppress the offset; adrp loaded the full address. This assumes the
						// the compiler does not emit code like the following:
						//
						//   adrp x0, symbol
						//   ldr x1, [x0, :lo12:symbol]
						//   ldr x2, [x0, :lo12:symbol+4]
						//
						// Such code would only work if lo12(symbol+4) = lo12(symbol) + 4, but
						// this is true when symbol is sufficiently aligned.
						args = append(args, "["+baseAddrReg+"]")
						changed = true
						continue
					}
				}

				args = append(args, d.contents(fullArg))

			case ruleLow12BitsSymbolRef:
				// These are the second instruction in a pair:
				//   adrp x0, symbol           // Load the page address into x0
				//   add x1, x0, :lo12:symbol  // Adds the page offset.
				//
				// The adrp instruction will have been turned into a sequence that loads
				// the full address, above, thus the offset is turned into zero. If that
				// results in the instruction being a nop, then it is deleted.
				//
				// This assumes the compiler does not emit code like the following:
				//
				//   adrp x0, symbol
				//   add x1, x0, :lo12:symbol
				//   add x2, x0, :lo12:symbol+4
				//
				// Such code would only work if lo12(symbol+4) = lo12(symbol) + 4, but
				// this is true when symbol is sufficiently aligned.
				if instructionName != "add" {
					panic(fmt.Sprintf("unsure how to handle %q instruction using lo12", instructionName))
				}

				if !strings.HasPrefix(args[0], "x") || !strings.HasPrefix(args[1], "x") {
					panic("address arithmetic with incorrectly sized register")
				}

				if args[0] == args[1] {
					d.writeCommentedNode(statement)
					return statement, nil
				}

				args = append(args, "#0")
				changed = true

			default:
				panic(fmt.Sprintf("unhandled MemoryRef type %s", rul3s[ref.pegRule]))
			}

		default:
			panic(fmt.Sprintf("unknown instruction argument type %q", rul3s[arg.pegRule]))
		}
	}

	if changed {
		d.writeCommentedNode(statement)
		replacement := "\t" + instructionName + "\t" + strings.Join(args, ", ") + "\n"
		d.output.WriteString(replacement)
	} else {
		d.writeNode(statement)
	}

	return statement, nil
}

func (d *delocation) gatherOffsets(symRef *node32, offsets string) (*node32, string) {
	for symRef != nil && symRef.pegRule == ruleOffset {
		offset := d.contents(symRef)
		if offset[0] != '+' && offset[0] != '-' {
			offset = "+" + offset
		}
		offsets = offsets + offset
		symRef = symRef.next
	}
	return symRef, offsets
}

func (d *delocation) parseMemRef(memRef *node32) (symbol, offset, section string, didChange, symbolIsLocal bool, nextRef *node32) {
	if memRef.pegRule != ruleSymbolRef {
		return "", "", "", false, false, memRef
	}

	symRef := memRef.up
	nextRef = memRef.next

	// (Offset* '+')?
	symRef, offset = d.gatherOffsets(symRef, offset)

	// (LocalSymbol / SymbolName)
	symbol = d.contents(symRef)
	if symRef.pegRule == ruleLocalSymbol {
		symbolIsLocal = true
		mapped := d.mapLocalSymbol(symbol)
		if mapped != symbol {
			symbol = mapped
			didChange = true
		}
	}
	symRef = symRef.next

	// Offset*
	symRef, offset = d.gatherOffsets(symRef, offset)

	// ('@' Section / Offset*)?
	if symRef != nil {
		assertNodeType(symRef, ruleSection)
		section = d.contents(symRef)
		symRef = symRef.next

		symRef, offset = d.gatherOffsets(symRef, offset)
	}

	if symRef != nil {
		panic(fmt.Sprintf("unexpected token in SymbolRef: %q", rul3s[symRef.pegRule]))
	}

	return
}

/* Intel */

type instructionType int

const (
	instrPush instructionType = iota
	instrMove
	// instrTransformingMove is essentially a move, but it performs some
	// transformation of the data during the process.
	instrTransformingMove
	instrJump
	instrConditionalMove
	// instrCombine merges the source and destination in some fashion, for example
	// a 2-operand bitwise operation.
	instrCombine
	// instrMemoryVectorCombine is similar to instrCombine, but the source
	// register must be a memory reference and the destination register
	// must be a vector register.
	instrMemoryVectorCombine
	// instrThreeArg merges two sources into a destination in some fashion.
	instrThreeArg
	// instrCompare takes two arguments and writes outputs to the flags register.
	instrCompare
	instrOther
)

func classifyInstruction(instr string, args []*node32) instructionType {
	switch instr {
	case "push", "pushq":
		if len(args) == 1 {
			return instrPush
		}

	case "mov", "movq", "vmovq", "movsd", "vmovsd":
		if len(args) == 2 {
			return instrMove
		}

	case "cmovneq", "cmoveq":
		if len(args) == 2 {
			return instrConditionalMove
		}

	case "call", "callq", "jmp", "jo", "jno", "js", "jns", "je", "jz", "jne", "jnz", "jb", "jnae", "jc", "jnb", "jae", "jnc", "jbe", "jna", "ja", "jnbe", "jl", "jnge", "jge", "jnl", "jle", "jng", "jg", "jnle", "jp", "jpe", "jnp", "jpo":
		if len(args) == 1 {
			return instrJump
		}

	case "orq", "andq", "xorq":
		if len(args) == 2 {
			return instrCombine
		}

	case "cmpq":
		if len(args) == 2 {
			return instrCompare
		}

	case "sarxq", "shlxq", "shrxq":
		if len(args) == 3 {
			return instrThreeArg
		}

	case "vpbroadcastq":
		if len(args) == 2 {
			return instrTransformingMove
		}

	case "movlps", "movhps":
		if len(args) == 2 {
			return instrMemoryVectorCombine
		}
	}

	return instrOther
}

func push(w stringWriter) wrapperFunc {
	return func(k func()) {
		w.WriteString("\tpushq %rax\n")
		k()
		w.WriteString("\txchg %rax, (%rsp)\n")
	}
}

func compare(w stringWriter, instr, a, b string) wrapperFunc {
	return func(k func()) {
		k()
		w.WriteString(fmt.Sprintf("\t%s %s, %s\n", instr, a, b))
	}
}

func (d *delocation) loadFromGOT(w stringWriter, destination, symbol, section string, redzoneCleared bool) wrapperFunc {
	d.gotExternalsNeeded[symbol+"@"+section] = struct{}{}

	return func(k func()) {
		if !redzoneCleared {
			w.WriteString("\tleaq -128(%rsp), %rsp\n") // Clear the red zone.
		}
		w.WriteString("\tpushf\n")
		w.WriteString(fmt.Sprintf("\tleaq %s_%s_external(%%rip), %s\n", symbol, section, destination))
		w.WriteString(fmt.Sprintf("\taddq (%s), %s\n", destination, destination))
		w.WriteString(fmt.Sprintf("\tmovq (%s), %s\n", destination, destination))
		w.WriteString("\tpopf\n")
		if !redzoneCleared {
			w.WriteString("\tleaq\t128(%rsp), %rsp\n")
		}
	}
}

func saveFlags(w stringWriter, redzoneCleared bool) wrapperFunc {
	return func(k func()) {
		if !redzoneCleared {
			w.WriteString("\tleaq -128(%rsp), %rsp\n") // Clear the red zone.
			defer w.WriteString("\tleaq 128(%rsp), %rsp\n")
		}
		w.WriteString("\tpushfq\n")
		k()
		w.WriteString("\tpopfq\n")
	}
}

func saveRegister(w stringWriter, avoidRegs []string) (wrapperFunc, string) {
	candidates := []string{"%rax", "%rbx", "%rcx", "%rdx"}

	var reg string
NextCandidate:
	for _, candidate := range candidates {
		for _, avoid := range avoidRegs {
			if candidate == avoid {
				continue NextCandidate
			}
		}

		reg = candidate
		break
	}

	if len(reg) == 0 {
		panic("too many excluded registers")
	}

	return func(k func()) {
		w.WriteString("\tleaq -128(%rsp), %rsp\n") // Clear the red zone.
		w.WriteString("\tpushq " + reg + "\n")
		k()
		w.WriteString("\tpopq " + reg + "\n")
		w.WriteString("\tleaq 128(%rsp), %rsp\n")
	}, reg
}

func moveTo(w stringWriter, target string, isAVX bool, source string) wrapperFunc {
	return func(k func()) {
		k()
		prefix := ""
		if isAVX {
			prefix = "v"
		}
		w.WriteString("\t" + prefix + "movq " + source + ", " + target + "\n")
	}
}

func finalTransform(w stringWriter, transformInstruction, reg string) wrapperFunc {
	return func(k func()) {
		k()
		w.WriteString("\t" + transformInstruction + " " + reg + ", " + reg + "\n")
	}
}

func combineOp(w stringWriter, instructionName, source, dest string) wrapperFunc {
	return func(k func()) {
		k()
		w.WriteString("\t" + instructionName + " " + source + ", " + dest + "\n")
	}
}

func threeArgCombineOp(w stringWriter, instructionName, source1, source2, dest string) wrapperFunc {
	return func(k func()) {
		k()
		w.WriteString("\t" + instructionName + " " + source1 + ", " + source2 + ", " + dest + "\n")
	}
}

func memoryVectorCombineOp(w stringWriter, instructionName, source, dest string) wrapperFunc {
	return func(k func()) {
		k()
		// These instructions can only read from memory, so push
		// tempReg and read from the stack. Note we assume the red zone
		// was previously cleared by saveRegister().
		w.WriteString("\tpushq " + source + "\n")
		w.WriteString("\t" + instructionName + " (%rsp), " + dest + "\n")
		w.WriteString("\tleaq 8(%rsp), %rsp\n")
	}
}

func isValidLEATarget(reg string) bool {
	return !strings.HasPrefix(reg, "%xmm") && !strings.HasPrefix(reg, "%ymm") && !strings.HasPrefix(reg, "%zmm")
}

func undoConditionalMove(w stringWriter, instr string) wrapperFunc {
	var invertedCondition string

	switch instr {
	case "cmoveq":
		invertedCondition = "ne"
	case "cmovneq":
		invertedCondition = "e"
	default:
		panic(fmt.Sprintf("don't know how to handle conditional move instruction %q", instr))
	}

	return func(k func()) {
		w.WriteString("\tj" + invertedCondition + " 999f\n")
		k()
		w.WriteString("999:\n")
	}
}

func (d *delocation) isRIPRelative(node *node32) bool {
	return node != nil && node.pegRule == ruleBaseIndexScale && d.contents(node) == "(%rip)"
}

func (d *delocation) processIntelInstruction(statement, instruction *node32) (*node32, error) {
	var prefix string
	if instruction.pegRule == ruleInstructionPrefix {
		prefix = d.contents(instruction)
		instruction = skipWS(instruction.next)
	}

	assertNodeType(instruction, ruleInstructionName)
	instructionName := d.contents(instruction)

	argNodes := instructionArgs(instruction.next)

	var wrappers wrapperStack
	var args []string
	changed := false

Args:
	for i, arg := range argNodes {
		fullArg := arg
		isIndirect := false

		if arg.pegRule == ruleIndirectionIndicator {
			arg = arg.next
			isIndirect = true
		}

		switch arg.pegRule {
		case ruleRegisterOrConstant, ruleLocalLabelRef:
			args = append(args, d.contents(fullArg))

		case ruleMemoryRef:
			symbol, offset, section, didChange, symbolIsLocal, memRef := d.parseMemRef(arg.up)
			changed = didChange

			switch section {
			case "":
				if _, knownSymbol := d.symbols[symbol]; knownSymbol {
					symbol = localTargetName(symbol)
					changed = true
				}

			case "PLT":
				if classifyInstruction(instructionName, argNodes) != instrJump {
					return nil, fmt.Errorf("Cannot rewrite PLT reference for non-jump instruction %q", instructionName)
				}

				if _, knownSymbol := d.symbols[symbol]; knownSymbol {
					symbol = localTargetName(symbol)
					changed = true
				} else if !symbolIsLocal && !isSynthesized(symbol) {
					// Unknown symbol via PLT is an
					// out-call from the module, e.g.
					// memcpy.
					d.redirectors[symbol+"@"+section] = redirectorName(symbol)
					symbol = redirectorName(symbol)
				}

				changed = true

			case "GOTPCREL":
				if len(offset) > 0 {
					return nil, errors.New("loading from GOT with offset is unsupported")
				}
				if !d.isRIPRelative(memRef) {
					return nil, errors.New("GOT access must be IP-relative")
				}

				useGOT := false
				if _, knownSymbol := d.symbols[symbol]; knownSymbol {
					symbol = localTargetName(symbol)
					changed = true
				} else if !isSynthesized(symbol) {
					useGOT = true
				}

				classification := classifyInstruction(instructionName, argNodes)
				if classification != instrThreeArg && classification != instrCompare && i != 0 {
					return nil, errors.New("GOT access must be source operand")
				}

				// Reduce the instruction to movq symbol@GOTPCREL, targetReg.
				var targetReg string
				var redzoneCleared bool
				switch classification {
				case instrPush:
					wrappers = append(wrappers, push(d.output))
					targetReg = "%rax"
				case instrConditionalMove:
					wrappers = append(wrappers, undoConditionalMove(d.output, instructionName))
					fallthrough
				case instrMove:
					assertNodeType(argNodes[1], ruleRegisterOrConstant)
					targetReg = d.contents(argNodes[1])
				case instrCompare:
					otherSource := d.contents(argNodes[i^1])
					saveRegWrapper, tempReg := saveRegister(d.output, []string{otherSource})
					redzoneCleared = true
					wrappers = append(wrappers, saveRegWrapper)
					if i == 0 {
						wrappers = append(wrappers, compare(d.output, instructionName, tempReg, otherSource))
					} else {
						wrappers = append(wrappers, compare(d.output, instructionName, otherSource, tempReg))
					}
					targetReg = tempReg
				case instrTransformingMove:
					assertNodeType(argNodes[1], ruleRegisterOrConstant)
					targetReg = d.contents(argNodes[1])
					wrappers = append(wrappers, finalTransform(d.output, instructionName, targetReg))
					if isValidLEATarget(targetReg) {
						return nil, errors.New("Currently transforming moves are assumed to target XMM registers. Otherwise we'll pop %rax before reading it to do the transform.")
					}
				case instrCombine:
					targetReg = d.contents(argNodes[1])
					if !isValidLEATarget(targetReg) {
						return nil, fmt.Errorf("cannot handle combining instructions targeting non-general registers")
					}
					saveRegWrapper, tempReg := saveRegister(d.output, []string{targetReg})
					redzoneCleared = true
					wrappers = append(wrappers, saveRegWrapper)

					wrappers = append(wrappers, combineOp(d.output, instructionName, tempReg, targetReg))
					targetReg = tempReg
				case instrMemoryVectorCombine:
					assertNodeType(argNodes[1], ruleRegisterOrConstant)
					targetReg = d.contents(argNodes[1])
					if isValidLEATarget(targetReg) {
						return nil, errors.New("target register must be an XMM register")
					}
					saveRegWrapper, tempReg := saveRegister(d.output, nil)
					wrappers = append(wrappers, saveRegWrapper)
					redzoneCleared = true
					wrappers = append(wrappers, memoryVectorCombineOp(d.output, instructionName, tempReg, targetReg))
					targetReg = tempReg
				case instrThreeArg:
					if n := len(argNodes); n != 3 {
						return nil, fmt.Errorf("three-argument instruction has %d arguments", n)
					}
					if i != 0 && i != 1 {
						return nil, errors.New("GOT access must be from source operand")
					}
					targetReg = d.contents(argNodes[2])

					otherSource := d.contents(argNodes[1])
					if i == 1 {
						otherSource = d.contents(argNodes[0])
					}

					saveRegWrapper, tempReg := saveRegister(d.output, []string{targetReg, otherSource})
					redzoneCleared = true
					wrappers = append(wrappers, saveRegWrapper)

					if i == 0 {
						wrappers = append(wrappers, threeArgCombineOp(d.output, instructionName, tempReg, otherSource, targetReg))
					} else {
						wrappers = append(wrappers, threeArgCombineOp(d.output, instructionName, otherSource, tempReg, targetReg))
					}
					targetReg = tempReg
				default:
					return nil, fmt.Errorf("Cannot rewrite GOTPCREL reference for instruction %q", instructionName)
				}

				if !isValidLEATarget(targetReg) {
					// Sometimes the compiler will load from the GOT to an
					// XMM register, which is not a valid target of an LEA
					// instruction.
					saveRegWrapper, tempReg := saveRegister(d.output, nil)
					wrappers = append(wrappers, saveRegWrapper)
					isAVX := strings.HasPrefix(instructionName, "v")
					wrappers = append(wrappers, moveTo(d.output, targetReg, isAVX, tempReg))
					targetReg = tempReg
					if redzoneCleared {
						return nil, fmt.Errorf("internal error: Red Zone was already cleared")
					}
					redzoneCleared = true
				}

				if useGOT {
					wrappers = append(wrappers, d.loadFromGOT(d.output, targetReg, symbol, section, redzoneCleared))
				} else {
					wrappers = append(wrappers, func(k func()) {
						d.output.WriteString(fmt.Sprintf("\tleaq\t%s(%%rip), %s\n", symbol, targetReg))
					})
				}
				changed = true
				break Args

			default:
				return nil, fmt.Errorf("Unknown section type %q", section)
			}

			if !changed && len(section) > 0 {
				panic("section was not handled")
			}
			section = ""

			argStr := ""
			if isIndirect {
				argStr += "*"
			}
			argStr += symbol
			argStr += offset

			for ; memRef != nil; memRef = memRef.next {
				argStr += d.contents(memRef)
			}

			for suffix := arg.next; suffix != nil; suffix = suffix.next {
				argStr += d.contents(suffix)
			}

			args = append(args, argStr)

		case ruleGOTAddress:
			if instructionName != "leaq" {
				return nil, fmt.Errorf("_GLOBAL_OFFSET_TABLE_ used outside of lea")
			}
			if i != 0 || len(argNodes) != 2 {
				return nil, fmt.Errorf("Load of _GLOBAL_OFFSET_TABLE_ address didn't have expected form")
			}
			if arg.next != nil {
				return nil, fmt.Errorf("unexpected argument suffix")
			}
			d.gotDeltaNeeded = true
			changed = true
			targetReg := d.contents(argNodes[1])
			args = append(args, ".Lboringssl_got_delta(%rip)")
			wrappers = append(wrappers, func(k func()) {
				k()
				d.output.WriteString(fmt.Sprintf("\taddq .Lboringssl_got_delta(%%rip), %s\n", targetReg))
			})

		case ruleGOTLocation:
			if instructionName != "movabsq" {
				return nil, fmt.Errorf("_GLOBAL_OFFSET_TABLE_ lookup didn't use movabsq")
			}
			if i != 0 || len(argNodes) != 2 {
				return nil, fmt.Errorf("movabs of _GLOBAL_OFFSET_TABLE_ didn't expected form")
			}
			if arg.next != nil {
				return nil, fmt.Errorf("unexpected argument suffix")
			}

			d.gotDeltaNeeded = true
			changed = true
			instructionName = "movq"
			assertNodeType(arg.up, ruleLocalSymbol)
			baseSymbol := d.mapLocalSymbol(d.contents(arg.up))
			targetReg := d.contents(argNodes[1])
			args = append(args, ".Lboringssl_got_delta(%rip)")
			wrappers = append(wrappers, func(k func()) {
				k()
				d.output.WriteString(fmt.Sprintf("\taddq $.Lboringssl_got_delta-%s, %s\n", baseSymbol, targetReg))
			})

		case ruleGOTSymbolOffset:
			if instructionName != "movabsq" {
				return nil, fmt.Errorf("_GLOBAL_OFFSET_TABLE_ offset didn't use movabsq")
			}
			if i != 0 || len(argNodes) != 2 {
				return nil, fmt.Errorf("movabs of _GLOBAL_OFFSET_TABLE_ offset didn't have expected form")
			}
			if arg.next != nil {
				return nil, fmt.Errorf("unexpected argument suffix")
			}

			assertNodeType(arg.up, ruleSymbolName)
			symbol := d.contents(arg.up)
			if strings.HasPrefix(symbol, ".L") {
				symbol = d.mapLocalSymbol(symbol)
			}
			targetReg := d.contents(argNodes[1])

			var prefix string
			isGOTOFF := strings.HasSuffix(d.contents(arg), "@GOTOFF")
			if isGOTOFF {
				prefix = "gotoff"
				d.gotOffOffsetsNeeded[symbol] = struct{}{}
			} else {
				prefix = "got"
				d.gotOffsetsNeeded[symbol] = struct{}{}
			}
			changed = true

			wrappers = append(wrappers, func(k func()) {
				// Even if one tries to use 32-bit GOT offsets, Clang's linker (at the time
				// of writing) emits 64-bit relocations anyway, so the following four bytes
				// get stomped. Thus we use 64-bit offsets.
				d.output.WriteString(fmt.Sprintf("\tmovq .Lboringssl_%s_%s(%%rip), %s\n", prefix, symbol, targetReg))
			})

		default:
			panic(fmt.Sprintf("unknown instruction argument type %q", rul3s[arg.pegRule]))
		}
	}

	if changed {
		d.writeCommentedNode(statement)
		replacement := "\t" + instructionName + "\t" + strings.Join(args, ", ") + "\n"
		if len(prefix) != 0 {
			replacement = "\t" + prefix + replacement
		}
		wrappers.do(func() {
			d.output.WriteString(replacement)
		})
	} else {
		d.writeNode(statement)
	}

	return statement, nil
}

func (d *delocation) handleBSS(statement *node32) (*node32, error) {
	lastStatement := statement
	for statement = statement.next; statement != nil; lastStatement, statement = statement, statement.next {
		node := skipWS(statement.up)
		if node == nil {
			d.writeNode(statement)
			continue
		}

		switch node.pegRule {
		case ruleGlobalDirective, ruleComment, ruleInstruction, ruleLocationDirective:
			d.writeNode(statement)

		case ruleDirective:
			directive := node.up
			assertNodeType(directive, ruleDirectiveName)
			directiveName := d.contents(directive)
			if directiveName == "text" || directiveName == "section" || directiveName == "data" {
				return lastStatement, nil
			}
			d.writeNode(statement)

		case ruleLabel:
			label := node.up
			d.writeNode(statement)

			if label.pegRule != ruleLocalSymbol {
				symbol := d.contents(label)
				localSymbol := localTargetName(symbol)
				d.output.WriteString(fmt.Sprintf("\n%s:\n", localSymbol))

				d.bssAccessorsNeeded[symbol] = localSymbol
			}

		case ruleLabelContainingDirective:
			var err error
			statement, err = d.processLabelContainingDirective(statement, node.up)
			if err != nil {
				return nil, err
			}

		case ruleSymbolDefiningDirective:
			var err error
			statement, err = d.processSymbolDefiningDirective(statement, node.up)
			if err != nil {
				return nil, err
			}

		default:
			return nil, fmt.Errorf("unknown BSS statement type %q in %q", rul3s[node.pegRule], d.contents(statement))
		}
	}

	return lastStatement, nil
}

func writeAarch64Function(w stringWriter, funcName string, writeContents func(stringWriter)) {
	w.WriteString(".p2align 2\n")
	w.WriteString(".hidden " + funcName + "\n")
	w.WriteString(".type " + funcName + ", @function\n")
	w.WriteString(funcName + ":\n")
	w.WriteString(".cfi_startproc\n")
	// We insert a landing pad (`bti c` instruction) unconditionally at the beginning of
	// every generated function so that they can be called indirectly (with `blr` or
	// `br x16/x17`). The instruction is encoded in the HINT space as `hint #34` and is
	// a no-op on machines or program states not supporting BTI (Branch Target Identification).
	// None of the generated function bodies call other functions (with bl or blr), so we only
	// insert a landing pad instead of signing and validating $lr with `paciasp` and `autiasp`.
	// Normally we would also generate a .note.gnu.property section to annotate the assembly
	// file as BTI-compatible, but if the input assembly files are BTI-compatible, they should
	// already have those sections so there is no need to add an extra one ourselves.
	w.WriteString("\thint #34 // bti c\n")
	writeContents(w)
	w.WriteString(".cfi_endproc\n")
	w.WriteString(".size " + funcName + ", .-" + funcName + "\n")
}

func transform(w stringWriter, inputs []inputFile) error {
	// symbols contains all defined symbols.
	symbols := make(map[string]struct{})
	// fileNumbers is the set of IDs seen in .file directives.
	fileNumbers := make(map[int]struct{})
	// maxObservedFileNumber contains the largest seen file number in a
	// .file directive. Zero is not a valid number.
	maxObservedFileNumber := 0
	// fileDirectivesContainMD5 is true if the compiler is outputting MD5
	// checksums in .file directives. If it does so, then this script needs
	// to match that behaviour otherwise warnings result.
	fileDirectivesContainMD5 := false

	for _, input := range inputs {
		forEachPath(input.ast.up, func(node *node32) {
			symbol := input.contents[node.begin:node.end]
			if _, ok := symbols[symbol]; ok {
				panic(fmt.Sprintf("Duplicate symbol found: %q in %q", symbol, input.path))
			}
			symbols[symbol] = struct{}{}
		}, ruleStatement, ruleLabel, ruleSymbolName)

		// Some directives also define symbols.
		forEachPath(input.ast.up, func(node *node32) {
			node = skipWS(node.next)
			if node.pegRule == ruleLocalSymbol {
				return
			}
			assertNodeType(node, ruleSymbolName)
			symbol := input.contents[node.begin:node.end]
			// Allow duplicates. A symbol may be set multiple times with .set.
			symbols[symbol] = struct{}{}
		}, ruleStatement, ruleSymbolDefiningDirective, ruleSymbolDefiningDirectiveName)

		forEachPath(input.ast.up, func(node *node32) {
			assertNodeType(node, ruleLocationDirective)
			directive := input.contents[node.begin:node.end]
			if !strings.HasPrefix(directive, ".file") {
				return
			}
			parts := strings.Fields(directive)
			if len(parts) == 2 {
				// This is a .file directive with just a
				// filename. Clang appears to generate just one
				// of these at the beginning of the output for
				// the compilation unit. Ignore it.
				return
			}
			fileNo, err := strconv.Atoi(parts[1])
			if err != nil {
				panic(fmt.Sprintf("Failed to parse file number from .file: %q", directive))
			}

			if _, ok := fileNumbers[fileNo]; ok {
				panic(fmt.Sprintf("Duplicate file number %d observed", fileNo))
			}
			fileNumbers[fileNo] = struct{}{}

			if fileNo > maxObservedFileNumber {
				maxObservedFileNumber = fileNo
			}

			for _, token := range parts[2:] {
				if token == "md5" {
					fileDirectivesContainMD5 = true
				}
			}
		}, ruleStatement, ruleLocationDirective)
	}

	processor := x86_64
	if len(inputs) > 0 {
		processor = detectProcessor(inputs[0])
	}

	commentIndicator := "#"
	if processor == aarch64 {
		commentIndicator = "//"
	}

	d := &delocation{
		symbols:             symbols,
		processor:           processor,
		commentIndicator:    commentIndicator,
		output:              w,
		redirectors:         make(map[string]string),
		bssAccessorsNeeded:  make(map[string]string),
		gotExternalsNeeded:  make(map[string]struct{}),
		gotOffsetsNeeded:    make(map[string]struct{}),
		gotOffOffsetsNeeded: make(map[string]struct{}),
	}

	w.WriteString(".text\n")
	var fileTrailing string
	if fileDirectivesContainMD5 {
		fileTrailing = " md5 0x00000000000000000000000000000000"
	}
	w.WriteString(fmt.Sprintf(".file %d \"inserted_by_delocate.c\"%s\n", maxObservedFileNumber+1, fileTrailing))
	w.WriteString(fmt.Sprintf(".loc %d 1 0\n", maxObservedFileNumber+1))
	w.WriteString("BORINGSSL_bcm_text_start:\n")

	for _, input := range inputs {
		if err := d.processInput(input); err != nil {
			return err
		}
	}

	w.WriteString(".text\n")
	w.WriteString(fmt.Sprintf(".loc %d 2 0\n", maxObservedFileNumber+1))
	w.WriteString("BORINGSSL_bcm_text_end:\n")

	// Emit redirector functions. Each is a single jump instruction.
	var redirectorNames []string
	for name := range d.redirectors {
		redirectorNames = append(redirectorNames, name)
	}
	sort.Strings(redirectorNames)

	for _, name := range redirectorNames {
		redirector := d.redirectors[name]
		switch d.processor {
		case aarch64:
			writeAarch64Function(w, redirector, func(w stringWriter) {
				w.WriteString("\tb " + name + "\n")
			})

		case x86_64:
			w.WriteString(".type " + redirector + ", @function\n")
			w.WriteString(redirector + ":\n")
			w.WriteString("\tjmp\t" + name + "\n")
		}
	}

	var accessorNames []string
	for accessor := range d.bssAccessorsNeeded {
		accessorNames = append(accessorNames, accessor)
	}
	sort.Strings(accessorNames)

	// Emit BSS accessor functions. Each is a single LEA followed by RET.
	for _, name := range accessorNames {
		funcName := accessorName(name)
		target := d.bssAccessorsNeeded[name]

		switch d.processor {
		case x86_64:
			w.WriteString(".type " + funcName + ", @function\n")
			w.WriteString(funcName + ":\n")
			w.WriteString("\tleaq\t" + target + "(%rip), %rax\n\tret\n")

		case aarch64:
			writeAarch64Function(w, funcName, func(w stringWriter) {
				w.WriteString("\tadrp x0, " + target + "\n")
				w.WriteString("\tadd x0, x0, :lo12:" + target + "\n")
				w.WriteString("\tret\n")
			})
		}
	}

	switch d.processor {
	case aarch64:
		externalNames := sortedSet(d.gotExternalsNeeded)
		for _, symbol := range externalNames {
			writeAarch64Function(w, gotHelperName(symbol), func(w stringWriter) {
				w.WriteString("\tadrp x0, :got:" + symbol + "\n")
				w.WriteString("\tldr x0, [x0, :got_lo12:" + symbol + "]\n")
				w.WriteString("\tret\n")
			})
		}

	case x86_64:
		externalNames := sortedSet(d.gotExternalsNeeded)
		for _, name := range externalNames {
			parts := strings.SplitN(name, "@", 2)
			symbol, section := parts[0], parts[1]
			w.WriteString(".type " + symbol + "_" + section + "_external, @object\n")
			w.WriteString(".size " + symbol + "_" + section + "_external, 8\n")
			w.WriteString(symbol + "_" + section + "_external:\n")
			// Ideally this would be .quad foo@GOTPCREL, but clang's
			// assembler cannot emit a 64-bit GOTPCREL relocation. Instead,
			// we manually sign-extend the value, knowing that the GOT is
			// always at the end, thus foo@GOTPCREL has a positive value.
			w.WriteString("\t.long " + symbol + "@" + section + "\n")
			w.WriteString("\t.long 0\n")
		}

		if d.gotDeltaNeeded {
			w.WriteString(".Lboringssl_got_delta:\n")
			w.WriteString("\t.quad _GLOBAL_OFFSET_TABLE_-.Lboringssl_got_delta\n")
		}

		for _, name := range sortedSet(d.gotOffsetsNeeded) {
			w.WriteString(".Lboringssl_got_" + name + ":\n")
			w.WriteString("\t.quad " + name + "@GOT\n")
		}
		for _, name := range sortedSet(d.gotOffOffsetsNeeded) {
			w.WriteString(".Lboringssl_gotoff_" + name + ":\n")
			w.WriteString("\t.quad " + name + "@GOTOFF\n")
		}
	}

	w.WriteString(".type BORINGSSL_bcm_text_hash, @object\n")
	w.WriteString(".size BORINGSSL_bcm_text_hash, 32\n")
	w.WriteString("BORINGSSL_bcm_text_hash:\n")
	for _, b := range fipscommon.UninitHashValue {
		w.WriteString(".byte 0x" + strconv.FormatUint(uint64(b), 16) + "\n")
	}

	return nil
}

// preprocess runs source through the C preprocessor.
func preprocess(cppCommand []string, path string) ([]byte, error) {
	var args []string
	args = append(args, cppCommand...)
	args = append(args, path)

	cpp := exec.Command(args[0], args[1:]...)
	cpp.Stderr = os.Stderr
	var result bytes.Buffer
	cpp.Stdout = &result

	if err := cpp.Run(); err != nil {
		return nil, err
	}

	return result.Bytes(), nil
}

func parseInputs(inputs []inputFile, cppCommand []string) error {
	for i, input := range inputs {
		var contents string

		if input.isArchive {
			arFile, err := os.Open(input.path)
			if err != nil {
				return err
			}
			defer arFile.Close()

			ar, err := ar.ParseAR(arFile)
			if err != nil {
				return err
			}

			if len(ar) != 1 {
				return fmt.Errorf("expected one file in archive, but found %d", len(ar))
			}

			for _, c := range ar {
				contents = string(c)
			}
		} else {
			var inBytes []byte
			var err error

			if len(cppCommand) > 0 {
				inBytes, err = preprocess(cppCommand, input.path)
			} else {
				inBytes, err = os.ReadFile(input.path)
			}
			if err != nil {
				return err
			}

			contents = string(inBytes)
		}

		asm := Asm{Buffer: contents, Pretty: true}
		asm.Init()
		if err := asm.Parse(); err != nil {
			return fmt.Errorf("error while parsing %q: %s", input.path, err)
		}
		ast := asm.AST()

		inputs[i].contents = contents
		inputs[i].ast = ast
	}

	return nil
}

// includePathFromHeaderFilePath returns an include directory path based on the
// path of a specific header file. It walks up the path and assumes that the
// include files are rooted in a directory called "openssl".
func includePathFromHeaderFilePath(path string) (string, error) {
	dir := path
	for {
		var file string
		dir, file = filepath.Split(dir)

		if file == "openssl" {
			return dir, nil
		}

		if len(dir) == 0 {
			break
		}
		dir = dir[:len(dir)-1]
	}

	return "", fmt.Errorf("failed to find 'openssl' path element in header file path %q", path)
}

func main() {
	// The .a file, if given, is expected to be an archive of textual
	// assembly sources. That's odd, but CMake really wants to create
	// archive files so it's the only way that we can make it work.
	arInput := flag.String("a", "", "Path to a .a file containing assembly sources")
	outFile := flag.String("o", "", "Path to output assembly")
	ccPath := flag.String("cc", "", "Path to the C compiler for preprocessing inputs")
	ccFlags := flag.String("cc-flags", "", "Flags for the C compiler when preprocessing")

	flag.Parse()

	if len(*outFile) == 0 {
		fmt.Fprintf(os.Stderr, "Must give argument to -o.\n")
		os.Exit(1)
	}

	var inputs []inputFile
	if len(*arInput) > 0 {
		inputs = append(inputs, inputFile{
			path:      *arInput,
			index:     0,
			isArchive: true,
		})
	}

	includePaths := make(map[string]struct{})

	for i, path := range flag.Args() {
		if len(path) == 0 {
			continue
		}

		// Header files are not processed but their path is remembered
		// and passed as -I arguments when invoking the preprocessor.
		if strings.HasSuffix(path, ".h") {
			dir, err := includePathFromHeaderFilePath(path)
			if err != nil {
				fmt.Fprintf(os.Stderr, "%s\n", err)
				os.Exit(1)
			}
			includePaths[dir] = struct{}{}
			continue
		}

		inputs = append(inputs, inputFile{
			path:  path,
			index: i + 1,
		})
	}

	var cppCommand []string
	if len(*ccPath) > 0 {
		cppCommand = append(cppCommand, *ccPath)
		cppCommand = append(cppCommand, strings.Fields(*ccFlags)...)
		// Some of ccFlags might be superfluous when running the
		// preprocessor, but we don't want the compiler complaining that
		// "argument unused during compilation".
		cppCommand = append(cppCommand, "-Wno-unused-command-line-argument")

		for includePath := range includePaths {
			cppCommand = append(cppCommand, "-I"+includePath)
		}

		// -E requests only preprocessing.
		cppCommand = append(cppCommand, "-E")
	}

	if err := parseInputs(inputs, cppCommand); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}

	out, err := os.OpenFile(*outFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		panic(err)
	}
	defer out.Close()

	if err := transform(out, inputs); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}
}

func forEachPath(node *node32, cb func(*node32), rules ...pegRule) {
	if node == nil {
		return
	}

	if len(rules) == 0 {
		cb(node)
		return
	}

	rule := rules[0]
	childRules := rules[1:]

	for ; node != nil; node = node.next {
		if node.pegRule != rule {
			continue
		}

		if len(childRules) == 0 {
			cb(node)
		} else {
			forEachPath(node.up, cb, childRules...)
		}
	}
}

func skipNodes(node *node32, ruleToSkip pegRule) *node32 {
	for ; node != nil && node.pegRule == ruleToSkip; node = node.next {
	}
	return node
}

func skipWS(node *node32) *node32 {
	return skipNodes(node, ruleWS)
}

func assertNodeType(node *node32, expected pegRule) {
	if rule := node.pegRule; rule != expected {
		panic(fmt.Sprintf("node was %q, but wanted %q", rul3s[rule], rul3s[expected]))
	}
}

type wrapperFunc func(func())

type wrapperStack []wrapperFunc

func (w *wrapperStack) do(baseCase func()) {
	if len(*w) == 0 {
		baseCase()
		return
	}

	wrapper := (*w)[0]
	*w = (*w)[1:]
	wrapper(func() { w.do(baseCase) })
}

// localTargetName returns the name of the local target label for a global
// symbol named name.
func localTargetName(name string) string {
	return ".L" + name + "_local_target"
}

func isSynthesized(symbol string) bool {
	return strings.HasSuffix(symbol, "_bss_get") ||
		strings.HasPrefix(symbol, "BORINGSSL_bcm_text_")
}

func redirectorName(symbol string) string {
	return "bcm_redirector_" + symbol
}

// sectionType returns the type of a section. I.e. a section called “.text.foo”
// is a “.text” section.
func sectionType(section string) (string, bool) {
	if len(section) == 0 || section[0] != '.' {
		return "", false
	}

	i := strings.Index(section[1:], ".")
	if i != -1 {
		section = section[:i+1]
	}

	if strings.HasPrefix(section, ".debug_") {
		return ".debug", true
	}

	return section, true
}

// accessorName returns the name of the accessor function for a BSS symbol
// named name.
func accessorName(name string) string {
	return name + "_bss_get"
}

func (d *delocation) mapLocalSymbol(symbol string) string {
	if d.currentInput.index == 0 {
		return symbol
	}
	return symbol + "_BCM_" + strconv.Itoa(d.currentInput.index)
}

func detectProcessor(input inputFile) processorType {
	for statement := input.ast.up; statement != nil; statement = statement.next {
		node := skipNodes(statement.up, ruleWS)
		if node == nil || node.pegRule != ruleInstruction {
			continue
		}

		instruction := node.up
		instructionName := input.contents[instruction.begin:instruction.end]

		switch instructionName {
		case "movq", "call", "leaq":
			return x86_64
		case "str", "bl", "ldr", "st1":
			return aarch64
		}
	}

	panic("processed entire input and didn't recognise any instructions.")
}

func sortedSet(m map[string]struct{}) []string {
	ret := make([]string, 0, len(m))
	for key := range m {
		ret = append(ret, key)
	}
	sort.Strings(ret)
	return ret
}
