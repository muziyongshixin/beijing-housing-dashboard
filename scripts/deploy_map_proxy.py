#!/usr/bin/env python3
"""Deploy only the approved AMap secrets and function; never print credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "mehbviiakjcbfckonzqk"

def main():
    credentials = json.loads((ROOT / "config/amap.local.json").read_text())
    values = {"AMAP_JS_KEY": credentials["amap_js_key"],
              "AMAP_SECURITY_CODE": credentials["amap_security_code"]}
    if not all(isinstance(v, str) and v.isalnum() and len(v) == 32 for v in values.values()):
        raise ValueError("Invalid local map credentials")
    private = ROOT / ".private"
    private.mkdir(exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=private, prefix="map-secrets-", suffix=".env") as file:
        os.chmod(file.name, 0o600)
        file.write("".join(f"{k}={v}\n" for k, v in values.items()))
        file.flush()
        subprocess.run(["npx", "--yes", "supabase@2.117.0", "secrets", "set",
                        "--project-ref", PROJECT, "--env-file", file.name], cwd=ROOT, check=True)
    subprocess.run(["npx", "--yes", "supabase@2.117.0", "functions", "deploy", "amap-proxy",
                    "--project-ref", PROJECT, "--use-api", "--no-verify-jwt"], cwd=ROOT, check=True)

if __name__ == "__main__":
    main()
