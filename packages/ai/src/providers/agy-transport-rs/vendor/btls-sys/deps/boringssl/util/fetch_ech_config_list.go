// Copyright 2021 The BoringSSL Authors
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
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path"
	"strings"

	"golang.org/x/crypto/cryptobyte"
	"golang.org/x/net/dns/dnsmessage"
)

const (
	httpsType = 65 // RRTYPE for HTTPS records.

	// SvcParamKey codepoints defined in draft-ietf-dnsop-svcb-https-06.
	httpsKeyMandatory     = 0
	httpsKeyALPN          = 1
	httpsKeyNoDefaultALPN = 2
	httpsKeyPort          = 3
	httpsKeyIPV4Hint      = 4
	httpsKeyECH           = 5
	httpsKeyIPV6Hint      = 6
)

var (
	name   = flag.String("name", "", "The name to look up in DNS. Required.")
	server = flag.String("server", "8.8.8.8:53", "Comma-separated host and UDP port that defines the DNS server to query.")
	outDir = flag.String("out-dir", "", "The directory where ECHConfigList values will be written. If unspecified, bytes are hexdumped to stdout.")
)

type httpsRecord struct {
	priority   uint16
	targetName string

	// SvcParams:
	mandatory     []uint16
	alpn          []string
	noDefaultALPN bool
	hasPort       bool
	port          uint16
	ipv4hint      []net.IP
	ech           []byte
	ipv6hint      []net.IP
	unknownParams map[uint16][]byte
}

// String pretty-prints |h| as a multi-line string with bullet points.
func (h httpsRecord) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "HTTPS SvcPriority:%d TargetName:%q", h.priority, h.targetName)

	if len(h.mandatory) != 0 {
		fmt.Fprintf(&b, "\n  * mandatory: %v", h.mandatory)
	}
	if len(h.alpn) != 0 {
		fmt.Fprintf(&b, "\n  * alpn: %q", h.alpn)
	}
	if h.noDefaultALPN {
		fmt.Fprint(&b, "\n  * no-default-alpn")
	}
	if h.hasPort {
		fmt.Fprintf(&b, "\n  * port: %d", h.port)
	}
	if len(h.ipv4hint) != 0 {
		fmt.Fprintf(&b, "\n  * ipv4hint:")
		for _, address := range h.ipv4hint {
			fmt.Fprintf(&b, "\n    - %s", address)
		}
	}
	if len(h.ech) != 0 {
		fmt.Fprintf(&b, "\n  * ech: %x", h.ech)
	}
	if len(h.ipv6hint) != 0 {
		fmt.Fprintf(&b, "\n  * ipv6hint:")
		for _, address := range h.ipv6hint {
			fmt.Fprintf(&b, "\n    - %s", address)
		}
	}
	if len(h.unknownParams) != 0 {
		fmt.Fprint(&b, "\n  * unknown SvcParams:")
		for key, value := range h.unknownParams {
			fmt.Fprintf(&b, "\n    - %d: %x", key, value)
		}
	}
	return b.String()
}

