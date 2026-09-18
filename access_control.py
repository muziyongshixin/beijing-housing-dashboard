"""Server-only entitlements. Never distribute this module's state directory."""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path

FREE_THROUGH = "2025-08-31"
PAID_FROM = "2025-09-01"
PRIVATE_DIR = Path(__file__).resolve().parent / ".private"
COOKIE_NAME = "housing_session"
VISITOR_COOKIE = "housing_visitor"
TRIAL_LIMIT = 2


def digest(value: str) -> str:
    # Tokens and sessions are random 256-bit secrets, not user passwords.
    return hashlib.sha256(value.encode()).hexdigest()


class AccessStore:
    def __init__(self, path=PRIVATE_DIR / "access.sqlite3", session_seconds=3600, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.session_seconds = session_seconds
        self.clock = clock
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tokens (
                    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
                    label TEXT NOT NULL, expires_at REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    session_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL, expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token_id);
                CREATE TABLE IF NOT EXISTS visitors (visitor_hash TEXT PRIMARY KEY, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS trials (
                    visitor_hash TEXT NOT NULL, district TEXT NOT NULL, business_area TEXT NOT NULL,
                    community TEXT NOT NULL, PRIMARY KEY(visitor_hash,district,business_area,community)
                );
            """)
        os.chmod(self.path, 0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def issue(self, label: str, days: float = 30):
        if not 0 < days <= 3660:
            raise ValueError("有效期必须在 0 至 3660 天之间")
        token = "bj_" + secrets.token_urlsafe(32)
        token_id = secrets.token_hex(8)
        expires = self.clock() + days * 86400
        with self.connect() as db:
            db.execute("INSERT INTO tokens VALUES (?, ?, ?, ?, 0)", (token_id, digest(token), label, expires))
        return {"id": token_id, "token": token, "expires_at": expires}

    def exchange(self, token: str):
        if not isinstance(token, str) or not 40 <= len(token) <= 128:
            return None
        now = self.clock()
        with self.connect() as db:
            row = db.execute("SELECT id, expires_at FROM tokens WHERE token_hash=? AND revoked=0 AND expires_at>?",
                             (digest(token), now)).fetchone()
            if not row:
                return None
            session = secrets.token_urlsafe(32)
            expires = min(now + self.session_seconds, row[1])
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            # One active browser session per token; exchanging again invalidates the old one.
            db.execute("DELETE FROM sessions WHERE token_id=?", (row[0],))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (digest(session), row[0], expires))
        return {"session": session, "expires_at": expires}

    def resolve(self, session: str):
        if not session or len(session) > 128:
            return None
        now = self.clock()
        with self.connect() as db:
            row = db.execute("""SELECT t.id, MIN(s.expires_at,t.expires_at) FROM sessions s
                JOIN tokens t ON t.id=s.token_id WHERE s.session_hash=? AND s.expires_at>?
                AND t.expires_at>? AND t.revoked=0""", (digest(session), now, now)).fetchone()
        return {"token_id": row[0], "expires_at": row[1]} if row and row[0] else None

    def logout(self, session: str):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE session_hash=?", (digest(session),))

    def revoke(self, token_id: str):
        with self.connect() as db:
            changed = db.execute("UPDATE tokens SET revoked=1 WHERE id=?", (token_id,)).rowcount
            db.execute("DELETE FROM sessions WHERE token_id=?", (token_id,))
        return bool(changed)

    def list_tokens(self):
        with self.connect() as db:
            return [dict(zip(("id", "label", "expires_at", "revoked"), row)) for row in
                    db.execute("SELECT id,label,expires_at,revoked FROM tokens ORDER BY expires_at DESC")]

    def visitor_exists(self, visitor):
        if not visitor or len(visitor) > 128:
            return False
        with self.connect() as db:
            return db.execute("SELECT 1 FROM visitors WHERE visitor_hash=?", (digest(visitor),)).fetchone() is not None

    def new_visitor(self):
        visitor = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("INSERT INTO visitors VALUES (?, ?)", (digest(visitor), self.clock()))
        return visitor

    def trials(self, visitor):
        with self.connect() as db:
            return [dict(zip(("district", "business_area", "community"), row)) for row in db.execute(
                "SELECT district,business_area,community FROM trials WHERE visitor_hash=? ORDER BY rowid", (digest(visitor),))]

    def has_trial(self, visitor, community):
        return community in self.trials(visitor)

    def claim_trial(self, visitor, community):
        if not self.visitor_exists(visitor):
            return False
        key = (digest(visitor), community["district"], community["business_area"], community["community"])
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM trials WHERE visitor_hash=? AND district=? AND business_area=? AND community=?", key).fetchone():
                return True
            count = db.execute("SELECT COUNT(*) FROM trials WHERE visitor_hash=?", (key[0],)).fetchone()[0]
            if count >= TRIAL_LIMIT:
                return False
            db.execute("INSERT INTO trials VALUES (?, ?, ?, ?)", key)
        return True


class RateLimiter:
    """Bounded, per-process limiter. Use an edge limit too for multi-worker deployment."""
    def __init__(self, clock=time.monotonic):
        self.clock, self.lock, self.buckets = clock, threading.Lock(), OrderedDict()

    def allow(self, key, limit, seconds=60):
        now = self.clock()
        with self.lock:
            start, count = self.buckets.pop(key, (now, 0))
            if now - start >= seconds:
                start, count = now, 0
            self.buckets[key] = (start, count + 1)
            while len(self.buckets) > 10000:
                self.buckets.popitem(last=False)
            return count < limit
