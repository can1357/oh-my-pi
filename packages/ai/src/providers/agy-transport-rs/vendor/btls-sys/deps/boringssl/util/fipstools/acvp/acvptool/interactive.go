// Copyright 2019 The BoringSSL Authors
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

//go:build interactive

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	neturl "net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"

	"boringssl.googlesource.com/boringssl.git/util/fipstools/acvp/acvptool/acvp"
	"golang.org/x/crypto/ssh/terminal"
)

const interactiveModeSupported = true

func updateTerminalSize(term *terminal.Terminal) {
	width, height, err := terminal.GetSize(0)
	if err != nil {
		return
	}
	term.SetSize(width, height)
}

func skipWS(node *node32) *node32 {
	for ; node != nil && node.pegRule == ruleWS; node = node.next {
	}
	return node
}

func assertNodeType(node *node32, rule pegRule) {
	if node.pegRule != rule {
		panic(fmt.Sprintf("expected %q, found %q", rul3s[rule], rul3s[node.pegRule]))
	}
}

type Object interface {
	String() (string, error)
	Index(string) (Object, error)
	Search(acvp.Query) (Object, error)
	Action(action string, args []string) error
}

type ServerObjectSet struct {
	env          *Env
	name         string
	searchKeys   map[string][]acvp.Relation
	resultType   reflect.Type
	subObjects   map[string]func(*Env, string) (Object, error)
	canEnumerate bool
}

func (set ServerObjectSet) String() (string, error) {
	if !set.canEnumerate {
		return "[object set " + set.name + "]", nil
	}

	data := reflect.New(reflect.SliceOf(set.resultType)).Interface()
	if err := set.env.server.GetPaged(data, "acvp/v1/"+set.name, nil); err != nil {
		return "", err
	}
	ret, err := json.MarshalIndent(data, "", "  ")
	return string(ret), err
}

func (set ServerObjectSet) Index(indexStr string) (Object, error) {
	index, err := strconv.ParseUint(indexStr, 0, 64)
	if err != nil {
		return nil, fmt.Errorf("object set indexes must be unsigned integers, trying to parse %q failed: %s", indexStr, err)
	}
	return ServerObject{&set, index}, nil
}

func (set ServerObjectSet) Search(condition acvp.Query) (Object, error) {
	if set.searchKeys == nil {
		return nil, errors.New("this object set cannot be searched")
	}

	for _, conj := range condition {
	NextCondition:
		for _, cond := range conj {
			allowed, ok := set.searchKeys[cond.Param]
			if !ok {
				return nil, fmt.Errorf("search key %q not valid for this object set", cond.Param)
			}

			for _, rel := range allowed {
				if rel == cond.Relation {
					continue NextCondition
				}
			}

			return nil, fmt.Errorf("search key %q cannot be used with relation %q", cond.Param, cond.Relation.String())
		}
	}

	return Search{ServerObjectSet: set, query: condition}, nil
}

func (set ServerObjectSet) Action(action string, args []string) error {
	switch action {
	default:
		return fmt.Errorf("unknown action %q", action)

	case "new":
		if len(args) != 0 {
			return fmt.Errorf("found %d arguments but %q takes none", len(args), action)
		}

		newContents, err := edit("")
		if err != nil {
			return err
		}

		if strings.TrimSpace(string(newContents)) == "" {
			io.WriteString(set.env.term, "Resulting file was empty. Ignoring.\n")
			return nil
		}

		var result map[string]any
		if err := set.env.server.Post(&result, "acvp/v1/"+set.name, newContents); err != nil {
			return err
		}

		// In case it's a testSession that was just created, poke any access token
		// into the server's lookup table and the cache.
		if urlInterface, ok := result["url"]; ok {
			if url, ok := urlInterface.(string); ok {
				if tokenInterface, ok := result["accessToken"]; ok {
					if token, ok := tokenInterface.(string); ok {
						for strings.HasPrefix(url, "/") {
							url = url[1:]
						}
						set.env.server.PrefixTokens[url] = token
						if len(set.env.config.SessionTokensCache) > 0 {
							os.WriteFile(filepath.Join(set.env.config.SessionTokensCache, neturl.PathEscape(url))+".token", []byte(token), 0600)
						}
					}
				}
			}
		}

		ret, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return err
		}
		set.env.term.Write(ret)
		return nil
	}
}

type ServerObject struct {
	set   *ServerObjectSet
	index uint64
}

func (obj ServerObject) String() (string, error) {
	data := reflect.New(obj.set.resultType).Interface()
	if err := obj.set.env.server.Get(data, "acvp/v1/"+obj.set.name+"/"+strconv.FormatUint(obj.index, 10)); err != nil {
		return "", err
	}
	ret, err := json.MarshalIndent(data, "", "  ")
	return string(ret), err
}

