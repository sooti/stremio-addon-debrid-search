#!/bin/bash
#
# Clear SQLite cache entries inside the Sootio Docker container.
# Supports wiping the entire cache or targeting individual services.
#
# Usage examples:
#   ./scripts/clear-sqlite-cache.sh --http-streams
#   ./scripts/clear-sqlite-cache.sh --realdebrid --alldebrid
#   ./scripts/clear-sqlite-cache.sh --all
#   ./scripts/clear-sqlite-cache.sh --service custom-provider
#

set -euo pipefail

CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
DB_PATH="/app/data/cache.db"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Flag -> service mappings
declare -A FLAG_SERVICE_MAP=(
    ["--http-streams"]="hdhub4u"
    ["--realdebrid"]="realdebrid"
    ["--alldebrid"]="alldebrid"
    ["--premiumize"]="premiumize"
    ["--offcloud"]="offcloud"
    ["--torbox"]="torbox"
    ["--debriderapp"]="debriderapp"
    ["--scraper"]="scraper"
)

KNOWN_SERVICE_FLAGS=(
    --http-streams
    --realdebrid
    --alldebrid
    --premiumize
    --offcloud
    --torbox
    --debriderapp
    --scraper
)

# Human friendly labels for services
declare -A SERVICE_LABELS=(
    ["realdebrid"]="Real-Debrid torrents"
    ["alldebrid"]="AllDebrid torrents"
    ["premiumize"]="Premiumize torrents"
    ["offcloud"]="Offcloud torrents"
    ["torbox"]="TorBox torrents"
    ["debriderapp"]="DebriderApp torrents"
    ["scraper"]="Public & specialized scrapers"
    ["hdhub4u"]="HTTP Streams (HDHub4u pages)"
    ["search"]="General search caches"
)

FORCE_CONFIRMATION=false
CLEAR_ALL=false
CLEAR_SEARCH=false
declare -a SERVICES=()
declare -A SERVICE_SET=()

function usage() {
    cat <<'EOF'
Usage: ./scripts/clear-sqlite-cache.sh [options]

Options:
  --all                  Clear every row from cache.db (overrides other options)
  --http-streams         Remove cached HTTP stream pages (HDHub4u)
  --realdebrid           Remove cached torrents for Real-Debrid
  --alldebrid            Remove cached torrents for AllDebrid
  --premiumize           Remove cached torrents for Premiumize
  --offcloud             Remove cached torrents for Offcloud
  --torbox               Remove cached torrents for TorBox
  --debriderapp          Remove cached torrents for DebriderApp
  --scraper              Remove cached scraper search results
  --search-cache         Remove all cached search results regardless of service
  --service <name>       Clear a custom service key (case-insensitive)
  --service=<name>       Same as above
  --list                 Show known flag aliases and exit
  -y, --yes, --force     Skip confirmation prompt
  -h, --help             Show this message

Environment:
  SOOTIO_CONTAINER       Docker container name (default: sootio)

The container will be started automatically if it is not running.
EOF
}

function list_known_services() {
    echo "Known service flags:"
    for flag in "${KNOWN_SERVICE_FLAGS[@]}"; do
        local svc="${FLAG_SERVICE_MAP[$flag]}"
        local label
        label=$(label_for_service "${svc}")
        printf "  %-15s -> %-12s (%s)\n" "${flag}" "${svc}" "${label}"
    done
}

function error_exit() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

function label_for_service() {
    local svc="$1"
    if [[ -n "${SERVICE_LABELS[$svc]:-}" ]]; then
        echo "${SERVICE_LABELS[$svc]}"
    else
        echo "Custom service (${svc})"
    fi
}

function add_service() {
    local svc="$1"
    if [[ -z "${svc}" ]]; then
        return
    fi

    svc=$(echo "${svc}" | tr '[:upper:]' '[:lower:]')

    if [[ ! "${svc}" =~ ^[a-z0-9._-]+$ ]]; then
        error_exit "Invalid service key '${svc}'. Use alphanumeric, dash, underscore, or dot characters."
    fi

    if [[ -n "${SERVICE_SET[$svc]:-}" ]]; then
        return
    fi

    SERVICE_SET["$svc"]=1
    SERVICES+=("$svc")
}

function ensure_container_running() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        return
    fi

    echo -e "${YELLOW}Container '${CONTAINER_NAME}' is not running. Attempting to start...${NC}"
    docker start "${CONTAINER_NAME}" >/dev/null || error_exit "Failed to start container '${CONTAINER_NAME}'"
    echo "Waiting for container to become ready..."
    sleep 3
}

