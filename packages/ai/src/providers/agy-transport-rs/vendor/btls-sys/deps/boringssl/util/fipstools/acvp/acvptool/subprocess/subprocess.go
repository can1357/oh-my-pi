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

// Package subprocess contains functionality to talk to a modulewrapper for
// testing of various algorithm implementations.
package subprocess

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// Transactable provides an interface to allow test injection of transactions
// that don't call a server.
type Transactable interface {
	Transact(cmd string, expectedResults int, args ...[]byte) ([][]byte, error)
	TransactAsync(cmd string, expectedResults int, args [][]byte, callback func([][]byte) error)
	Barrier(callback func()) error
	Flush() error
}

// Subprocess is a "middle" layer that interacts with a FIPS module via running
// a command and speaking a simple protocol over stdin/stdout.
type Subprocess struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     io.ReadCloser
	primitives map[string]primitive
	// supportsFlush is true if the modulewrapper indicated that it wants to receive flush commands.
	supportsFlush bool
	// pendingReads is a queue of expected responses. `readerRoutine` reads each response and calls the callback in the matching pendingRead.
	pendingReads chan pendingRead
	// readerFinished is a channel that is closed if `readerRoutine` has finished (e.g. because of a read error).
	readerFinished chan struct{}
}

// pendingRead represents an expected response from the modulewrapper.
type pendingRead struct {
	// barrierCallback is called as soon as this pendingRead is the next in the queue, before any read from the modulewrapper.
	barrierCallback func()

	// callback is called with the result from the modulewrapper. If this is nil then no read is performed.
	callback func(result [][]byte) error
	// cmd is the command that requested this read for logging purposes.
	cmd                string
	expectedNumResults int
}

// New returns a new Subprocess middle layer that runs the given binary.
func New(path string) (*Subprocess, error) {
	cmd := exec.Command(path)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	return NewWithIO(cmd, stdin, stdout), nil
}

// maxPending is the maximum number of requests that can be in the pipeline.
const maxPending = 4096

