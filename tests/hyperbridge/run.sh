#!/usr/bin/env bash
# This file is part of midnight-node.
# Copyright (C) Midnight Foundation
# SPDX-License-Identifier: Apache-2.0
# Licensed under the Apache License, Version 2.0 (the "License");
# You may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
python3 tests/hyperbridge/prepare.py --check-only
export PATH="$ROOT/artifacts/snowbridge/tools/go/bin:$PATH"
if [[ $(uname -s) == Darwin ]]; then export CC=${CC:-/usr/bin/clang}; fi
export SNOWBRIDGE_HYPERBRIDGE=true
export HYPERBRIDGE_KEY=${HYPERBRIDGE_KEY:-$ROOT/artifacts/hyperbridge/program.json}
[[ -f "$HYPERBRIDGE_KEY" ]] || { echo 'Run tests/hyperbridge/prepare.sh first' >&2; exit 1; }
python3 tests/snowbridge/pos-test.py
