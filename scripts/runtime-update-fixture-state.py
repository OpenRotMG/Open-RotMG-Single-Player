#!/usr/bin/env python3
"""Owned QA fixture construction only; mirrors Rust's schema21 fixture, never consumer migration code."""
import json
from pathlib import Path
import sqlite3
import sys

assert len(sys.argv) == 3 and sys.argv[1] == '--schema21'
path = Path(sys.argv[2])
assert path.is_absolute() and path.name == 'game.db' and path.is_file()
with sqlite3.connect(path) as db:
    assert db.execute('PRAGMA user_version').fetchone()[0] == 22
    db.executescript('DROP TABLE portable_history; DROP TABLE portable_consumed_levels; DROP TABLE portable_assists; DROP TABLE account_origins; DROP TABLE save_namespace; PRAGMA user_version=21;')
    db.execute('VACUUM')
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print(json.dumps({'fixture': 'schema21 constructed like Rust account_save tests; not a migration success', 'schema': 21}))
