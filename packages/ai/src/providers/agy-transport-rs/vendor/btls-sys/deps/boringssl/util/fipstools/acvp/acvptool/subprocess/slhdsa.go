package subprocess

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// Common top-level structure to parse mode
type slhdsaTestVectorSet struct {
	Algorithm string `json:"algorithm"`
	Mode      string `json:"mode"`
	Revision  string `json:"revision"`
}

type slhdsaKeyGenTestVectorSet struct {
	Algorithm string                  `json:"algorithm"`
	Mode      string                  `json:"mode"`
	Revision  string                  `json:"revision"`
	Groups    []slhdsaKeyGenTestGroup `json:"testGroups"`
}

type slhdsaKeyGenTestGroup struct {
	ID           uint64             `json:"tgId"`
	TestType     string             `json:"testType"`
	ParameterSet string             `json:"parameterSet"`
	Tests        []slhdsaKeyGenTest `json:"tests"`
}

type slhdsaKeyGenTest struct {
	ID     uint64 `json:"tcId"`
	SKSeed string `json:"skSeed"`
	SKPrf  string `json:"skPrf"`
	PKSeed string `json:"pkSeed"`
}

type slhdsaKeyGenTestGroupResponse struct {
	ID    uint64                     `json:"tgId"`
	Tests []slhdsaKeyGenTestResponse `json:"tests"`
}

type slhdsaKeyGenTestResponse struct {
	ID         uint64 `json:"tcId"`
	PublicKey  string `json:"pk"`
	PrivateKey string `json:"sk"`
}

type slhdsaSigGenTestVectorSet struct {
	Algorithm string                  `json:"algorithm"`
	Mode      string                  `json:"mode"`
	Revision  string                  `json:"revision"`
	Groups    []slhdsaSigGenTestGroup `json:"testGroups"`
}

type slhdsaSigGenTestGroup struct {
	ID            uint64             `json:"tgId"`
	TestType      string             `json:"testType"`
	ParameterSet  string             `json:"parameterSet"`
	Deterministic bool               `json:"deterministic"`
	Tests         []slhdsaSigGenTest `json:"tests"`
}

type slhdsaSigGenTest struct {
	ID                   uint64 `json:"tcId"`
	Message              string `json:"message"`
	PrivateKey           string `json:"sk"`
	AdditionalRandomness string `json:"additionalRandomness,omitempty"`
}

type slhdsaSigGenTestGroupResponse struct {
	ID    uint64                     `json:"tgId"`
	Tests []slhdsaSigGenTestResponse `json:"tests"`
}

type slhdsaSigGenTestResponse struct {
	ID        uint64 `json:"tcId"`
	Signature string `json:"signature"`
}

type slhdsaSigVerTestVectorSet struct {
	Algorithm string                  `json:"algorithm"`
	Mode      string                  `json:"mode"`
	Revision  string                  `json:"revision"`
	Groups    []slhdsaSigVerTestGroup `json:"testGroups"`
}

type slhdsaSigVerTestGroup struct {
	ID           uint64             `json:"tgId"`
	TestType     string             `json:"testType"`
	ParameterSet string             `json:"parameterSet"`
	Tests        []slhdsaSigVerTest `json:"tests"`
}

