#!/bin/bash
#
# Import SQLite databases into Sootio Docker container
#
# Usage: ./scripts/import-sqlite.sh [source-directory]
#

set -e

# Configuration
CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
SOURCE_DIR="${1:-./sqlite-backup}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Sootio SQLite Database Import ===${NC}"
echo ""

# Check if source directory exists
if [ ! -d "${SOURCE_DIR}" ]; then
    echo -e "${RED}Error: Source directory '${SOURCE_DIR}' does not exist${NC}"
    exit 1
fi

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Warning: Container '${CONTAINER_NAME}' is not running${NC}"
    echo "Attempting to start container..."
    docker start "${CONTAINER_NAME}" || {
        echo -e "${RED}Failed to start container${NC}"
        exit 1
    }
    echo "Waiting for container to be ready..."
    sleep 3
fi

echo -e "Source directory: ${YELLOW}${SOURCE_DIR}${NC}"
echo ""

# Confirmation prompt
echo -e "${YELLOW}WARNING: This will overwrite existing databases in the container!${NC}"
read -p "Continue? (yes/no): " -r
echo ""
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Import cancelled."
    exit 0
fi

# List of databases to import
DATABASES=("cache.db" "hash-cache.db" "performance.db")
IMPORTED_COUNT=0

# Stop the application temporarily to prevent database locks
echo -e "${YELLOW}Stopping Sootio application...${NC}"
docker exec "${CONTAINER_NAME}" sh -c "pkill -f 'node.*start' || true" 2>/dev/null || true
sleep 2

# Import each database
for db in "${DATABASES[@]}"; do
    # Look for the latest version of this database
    SOURCE_FILE=""

    # Check for .latest symlink first
    if [ -L "${SOURCE_DIR}/${db}.latest" ]; then
        SOURCE_FILE=$(readlink -f "${SOURCE_DIR}/${db}.latest")
    # Otherwise find the most recent timestamped version
    elif ls "${SOURCE_DIR}/${db}".* 2>/dev/null | grep -q .; then
        SOURCE_FILE=$(ls -t "${SOURCE_DIR}/${db}".* | head -1)
    # Check for exact filename match
    elif [ -f "${SOURCE_DIR}/${db}" ]; then
        SOURCE_FILE="${SOURCE_DIR}/${db}"
    fi

    if [ -n "${SOURCE_FILE}" ] && [ -f "${SOURCE_FILE}" ]; then
        echo -e "${GREEN}Importing ${db}...${NC}"

        TEMP_NAME="${db}.import.$(date +%s).$$"
        TEMP_PATH="/tmp/${TEMP_NAME}"

        # Copy database to container temp location for verification
        docker cp "${SOURCE_FILE}" "${CONTAINER_NAME}:${TEMP_PATH}"

        # Verify database integrity inside the container to avoid local sqlite dependency
        echo -e "  ${YELLOW}Verifying database integrity...${NC}"
        INTEGRITY_CHECK=$(docker exec "${CONTAINER_NAME}" sh -c "sqlite3 '${TEMP_PATH}' 'PRAGMA integrity_check;'" 2>&1 || echo "FAILED")

        if [[ "${INTEGRITY_CHECK}" != *"ok"* ]]; then
            echo -e "  ${RED}✗ Database integrity check failed for ${SOURCE_FILE}${NC}"
            echo -e "  ${YELLOW}Skipping import of corrupted database${NC}"
            echo -e "  ${YELLOW}Please use a different backup or run recovery script${NC}"
            echo -e "  ${YELLOW}Details: ${INTEGRITY_CHECK}${NC}"
            docker exec "${CONTAINER_NAME}" sh -c "rm -f '${TEMP_PATH}'" 2>/dev/null || true
            continue
        fi
        echo -e "  ${GREEN}✓ Database integrity verified${NC}"

        # Backup existing database in container (including WAL/SHM files)
        docker exec "${CONTAINER_NAME}" sh -c "if [ -f /app/data/${db} ]; then mv /app/data/${db} /app/data/${db}.backup.\$(date +%s); fi" 2>/dev/null || true

        # CRITICAL: Remove old WAL and SHM files to prevent corruption
        docker exec "${CONTAINER_NAME}" sh -c "rm -f /app/data/${db}-wal /app/data/${db}-shm" 2>/dev/null || true

        # Move verified database into place
        docker exec "${CONTAINER_NAME}" sh -c "mv '${TEMP_PATH}' '/app/data/${db}'"

        # Set proper permissions
        docker exec "${CONTAINER_NAME}" chown 1000:1000 "/app/data/${db}" 2>/dev/null || true

        # Checkpoint WAL if database uses WAL mode
        docker exec "${CONTAINER_NAME}" sh -c "sqlite3 /app/data/${db} 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true"

        SIZE=$(du -h "${SOURCE_FILE}" | cut -f1)
        echo -e "  ${GREEN}✓ Imported: ${db} (${SIZE})${NC}"
        ((IMPORTED_COUNT++))
    else
        echo -e "  ${YELLOW}⊘ Skipped: ${db} not found in source directory${NC}"
    fi
done

echo ""

if [ ${IMPORTED_COUNT} -gt 0 ]; then
    echo -e "${GREEN}=== Import Complete ===${NC}"
    echo -e "${YELLOW}Restarting Sootio application...${NC}"
    docker restart "${CONTAINER_NAME}"
    echo ""
    echo -e "${GREEN}Database import successful!${NC}"
    echo "Check logs with: docker logs -f ${CONTAINER_NAME}"
else
    echo -e "${YELLOW}No databases were imported.${NC}"
    echo -e "Restarting Sootio application..."
    docker restart "${CONTAINER_NAME}"
fi
