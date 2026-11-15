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

// testmodulewrapper is a modulewrapper binary that works with acvptool and
// implements the primitives that BoringSSL's modulewrapper doesn't, so that
// we have something that can exercise all the code in avcptool.

package main

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha3"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"

	"filippo.io/edwards25519"

	"golang.org/x/crypto/xts"
)

var (
	output       io.Writer
	outputBuffer *bytes.Buffer
)

var handlers = map[string]func([][]byte) error{
	"flush":                    flush,
	"getConfig":                getConfig,
	"KDF-counter":              kdfCounter,
	"AES-XTS/encrypt":          xtsEncrypt,
	"AES-XTS/decrypt":          xtsDecrypt,
	"HKDF/SHA2-256":            hkdfMAC,
	"hmacDRBG-reseed/SHA2-256": hmacDRBGReseed,
	"hmacDRBG-pr/SHA2-256":     hmacDRBGPredictionResistance,
	"AES-CBC-CS3/encrypt":      ctsEncrypt,
	"AES-CBC-CS3/decrypt":      ctsDecrypt,
	"PBKDF":                    pbkdf,
	"EDDSA/keyGen":             eddsaKeyGen,
	"EDDSA/keyVer":             eddsaKeyVer,
	"EDDSA/sigGen":             eddsaSigGen,
	"EDDSA/sigVer":             eddsaSigVer,
	"SHAKE-128":                shakeAftVot(sha3.NewSHAKE128),
	"SHAKE-128/VOT":            shakeAftVot(sha3.NewSHAKE128),
	"SHAKE-128/MCT":            shakeMct(sha3.NewSHAKE128),
	"SHAKE-256":                shakeAftVot(sha3.NewSHAKE256),
	"SHAKE-256/VOT":            shakeAftVot(sha3.NewSHAKE256),
	"SHAKE-256/MCT":            shakeMct(sha3.NewSHAKE256),
	"cSHAKE-128":               cShakeAft(sha3.NewCSHAKE128),
	"cSHAKE-128/MCT":           cShakeMct(sha3.NewCSHAKE128),
	"cSHAKE-256":               cShakeAft(sha3.NewCSHAKE256),
	"cSHAKE-256/MCT":           cShakeMct(sha3.NewCSHAKE256),
}

func flush(args [][]byte) error {
	if outputBuffer == nil {
		return nil
	}

	if _, err := os.Stdout.Write(outputBuffer.Bytes()); err != nil {
		return err
	}
	outputBuffer = new(bytes.Buffer)
	output = outputBuffer
	return nil
}

