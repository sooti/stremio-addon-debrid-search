#!/bin/bash
# Deploy FastAPI Usenet File Server

set -e

echo "🚀 Deploying FastAPI Usenet File Server"
echo "========================================"

# Change to script directory
cd "$(dirname "$0")"

# Stop old container if running
echo "📦 Stopping old container..."
docker-compose down 2>/dev/null || true

# Build new image with no cache
echo "🔨 Building FastAPI image (no cache)..."
docker-compose build --no-cache usenet-server

# Start new container
echo "▶️  Starting FastAPI server..."
docker-compose up -d usenet-server

# Wait for container to be ready
echo "⏳ Waiting for server to be healthy..."
sleep 5

# Check health
echo "🏥 Checking health..."
for i in {1..30}; do
    if docker exec usenet-file-server wget -qO- http://localhost:3003/health >/dev/null 2>&1; then
        echo "✅ Server is healthy!"
        break
    fi
    echo "   Attempt $i/30..."
    sleep 2
done

# Show logs
echo ""
echo "📋 Recent logs:"
echo "========================================"
docker logs --tail 20 usenet-file-server

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Server running at: http://localhost:3003"
echo "Health check: curl http://localhost:3003/health"
echo "View logs: docker logs -f usenet-file-server"
echo ""