// dnsQueryForHTTPS queries the DNS server over UDP for any HTTPS records
// associated with |domain|. It scans the response's answers and returns all the
// HTTPS records it finds. It returns an error if any connection steps fail.
func dnsQueryForHTTPS(domain string) ([][]byte, error) {
	udpAddr, err := net.ResolveUDPAddr("udp", *server)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialUDP("udp", nil, udpAddr)
	if err != nil {
		return nil, fmt.Errorf("failed to dial: %s", err)
	}
	defer conn.Close()

	// Domain name must be canonical or message packing will fail.
	if domain[len(domain)-1] != '.' {
		domain += "."
	}
	dnsName, err := dnsmessage.NewName(domain)
	if err != nil {
		return nil, fmt.Errorf("failed to create DNS name from %q: %s", domain, err)
	}
	question := dnsmessage.Question{
		Name:  dnsName,
		Type:  httpsType,
		Class: dnsmessage.ClassINET,
	}
	msg := dnsmessage.Message{
		Header: dnsmessage.Header{
			RecursionDesired: true,
		},
		Questions: []dnsmessage.Question{question},
	}
	packedMsg, err := msg.Pack()
	if err != nil {
		return nil, fmt.Errorf("failed to pack msg: %s", err)
	}

	if _, err = conn.Write(packedMsg); err != nil {
		return nil, fmt.Errorf("failed to send the DNS query: %s", err)
	}

	for {
		response := make([]byte, 512)
		n, err := conn.Read(response)
		if err != nil {
			return nil, fmt.Errorf("failed to read the DNS response: %s", err)
		}
		response = response[:n]

		var p dnsmessage.Parser
		header, err := p.Start(response)
		if err != nil {
			return nil, err
		}
		if !header.Response {
			return nil, errors.New("received DNS message is not a response")
		}
		if header.RCode != dnsmessage.RCodeSuccess {
			return nil, fmt.Errorf("response from DNS has non-success RCode: %s", header.RCode.String())
		}
		if header.ID != 0 {
			return nil, errors.New("received a DNS response with the wrong ID")
		}
		if !header.RecursionAvailable {
			return nil, errors.New("server does not support recursion")
		}
		// Verify that this response answers the question that we asked in the
		// query. If the resolver encountered any CNAMEs, it's not guaranteed
		// that the response will contain a question with the same QNAME as our
		// query. However, RFC 8499 Section 4 indicates that in general use, the
		// response's QNAME should match the query, so we will make that
		// assumption.
		q, err := p.Question()
		if err != nil {
			return nil, err
		}
		if q != question {
			return nil, fmt.Errorf("response answers the wrong question: %v", q)
		}
		if q, err = p.Question(); err != dnsmessage.ErrSectionDone {
			return nil, fmt.Errorf("response contains an unexpected question: %v", q)
		}

		var httpsRecords [][]byte
		for {
			h, err := p.AnswerHeader()
			if err == dnsmessage.ErrSectionDone {
				break
			}
			if err != nil {
				return nil, err
			}

			switch h.Type {
			case httpsType:
				// This should continue to work when golang.org/x/net/dns/dnsmessage
				// adds support for HTTPS records.
				r, err := p.UnknownResource()
				if err != nil {
					return nil, err
				}
				httpsRecords = append(httpsRecords, r.Data)
			default:
				if _, err := p.UnknownResource(); err != nil {
					return nil, err
				}
			}
		}
		return httpsRecords, nil
	}
}