func (obj ServerObject) Index(index string) (Object, error) {
	if obj.set.subObjects == nil {
		return nil, errors.New("cannot index " + obj.set.name + " objects")
	}
	constr, ok := obj.set.subObjects[index]
	if !ok {
		return nil, fmt.Errorf("no such subobject %q", index)
	}
	return constr(obj.set.env, fmt.Sprintf("%s/%d", obj.set.name, obj.index))
}

func (ServerObject) Search(condition acvp.Query) (Object, error) {
	return nil, errors.New("cannot search individual object")
}

func edit(initialContents string) ([]byte, error) {
	tmp, err := os.CreateTemp("", "acvp*.json")
	if err != nil {
		return nil, err
	}
	path := tmp.Name()
	defer os.Remove(path)

	_, err = io.WriteString(tmp, initialContents)
	tmp.Close()
	if err != nil {
		return nil, err
	}

	editor := os.Getenv("EDITOR")
	if len(editor) == 0 {
		editor = "vim"
	}

	cmd := exec.Command(editor, path)
	cmd.Stdout = os.Stdout
	cmd.Stdin = os.Stdin
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}

	return os.ReadFile(path)
}

func (obj ServerObject) Action(action string, args []string) error {
	switch action {
	default:
		return fmt.Errorf("unknown action %q", action)

	case "edit":
		if len(args) != 0 {
			return fmt.Errorf("found %d arguments but %q takes none", len(args), action)
		}

		contents, err := obj.String()
		if err != nil {
			return err
		}

		newContents, err := edit(contents)
		if err != nil {
			return err
		}

		if trimmed := strings.TrimSpace(string(newContents)); len(trimmed) == 0 || trimmed == strings.TrimSpace(contents) {
			io.WriteString(obj.set.env.term, "Resulting file was equal or empty. Not updating.\n")
			return nil
		}

		var status acvp.RequestStatus
		if err := obj.set.env.server.Put(&status, "acvp/v1/"+obj.set.name+"/"+strconv.FormatUint(obj.index, 10), newContents); err != nil {
			return err
		}

		fmt.Fprintf(obj.set.env.term, "%#v\n", status)
		return nil

	case "delete":
		if len(args) != 0 {
			return fmt.Errorf("found %d arguments but %q takes none", len(args), action)
		}
		return obj.set.env.server.Delete("acvp/v1/" + obj.set.name + "/" + strconv.FormatUint(obj.index, 10))
	}
}

type Search struct {
	ServerObjectSet
	query acvp.Query
}

func (search Search) String() (string, error) {
	data := reflect.New(reflect.SliceOf(search.resultType)).Interface()
	fmt.Printf("Searching for %#v\n", search.query)
	if err := search.env.server.GetPaged(data, "acvp/v1/"+search.name, search.query); err != nil {
		return "", err
	}
	ret, err := json.MarshalIndent(data, "", "  ")
	return string(ret), err
}

func (search Search) Index(_ string) (Object, error) {
	return nil, errors.New("indexing of search results not supported")
}

func (search Search) Search(condition acvp.Query) (Object, error) {
	search.query = append(search.query, condition...)
	return search, nil
}

func (Search) Action(_ string, _ []string) error {
	return errors.New("no actions supported on search objects")
}

type Algorithms struct {
	ServerObjectSet
}

func (algos Algorithms) String() (string, error) {
	var result struct {
		Algorithms []map[string]any `json:"algorithms"`
	}
	if err := algos.env.server.Get(&result, "acvp/v1/algorithms"); err != nil {
		return "", err
	}
	ret, err := json.MarshalIndent(result.Algorithms, "", "  ")
	return string(ret), err
}

type Env struct {
	line      string
	variables map[string]Object
	server    *acvp.Server
	term      *terminal.Terminal
	config    Config
}

func (e *Env) bytes(node *node32) []byte {
	return []byte(e.line[node.begin:node.end])
}

func (e *Env) contents(node *node32) string {
	return e.line[node.begin:node.end]
}

type stringLiteral struct {
	env      *Env
	contents string
}

func (s stringLiteral) String() (string, error) {
	return s.contents, nil
}

func (stringLiteral) Index(_ string) (Object, error) {
	return nil, errors.New("cannot index strings")
}

func (stringLiteral) Search(_ acvp.Query) (Object, error) {
	return nil, errors.New("cannot search strings")
}

func (s stringLiteral) Action(action string, args []string) error {
	switch action {
	default:
		return fmt.Errorf("action %q not supported on string literals", action)

	case "GET":
		if len(args) != 0 {
			return fmt.Errorf("found %d arguments but %q takes none", len(args), action)
		}

		var results map[string]any
		if err := s.env.server.Get(&results, s.contents); err != nil {
			return err
		}
		ret, err := json.MarshalIndent(results, "", "  ")
		if err != nil {
			return err
		}
		s.env.term.Write(ret)
		return nil
	}
}

