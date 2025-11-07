# Sootio Database Management Scripts

This directory contains utility scripts for managing Sootio's SQLite databases.

## SQLite Export/Import Scripts

### Export Databases

Export all SQLite databases from the running Docker container:

```bash
./scripts/export-sqlite.sh [output-directory]
```

**Examples:**
```bash
# Export to default location (./sqlite-backup)
./scripts/export-sqlite.sh

# Export to custom location
./scripts/export-sqlite.sh /path/to/backup

# Export with custom container name
SOOTIO_CONTAINER=my-sootio ./scripts/export-sqlite.sh
```

**What it exports:**
- `cache.db` - Main cache database (torrent metadata, cached hashes)
- `hash-cache.db` - Hash cache for instant availability
- `performance.db` - Scraper performance metrics

Exported files are timestamped and a `.latest` symlink is created for convenience.

### Import Databases

Import SQLite databases into the Docker container:

```bash
./scripts/import-sqlite.sh [source-directory]
```

**Examples:**
```bash
# Import from default location (./sqlite-backup)
./scripts/import-sqlite.sh

# Import from custom location
./scripts/import-sqlite.sh /path/to/backup

# Import with custom container name
SOOTIO_CONTAINER=my-sootio ./scripts/import-sqlite.sh
```

**Important:**
- The import script will **overwrite** existing databases in the container
- You will be prompted for confirmation before proceeding
- The application will be temporarily stopped during import
- Existing databases are backed up with a timestamp before being replaced
- The container will be restarted after import

### Use Cases

**1. Backup before updates:**
```bash
./scripts/export-sqlite.sh ./backup-before-update
# Update your application
# If something goes wrong:
./scripts/import-sqlite.sh ./backup-before-update
```

**2. Transfer cache between machines:**
```bash
# On machine A:
./scripts/export-sqlite.sh ./transfer

# Copy ./transfer directory to machine B

# On machine B:
./scripts/import-sqlite.sh ./transfer
```

**3. Regular backups (cron):**
```bash
# Add to crontab:
0 2 * * * cd /path/to/sootio && ./scripts/export-sqlite.sh /backups/sootio-db
```

## Environment Variables

- `SOOTIO_CONTAINER` - Docker container name (default: `sootio`)

### Recover Corrupted Databases

If you encounter database corruption errors (e.g., "database disk image is malformed"), use the recovery script:

```bash
./scripts/recover-sqlite.sh [database-name]
```

**Examples:**
```bash
# Recover cache.db (most common)
./scripts/recover-sqlite.sh cache.db

# Recover hash-cache.db
./scripts/recover-sqlite.sh hash-cache.db

# Use custom container name
SOOTIO_CONTAINER=my-sootio ./scripts/recover-sqlite.sh cache.db
```

**What it does:**
1. Creates a backup of the corrupted database
2. Attempts to checkpoint the WAL (Write-Ahead Log) file
3. Runs integrity checks
4. If corrupted, attempts to rebuild from recoverable data
5. If unable to recover, creates a fresh database

**Important:** The script will automatically restart the container after recovery.

## Understanding SQLite WAL Mode

Sootio uses SQLite in WAL (Write-Ahead Log) mode for better performance. This creates three files:
- `cache.db` - Main database file
- `cache.db-wal` - Write-Ahead Log (uncommitted transactions)
- `cache.db-shm` - Shared memory for WAL coordination

**Why databases get corrupted:**
- Exporting while the WAL file has uncommitted data
- Copying database files without checkpointing first
- Improper shutdown during write operations

**Prevention:**
The export script now automatically checkpoints WAL files before export to prevent corruption.

## Troubleshooting

**Container not running:**
The import script will attempt to start the container automatically. If this fails, start it manually:
```bash
docker start sootio
```

**Permission errors:**
The scripts require Docker access. Ensure your user is in the `docker` group or use `sudo`.

**Database locks:**
The import script stops the application temporarily to prevent database locks. If you encounter lock issues, try:
```bash
docker restart sootio
./scripts/import-sqlite.sh
```

**"database disk image is malformed" error:**
This indicates database corruption. Use the recovery script:
```bash
./scripts/recover-sqlite.sh cache.db
```

**After recovery, cache is empty:**
If the database was too corrupted to recover, it will be rebuilt from scratch. This is normal - the cache will repopulate as you use the addon.
