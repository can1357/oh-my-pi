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

package acvp

import (
	"bytes"
	"crypto"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"time"
)

const loginEndpoint = "acvp/v1/login"

// Server represents an ACVP server.
type Server struct {
	// PrefixTokens are access tokens that apply to URLs under a certain prefix.
	// The keys of this map are strings like "acvp/v1/testSessions/1234" and the
	// values are JWT access tokens.
	PrefixTokens map[string]string
	// SizeLimit is the maximum number of bytes that the server can accept
	// as an upload before the large endpoint support must be used. Zero
	// means that there is no limit.
	SizeLimit uint64
	// AccessToken is the top-level access token for the current session.
	AccessToken string

	client   *http.Client
	prefix   string
	totpFunc func() string
}

// NewServer returns a fresh Server instance representing the ACVP server at
// prefix (e.g. "https://acvp.example.com/"). A copy of all bytes exchanged
// will be written to logFile, if not empty.
func NewServer(prefix string, logFile string, derCertificates [][]byte, privateKey crypto.PrivateKey, totp func() string) *Server {
	if !strings.HasSuffix(prefix, "/") {
		prefix = prefix + "/"
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{
			tls.Certificate{
				Certificate: derCertificates,
				PrivateKey:  privateKey,
			},
		},
		Renegotiation: tls.RenegotiateOnceAsClient,
	}

	client := &http.Client{
		Transport: &http.Transport{
			Dial: func(network, addr string) (net.Conn, error) {
				panic("HTTP connection requested")
			},
			DialTLS: func(network, addr string) (net.Conn, error) {
				conn, err := tls.Dial(network, addr, tlsConfig)
				if err != nil {
					return nil, err
				}
				if len(logFile) > 0 {
					logFile, err := os.OpenFile(logFile, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
					if err != nil {
						return nil, err
					}
					return &logger{Conn: conn, log: logFile}, nil
				}
				return conn, err
			},
		},
		Timeout: 120 * time.Second,
	}

	return &Server{client: client, prefix: prefix, totpFunc: totp, PrefixTokens: make(map[string]string)}
}

type logger struct {
	*tls.Conn
	log           *os.File
	lastDirection int
}

var newLine = []byte{'\n'}

func (l *logger) Read(buf []byte) (int, error) {
	if l.lastDirection != 1 {
		l.log.Write(newLine)
	}
	l.lastDirection = 1

	n, err := l.Conn.Read(buf)
	if err == nil {
		l.log.Write(buf[:n])
	}
	return n, err
}

func (l *logger) Write(buf []byte) (int, error) {
	if l.lastDirection != 2 {
		l.log.Write(newLine)
	}
	l.lastDirection = 2

	n, err := l.Conn.Write(buf)
	if err == nil {
		l.log.Write(buf[:n])
	}
	return n, err
}

const requestPrefix = `[{"acvVersion":"1.0"},`
const requestSuffix = "]"

// parseHeaderElement parses the first JSON object that's always returned by
// ACVP servers. If successful, it returns a JSON Decoder positioned just
// before the second element.
func parseHeaderElement(in io.Reader) (*json.Decoder, error) {
	decoder := json.NewDecoder(in)
	arrayStart, err := decoder.Token()
	if err != nil {
		return nil, errors.New("failed to read from server reply: " + err.Error())
	}
	if delim, ok := arrayStart.(json.Delim); !ok || delim != '[' {
		return nil, fmt.Errorf("found %#v when expecting initial array from server", arrayStart)
	}

	var version struct {
		Version string `json:"acvVersion"`
	}
	if err := decoder.Decode(&version); err != nil {
		return nil, errors.New("parse error while decoding version element: " + err.Error())
	}
	if !strings.HasPrefix(version.Version, "1.") {
		return nil, fmt.Errorf("expected version 1.* from server but found %q", version.Version)
	}

	return decoder, nil
}

// parseReplyToBytes reads the contents of an ACVP reply after removing the
// header element.
func parseReplyToBytes(in io.Reader) ([]byte, error) {
	decoder, err := parseHeaderElement(in)
	if err != nil {
		return nil, err
	}

	buf, err := io.ReadAll(decoder.Buffered())
	if err != nil {
		return nil, err
	}

	rest, err := io.ReadAll(in)
	if err != nil {
		return nil, err
	}
	buf = append(buf, rest...)

	buf = bytes.TrimSpace(buf)
	if len(buf) == 0 || buf[0] != ',' {
		return nil, errors.New("didn't find initial ','")
	}
	buf = buf[1:]

	if len(buf) == 0 || buf[len(buf)-1] != ']' {
		return nil, errors.New("didn't find trailing ']'")
	}
	buf = buf[:len(buf)-1]

	return buf, nil
}

// parseReply parses the contents of an ACVP reply (after removing the header
// element) into out. See the documentation of the encoding/json package for
// details of the parsing.
func parseReply(out any, in io.Reader) error {
	if out == nil {
		// No reply expected.
		return nil
	}

	decoder, err := parseHeaderElement(in)
	if err != nil {
		return err
	}

	if err := decoder.Decode(out); err != nil {
		return errors.New("error while decoding reply body: " + err.Error())
	}

	arrayEnd, err := decoder.Token()
	if err != nil {
		return errors.New("failed to read end of reply from server: " + err.Error())
	}
	if delim, ok := arrayEnd.(json.Delim); !ok || delim != ']' {
		return fmt.Errorf("found %#v when expecting end of array from server", arrayEnd)
	}
	if decoder.More() {
		return errors.New("unexpected trailing data from server")
	}

	return nil
}

// expired returns true if the given JWT token has expired.
func expired(tokenStr string) bool {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return false
	}
	jsonBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var token struct {
		Expiry uint64 `json:"exp"`
	}
	if json.Unmarshal(jsonBytes, &token) != nil {
		return false
	}
	return token.Expiry > 0 && token.Expiry < uint64(time.Now().Add(-10*time.Second).Unix())
}