type results struct {
	env    *Env
	prefix string
}

func (r results) String() (string, error) {
	var results map[string]any
	if err := r.env.server.Get(&results, "acvp/v1/"+r.prefix+"/results"); err != nil {
		return "", err
	}
	ret, err := json.MarshalIndent(results, "", "  ")
	return string(ret), err
}

func (results) Index(_ string) (Object, error) {
	return nil, errors.New("cannot index results objects")
}

func (results) Search(_ acvp.Query) (Object, error) {
	return nil, errors.New("cannot search results objects")
}

func (results) Action(_ string, _ []string) error {
	return errors.New("no actions supported on results objects")
}

func (e *Env) parseStringLiteral(node *node32) string {
	assertNodeType(node, ruleStringLiteral)
	in := e.bytes(node)
	var buf bytes.Buffer
	for i := 1; i < len(in)-1; i++ {
		if in[i] == '\\' {
			switch in[i+1] {
			case '\\':
				buf.WriteByte('\\')
			case 'n':
				buf.WriteByte('\n')
			case '"':
				buf.WriteByte('"')
			default:
				panic("unknown escape")
			}
			i++
			continue
		}
		buf.WriteByte(in[i])
	}

	return buf.String()
}

func (e *Env) evalExpression(node *node32) (obj Object, err error) {
	switch node.pegRule {
	case ruleStringLiteral:
		return stringLiteral{e, e.parseStringLiteral(node)}, nil

	case ruleVariable:
		varName := e.contents(node)
		obj, ok := e.variables[varName]
		if !ok {
			return nil, fmt.Errorf("unknown variable %q", varName)
		}
		return obj, nil

	case ruleIndexing:
		node = node.up
		assertNodeType(node, ruleVariable)
		varName := e.contents(node)
		obj, ok := e.variables[varName]
		if !ok {
			return nil, fmt.Errorf("unknown variable %q", varName)
		}

		node = node.next
		for node != nil {
			assertNodeType(node, ruleIndex)
			indexStr := e.contents(node)
			if obj, err = obj.Index(indexStr); err != nil {
				return nil, err
			}
			node = node.next
		}

		return obj, nil

	case ruleSearch:
		node = node.up
		assertNodeType(node, ruleVariable)
		varName := e.contents(node)
		obj, ok := e.variables[varName]
		if !ok {
			return nil, fmt.Errorf("unknown variable %q", varName)
		}

		node = skipWS(node.next)
		assertNodeType(node, ruleQuery)
		node = node.up

		var query acvp.Query
		for node != nil {
			assertNodeType(node, ruleConjunctions)
			query = append(query, e.parseConjunction(node.up))
			node = skipWS(node.next)
		}

		if len(query) == 0 {
			return nil, errors.New("cannot have empty query")
		}

		return obj.Search(query)
	}

	panic("unhandled")
}

func (e *Env) evalAction(node *node32) error {
	assertNodeType(node, ruleExpression)
	obj, err := e.evalExpression(node.up)
	if err != nil {
		return err
	}

	node = node.next
	assertNodeType(node, ruleCommand)
	node = node.up
	assertNodeType(node, ruleFunction)
	function := e.contents(node)
	node = node.next

	var args []string
	for node != nil {
		assertNodeType(node, ruleArgs)
		node = node.up
		args = append(args, e.parseStringLiteral(node))

		node = skipWS(node.next)
	}

	return obj.Action(function, args)
}

func (e *Env) parseConjunction(node *node32) (ret acvp.Conjunction) {
	for node != nil {
		assertNodeType(node, ruleConjunction)
		ret = append(ret, e.parseCondition(node.up))

		node = skipWS(node.next)
		if node != nil {
			assertNodeType(node, ruleConjunctions)
			node = node.up
		}
	}
	return ret
}

func (e *Env) parseCondition(node *node32) (ret acvp.Condition) {
	assertNodeType(node, ruleField)
	ret.Param = e.contents(node)
	node = skipWS(node.next)

	assertNodeType(node, ruleRelation)
	switch e.contents(node) {
	case "==":
		ret.Relation = acvp.Equals
	case "!=":
		ret.Relation = acvp.NotEquals
	case "contains":
		ret.Relation = acvp.Contains
	case "startsWith":
		ret.Relation = acvp.StartsWith
	case "endsWith":
		ret.Relation = acvp.EndsWith
	default:
		panic("relation not handled: " + e.contents(node))
	}
	node = skipWS(node.next)

	ret.Value = e.parseStringLiteral(node)

	return ret
}

