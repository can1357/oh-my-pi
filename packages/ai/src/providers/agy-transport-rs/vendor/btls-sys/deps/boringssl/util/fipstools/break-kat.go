// Copyright 2022 The BoringSSL Authors
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

// break-kat corrupts a known-answer-test input in a binary and writes the
// corrupted binary to stdout. This is used to demonstrate that the KATs in the
// binary notice the error.
package main

import (
	"bytes"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
)

var (
	kats = map[string]string{
		"HMAC-SHA-256":    "dad91293dfcf2a7c8ecd13fe353fa75b",
		"AES-CBC-encrypt": "078609a6c5ac2544699adf682fa377f9be8ab6aef563e8c56a36b84f557fadd3",
		"AES-CBC-decrypt": "347aa5a024b28257b36510be583d4f47adb7bbeedc6005bbbd0d0a9f06bb7b10",
		"AES-GCM-encrypt": "8fcc4099808e75caaff582898848a88d808b55ab4e9370797d940be8cc1d7884",
		"AES-GCM-decrypt": "35f3058f875760ff09d3120f70c4bc9ed7a86872e13452202176f7371ae04faae1dd391920f5d13953d896785994823c",
		"DRBG":            "c4da0740d505f1ee280b95e58c4931ac6de846a0152fbb4a3f174cf4787a4f1a40c2b50babe14aae530be5886d910a27",
		"DRBG-reseed":     "c7161ca36c2309b716e9859bb96c6d49bdc8352103a18cd24ef42ec97ef46bf446eb1a4576c186e9351803763a7912fe",
		"HKDF":            "68678504b9b3add17d5967a1a7bd37993fd8a33ce7303071f39c096d1635b3c9",
		"MLDSA-keygen":    "0c6f387d2ab43387f021b0da816c71f0bc815ef0b16af1124f354c273eedb42fe54a019a",
		"MLDSA-sign":      "f8c725848b39d9d980f02ff7a02419087065e2c80ac4d3d5974931ea7bd664b66e6bf3c7",
		"MLDSA-verify":    "4923cea1293b2400ccc3b19f1e803ed85a0d6e0ba64f35f845f420d848e1858205883fdd",
		"MLKEM-keygen":    "d8c9397c3130d8ecb411a68efcc89a553cb7e6817e0288bd0691609bf5",
		"MLKEM-encap":     "7d9f1cb4ae04d75fa6575ae0e429b573a974b7",
		"MLKEM-decap":     "a3192a8c88fc996d2df9858d2c55363993f0494d7ec0be5a567b8a4243a5745d",
		"SHA-1":           "132fd9bad5c1826263bafbb699f707a5",
		"SHA-256":         "ff3b857da7236a2baa0f396b51522217",
		"SHA-512":         "212512f8d2ad8322781c6c4d69a9daa1",
		"SLHDSA-keygen":   "be6bd7e8e198eaf62d572f13fc79f26f",
		"SLHDSA-sign":     "82d409744d97ae305318469f7b857b91d4e33310b709b550a7c48a46094ec9d4",
		"SLHDSA-verify":   "3fd69193ee9708bdea110ba29f235ff2ec9888d12761f84dc6e3f0d7eb48d05cacf6e87f",
		"TLS10-KDF":       "abc3657b094c7628a0b282996fe75a75f4984fd94d4ecc2fcf53a2c469a3f731",
		"TLS12-KDF":       "c5438ee26fd4acbd259fc91855dc69bf884ee29322fcbfd2966a4623d42ec781",
		"TLS13-KDF":       "024a0d80f357f2499a1244dac26dab66fc13ed85fca71dace146211119525874",
		"RSA-sign":        "d2b56e53306f720d7929d8708bf46f1c22300305582b115bedcac722d8aa5ab2",
		"RSA-verify":      "abe2cbc13d6bd39d48db5334ddbf8d070a93bdcb104e2cc5d0ee486ee295f6b31bda126c41890b98b73e70e6b65d82f95c663121755a90744c8d1c21148a1960be0eca446e9ff497f1345c537ef8119b9a4398e95c5c6de2b1c955905c5299d8ce7a3b6ab76380d9babdd15f610237e1f3f2aa1c1f1e770b62fbb596381b2ebdd77ecef9c90d4c92f7b6b05fed2936285fa94826e62055322a33b6f04c74ce69e5d8d737fb838b79d2d48e3daf71387531882531a95ac964d02ea413bf85952982bbc089527daff5b845c9a0f4d14ef1956d9c3acae882d12da66da0f35794f5ee32232333517db9315232a183b991654dbea41615345c885325926744a53915",
		"ECDSA-sign":      "1e35930be860d0942ca7bbd6f6ded87f157e4de24f81ed4b875c0e018e89a81f",
		"ECDSA-verify":    "6780c5fc70275e2c7061a0e7877bb174deadeb9887027f3fa83654158ba7f50c2d36e5799790bfbe2183d33e96f3c51f6a232f2a24488c8e5f64c37ea2cf0529",
		"Z-computation":   "e7604491269afb5b102d6ea52cb59feb70aede6ce3bfb3e0105485abd861d77b",
		"FFDH":            "a14f8ad36be37b18b8f35864392f150ab7ee22c47e1870052a3f17918274af18aaeaf4cf6aacfde96c9d586eb7ebaff6b03fe3b79a8e2ff9dd6df34caaf2ac70fd3771d026b41a561ee90e4337d0575f8a0bd160c868e7e3cef88aa1d88448b1e4742ba11480a9f8a8b737347c408d74a7d57598c48875629df0c85327a124ddec1ad50cd597a985588434ce19c6f044a1696b5f244b899b7e77d4f6f20213ae8eb15d37eb8e67e6c8bdbc4fd6e17426283da96f23a897b210058c7c70fb126a5bf606dbeb1a6d5cca04184c4e95c2e8a70f50f5c1eabd066bd79c180456316ac02d366eb3b0e7ba82fb70dcbd737ca55734579dd250fffa8e0584be99d32b35",
	}

	listTests = flag.Bool("list-tests", false, "List known test values and exit")
)