func (server *Server) getToken(endPoint string) (string, error) {
	for path, token := range server.PrefixTokens {
		if endPoint != path && !strings.HasPrefix(endPoint, path+"/") {
			continue
		}

		if !expired(token) {
			return token, nil
		}

		var reply struct {
			AccessToken string `json:"accessToken"`
		}
		if err := server.postMessage(&reply, loginEndpoint, map[string]string{
			"password":    server.totpFunc(),
			"accessToken": token,
		}); err != nil {
			return "", err
		}
		server.PrefixTokens[path] = reply.AccessToken
		return reply.AccessToken, nil
	}
	return server.AccessToken, nil
}

// Login sends a login request and stores the returned access tokens for use
// with future requests. The login process isn't specifically documented in
// draft-fussell-acvp-spec and the best reference is
// https://github.com/usnistgov/ACVP/wiki#credentials-for-accessing-the-demo-server
func (server *Server) Login() error {
	var reply struct {
		AccessToken           string `json:"accessToken"`
		LargeEndpointRequired bool   `json:"largeEndpointRequired"`
		SizeLimit             int64  `json:"sizeConstraint"`
	}

	if err := server.postMessage(&reply, loginEndpoint, map[string]string{"password": server.totpFunc()}); err != nil {
		return err
	}

	if len(reply.AccessToken) == 0 {
		return errors.New("login reply didn't contain access token")
	}
	server.AccessToken = reply.AccessToken

	if reply.LargeEndpointRequired {
		if reply.SizeLimit <= 0 {
			return errors.New("login indicated largeEndpointRequired but didn't provide a sizeConstraint")
		}
		server.SizeLimit = uint64(reply.SizeLimit)
	}

	return nil
}

type Relation int

const (
	Equals           Relation = iota
	NotEquals        Relation = iota
	GreaterThan      Relation = iota
	GreaterThanEqual Relation = iota
	LessThan         Relation = iota
	LessThanEqual    Relation = iota
	Contains         Relation = iota
	StartsWith       Relation = iota
	EndsWith         Relation = iota
)

func (rel Relation) String() string {
	switch rel {
	case Equals:
		return "eq"
	case NotEquals:
		return "ne"
	case GreaterThan:
		return "gt"
	case GreaterThanEqual:
		return "ge"
	case LessThan:
		return "lt"
	case LessThanEqual:
		return "le"
	case Contains:
		return "contains"
	case StartsWith:
		return "start"
	case EndsWith:
		return "end"
	default:
		panic("unknown relation")
	}
}

type Condition struct {
	Param    string
	Relation Relation
	Value    string
}

type Conjunction []Condition

type Query []Conjunction

func (query Query) toURLParams() string {
	var ret string

	for i, conj := range query {
		for _, cond := range conj {
			if len(ret) > 0 {
				ret += "&"
			}
			ret += fmt.Sprintf("%s[%d]=%s:%s", url.QueryEscape(cond.Param), i, cond.Relation.String(), url.QueryEscape(cond.Value))
		}
	}

	return ret
}

var NotFound = errors.New("acvp: HTTP code 404")

func (server *Server) newRequestWithToken(method, endpoint string, body io.Reader) (*http.Request, error) {
	token, err := server.getToken(endpoint)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(method, server.prefix+endpoint, body)
	if err != nil {
		return nil, err
	}
	if len(token) != 0 && endpoint != loginEndpoint {
		req.Header.Add("Authorization", "Bearer "+token)
	}
	return req, nil
}

