#!/usr/bin/env python3
"""Read-only test evidence: fingerprints, never database writes or credential output."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

path = Path(sys.argv[1]).resolve()
with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as db:
    encode = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), default=lambda blob: {'blob': blob.hex()}).encode()
    schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
    tables = {}
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        rows = db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall()
        canonical = sorted(encode(row).decode() for row in rows)
        tables[name] = {'rows': len(rows), 'sha256': hashlib.sha256(encode(canonical)).hexdigest()}
    result = {'schemaSha256': hashlib.sha256(encode(schema)).hexdigest(), 'tables': tables}
    result['sha256'] = hashlib.sha256(encode(result)).hexdigest()
    print(json.dumps(result, indent=2))
