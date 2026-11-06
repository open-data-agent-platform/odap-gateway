"""Read detached rollback-mode SQLite snapshots without creating sidecars."""
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3


def distinct_snapshots(restored, reference):
    paths = restored.resolve(strict=True), reference.resolve(strict=True)
    if paths[0].samefile(paths[1]):
        raise ValueError("same input")
    return paths


@contextmanager
def open_snapshot(path, *required_tables):
    # immutable=1 ignores journals. Only use it on standalone, offline rollback-mode copies.
    if not path.is_file() or any(Path(str(path) + suffix).exists()
                                 for suffix in ("-journal", "-wal", "-shm")):
        raise ValueError("not a standalone snapshot")
    with path.open("rb") as src:
        header = src.read(20)
    if header[:16] != b"SQLite format 3\0" or header[18:20] != b"\x01\x01":
        raise ValueError("unsupported snapshot format")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        tables = {name for schema, name, kind, *_ in db.execute("PRAGMA main.table_list")
                  if schema == "main" and kind == "table"}
        if not tables.issuperset(required_tables):
            raise ValueError("missing snapshot table")
        yield db