func getConfig(args [][]byte) error {
	if len(args) != 0 {
		return fmt.Errorf("getConfig received %d args", len(args))
	}

	if err := reply([]byte(`[
	{
		"algorithm": "acvptool",
		"features": ["batch"]
	}, {
		"algorithm": "KDF",
		"revision": "1.0",
		"capabilities": [{
			"kdfMode": "counter",
			"macMode": [
				"HMAC-SHA2-256"
			],
			"supportedLengths": [{
				"min": 8,
				"max": 4096,
				"increment": 8
			}],
			"fixedDataOrder": [
				"before fixed data"
			],
			"counterLength": [
				32
			]
		}]
	}, {
		"algorithm": "ACVP-AES-XTS",
		"revision": "1.0",
		"direction": [
		  "encrypt",
		  "decrypt"
		],
		"keyLen": [
		  128,
		  256
		],
		"payloadLen": [
		  1024
		],
		"tweakMode": [
		  "number"
		]
	}, {
		"algorithm": "KDA",
		"mode": "HKDF",
		"revision": "Sp800-56Cr1",
		"fixedInfoPattern": "uPartyInfo||vPartyInfo",
		"encoding": [
			"concatenation"
		],
		"hmacAlg": [
			"SHA2-256"
		],
		"macSaltMethods": [
			"default",
			"random"
		],
		"l": 256,
		"z": [256, 384]
	}, {
		"algorithm": "hmacDRBG",
		"revision": "1.0",
		"predResistanceEnabled": [false, true],
		"reseedImplemented": true,
		"capabilities": [{
			"mode": "SHA2-256",
			"derFuncEnabled": false,
			"entropyInputLen": [
				256
			],
			"nonceLen": [
				128
			],
			"persoStringLen": [
				256
			],
			"additionalInputLen": [
				256
			],
			"returnedBitsLen": 256
		}]
	}, {
		"algorithm": "ACVP-AES-CBC-CS3",
		"revision": "1.0",
		"payloadLen": [{
			"min": 128,
			"max": 2048,
			"increment": 8
		}],
		"direction": [
		  "encrypt",
		  "decrypt"
		],
		"keyLen": [
		  128,
		  256
		]
	}, {
		"algorithm": "PBKDF",
		"revision":"1.0",
		"capabilities": [{
			"iterationCount":[{
				"min":1,
				"max":10000,
				"increment":1
			}],
			"keyLen": [{
				"min":112,
				"max":4096,
				"increment":8
			}],
			"passwordLen":[{
				"min":8,
				"max":64,
				"increment":1
			}],
			"saltLen":[{
				"min":128,
				"max":512,
				"increment":8
			}],
			"hmacAlg":[
				"SHA2-224",
				"SHA2-256",
				"SHA2-384",
				"SHA2-512",
				"SHA2-512/224",
				"SHA2-512/256",
				"SHA3-224",
				"SHA3-256",
				"SHA3-384",
				"SHA3-512"
			]
		}]
	}, {
		"algorithm": "EDDSA",
		"mode": "keyVer",
		"revision": "1.0",
		"curve": ["ED-25519"]
	}, {
		"algorithm": "EDDSA",
		"mode": "sigVer",
		"revision": "1.0",
		"pure": true,
		"preHash": true,
		"curve": ["ED-25519"]
	}, {
		"algorithm": "SHAKE-128",
		"inBit": false,
		"outBit": false,
		"inEmpty": false,
		"outputLen": [{
			"min": 128,
			"max": 4096,
			"increment": 8
		}],
		"revision": "1.0"
	}, {
		"algorithm": "SHAKE-256",
		"inBit": false,
		"outBit": false,
		"inEmpty": false,
		"outputLen": [{
			"min": 128,
			"max": 4096,
			"increment": 8
		}],
		"revision": "1.0"
	}, {
		"algorithm": "cSHAKE-128",
		"hexCustomization": false,
		"outputLen": [{
			"min": 16,
			"max": 65536,
			"increment": 8
		}],
		"msgLen": [{
			"min": 0,
			"max": 65536,
			"increment": 8
		}],
		"revision": "1.0"
	}, {
		"algorithm": "cSHAKE-256",
		"hexCustomization": false,
		"outputLen": [{
			"min": 16,
			"max": 65536,
			"increment": 8
		}],
		"msgLen": [{
			"min": 0,
			"max": 65536,
			"increment": 8
		}],
		"revision": "1.0"
	}
]`)); err != nil {
		return err
	}

	return flush(nil)
}

func kdfCounter(args [][]byte) error {
	if len(args) != 5 {
		return fmt.Errorf("KDF received %d args", len(args))
	}

	outputBytes32, prf, counterLocation, key, counterBits32 := args[0], args[1], args[2], args[3], args[4]
	outputBytes := binary.LittleEndian.Uint32(outputBytes32)
	counterBits := binary.LittleEndian.Uint32(counterBits32)

	if !bytes.Equal(prf, []byte("HMAC-SHA2-256")) {
		return fmt.Errorf("KDF received unsupported PRF %q", string(prf))
	}
	if !bytes.Equal(counterLocation, []byte("before fixed data")) {
		return fmt.Errorf("KDF received unsupported counter location %q", counterLocation)
	}
	if counterBits != 32 {
		return fmt.Errorf("KDF received unsupported counter length %d", counterBits)
	}

	if len(key) == 0 {
		key = make([]byte, 32)
		rand.Reader.Read(key)
	}

	// See https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-108.pdf section 5.1
	if outputBytes+31 < outputBytes {
		return fmt.Errorf("KDF received excessive output length %d", outputBytes)
	}

	n := (outputBytes + 31) / 32
	result := make([]byte, 0, 32*n)
	mac := hmac.New(sha256.New, key)
	var input [4 + 8]byte
	var digest []byte
	rand.Reader.Read(input[4:])
	for i := uint32(1); i <= n; i++ {
		mac.Reset()
		binary.BigEndian.PutUint32(input[:4], i)
		mac.Write(input[:])
		digest = mac.Sum(digest[:0])
		result = append(result, digest...)
	}

	return reply(key, input[4:], result[:outputBytes])
}