function ensure_database_exists() {
    if ! docker exec "${CONTAINER_NAME}" test -f "${DB_PATH}" 2>/dev/null; then
        error_exit "Database '${DB_PATH}' not found in container. Make sure SQLite cache is enabled."
    fi
}

function clear_all_entries() {
    echo -e "${YELLOW}Clearing all cache entries in ${DB_PATH}...${NC}"
    local deleted
    deleted=$(docker exec "${CONTAINER_NAME}" sqlite3 "${DB_PATH}" "DELETE FROM cache; SELECT changes();")
    deleted=${deleted:-0}
    echo -e "${GREEN}✓ Removed ${deleted} total entries from cache.db${NC}"
}

function clear_search_entries() {
    echo -e "${YELLOW}Clearing cached search results...${NC}"
    local sql="DELETE FROM cache WHERE (releaseKey IS NOT NULL AND (releaseKey LIKE 'search-%' OR releaseKey LIKE '%-search:%')) OR service = 'search'; SELECT changes();"
    local deleted
    deleted=$(docker exec "${CONTAINER_NAME}" sqlite3 "${DB_PATH}" "${sql}")
    deleted=${deleted:-0}
    echo -e "${GREEN}✓ Removed ${deleted} search cache entries${NC}"
}

function clear_service_entries() {
    local svc="$1"
    local label
    label=$(label_for_service "${svc}")
    echo -e "${YELLOW}Clearing ${label} [service: ${svc}]...${NC}"
    local sql
    printf -v sql "DELETE FROM cache WHERE service = '%s'; SELECT changes();" "${svc}"
    local deleted
    deleted=$(docker exec "${CONTAINER_NAME}" sqlite3 "${DB_PATH}" "${sql}")
    deleted=${deleted:-0}
    echo -e "  ${GREEN}✓ ${deleted} entries removed for ${svc}${NC}"
}

# -----------------------------
# Argument parsing
# -----------------------------
if [[ $# -eq 0 ]]; then
    usage
    exit 1
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            CLEAR_ALL=true
            ;;
        --search|--search-cache)
            CLEAR_SEARCH=true
            ;;
        -y|--yes|--force)
            FORCE_CONFIRMATION=true
            ;;
        --list)
            list_known_services
            exit 0
            ;;
        --service)
            shift
            [[ $# -gt 0 ]] || error_exit "Missing value for --service"
            add_service "$1"
            ;;
        --service=*)
            add_service "${1#*=}"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [[ -n "${FLAG_SERVICE_MAP[$1]:-}" ]]; then
                add_service "${FLAG_SERVICE_MAP[$1]}"
            else
                error_exit "Unknown option '$1'"
            fi
            ;;
    esac
    shift
done

if ! $CLEAR_ALL && ! $CLEAR_SEARCH && [[ ${#SERVICES[@]} -eq 0 ]]; then
    error_exit "No cache target specified. Use --help to see available options."
fi

# -----------------------------
# Summary + confirmation
# -----------------------------
echo -e "${GREEN}=== Sootio SQLite Cache Cleaner ===${NC}"
echo -e "Container: ${YELLOW}${CONTAINER_NAME}${NC}"
echo ""

echo "Pending operations:"
if $CLEAR_ALL; then
    echo "  - Clear ALL entries from ${DB_PATH}"
    if $CLEAR_SEARCH || [[ ${#SERVICES[@]} -gt 0 ]]; then
        echo -e "  ${BLUE}Note:${NC} --all overrides other selections; per-service options will be ignored."
    fi
else
    if $CLEAR_SEARCH; then
        echo "  - Clear cached search results"
    fi
    for svc in "${SERVICES[@]}"; do
        local_label=$(label_for_service "${svc}")
        echo "  - Clear ${local_label} [service: ${svc}]"
    done
fi

if ! $FORCE_CONFIRMATION; then
    echo ""
    read -p "Proceed? (yes/no): " -r CONFIRM
    if [[ ! "${CONFIRM}" =~ ^[Yy]([Ee][Ss])?$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

echo ""
ensure_container_running
ensure_database_exists

if $CLEAR_ALL; then
    clear_all_entries
else
    if $CLEAR_SEARCH; then
        clear_search_entries
    fi
    for svc in "${SERVICES[@]}"; do
        clear_service_entries "${svc}"
    done
fi

echo ""
echo -e "${GREEN}Cache cleanup complete.${NC}"