func main() {
	flag.Parse()

	if *listTests {
		for _, kat := range sortedKATs() {
			fmt.Println(kat)
		}
		os.Exit(0)
	}

	if flag.NArg() == 0 || flag.NArg() > 2 || (flag.NArg() == 2 && kats[flag.Arg(1)] == "") {
		fmt.Fprintln(os.Stderr, "Usage: break-kat <binary path> <test to break> > output")
		fmt.Fprintln(os.Stderr, "       break-kat <binary path>  (to run all tests)")
		fmt.Fprintln(os.Stderr, "Possible values for <test to break>:")
		for _, kat := range sortedKATs() {
			fmt.Fprintln(os.Stderr, " ", kat)
		}
		os.Exit(1)
	}

	inPath := flag.Arg(0)
	binaryContents, err := os.ReadFile(inPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if flag.NArg() == 2 {
		breakBinary(binaryContents, flag.Arg(1), os.Stdout)
		return
	}

	for _, test := range sortedKATs() {
		fmt.Printf("\n### Running test for %q\n\n", test)

		const outFile = "test_fips_broken"
		output, err := os.OpenFile(outFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
		if err != nil {
			panic(err)
		}
		breakBinary(binaryContents, test, output)
		output.Close()

		cmd := exec.Command("./" + outFile)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stdout
		if err := cmd.Run(); err != nil {
			fmt.Printf("(task failed with: %s)\n", err)
		} else {
			fmt.Println("(task exec successful)")
		}
		os.Remove(outFile)
	}

	for _, test := range []string{"ECDSA_PWCT", "RSA_PWCT", "MLDSA_PWCT", "MLKEM_PWCT", "SLHDSA_PWCT", "CRNG"} {
		fmt.Printf("\n### Running test for %q\n\n", test)

		cmd := exec.Command("./" + inPath)
		cmd.Env = append(cmd.Environ(), "BORINGSSL_FIPS_BREAK_TEST="+test)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stdout
		if err := cmd.Run(); err != nil {
			fmt.Printf("(task failed with: %s)\n", err)
		} else {
			fmt.Println("(task exec successful)")
		}
	}
}

func breakBinary(binaryContents []byte, test string, output io.Writer) {
	testInputValue, err := hex.DecodeString(kats[test])
	if err != nil {
		panic("invalid KAT data: " + err.Error())
	}

	brokenContents := make([]byte, len(binaryContents))
	copy(brokenContents, binaryContents)

	found := false
	for {
		i := bytes.Index(brokenContents, testInputValue)
		if i < 0 {
			break
		}
		found = true

		// Zero out the entire value because the compiler may produce code
		// where parts of the value are embedded in the instructions.
		// See crbug.com/399818730
		for j := range testInputValue {
			brokenContents[i+j] = 0
		}
	}

	if !found {
		fmt.Fprintln(os.Stderr, "Expected test input value for", test, "was not found in binary.")
		os.Exit(3)
	}

	if n, err := output.Write(brokenContents); err != nil || n != len(brokenContents) {
		fmt.Fprintf(os.Stderr, "Bad write: %s (%d vs expected %d)\n", err, n, len(brokenContents))
		os.Exit(1)
	}
}

func sortedKATs() []string {
	var ret []string
	for kat := range kats {
		ret = append(ret, kat)
	}
	sort.Strings(ret)
	return ret
}
