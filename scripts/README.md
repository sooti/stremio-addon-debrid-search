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