// NewWithIO returns a new Subprocess middle layer with the given ReadCloser and
// WriteCloser. The returned Subprocess will call Wait on the Cmd when closed.
func NewWithIO(cmd *exec.Cmd, in io.WriteCloser, out io.ReadCloser) *Subprocess {
	m := &Subprocess{
		cmd:            cmd,
		stdin:          in,
		stdout:         out,
		pendingReads:   make(chan pendingRead, maxPending),
		readerFinished: make(chan struct{}),
	}

	m.primitives = map[string]primitive{
		"SHA-1":             &hashPrimitive{"SHA-1", 20},
		"SHA2-224":          &hashPrimitive{"SHA2-224", 28},
		"SHA2-256":          &hashPrimitive{"SHA2-256", 32},
		"SHA2-384":          &hashPrimitive{"SHA2-384", 48},
		"SHA2-512":          &hashPrimitive{"SHA2-512", 64},
		"SHA2-512/224":      &hashPrimitive{"SHA2-512/224", 28},
		"SHA2-512/256":      &hashPrimitive{"SHA2-512/256", 32},
		"SHA3-224":          &hashPrimitive{"SHA3-224", 28},
		"SHA3-256":          &hashPrimitive{"SHA3-256", 32},
		"SHA3-384":          &hashPrimitive{"SHA3-384", 48},
		"SHA3-512":          &hashPrimitive{"SHA3-512", 64},
		"SHAKE-128":         &shake{"SHAKE-128", 16},
		"SHAKE-256":         &shake{"SHAKE-256", 32},
		"cSHAKE-128":        &cShake{"cSHAKE-128"},
		"cSHAKE-256":        &cShake{"cSHAKE-256"},
		"ACVP-AES-ECB":      &blockCipher{"AES", 16, 2, true, false, iterateAES},
		"ACVP-AES-CBC":      &blockCipher{"AES-CBC", 16, 2, true, true, iterateAESCBC},
		"ACVP-AES-CBC-CS3":  &blockCipher{"AES-CBC-CS3", 16, 1, false, true, iterateAESCBC},
		"ACVP-AES-CTR":      &blockCipher{"AES-CTR", 16, 1, false, true, nil},
		"ACVP-TDES-ECB":     &blockCipher{"3DES-ECB", 8, 3, true, false, iterate3DES},
		"ACVP-TDES-CBC":     &blockCipher{"3DES-CBC", 8, 3, true, true, iterate3DESCBC},
		"ACVP-AES-XTS":      &xts{},
		"ACVP-AES-GCM":      &aead{"AES-GCM", false},
		"ACVP-AES-GMAC":     &aead{"AES-GCM", false},
		"ACVP-AES-CCM":      &aead{"AES-CCM", true},
		"ACVP-AES-KW":       &aead{"AES-KW", false},
		"ACVP-AES-KWP":      &aead{"AES-KWP", false},
		"HMAC-SHA-1":        &hmacPrimitive{"HMAC-SHA-1", 20},
		"HMAC-SHA2-224":     &hmacPrimitive{"HMAC-SHA2-224", 28},
		"HMAC-SHA2-256":     &hmacPrimitive{"HMAC-SHA2-256", 32},
		"HMAC-SHA2-384":     &hmacPrimitive{"HMAC-SHA2-384", 48},
		"HMAC-SHA2-512":     &hmacPrimitive{"HMAC-SHA2-512", 64},
		"HMAC-SHA2-512/224": &hmacPrimitive{"HMAC-SHA2-512/224", 28},
		"HMAC-SHA2-512/256": &hmacPrimitive{"HMAC-SHA2-512/256", 32},
		"HMAC-SHA3-224":     &hmacPrimitive{"HMAC-SHA3-224", 28},
		"HMAC-SHA3-256":     &hmacPrimitive{"HMAC-SHA3-256", 32},
		"HMAC-SHA3-384":     &hmacPrimitive{"HMAC-SHA3-384", 48},
		"HMAC-SHA3-512":     &hmacPrimitive{"HMAC-SHA3-512", 64},
		"ctrDRBG":           &drbg{"ctrDRBG", map[string]bool{"AES-128": true, "AES-192": true, "AES-256": true}},
		"hmacDRBG":          &drbg{"hmacDRBG", map[string]bool{"SHA-1": true, "SHA2-224": true, "SHA2-256": true, "SHA2-384": true, "SHA2-512": true, "SHA2-512/224": true, "SHA2-512/256": true, "SHA3-224": true, "SHA3-256": true, "SHA3-384": true, "SHA3-512": true}},
		"KDF":               &kdfPrimitive{},
		"KDA":               &multiModeKda{modes: map[string]primitive{"HKDF": &hkdf{}, "OneStepNoCounter": &oneStepNoCounter{}}},
		"TLS-v1.2":          &tlsKDF{},
		"TLS-v1.3":          &tls13{},
		"CMAC-AES":          &keyedMACPrimitive{"CMAC-AES"},
		"RSA":               &rsa{},
		"KAS-ECC-SSC":       &kas{},
		"KAS-FFC-SSC":       &kasDH{},
		"PBKDF":             &pbkdf{},
		"ML-DSA":            &mldsa{},
		"ML-KEM":            &mlkem{},
		"SLH-DSA":           &slhdsa{},
		"kdf-components":    &ssh{},
		"KTS-IFC":           &kts{map[string]bool{"SHA-1": true, "SHA2-224": true, "SHA2-256": true, "SHA2-384": true, "SHA2-512": true, "SHA2-512/224": true, "SHA2-512/256": true, "SHA3-224": true, "SHA3-256": true, "SHA3-384": true, "SHA3-512": true}},
	}
	m.primitives["ECDSA"] = &ecdsa{"ECDSA", map[string]bool{"P-224": true, "P-256": true, "P-384": true, "P-521": true}, m.primitives}
	m.primitives["DetECDSA"] = &ecdsa{"DetECDSA", map[string]bool{"P-224": true, "P-256": true, "P-384": true, "P-521": true}, m.primitives}
	m.primitives["EDDSA"] = &eddsa{"EDDSA", map[string]bool{"ED-25519": true}}

	go m.readerRoutine()
	return m
}

// Close signals the child process to exit and waits for it to complete.
func (m *Subprocess) Close() {
	m.stdout.Close()
	m.stdin.Close()
	m.cmd.Wait()
	close(m.pendingReads)
	<-m.readerFinished
}

func (m *Subprocess) flush() error {
	if !m.supportsFlush {
		return nil
	}

	const cmd = "flush"
	buf := make([]byte, 8, 8+len(cmd))
	binary.LittleEndian.PutUint32(buf, 1)
	binary.LittleEndian.PutUint32(buf[4:], uint32(len(cmd)))
	buf = append(buf, []byte(cmd)...)

	if _, err := m.stdin.Write(buf); err != nil {
		return err
	}
	return nil
}

func (m *Subprocess) enqueueRead(pending pendingRead) error {
	select {
	case <-m.readerFinished:
		panic("attempted to enqueue request after the reader failed")
	default:
	}

	select {
	case m.pendingReads <- pending:
		break
	default:
		// `pendingReads` is full. Ensure that the modulewrapper will process
		// some outstanding requests to free up space in the queue.
		if err := m.flush(); err != nil {
			return err
		}
		m.pendingReads <- pending
	}

	return nil
}

// TransactAsync performs a single request--response pair with the subprocess.
// The callback will run at some future point, in a separate goroutine. All
// callbacks will, however, be run in the order that TransactAsync was called.
// Use Flush to wait for all outstanding callbacks.
func (m *Subprocess) TransactAsync(cmd string, expectedNumResults int, args [][]byte, callback func(result [][]byte) error) {
	if err := m.enqueueRead(pendingRead{nil, callback, cmd, expectedNumResults}); err != nil {
		panic(err)
	}

	argLength := len(cmd)
	for _, arg := range args {
		argLength += len(arg)
	}

	buf := make([]byte, 4*(2+len(args)), 4*(2+len(args))+argLength)
	binary.LittleEndian.PutUint32(buf, uint32(1+len(args)))
	binary.LittleEndian.PutUint32(buf[4:], uint32(len(cmd)))
	for i, arg := range args {
		binary.LittleEndian.PutUint32(buf[4*(i+2):], uint32(len(arg)))
	}
	buf = append(buf, []byte(cmd)...)
	for _, arg := range args {
		buf = append(buf, arg...)
	}

	if _, err := m.stdin.Write(buf); err != nil {
		panic(err)
	}
}