func runInteractive(server *acvp.Server, config Config) {
	oldState, err := terminal.MakeRaw(0)
	if err != nil {
		panic(err)
	}
	defer terminal.Restore(0, oldState)
	term := terminal.NewTerminal(os.Stdin, "> ")

	resizeChan := make(chan os.Signal, 1)
	go func() {
		for _ = range resizeChan {
			updateTerminalSize(term)
		}
	}()
	signal.Notify(resizeChan, syscall.SIGWINCH)

	env := &Env{variables: make(map[string]Object), server: server, term: term, config: config}
	env.variables["requests"] = ServerObjectSet{
		env:          env,
		name:         "requests",
		resultType:   reflect.TypeOf(&acvp.RequestStatus{}),
		canEnumerate: true,
	}
	env.variables["vendors"] = ServerObjectSet{
		env:  env,
		name: "vendors",
		searchKeys: map[string][]acvp.Relation{
			"name":        []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"website":     []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"email":       []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"phoneNumber": []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
		},
		subObjects: map[string]func(*Env, string) (Object, error){
			"contacts": func(env *Env, prefix string) (Object, error) {
				return ServerObjectSet{
					env:          env,
					name:         prefix + "/contacts",
					resultType:   reflect.TypeOf(&acvp.Person{}),
					canEnumerate: true,
				}, nil
			},
			"addresses": func(env *Env, prefix string) (Object, error) {
				return ServerObjectSet{
					env:          env,
					name:         prefix + "/addresses",
					resultType:   reflect.TypeOf(&acvp.Address{}),
					canEnumerate: true,
				}, nil
			},
		},
		resultType: reflect.TypeOf(&acvp.Vendor{}),
	}
	env.variables["persons"] = ServerObjectSet{
		env:  env,
		name: "persons",
		searchKeys: map[string][]acvp.Relation{
			"fullName":    []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"email":       []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"phoneNumber": []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"vendorId":    []acvp.Relation{acvp.Equals, acvp.NotEquals, acvp.LessThan, acvp.LessThanEqual, acvp.GreaterThan, acvp.GreaterThanEqual},
		},
		resultType: reflect.TypeOf(&acvp.Person{}),
	}
	env.variables["modules"] = ServerObjectSet{
		env:  env,
		name: "modules",
		searchKeys: map[string][]acvp.Relation{
			"name":        []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"version":     []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"website":     []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"description": []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"type":        []acvp.Relation{acvp.Equals, acvp.NotEquals},
			"vendorId":    []acvp.Relation{acvp.Equals, acvp.NotEquals, acvp.LessThan, acvp.LessThanEqual, acvp.GreaterThan, acvp.GreaterThanEqual},
		},
		resultType: reflect.TypeOf(&acvp.Module{}),
	}
	env.variables["oes"] = ServerObjectSet{
		env:  env,
		name: "oes",
		searchKeys: map[string][]acvp.Relation{
			"name": []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
		},
		resultType: reflect.TypeOf(&acvp.OperationalEnvironment{}),
	}
	env.variables["deps"] = ServerObjectSet{
		env:  env,
		name: "dependencies",
		searchKeys: map[string][]acvp.Relation{
			"name":        []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"type":        []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
			"description": []acvp.Relation{acvp.Equals, acvp.StartsWith, acvp.EndsWith, acvp.Contains},
		},
		resultType: reflect.TypeOf(&acvp.Dependency{}),
	}
	env.variables["algos"] = Algorithms{
		ServerObjectSet{
			env:          env,
			name:         "algorithms",
			resultType:   reflect.TypeOf(&acvp.Algorithm{}),
			canEnumerate: true,
		},
	}
	env.variables["sessions"] = ServerObjectSet{
		env:          env,
		name:         "testSessions",
		resultType:   reflect.TypeOf(&acvp.TestSession{}),
		canEnumerate: true,
		subObjects: map[string]func(env *Env, prefix string) (Object, error){
			"results": func(env *Env, prefix string) (Object, error) {
				return results{env: env, prefix: prefix}, nil
			},
		},
	}

	for {
		if env.line, err = term.ReadLine(); err != nil {
			return
		}
		if len(env.line) == 0 {
			continue
		}

		stmt := Statement{Buffer: env.line, Pretty: true}
		stmt.Init()
		if err := stmt.Parse(); err != nil {
			io.WriteString(term, err.Error())
			continue
		}

		node := skipWS(stmt.AST().up)
		switch node.pegRule {
		case ruleExpression:
			obj, err := env.evalExpression(node.up)
			var repr string
			if err == nil {
				repr, err = obj.String()
			}

			if err != nil {
				fmt.Fprintf(term, "error while evaluating expression: %s\n", err)
			} else {
				io.WriteString(term, repr)
				io.WriteString(term, "\n")
			}

		case ruleAction:
			if err := env.evalAction(node.up); err != nil {
				io.WriteString(term, err.Error())
				io.WriteString(term, "\n")
			}

		default:
			fmt.Fprintf(term, "internal error parsing input.\n")
		}
	}
}
