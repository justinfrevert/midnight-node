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
if [[ $(uname -s) == Darwin ]]; then export CC=${CC:-/usr/bin/clang}; fi
python3 tests/hyperbridge/prepare.py
bash tests/snowbridge/prepare-proof.sh
export PATH="$ROOT/artifacts/snowbridge/tools/go/bin:$PATH"
export CARGO_TARGET_DIR="$ROOT/artifacts/snowbridge/sp1-target"
cargo build --locked --release --manifest-path tests/hyperbridge/probe/Cargo.toml
OUT="$ROOT/artifacts/hyperbridge/key-$(date +%s)"
"$CARGO_TARGET_DIR/release/midnight-hyperbridge-probe" execute \
    tests/hyperbridge/fixtures/midnight-live.json \
    artifacts/hyperbridge/sp1-beefy/elf/sp1-beefy-program "$OUT"
cp "$OUT/probe.json" artifacts/hyperbridge/program.json