// parseHTTPSRecord parses an HTTPS record (draft-ietf-dnsop-svcb-https-06,
// Section 2.2) from |raw|. If there are syntax errors, it returns an error.
func parseHTTPSRecord(raw []byte) (httpsRecord, error) {
	reader := cryptobyte.String(raw)

	var priority uint16
	if !reader.ReadUint16(&priority) {
		return httpsRecord{}, errors.New("failed to parse HTTPS record priority")
	}

	// Read the TargetName.
	var dottedDomain string
	for {
		var label cryptobyte.String
		if !reader.ReadUint8LengthPrefixed(&label) {
			return httpsRecord{}, errors.New("failed to parse HTTPS record TargetName")
		}
		if label.Empty() {
			break
		}
		dottedDomain += string(label) + "."
	}

	if priority == 0 {
		// TODO(dmcardle) Recursively follow AliasForm records.
		return httpsRecord{}, fmt.Errorf("received an AliasForm HTTPS record with TargetName=%q", dottedDomain)
	}

	record := httpsRecord{
		priority:      priority,
		targetName:    dottedDomain,
		unknownParams: make(map[uint16][]byte),
	}

	// Read the SvcParams.
	var lastSvcParamKey uint16
	for svcParamCount := 0; !reader.Empty(); svcParamCount++ {
		var svcParamKey uint16
		var svcParamValue cryptobyte.String
		if !reader.ReadUint16(&svcParamKey) ||
			!reader.ReadUint16LengthPrefixed(&svcParamValue) {
			return httpsRecord{}, errors.New("failed to parse HTTPS record SvcParam")
		}
		if svcParamCount > 0 && svcParamKey <= lastSvcParamKey {
			return httpsRecord{}, errors.New("malformed HTTPS record contains out-of-order SvcParamKey")
		}
		lastSvcParamKey = svcParamKey

		switch svcParamKey {
		case httpsKeyMandatory:
			if svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed mandatory SvcParamValue")
			}
			var lastKey uint16
			for !svcParamValue.Empty() {
				// |httpsKeyMandatory| may not appear in the mandatory list.
				// |httpsKeyMandatory| is zero, so checking against the initial
				// value of |lastKey| handles ordering and the invalid code point.
				var key uint16
				if !svcParamValue.ReadUint16(&key) ||
					key <= lastKey {
					return httpsRecord{}, errors.New("malformed mandatory SvcParamValue")
				}
				lastKey = key
				record.mandatory = append(record.mandatory, key)
			}
		case httpsKeyALPN:
			if svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed alpn SvcParamValue")
			}
			for !svcParamValue.Empty() {
				var alpn cryptobyte.String
				if !svcParamValue.ReadUint8LengthPrefixed(&alpn) || alpn.Empty() {
					return httpsRecord{}, errors.New("malformed alpn SvcParamValue")
				}
				record.alpn = append(record.alpn, string(alpn))
			}
		case httpsKeyNoDefaultALPN:
			if !svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed no-default-alpn SvcParamValue")
			}
			record.noDefaultALPN = true
		case httpsKeyPort:
			if !svcParamValue.ReadUint16(&record.port) ||
				!svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed port SvcParamValue")
			}
			record.hasPort = true
		case httpsKeyIPV4Hint:
			if svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed ipv4hint SvcParamValue")
			}
			for !svcParamValue.Empty() {
				var address []byte
				if !svcParamValue.ReadBytes(&address, 4) {
					return httpsRecord{}, errors.New("malformed ipv4hint SvcParamValue")
				}
				record.ipv4hint = append(record.ipv4hint, address)
			}
		case httpsKeyECH:
			if svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed ech SvcParamValue")
			}
			record.ech = svcParamValue
		case httpsKeyIPV6Hint:
			if svcParamValue.Empty() {
				return httpsRecord{}, errors.New("malformed ipv6hint SvcParamValue")
			}
			for !svcParamValue.Empty() {
				var address []byte
				if !svcParamValue.ReadBytes(&address, 16) {
					return httpsRecord{}, errors.New("malformed ipv6hint SvcParamValue")
				}
				record.ipv6hint = append(record.ipv6hint, address)
			}
		default:
			record.unknownParams[svcParamKey] = svcParamValue
		}
	}
	return record, nil
}

func main() {
	flag.Parse()
	log.SetFlags(log.Lshortfile | log.LstdFlags)

	if len(*name) == 0 {
		flag.Usage()
		os.Exit(1)
	}

	httpsRecords, err := dnsQueryForHTTPS(*name)
	if err != nil {
		log.Printf("Error querying %q: %s\n", *name, err)
		os.Exit(1)
	}
	if len(httpsRecords) == 0 {
		log.Println("No HTTPS records found in DNS response.")
		os.Exit(1)
	}

	if len(*outDir) > 0 {
		if err = os.Mkdir(*outDir, 0755); err != nil && !os.IsExist(err) {
			log.Printf("Failed to create out directory %q: %s\n", *outDir, err)
			os.Exit(1)
		}
	}

	var echConfigListCount int
	for _, httpsRecord := range httpsRecords {
		record, err := parseHTTPSRecord(httpsRecord)
		if err != nil {
			log.Printf("Failed to parse HTTPS record: %s", err)
			os.Exit(1)
		}
		fmt.Printf("%s\n", record)
		if len(*outDir) == 0 {
			continue
		}

		outFile := path.Join(*outDir, fmt.Sprintf("ech-config-list-%d", echConfigListCount))
		if err = os.WriteFile(outFile, record.ech, 0644); err != nil {
			log.Printf("Failed to write file: %s\n", err)
			os.Exit(1)
		}
		fmt.Printf("Wrote ECHConfigList to %q\n", outFile)
		echConfigListCount++
	}
}
