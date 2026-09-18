#!/usr/bin/env python3
"""Local operator CLI; no administrative endpoint is exposed to the browser."""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from access_control import AccessStore, PRIVATE_DIR


def main():
    parser = argparse.ArgumentParser(description="签发、查看或撤销付费 token；明文只写入本地私有文件")
    sub = parser.add_subparsers(dest="command", required=True)
    issue = sub.add_parser("issue")
    issue.add_argument("--label", required=True)
    issue.add_argument("--days", type=float, default=30)
    revoke = sub.add_parser("revoke")
    revoke.add_argument("id")
    sub.add_parser("list")
    args = parser.parse_args()
    store = AccessStore()
    if args.command == "issue":
        issued = store.issue(args.label, args.days)
        path = PRIVATE_DIR / f"token-{issued['id']}.txt"
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(issued["token"] + "\n")
        print(json.dumps({"id": issued["id"], "expires": datetime.fromtimestamp(issued["expires_at"], timezone.utc).isoformat(), "token_file": str(path)}, ensure_ascii=False))
    elif args.command == "revoke":
        if not store.revoke(args.id):
            parser.error("未找到该 token ID")
        print("已撤销 token 及其所有会话；本地签发文件不会自动删除。")
    else:
        print(json.dumps(store.list_tokens(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
