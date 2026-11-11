#!/usr/bin/env python3
# This file is part of midnight-node.
# Copyright (C) Midnight Foundation
# SPDX-License-Identifier: Apache-2.0
# Licensed under the Apache License, Version 2.0 (the "License");
# You may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#	http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Stage an owned build checkout with explicit PoC dependency overrides.
The main checkout keeps its normal dependency pins and lockfile.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "artifacts/snowbridge"
NODE = Path(os.environ.get("SNOWBRIDGE_BUILD_DIR", str(ART / "node"))).resolve()
assert NODE.is_relative_to(ROOT / "artifacts"), "Build checkout must be inside artifacts"

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

revision = git("rev-parse", "HEAD")
if not NODE.exists():
    subprocess.run(["git", "clone", "--shared", "--no-checkout", str(ROOT), str(NODE)], check=True)
    subprocess.run(["git", "-C", str(NODE), "checkout", "--detach", revision], check=True)
    (NODE / ".snowbridge-build").write_text("owned experimental build checkout\n")
assert (NODE / ".snowbridge-build").is_file(), "Refusing to overwrite an unowned checkout"
build_revision = git("-C", str(NODE), "rev-parse", "HEAD")
subprocess.run(["git", "merge-base", "--is-ancestor", build_revision, revision], cwd=ROOT, check=True)

paths = {"Cargo.toml"}
paths.update(git("diff", "--name-only", build_revision).splitlines())
paths.update(p for p in git("ls-files", "--others", "--exclude-standard").splitlines()
             if p.startswith(("ledger/", "pallets/", "primitives/", "runtime/", "node/", "changes/", "tests/snowbridge/fixtures/")))
manifest = {}
for name in sorted(paths):
    source = ROOT / name
    target = NODE / name
    if not source.is_file():
        if source.exists():
            raise RuntimeError(f"Unsupported source: {name}")
        if target.is_file():
            target.unlink()
        manifest[name] = None
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or target.read_bytes() != source.read_bytes():
        shutil.copyfile(source, target)
    manifest[name] = hashlib.sha256(source.read_bytes()).hexdigest()

# Override only the experimental build checkout, never the normal workspace or Cargo cache.
cargo = (NODE / "Cargo.toml").read_text()
lines = cargo.splitlines()
for index, line in enumerate(lines):
    if line.startswith("midnight-ledger-v9 "):
        lines[index] = f'midnight-ledger-v9 = {{ path = "{ART / "ledger/ledger"}" }}'
    elif line.startswith("v8-to-v9-state-translation ="):
        lines[index] = f'v8-to-v9-state-translation = {{ path = "{ART / "migration/v8-to-v9-state-translation"}" }}'
(NODE / "Cargo.toml").write_text("\n".join(lines) + "\n")
# Host tests consume the same generated Compact evidence as the standalone ledger fixture.
link = NODE / "artifacts/snowbridge"
link.parent.mkdir(exist_ok=True)
if not link.exists():
    link.symlink_to(ART, target_is_directory=True)
assert link.is_symlink() and link.resolve() == ART
(ART / "node-build-sources.json").write_text(json.dumps({"base": build_revision, "sourceRevision": revision, "files": manifest}, indent=2) + "\n")
print(NODE)
