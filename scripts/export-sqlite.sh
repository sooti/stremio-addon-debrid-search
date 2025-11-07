#!/bin/bash
#
# Export SQLite databases from Sootio Docker container
#
# Usage: ./scripts/export-sqlite.sh [output-directory]
#

set -e

# Configuration
CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
OUTPUT_DIR="${1:-./sqlite-backup}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Sootio SQLite Database Export ===${NC}"
echo ""

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}Error: Container '${CONTAINER_NAME}' is not running${NC}"
    echo "Available containers:"
    docker ps --format "  - {{.Names}}"
    exit 1
fi

# Create output directory
mkdir -p "${OUTPUT_DIR}"
echo -e "Output directory: ${YELLOW}${OUTPUT_DIR}${NC}"
echo ""

# List of databases to export
DATABASES=("cache.db" "hash-cache.db" "performance.db")

# Export each database
for db in "${DATABASES[@]}"; do
    echo -e "${GREEN}Exporting ${db}...${NC}"

    # Check if database exists in container
    if docker exec "${CONTAINER_NAME}" test -f "/app/data/${db}" 2>/dev/null; then
        # Copy database from container
        docker cp "${CONTAINER_NAME}:/app/data/${db}" "${OUTPUT_DIR}/${db}.${TIMESTAMP}"

        # Create a 'latest' symlink for convenience
        ln -sf "${db}.${TIMESTAMP}" "${OUTPUT_DIR}/${db}.latest"

        # Get file size
        SIZE=$(du -h "${OUTPUT_DIR}/${db}.${TIMESTAMP}" | cut -f1)
        echo -e "  ✓ Exported: ${OUTPUT_DIR}/${db}.${TIMESTAMP} (${SIZE})"
    else
        echo -e "  ${YELLOW}⊘ Skipped: ${db} not found in container${NC}"
    fi
done

echo ""
echo -e "${GREEN}=== Export Complete ===${NC}"
echo ""
echo "Exported files:"
ls -lh "${OUTPUT_DIR}" | grep "\.db\." | awk '{print "  " $9 " (" $5 ")"}'
echo ""
echo -e "To import these databases later, run:"
echo -e "  ${YELLOW}./scripts/import-sqlite.sh ${OUTPUT_DIR}${NC}"