func reply(responses ...[]byte) error {
	if len(responses) > maxArgs {
		return fmt.Errorf("%d responses is too many", len(responses))
	}

	var lengths [4 * (1 + maxArgs)]byte
	binary.LittleEndian.PutUint32(lengths[:4], uint32(len(responses)))
	for i, response := range responses {
		binary.LittleEndian.PutUint32(lengths[4*(i+1):4*(i+2)], uint32(len(response)))
	}

	lengthsLength := (1 + len(responses)) * 4
	if n, err := output.Write(lengths[:lengthsLength]); n != lengthsLength || err != nil {
		return fmt.Errorf("write failed: %s", err)
	}

	for _, response := range responses {
		if n, err := output.Write(response); n != len(response) || err != nil {
			return fmt.Errorf("write failed: %s", err)
		}
	}

	return nil
}

func xtsEncrypt(args [][]byte) error {
	return doXTS(args, false)
}

func xtsDecrypt(args [][]byte) error {
	return doXTS(args, true)
}

func doXTS(args [][]byte, decrypt bool) error {
	if len(args) != 3 {
		return fmt.Errorf("XTS received %d args, wanted 3", len(args))
	}
	key := args[0]
	msg := args[1]
	tweak := args[2]

	if len(msg)%16 != 0 {
		return fmt.Errorf("XTS received %d-byte msg, need multiple of 16", len(msg))
	}
	if len(tweak) != 16 {
		return fmt.Errorf("XTS received %d-byte tweak, wanted 16", len(tweak))
	}

	var zeros [8]byte
	if !bytes.Equal(tweak[8:], zeros[:]) {
		return errors.New("XTS received tweak with invalid structure. Ensure that configuration specifies a 'number' tweak")
	}

	sectorNum := binary.LittleEndian.Uint64(tweak[:8])

	c, err := xts.NewCipher(aes.NewCipher, key)
	if err != nil {
		return err
	}

	if decrypt {
		c.Decrypt(msg, msg, sectorNum)
	} else {
		c.Encrypt(msg, msg, sectorNum)
	}

	return reply(msg)
}

func hkdfMAC(args [][]byte) error {
	if len(args) != 4 {
		return fmt.Errorf("HKDF received %d args, wanted 4", len(args))
	}

	key := args[0]
	salt := args[1]
	info := args[2]
	lengthBytes := args[3]

	if len(lengthBytes) != 4 {
		return fmt.Errorf("uint32 length was %d bytes long", len(lengthBytes))
	}

	length := binary.LittleEndian.Uint32(lengthBytes)

	ret, err := hkdf.Key(sha256.New, key, salt, string(info), int(length))
	if err != nil {
		return err
	}

	return reply(ret)
}

func hmacDRBGReseed(args [][]byte) error {
	if len(args) != 8 {
		return fmt.Errorf("hmacDRBG received %d args, wanted 8", len(args))
	}

	outLenBytes, entropy, personalisation, reseedAdditionalData, reseedEntropy, additionalData1, additionalData2, nonce := args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]

	if len(outLenBytes) != 4 {
		return fmt.Errorf("uint32 length was %d bytes long", len(outLenBytes))
	}
	outLen := binary.LittleEndian.Uint32(outLenBytes)
	out := make([]byte, outLen)

	drbg := NewHMACDRBG(entropy, nonce, personalisation)
	drbg.Reseed(reseedEntropy, reseedAdditionalData)
	drbg.Generate(out, additionalData1)
	drbg.Generate(out, additionalData2)

	return reply(out)
}

func hmacDRBGPredictionResistance(args [][]byte) error {
	if len(args) != 8 {
		return fmt.Errorf("hmacDRBG received %d args, wanted 8", len(args))
	}

	outLenBytes, entropy, personalisation, additionalData1, entropy1, additionalData2, entropy2, nonce := args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]

	if len(outLenBytes) != 4 {
		return fmt.Errorf("uint32 length was %d bytes long", len(outLenBytes))
	}
	outLen := binary.LittleEndian.Uint32(outLenBytes)
	out := make([]byte, outLen)

	drbg := NewHMACDRBG(entropy, nonce, personalisation)
	drbg.Reseed(entropy1, additionalData1)
	drbg.Generate(out, nil)
	drbg.Reseed(entropy2, additionalData2)
	drbg.Generate(out, nil)

	return reply(out)
}