type slhdsaSigVerTest struct {
	ID        uint64 `json:"tcId"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
	PublicKey string `json:"pk"`
}

type slhdsaSigVerTestGroupResponse struct {
	ID    uint64                     `json:"tgId"`
	Tests []slhdsaSigVerTestResponse `json:"tests"`
}

type slhdsaSigVerTestResponse struct {
	ID         uint64 `json:"tcId"`
	TestPassed bool   `json:"testPassed"`
}

type slhdsa struct{}

func (s *slhdsa) Process(vectorSet []byte, t Transactable) (any, error) {
	var common slhdsaTestVectorSet
	if err := json.Unmarshal(vectorSet, &common); err != nil {
		return nil, fmt.Errorf("failed to unmarshal vector set: %v", err)
	}

	switch common.Mode {
	case "keyGen":
		return s.processKeyGen(vectorSet, t)
	case "sigGen":
		return s.processSigGen(vectorSet, t)
	case "sigVer":
		return s.processSigVer(vectorSet, t)
	default:
		return nil, fmt.Errorf("unsupported SLH-DSA mode: %s", common.Mode)
	}
}

func (s *slhdsa) processKeyGen(vectorSet []byte, t Transactable) (any, error) {
	var parsed slhdsaKeyGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal keyGen vector set: %v", err)
	}

	var ret []slhdsaKeyGenTestGroupResponse

	for _, group := range parsed.Groups {
		response := slhdsaKeyGenTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "SLH-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/keyGen"

		for _, test := range group.Tests {
			skSeed, err := hex.DecodeString(test.SKSeed)
			if err != nil {
				return nil, fmt.Errorf("failed to decode skSeed in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			skPrf, err := hex.DecodeString(test.SKPrf)
			if err != nil {
				return nil, fmt.Errorf("failed to decode skPrf in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			pkSeed, err := hex.DecodeString(test.PKSeed)
			if err != nil {
				return nil, fmt.Errorf("failed to decode pkSeed in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			var seed []byte
			seed = append(seed, skSeed...)
			seed = append(seed, skPrf...)
			seed = append(seed, pkSeed...)

			result, err := t.Transact(cmdName, 2, seed)
			if err != nil {
				return nil, fmt.Errorf("key generation failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			response.Tests = append(response.Tests, slhdsaKeyGenTestResponse{
				ID:         test.ID,
				PrivateKey: hex.EncodeToString(result[0]),
				PublicKey:  hex.EncodeToString(result[1]),
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}

func (s *slhdsa) processSigGen(vectorSet []byte, t Transactable) (any, error) {
	var parsed slhdsaSigGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sigGen vector set: %v", err)
	}

	var ret []slhdsaSigGenTestGroupResponse

	for _, group := range parsed.Groups {
		response := slhdsaSigGenTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "SLH-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/sigGen"

		for _, test := range group.Tests {
			sk, err := hex.DecodeString(test.PrivateKey)
			if err != nil {
				return nil, fmt.Errorf("failed to decode private key in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			msg, err := hex.DecodeString(test.Message)
			if err != nil {
				return nil, fmt.Errorf("failed to decode message in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			var randomness []byte
			if !group.Deterministic {
				randomness, err = hex.DecodeString(test.AdditionalRandomness)
				if err != nil {
					return nil, fmt.Errorf("failed to decode randomness in test case %d/%d: %s",
						group.ID, test.ID, err)
				}
			}

			result, err := t.Transact(cmdName, 1, sk, msg, randomness)
			if err != nil {
				return nil, fmt.Errorf("signature generation failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			response.Tests = append(response.Tests, slhdsaSigGenTestResponse{
				ID:        test.ID,
				Signature: hex.EncodeToString(result[0]),
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}

func (s *slhdsa) processSigVer(vectorSet []byte, t Transactable) (any, error) {
	var parsed slhdsaSigVerTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sigVer vector set: %v", err)
	}

	var ret []slhdsaSigVerTestGroupResponse

	for _, group := range parsed.Groups {
		response := slhdsaSigVerTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "SLH-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/sigVer"

		for _, test := range group.Tests {
			pk, err := hex.DecodeString(test.PublicKey)
			if err != nil {
				return nil, fmt.Errorf("failed to decode public key in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			msg, err := hex.DecodeString(test.Message)
			if err != nil {
				return nil, fmt.Errorf("failed to decode message in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			sig, err := hex.DecodeString(test.Signature)
			if err != nil {
				return nil, fmt.Errorf("failed to decode signature in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			result, err := t.Transact(cmdName, 1, pk, msg, sig)
			if err != nil {
				return nil, fmt.Errorf("signature verification failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			testPassed := result[0][0] != 0
			response.Tests = append(response.Tests, slhdsaSigVerTestResponse{
				ID:         test.ID,
				TestPassed: testPassed,
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}