func (server *Server) Get(out any, endPoint string) error {
	req, err := server.newRequestWithToken("GET", endPoint, nil)
	if err != nil {
		return err
	}
	resp, err := server.client.Do(req)
	if err != nil {
		return fmt.Errorf("error while fetching chunk for %q: %s", endPoint, err)
	}

	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return NotFound
	} else if resp.StatusCode != 200 {
		return fmt.Errorf("acvp: HTTP error %d", resp.StatusCode)
	}
	return parseReply(out, resp.Body)
}

func (server *Server) GetBytes(endPoint string) ([]byte, error) {
	req, err := server.newRequestWithToken("GET", endPoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := server.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("error while fetching chunk for %q: %s", endPoint, err)
	}

	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, NotFound
	} else if resp.StatusCode != 200 {
		return nil, fmt.Errorf("acvp: HTTP error %d", resp.StatusCode)
	}
	return parseReplyToBytes(resp.Body)
}

func (server *Server) write(method string, reply any, endPoint string, contents []byte) error {
	var buf bytes.Buffer
	buf.WriteString(requestPrefix)
	buf.Write(contents)
	buf.WriteString(requestSuffix)

	req, err := server.newRequestWithToken(method, endPoint, &buf)
	if err != nil {
		return err
	}
	req.Header.Add("Content-Type", "application/json")
	resp, err := server.client.Do(req)
	if err != nil {
		return fmt.Errorf("error while writing to %q: %s", endPoint, err)
	}

	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return NotFound
	} else if resp.StatusCode != 200 {
		return fmt.Errorf("acvp: HTTP error %d", resp.StatusCode)
	}
	return parseReply(reply, resp.Body)
}

func (server *Server) postMessage(reply any, endPoint string, request any) error {
	contents, err := json.Marshal(request)
	if err != nil {
		return err
	}
	return server.write("POST", reply, endPoint, contents)
}

func (server *Server) Post(out any, endPoint string, contents []byte) error {
	return server.write("POST", out, endPoint, contents)
}

func (server *Server) Put(out any, endPoint string, contents []byte) error {
	return server.write("PUT", out, endPoint, contents)
}

func (server *Server) Delete(endPoint string) error {
	req, err := server.newRequestWithToken("DELETE", endPoint, nil)
	resp, err := server.client.Do(req)
	if err != nil {
		return fmt.Errorf("error while writing to %q: %s", endPoint, err)
	}

	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("acvp: HTTP error %d", resp.StatusCode)
	}
	fmt.Printf("DELETE %q %d\n", server.prefix+endPoint, resp.StatusCode)
	return nil
}

var (
	uint64Type = reflect.TypeOf(uint64(0))
	boolType   = reflect.TypeOf(false)
	stringType = reflect.TypeOf("")
)

// GetPaged returns an array of records of some type using one or more requests to the server. See
// https://pages.nist.gov/ACVP/draft-fussell-acvp-spec.html#paging_response
func (server *Server) GetPaged(out any, endPoint string, condition Query) error {
	output := reflect.ValueOf(out)
	if output.Kind() != reflect.Ptr {
		panic(fmt.Sprintf("GetPaged output parameter of non-pointer type %T", out))
	}

	token, err := server.getToken(endPoint)
	if err != nil {
		return err
	}

	outputSlice := output.Elem()

	replyType := reflect.StructOf([]reflect.StructField{
		{Name: "TotalCount", Type: uint64Type, Tag: `json:"totalCount"`},
		{Name: "Incomplete", Type: boolType, Tag: `json:"incomplete"`},
		{Name: "Data", Type: output.Elem().Type(), Tag: `json:"data"`},
		{Name: "Links", Type: reflect.StructOf([]reflect.StructField{
			{Name: "Next", Type: stringType, Tag: `json:"next"`},
		}), Tag: `json:"links"`},
	})
	nextURL := server.prefix + endPoint
	conditionParams := condition.toURLParams()
	if len(conditionParams) > 0 {
		nextURL += "?" + conditionParams
	}

	isFirstRequest := true
	for {
		req, err := http.NewRequest("GET", nextURL, nil)
		if err != nil {
			return err
		}
		if len(token) != 0 {
			req.Header.Add("Authorization", "Bearer "+token)
		}
		resp, err := server.client.Do(req)
		if err != nil {
			return fmt.Errorf("error while fetching chunk for %q: %s", endPoint, err)
		}
		if resp.StatusCode == 404 && isFirstRequest {
			resp.Body.Close()
			return nil
		} else if resp.StatusCode != 200 {
			resp.Body.Close()
			return fmt.Errorf("acvp: HTTP error %d", resp.StatusCode)
		}
		isFirstRequest = false

		reply := reflect.New(replyType)
		err = parseReply(reply.Interface(), resp.Body)
		resp.Body.Close()
		if err != nil {
			return err
		}

		data := reply.Elem().FieldByName("Data")
		for i := 0; i < data.Len(); i++ {
			outputSlice.Set(reflect.Append(outputSlice, data.Index(i)))
		}

		if uint64(outputSlice.Len()) == reply.Elem().FieldByName("TotalCount").Uint() ||
			reply.Elem().FieldByName("Links").FieldByName("Next").String() == "" {
			break
		}

		nextURL = server.prefix + endPoint + fmt.Sprintf("?offset=%d", outputSlice.Len())
		if len(conditionParams) > 0 {
			nextURL += "&" + conditionParams
		}
	}

	return nil
}