func swapFinalTwoAESBlocks(d []byte) {
	var blockNMinus1 [aes.BlockSize]byte
	copy(blockNMinus1[:], d[len(d)-2*aes.BlockSize:])
	copy(d[len(d)-2*aes.BlockSize:], d[len(d)-aes.BlockSize:])
	copy(d[len(d)-aes.BlockSize:], blockNMinus1[:])
}

func roundUp(n, m int) int {
	return n + (m-(n%m))%m
}

func doCTSEncrypt(key, origPlaintext, iv []byte) []byte {
	// https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38a-add.pdf
	if len(origPlaintext) < aes.BlockSize {
		panic("input too small")
	}

	plaintext := make([]byte, roundUp(len(origPlaintext), aes.BlockSize))
	copy(plaintext, origPlaintext)

	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	cbcEncryptor := cipher.NewCBCEncrypter(block, iv)
	cbcEncryptor.CryptBlocks(plaintext, plaintext)
	ciphertext := plaintext

	if len(origPlaintext) > aes.BlockSize {
		swapFinalTwoAESBlocks(ciphertext)

		if len(origPlaintext)%16 != 0 {
			// Truncate the ciphertext
			ciphertext = ciphertext[:len(ciphertext)-aes.BlockSize+(len(origPlaintext)%aes.BlockSize)]
		}
	}

	if len(ciphertext) != len(origPlaintext) {
		panic("internal error")
	}

	return ciphertext
}

