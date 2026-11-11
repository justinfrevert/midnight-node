#!/usr/bin/env python3
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

"""Fetch pinned upstream sources; refuse changed revisions or dirty checkouts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ART = ROOT / "artifacts/hyperbridge"


def prepare(check_only=False):
    pins = json.loads((HERE / "upstream.json").read_text())
    for pin in pins.values():
        directory = ART / pin["directory"]
        if not (directory / ".git").exists():
            if check_only:
                raise RuntimeError(f"Missing checkout: {directory}")
            subprocess.run(["git", "clone", "--no-checkout", pin["url"], str(directory)], check=True)
            subprocess.run(["git", "-C", str(directory), "checkout", "--detach", pin["revision"]], check=True)
        def git(*args):
            return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()
        if git("rev-parse", "HEAD") != pin["revision"]:
            raise RuntimeError(f"Unexpected revision: {directory}")
        if git("status", "--porcelain", "--untracked-files=normal"):
            raise RuntimeError(f"Upstream source must remain unmodified: {directory}")
        for name, expected in pin["sha256"].items():
            if hashlib.sha256((directory / name).read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"Upstream hash mismatch: {name}")
    if not check_only:
        deps = ART / "deps"
        deps.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(HERE / name, deps / name)
        subprocess.run(["npm", "ci", "--prefix", str(deps), "--ignore-scripts"], check=True)
    print("PASS: pinned Hyperbridge guest, ELF, contracts and SP1 verifier are unmodified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    prepare(parser.parse_args().check_only)
