#!/bin/bash
#
# Recover corrupted SQLite databases in Sootio Docker container
#
# This script attempts to recover corrupted SQLite databases by:
# 1. Checkpointing the WAL file to merge uncommitted data
# 2. Running integrity checks
# 3. Rebuilding the database if necessary
#
# Usage: ./scripts/recover-sqlite.sh [database-name]
#

set -e

# Configuration
CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
DB_NAME="${1:-cache.db}"
DB_PATH="/app/data/${DB_NAME}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Sootio SQLite Database Recovery ===${NC}"
echo -e "Database: ${YELLOW}${DB_NAME}${NC}"
echo ""

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Container '${CONTAINER_NAME}' is not running. Starting...${NC}"
    docker start "${CONTAINER_NAME}" || {
        echo -e "${RED}Failed to start container${NC}"
        exit 1
    }
    echo "Waiting for container to be ready..."
    sleep 3
fi

# Stop the application to prevent database locks
echo -e "${YELLOW}Stopping Sootio application...${NC}"
docker exec "${CONTAINER_NAME}" sh -c "pkill -f 'node.*start' || true" 2>/dev/null || true
sleep 2

# Check if database exists
if ! docker exec "${CONTAINER_NAME}" test -f "${DB_PATH}" 2>/dev/null; then
    echo -e "${RED}Error: Database ${DB_NAME} not found in container${NC}"
    docker restart "${CONTAINER_NAME}"
    exit 1
fi

echo -e "${BLUE}Step 1: Creating backup of current database...${NC}"
BACKUP_NAME="${DB_NAME}.corrupted.$(date +%s)"
docker exec "${CONTAINER_NAME}" sh -c "cp ${DB_PATH} /app/data/${BACKUP_NAME} 2>/dev/null || true"
docker exec "${CONTAINER_NAME}" sh -c "cp ${DB_PATH}-wal /app/data/${BACKUP_NAME}-wal 2>/dev/null || true"
docker exec "${CONTAINER_NAME}" sh -c "cp ${DB_PATH}-shm /app/data/${BACKUP_NAME}-shm 2>/dev/null || true"
echo -e "${GREEN}✓ Backup created: ${BACKUP_NAME}${NC}"

echo ""
echo -e "${BLUE}Step 2: Attempting to checkpoint WAL file...${NC}"
# Try to checkpoint the WAL file using sqlite3 CLI
docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} 'PRAGMA wal_checkpoint(TRUNCATE);' 2>&1" || {
    echo -e "${YELLOW}⚠ WAL checkpoint failed, attempting recovery...${NC}"
}

echo ""
echo -e "${BLUE}Step 3: Running integrity check...${NC}"
INTEGRITY_RESULT=$(docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} 'PRAGMA integrity_check;' 2>&1" || echo "FAILED")

if [[ "${INTEGRITY_RESULT}" == *"ok"* ]]; then
    echo -e "${GREEN}✓ Database integrity check passed!${NC}"
    echo -e "${GREEN}Database has been successfully recovered.${NC}"
    echo ""
    echo -e "${YELLOW}Restarting Sootio application...${NC}"
    docker restart "${CONTAINER_NAME}"
    echo -e "${GREEN}Recovery complete!${NC}"
    exit 0
else
    echo -e "${RED}✗ Database integrity check failed${NC}"
    echo "${INTEGRITY_RESULT}"
fi

echo ""
echo -e "${BLUE}Step 4: Attempting to dump and rebuild database...${NC}"

# Try to dump as much data as possible
DUMP_FILE="/tmp/${DB_NAME}.dump.sql"
echo "Dumping recoverable data..."
docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} '.recover' > ${DUMP_FILE} 2>&1" || {
    echo -e "${YELLOW}⚠ .recover failed, trying .dump...${NC}"
    docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} '.dump' > ${DUMP_FILE} 2>&1" || {
        echo -e "${RED}✗ Unable to dump database data${NC}"
        echo -e "${YELLOW}The database is too corrupted to recover.${NC}"
        echo -e "${YELLOW}Rebuilding from scratch...${NC}"

        # Remove corrupted database files
        docker exec "${CONTAINER_NAME}" sh -c "rm -f ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm"

        echo -e "${GREEN}✓ Corrupted database removed${NC}"
        echo -e "${BLUE}The application will recreate the database on next start.${NC}"
        echo ""
        echo -e "${YELLOW}Restarting Sootio application...${NC}"
        docker restart "${CONTAINER_NAME}"
        echo ""
        echo -e "${GREEN}Recovery complete!${NC}"
        echo -e "${YELLOW}Note: Cache is empty and will be rebuilt from scratch.${NC}"
        echo -e "Backup of corrupted database: ${BACKUP_NAME}"
        exit 0
    }
}

# If we got here, we have a dump file
echo "Rebuilding database from dump..."

# Remove old database files
docker exec "${CONTAINER_NAME}" sh -c "rm -f ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm"

# Import the dump into a new database
docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} < ${DUMP_FILE}" || {
    echo -e "${RED}✗ Failed to import dump${NC}"
    echo -e "${YELLOW}Rebuilding from scratch...${NC}"
    docker exec "${CONTAINER_NAME}" sh -c "rm -f ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm"
}

# Clean up dump file
docker exec "${CONTAINER_NAME}" sh -c "rm -f ${DUMP_FILE}"

echo ""
echo -e "${BLUE}Step 5: Verifying rebuilt database...${NC}"
VERIFY_RESULT=$(docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} 'PRAGMA integrity_check;' 2>&1" || echo "FAILED")

if [[ "${VERIFY_RESULT}" == *"ok"* ]]; then
    echo -e "${GREEN}✓ Rebuilt database integrity check passed!${NC}"

    # Get table counts
    echo ""
    echo "Database statistics:"
    docker exec "${CONTAINER_NAME}" sh -c "sqlite3 ${DB_PATH} 'SELECT COUNT(*) as records FROM cache;' 2>&1" | while read count; do
        echo -e "  Cache records: ${GREEN}${count}${NC}"
    done
else
    echo -e "${RED}✗ Rebuilt database verification failed${NC}"
    echo -e "${YELLOW}Creating empty database...${NC}"
    docker exec "${CONTAINER_NAME}" sh -c "rm -f ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm"
fi

echo ""
echo -e "${YELLOW}Restarting Sootio application...${NC}"
docker restart "${CONTAINER_NAME}"

echo ""
echo -e "${GREEN}=== Recovery Complete ===${NC}"
echo -e "Backup of corrupted database: ${YELLOW}${BACKUP_NAME}${NC}"
echo ""
echo "Check logs with: docker logs -f ${CONTAINER_NAME}"