// https://pages.nist.gov/ACVP/draft-fussell-acvp-spec.html#rfc.section.11.8.3.1
type Vendor struct {
	URL         string    `json:"url,omitempty"`
	Name        string    `json:"name,omitempty"`
	ParentURL   string    `json:"parentUrl,omitempty"`
	Website     string    `json:"website,omitempty"`
	Emails      []string  `json:"emails,omitempty"`
	ContactsURL string    `json:"contactsUrl,omitempty"`
	Addresses   []Address `json:"addresses,omitempty"`
}

// https://pages.nist.gov/ACVP/draft-fussell-acvp-spec.html#rfc.section.11.9
type Address struct {
	URL        string `json:"url,omitempty"`
	Street1    string `json:"street1,omitempty"`
	Street2    string `json:"street2,omitempty"`
	Street3    string `json:"street3,omitempty"`
	Locality   string `json:"locality,omitempty"`
	Region     string `json:"region,omitempty"`
	Country    string `json:"country,omitempty"`
	PostalCode string `json:"postalCode,omitempty"`
}

// https://pages.nist.gov/ACVP/draft-fussell-acvp-spec.html#rfc.section.11.10
type Person struct {
	URL          string   `json:"url,omitempty"`
	FullName     string   `json:"fullName,omitempty"`
	VendorURL    string   `json:"vendorUrl,omitempty"`
	Emails       []string `json:"emails,omitempty"`
	PhoneNumbers []struct {
		Number string `json:"number,omitempty"`
		Type   string `json:"type,omitempty"`
	} `json:"phoneNumbers,omitempty"`
}

// https://pages.nist.gov/ACVP/draft-fussell-acvp-spec.html#rfc.section.11.11
type Module struct {
	URL         string   `json:"url,omitempty"`
	Name        string   `json:"name,omitempty"`
	Version     string   `json:"version,omitempty"`
	Type        string   `json:"type,omitempty"`
	Website     string   `json:"website,omitempty"`
	VendorURL   string   `json:"vendorUrl,omitempty"`
	AddressURL  string   `json:"addressUrl,omitempty"`
	ContactURLs []string `json:"contactUrls,omitempty"`
	Description string   `json:"description,omitempty"`
}

type RequestStatus struct {
	URL         string `json:"url,omitempty"`
	Status      string `json:"status,omitempty"`
	Message     string `json:"message,omitempty"`
	ApprovedURL string `json:"approvedUrl,omitempty"`
}

type OperationalEnvironment struct {
	URL            string       `json:"url,omitempty"`
	Name           string       `json:"name,omitempty"`
	DependencyUrls []string     `json:"dependencyUrls,omitempty"`
	Dependencies   []Dependency `json:"dependencies,omitempty"`
}

type Dependency map[string]any

type Algorithm map[string]any

type TestSession struct {
	URL           string           `json:"url,omitempty"`
	ACVPVersion   string           `json:"acvpVersion,omitempty"`
	Created       string           `json:"createdOn,omitempty"`
	Expires       string           `json:"expiresOn,omitempty"`
	VectorSetURLs []string         `json:"vectorSetUrls,omitempty"`
	AccessToken   string           `json:"accessToken,omitempty"`
	Algorithms    []map[string]any `json:"algorithms,omitempty"`
	EncryptAtRest bool             `json:"encryptAtRest,omitempty"`
	IsSample      bool             `json:"isSample,omitempty"`
	Publishable   bool             `json:"publishable,omitempty"`
	Passed        bool             `json:"passed,omitempty"`
}

type Vectors struct {
	Retry    uint64 `json:"retry,omitempty"`
	ID       uint64 `json:"vsId"`
	Algo     string `json:"algorithm,omitempty"`
	Revision string `json:"revision,omitempty"`
}

type LargeUploadRequest struct {
	Size uint64 `json:"submissionSize,omitempty"`
	URL  string `json:"vectorSetUrl,omitempty"`
}

type LargeUploadResponse struct {
	URL         string `json:"url"`
	AccessToken string `json:"accessToken"`
}

type SessionResults struct {
	Passed  bool `json:"passed"`
	Results []struct {
		URL    string `json:"vectorSetUrl,omitempty"`
		Status string `json:"status"`
	} `json:"results"`
}
