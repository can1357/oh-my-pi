// Copyright 2020 The BoringSSL Authors
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

package testconfig

import (
	"encoding/json"
	"os"
)

type Test struct {
	Cmd     []string `json:"cmd"`
	Env     []string `json:"env"`
	SkipSDE bool     `json:"skip_sde"`
	Shard   bool     `json:"shard"`
}

func ParseTestConfig(filename string) ([]Test, error) {
	in, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer in.Close()

	decoder := json.NewDecoder(in)
	var result []Test
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}