func doCTSDecrypt(key, origCiphertext, iv []byte) []byte {
	if len(origCiphertext) < aes.BlockSize {
		panic("input too small")
	}

	ciphertext := make([]byte, roundUp(len(origCiphertext), aes.BlockSize))
	copy(ciphertext, origCiphertext)

	if len(ciphertext) > aes.BlockSize {
		swapFinalTwoAESBlocks(ciphertext)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	cbcDecrypter := cipher.NewCBCDecrypter(block, iv)

	var plaintext []byte
	if overhang := len(origCiphertext) % aes.BlockSize; overhang == 0 {
		cbcDecrypter.CryptBlocks(ciphertext, ciphertext)
		plaintext = ciphertext
	} else {
		ciphertext, finalBlock := ciphertext[:len(ciphertext)-aes.BlockSize], ciphertext[len(ciphertext)-aes.BlockSize:]
		var plaintextFinalBlock [aes.BlockSize]byte
		block.Decrypt(plaintextFinalBlock[:], finalBlock)
		copy(ciphertext[len(ciphertext)-aes.BlockSize+overhang:], plaintextFinalBlock[overhang:])
		plaintext = make([]byte, len(origCiphertext))
		cbcDecrypter.CryptBlocks(plaintext, ciphertext)
		for i := 0; i < overhang; i++ {
			plaintextFinalBlock[i] ^= ciphertext[len(ciphertext)-aes.BlockSize+i]
		}
		copy(plaintext[len(ciphertext):], plaintextFinalBlock[:overhang])
	}

	return plaintext
}

func ctsEncrypt(args [][]byte) error {
	if len(args) != 4 {
		return fmt.Errorf("ctsEncrypt received %d args, wanted 4", len(args))
	}

	key, plaintext, iv, numIterations32 := args[0], args[1], args[2], args[3]
	if len(numIterations32) != 4 || binary.LittleEndian.Uint32(numIterations32) != 1 {
		return errors.New("only a single iteration supported for ctsEncrypt")
	}

	if len(plaintext) < aes.BlockSize {
		return fmt.Errorf("ctsEncrypt plaintext too short: %d bytes", len(plaintext))
	}

	return reply(doCTSEncrypt(key, plaintext, iv))
}

func ctsDecrypt(args [][]byte) error {
	if len(args) != 4 {
		return fmt.Errorf("ctsDecrypt received %d args, wanted 4", len(args))
	}

	key, ciphertext, iv, numIterations32 := args[0], args[1], args[2], args[3]
	if len(numIterations32) != 4 || binary.LittleEndian.Uint32(numIterations32) != 1 {
		return errors.New("only a single iteration supported for ctsDecrypt")
	}

	if len(ciphertext) < aes.BlockSize {
		return errors.New("ctsDecrypt ciphertext too short")
	}

	return reply(doCTSDecrypt(key, ciphertext, iv))
}

func pbkdf(args [][]byte) error {
	if len(args) != 5 {
		return fmt.Errorf("pbkdf received %d args, wanted 5", len(args))
	}

	hmacName := args[0]
	var h func() hash.Hash
	switch string(hmacName) {
	case "SHA2-224":
		h = sha256.New224
	case "SHA2-256":
		h = sha256.New
	case "SHA2-384":
		h = sha512.New384
	case "SHA2-512":
		h = sha512.New
	case "SHA2-512/224":
		h = sha512.New512_224
	case "SHA2-512/256":
		h = sha512.New512_256
	case "SHA3-224":
		h = func() hash.Hash { return sha3.New224() }
	case "SHA3-256":
		h = func() hash.Hash { return sha3.New256() }
	case "SHA3-384":
		h = func() hash.Hash { return sha3.New384() }
	case "SHA3-512":
		h = func() hash.Hash { return sha3.New512() }
	default:
		return fmt.Errorf("pbkdf unknown HMAC algorithm: %q", hmacName)
	}
	keyLen := binary.LittleEndian.Uint32(args[1]) / 8
	salt, password := args[2], args[3]
	iterationCount := binary.LittleEndian.Uint32(args[4])

	derivedKey, err := pbkdf2.Key(h, string(password), salt, int(iterationCount), int(keyLen))
	if err != nil {
		return err
	}

	return reply(derivedKey)
}

func eddsaKeyGen(args [][]byte) error {
	if string(args[0]) != "ED-25519" {
		return fmt.Errorf("unsupported EDDSA curve: %q", args[0])
	}

	pk, sk, err := ed25519.GenerateKey(nil)
	if err != nil {
		return fmt.Errorf("generating EDDSA keypair: %w", err)
	}

	// EDDSA/keyGen/AFT responses are d & q, described[0] as:
	//   d	The encoded private key point
	//   q	The encoded public key point
	//
	// Contrary to the description of a "point", d is the private key
	// seed bytes per FIPS.186-5[1] A.2.3.
	//
	// [0]: https://pages.nist.gov/ACVP/draft-celi-acvp-eddsa.html#section-9.1
	// [1]: https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.186-5.pdf
	return reply(sk.Seed(), pk)
}

func eddsaKeyVer(args [][]byte) error {
	if string(args[0]) != "ED-25519" {
		return fmt.Errorf("unsupported EDDSA curve: %q", args[0])
	}

	if len(args[1]) != ed25519.PublicKeySize {
		return reply([]byte{0})
	}

	// Verify the point is on the curve. The higher-level ed25519 API does
	// this at signature verification time so we have to use the lower-level
	// edwards25519 package to do it here in absence of a signature to verify.
	if _, err := new(edwards25519.Point).SetBytes(args[1]); err != nil {
		return reply([]byte{0})
	}

	return reply([]byte{1})
}

func eddsaSigGen(args [][]byte) error {
	if string(args[0]) != "ED-25519" {
		return fmt.Errorf("unsupported EDDSA curve: %q", args[0])
	}

	sk := ed25519.NewKeyFromSeed(args[1])
	msg := args[2]
	prehash := args[3]
	context := string(args[4])

	var opts ed25519.Options
	if prehash[0] == 1 {
		opts.Hash = crypto.SHA512
		h := sha512.New()
		h.Write(msg)
		msg = h.Sum(nil)
		// With ed25519 the context is only specified for sigGen tests when using prehashing.
		// See https://pages.nist.gov/ACVP/draft-celi-acvp-eddsa.html#section-8.6
		opts.Context = context
	}

	sig, err := sk.Sign(nil, msg, &opts)
	if err != nil {
		return fmt.Errorf("error signing message: %w", err)
	}

	return reply(sig)
}

func eddsaSigVer(args [][]byte) error {
	if string(args[0]) != "ED-25519" {
		return fmt.Errorf("unsupported EDDSA curve: %q", args[0])
	}

	msg := args[1]
	pk := ed25519.PublicKey(args[2])
	sig := args[3]
	prehash := args[4]

	var opts ed25519.Options
	if prehash[0] == 1 {
		opts.Hash = crypto.SHA512
		h := sha512.New()
		h.Write(msg)
		msg = h.Sum(nil)
		// Context is only specified for sigGen, not sigVer.
		// See https://pages.nist.gov/ACVP/draft-celi-acvp-eddsa.html#section-8.6
	}

	if err := ed25519.VerifyWithOptions(pk, msg, sig, &opts); err != nil {
		return reply([]byte{0})
	}

	return reply([]byte{1})
}

func shakeAftVot(digestFn func() *sha3.SHAKE) func([][]byte) error {
	return func(args [][]byte) error {
		if len(args) != 2 {
			return fmt.Errorf("shakeAftVot received %d args, wanted 2", len(args))
		}

		msg := args[0]
		outLenBytes := binary.LittleEndian.Uint32(args[1])

		h := digestFn()
		h.Write(msg)
		digest := make([]byte, outLenBytes)
		h.Read(digest)

		return reply(digest)
	}
}

func shakeMct(digestFn func() *sha3.SHAKE) func([][]byte) error {
	return func(args [][]byte) error {
		if len(args) != 4 {
			return fmt.Errorf("shakeMct received %d args, wanted 4", len(args))
		}

		md := args[0]
		minOutBytes := binary.LittleEndian.Uint32(args[1])
		maxOutBytes := binary.LittleEndian.Uint32(args[2])

		outputLenBytes := binary.LittleEndian.Uint32(args[3])
		if outputLenBytes < 2 {
			return fmt.Errorf("invalid output length: %d", outputLenBytes)
		}

		if maxOutBytes < minOutBytes {
			return fmt.Errorf("invalid maxOutBytes and minOutBytes: %d, %d", maxOutBytes, minOutBytes)
		}

		rangeBytes := maxOutBytes - minOutBytes + 1

		for i := 0; i < 1000; i++ {
			// "The MSG[i] input to SHAKE MUST always contain at least 128 bits. If this is not the case
			// as the previous digest was too short, append empty bits to the rightmost side of the digest."
			boundary := min(len(md), 16)
			msg := make([]byte, 16)
			copy(msg, md[:boundary])

			//  MD[i] = SHAKE(MSG[i], OutputLen * 8)
			h := digestFn()
			h.Write(msg)
			digest := make([]byte, outputLenBytes)
			h.Read(digest)
			md = digest

			// RightmostOutputBits = 16 rightmost bits of MD[i] as an integer
			// OutputLen = minOutBytes + (RightmostOutputBits % Range)
			rightmostOutput := uint32(md[outputLenBytes-2])<<8 | uint32(md[outputLenBytes-1])
			outputLenBytes = minOutBytes + (rightmostOutput % rangeBytes)
		}

		encodedOutputLenBytes := make([]byte, 4)
		binary.LittleEndian.PutUint32(encodedOutputLenBytes, outputLenBytes)

		return reply(md, encodedOutputLenBytes)
	}
}

func cShakeAft(hFn func(N, S []byte) *sha3.SHAKE) func([][]byte) error {
	return func(args [][]byte) error {
		if len(args) != 4 {
			return fmt.Errorf("cShakeAft received %d args, wanted 4", len(args))
		}

		msg := args[0]
		outLenBytes := binary.LittleEndian.Uint32(args[1])
		functionName := args[2]
		customization := args[3]

		h := hFn(functionName, customization)
		h.Write(msg)
		digest := make([]byte, outLenBytes)
		h.Read(digest)

		return reply(digest)
	}
}

func cShakeMct(hFn func(N, S []byte) *sha3.SHAKE) func([][]byte) error {
	return func(args [][]byte) error {
		if len(args) != 6 {
			return fmt.Errorf("cShakeMct received %d args, wanted 6", len(args))
		}

		message := args[0]
		minOutLenBytes := binary.LittleEndian.Uint32(args[1])
		maxOutLenBytes := binary.LittleEndian.Uint32(args[2])
		outputLenBytes := binary.LittleEndian.Uint32(args[3])
		incrementBytes := binary.LittleEndian.Uint32(args[4])
		customization := args[5]

		if outputLenBytes < 2 {
			return fmt.Errorf("invalid output length: %d", outputLenBytes)
		}

		rangeBits := (maxOutLenBytes*8 - minOutLenBytes*8) + 1
		if rangeBits == 0 {
			return fmt.Errorf("invalid maxOutLenBytes and minOutLenBytes: %d, %d", maxOutLenBytes, minOutLenBytes)
		}

		// cSHAKE Monte Carlo test inner loop:
		//   https://pages.nist.gov/ACVP/draft-celi-acvp-xof.html#section-6.2.1
		for i := 0; i < 1000; i++ {
			// InnerMsg = Left(Output[i-1] || ZeroBits(128), 128);
			boundary := min(len(message), 16)
			innerMsg := make([]byte, 16)
			copy(innerMsg, message[:boundary])

			// Output[i] = CSHAKE(InnerMsg, OutputLen, FunctionName, Customization);
			h := hFn(nil, customization) // Note: function name fixed to "" for MCT.
			h.Write(innerMsg)
			digest := make([]byte, outputLenBytes)
			h.Read(digest)
			message = digest

			// Rightmost_Output_bits = Right(Output[i], 16);
			rightmostOutput := digest[outputLenBytes-2:]
			// IMPORTANT: the specification says:
			//   NOTE: For the "Rightmost_Output_bits % Range" operation, the Rightmost_Output_bits bit string
			//   should be interpreted as a little endian-encoded number.
			// This is **a lie**! It has to be interpreted as a big-endian number.
			rightmostOutputBE := binary.BigEndian.Uint16(rightmostOutput)

			// OutputLen = MinOutLen + (floor((Rightmost_Output_bits % Range) / OutLenIncrement) * OutLenIncrement);
			incrementBits := incrementBytes * 8
			outputLenBits := (minOutLenBytes * 8) + (((uint32)(rightmostOutputBE)%rangeBits)/incrementBits)*incrementBits
			outputLenBytes = outputLenBits / 8

			// Customization = BitsToString(InnerMsg || Rightmost_Output_bits);
			msgWithBits := append(innerMsg, rightmostOutput...)
			customization = make([]byte, len(msgWithBits))
			for i, b := range msgWithBits {
				customization[i] = (b % 26) + 65
			}
		}

		encodedOutputLenBytes := make([]byte, 4)
		binary.LittleEndian.PutUint32(encodedOutputLenBytes, outputLenBytes)

		return reply(message, encodedOutputLenBytes, customization)
	}
}

const (
	maxArgs       = 9
	maxArgLength  = 1 << 20
	maxNameLength = 30
)

func main() {
	if err := do(); err != nil {
		fmt.Fprintf(os.Stderr, "%s.\n", err)
		os.Exit(1)
	}
}

func do() error {
	// In order to exercise pipelining, all output is buffered until a "flush".
	outputBuffer = new(bytes.Buffer)
	output = outputBuffer

	var nums [4 * (1 + maxArgs)]byte
	var argLengths [maxArgs]uint32
	var args [maxArgs][]byte
	var argsData []byte

	for {
		if _, err := io.ReadFull(os.Stdin, nums[:8]); err != nil {
			return err
		}

		numArgs := binary.LittleEndian.Uint32(nums[:4])
		if numArgs == 0 {
			return errors.New("Invalid, zero-argument operation requested")
		} else if numArgs > maxArgs {
			return fmt.Errorf("Operation requested with %d args, but %d is the limit", numArgs, maxArgs)
		}

		if numArgs > 1 {
			if _, err := io.ReadFull(os.Stdin, nums[8:4+4*numArgs]); err != nil {
				return err
			}
		}

		input := nums[4:]
		var need uint64
		for i := uint32(0); i < numArgs; i++ {
			argLength := binary.LittleEndian.Uint32(input[:4])
			if i == 0 && argLength > maxNameLength {
				return fmt.Errorf("Operation with name of length %d exceeded limit of %d", argLength, maxNameLength)
			} else if argLength > maxArgLength {
				return fmt.Errorf("Operation with argument of length %d exceeded limit of %d", argLength, maxArgLength)
			}
			need += uint64(argLength)
			argLengths[i] = argLength
			input = input[4:]
		}

		if need > uint64(cap(argsData)) {
			argsData = make([]byte, need)
		} else {
			argsData = argsData[:need]
		}

		if _, err := io.ReadFull(os.Stdin, argsData); err != nil {
			return err
		}

		input = argsData
		for i := uint32(0); i < numArgs; i++ {
			args[i] = input[:argLengths[i]]
			input = input[argLengths[i]:]
		}

		name := string(args[0])
		if handler, ok := handlers[name]; !ok {
			return fmt.Errorf("unknown operation %q", name)
		} else {
			if err := handler(args[1:numArgs]); err != nil {
				return err
			}
		}
	}
}