// Flush tells the subprocess to complete all outstanding requests and waits
// for all outstanding TransactAsync callbacks to complete.
func (m *Subprocess) Flush() error {
	if m.supportsFlush {
		m.flush()
	}

	done := make(chan struct{})
	if err := m.enqueueRead(pendingRead{barrierCallback: func() {
		close(done)
	}}); err != nil {
		return err
	}

	<-done
	return nil
}

// Barrier runs callback after all outstanding TransactAsync callbacks have
// been run.
func (m *Subprocess) Barrier(callback func()) error {
	return m.enqueueRead(pendingRead{barrierCallback: callback})
}

func (m *Subprocess) Transact(cmd string, expectedNumResults int, args ...[]byte) ([][]byte, error) {
	done := make(chan struct{})
	var result [][]byte
	m.TransactAsync(cmd, expectedNumResults, args, func(r [][]byte) error {
		result = r
		close(done)
		return nil
	})

	if err := m.flush(); err != nil {
		return nil, err
	}

	select {
	case <-done:
		return result, nil
	case <-m.readerFinished:
		panic("was still waiting for a result when the reader finished")
	}
}

func (m *Subprocess) readerRoutine() {
	defer close(m.readerFinished)

	for pendingRead := range m.pendingReads {
		if pendingRead.barrierCallback != nil {
			pendingRead.barrierCallback()
		}

		if pendingRead.callback == nil {
			continue
		}

		result, err := m.readResult(pendingRead.cmd, pendingRead.expectedNumResults)
		if err != nil {
			panic(fmt.Errorf("failed to read from subprocess: %w", err))
		}

		if err := pendingRead.callback(result); err != nil {
			panic(fmt.Errorf("result from subprocess was rejected: %w", err))
		}
	}
}

func (m *Subprocess) readResult(cmd string, expectedNumResults int) ([][]byte, error) {
	buf := make([]byte, 4)

	if _, err := io.ReadFull(m.stdout, buf); err != nil {
		return nil, err
	}

	numResults := binary.LittleEndian.Uint32(buf)
	if int(numResults) != expectedNumResults {
		return nil, fmt.Errorf("expected %d results from %q but got %d", expectedNumResults, cmd, numResults)
	}

	buf = make([]byte, 4*numResults)
	if _, err := io.ReadFull(m.stdout, buf); err != nil {
		return nil, err
	}

	var resultsLength uint64
	for i := uint32(0); i < numResults; i++ {
		resultsLength += uint64(binary.LittleEndian.Uint32(buf[4*i:]))
	}

	if resultsLength > (1 << 30) {
		return nil, fmt.Errorf("results too large (%d bytes)", resultsLength)
	}

	results := make([]byte, resultsLength)
	if _, err := io.ReadFull(m.stdout, results); err != nil {
		return nil, err
	}

	ret := make([][]byte, 0, numResults)
	var offset int
	for i := uint32(0); i < numResults; i++ {
		length := binary.LittleEndian.Uint32(buf[4*i:])
		ret = append(ret, results[offset:offset+int(length)])
		offset += int(length)
	}

	return ret, nil
}

// Config returns a JSON blob that describes the supported primitives. The
// format of the blob is defined by ACVP. See
// http://usnistgov.github.io/ACVP/artifacts/draft-fussell-acvp-spec-00.html#rfc.section.11.15.2.1
func (m *Subprocess) Config() ([]byte, error) {
	results, err := m.Transact("getConfig", 1)
	if err != nil {
		return nil, err
	}
	var config []struct {
		Algorithm string   `json:"algorithm"`
		Features  []string `json:"features"`
	}
	if err := json.Unmarshal(results[0], &config); err != nil {
		return nil, errors.New("failed to parse config response from wrapper: " + err.Error())
	}
	for _, algo := range config {
		if algo.Algorithm == "acvptool" {
			for _, feature := range algo.Features {
				switch feature {
				case "batch":
					m.supportsFlush = true
				}
			}
		}
	}

	return results[0], nil
}

// Process runs a set of test vectors and returns the result.
func (m *Subprocess) Process(algorithm string, vectorSet []byte) (any, error) {
	prim, ok := m.primitives[algorithm]
	if !ok {
		return nil, fmt.Errorf("unknown algorithm %q", algorithm)
	}
	ret, err := prim.Process(vectorSet, m)
	if err != nil {
		return nil, err
	}
	return ret, nil
}

type primitive interface {
	Process(vectorSet []byte, t Transactable) (any, error)
}

func uint32le(n uint32) []byte {
	var ret [4]byte
	binary.LittleEndian.PutUint32(ret[:], n)
	return ret[:]
}
