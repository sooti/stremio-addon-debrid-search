# Media File Server

**Production-grade file server for streaming video files with RAR archive support and error video generation.**

Designed for Usenet downloads (SABnzbd integration) and personal media libraries. Works seamlessly with Stremio via the Sootio addon for Home Media Server (HM+) and Usenet (UN+) streaming.

---

## 🌟 Features

- ✅ **High-Performance Async I/O** - Handle 100+ concurrent video streams
- ✅ **Automatic Range Requests** - Perfect seeking, resuming, and scrubbing
- ✅ **rar2fs Integration** - Transparent RAR archive streaming (no extraction needed)
- ✅ **API Key Authentication** - Secure your file server with optional API keys
- ✅ **Error Video Generation** - FFmpeg-powered 10-second error messages with text overlay
- ✅ **File Discovery API** - JSON endpoints for file listing and archive detection
- ✅ **Production ASGI Server** - Built on FastAPI + Uvicorn with multiple workers
- ✅ **Structured Logging** - Easy debugging and monitoring
- ✅ **CORS Support** - Works with any frontend/client
- ✅ **Health Checks** - Monitor server status and uptime
- ✅ **Docker Ready** - Fully containerized with docker-compose support

---

## 🚀 Quick Start

### Docker (Recommended)

```bash
# 1. Navigate to the media-file-server directory
cd media-file-server

# 2. Set your API key (optional)
echo "USENET_API_KEY=your-secret-key-here" > .env

# 3. Build and start the server
docker-compose up -d usenet-server

# 4. Check server health
curl http://localhost:3003/health

# 5. View logs
docker-compose logs -f usenet-server
```

### Manual Installation

```bash
# 1. Install system dependencies
sudo apt-get update
sudo apt-get install -y python3 python3-pip ffmpeg rar2fs fuse

# 2. Install Python dependencies
cd media-file-server
pip3 install -r requirements.txt

# 3. Run the server
python3 fastapi_file_server.py /path/to/your/downloads \
  --port 3003 \
  --host 0.0.0.0 \
  --workers 4 \
  --api-key your-secret-key
```

---

## 📖 Installation Guide

### Prerequisites

- **Docker** (recommended) or Python 3.8+
- **FFmpeg** - For error video generation
- **rar2fs** - For RAR archive streaming (optional but recommended)
- **FUSE** - Required for rar2fs

### Docker Installation

1. **Clone or navigate to the repository**
   ```bash
   cd /path/to/stremio-addon-debrid-search/media-file-server
   ```

2. **Create environment file** (optional)
   ```bash
   cp .env.example .env
   # Edit .env and set your API key
   nano .env
   ```

3. **Build the Docker image**
   ```bash
   docker-compose build usenet-server
   ```

4. **Start the server**
   ```bash
   docker-compose up -d usenet-server
   ```

5. **Verify it's running**
   ```bash
   # Check health endpoint
   curl http://localhost:3003/health

   # Check Docker logs
   docker-compose logs usenet-server
   ```

### Configuration Options

#### Docker Compose (`docker-compose.yml`)

```yaml
services:
  usenet-server:
    build:
      context: .
      dockerfile: Dockerfile.fastapi
    image: usenet-file-server:fastapi
    container_name: usenet-file-server
    privileged: true  # Required for rar2fs FUSE mount
    cap_add:
      - SYS_ADMIN
    devices:
      - /dev/fuse:/dev/fuse
    security_opt:
      - apparmor:unconfined
    volumes:
      - /path/to/your/downloads:/downloads:rw  # Change this to your download directory
    ports:
      - "3003:3003"
    environment:
      - API_KEY=${USENET_API_KEY:-}  # Optional API key from .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3003/health >/dev/null 2>&1"]
      interval: 30s
      timeout: 5s
      retries: 3
```

#### Environment Variables

Create a `.env` file in the `media-file-server` directory:

```bash
# Optional: API key for authentication
USENET_API_KEY=your-secret-key-here
```

---

## 🎯 Usage

### Command Line Options

```bash
python3 fastapi_file_server.py [directory] [options]

Arguments:
  directory              Directory to serve (e.g., SABnzbd downloads)

Options:
  --port, -p            Port to listen on (default: 3003)
  --host                Host to bind to (default: 0.0.0.0)
  --api-key             API key for authentication (optional)
  --workers             Number of worker processes (default: 4)
  --log-level           Log level: debug, info, warning, error (default: info)
```

### API Endpoints

#### 1. Health Check
```bash
GET /health

Response:
{
  "status": "healthy",
  "timestamp": "2025-10-10T12:30:45.123456",
  "mount": "/mnt/rarfs",
  "source": "/downloads"
}
```

#### 2. List All Video Files
```bash
GET /api/list
Headers:
  X-API-Key: your-secret-key  # Optional if API_KEY is not set

Response:
{
  "files": [
    {
      "name": "Movie.2024.1080p.mkv",
      "path": "incomplete/Movie.2024.1080p/Movie.2024.1080p.mkv",
      "flatPath": "Movie.2024.1080p.mkv",
      "folderName": "Movie.2024.1080p",
      "size": 12589934592,
      "modified": 1674266632.7247415,
      "isComplete": false
    },
    {
      "name": "Series.S01E01.mkv",
      "path": "personal/Series.S01E01.mkv",
      "flatPath": "Series.S01E01.mkv",
      "folderName": "personal",
      "size": 2589934592,
      "modified": 1674266632.7247415,
      "isComplete": true
    }
  ]
}
```

**File Status:**
- `isComplete: true` - File is in a completed folder (ready to stream)
- `isComplete: false` - File is still downloading (in `incomplete/` folder)

#### 3. Check for Archives
```bash
GET /api/check-archives?folder=Release.Name
Headers:
  X-API-Key: your-secret-key

Response:
{
  "folder": "Release.Name",
  "found": true,
  "has7z": false,
  "hasRar": true
}
```

#### 4. Stream Video File
```bash
GET /{file_path}
Headers:
  Range: bytes=0-1048575
  X-API-Key: your-secret-key

# Example:
GET /Movie.2024.1080p.mkv?key=your-secret-key

Response:
206 Partial Content
Content-Range: bytes 0-1048575/12589934592
Content-Length: 1048576
Accept-Ranges: bytes
```

#### 5. Error Video
```bash
GET /error?message=Download%20failed
Headers:
  X-API-Key: your-secret-key

Response:
200 OK
Content-Type: video/mp4
(10-second video with error message overlay)
```

**Common Error Messages:**
- `File not found`
- `Download failed`
- `Extraction failed`
- `7z archives are not supported`
- `Network error`

Error videos are pre-generated at startup for fast response times.

#### 6. Delete File or Directory
```bash
DELETE /{file_path}
Headers:
  X-API-Key: your-secret-key

Response:
{
  "status": "success",
  "message": "Deleted Movie.2024.1080p.mkv"
}
```

### Authentication Methods

The server supports three authentication methods:

1. **X-API-Key Header** (recommended)
   ```bash
   curl -H "X-API-Key: your-secret-key" http://localhost:3003/api/list
   ```

2. **Authorization Bearer Token**
   ```bash
   curl -H "Authorization: Bearer your-secret-key" http://localhost:3003/api/list
   ```

3. **Query Parameter** (for direct browser/app access)
   ```bash
   http://localhost:3003/Movie.mkv?key=your-secret-key
   ```

**Note:** If no `API_KEY` is set, authentication is disabled.

---

## 🔌 Integration with Stremio

### Home Media Server (HM+)

Use this file server as a standalone personal media library with Stremio.

1. **Start the file server** on port 3003
2. **In Stremio addon configuration**, add a new service:
   - **Provider:** Home Media Server
   - **Server URL:** `http://your-server-ip:3003`
   - **API Key:** Your API key (if set)

3. **Files will appear** with a ☁️ cloud icon in Stremio, marked as "Personal"

### Usenet (UN+)

Use with SABnzbd for automated Usenet downloads.

1. **Configure SABnzbd** to download to `/downloads`
2. **Start the file server** pointing to SABnzbd's download directory
3. **In Stremio addon**, configure Usenet with:
   - **Newznab URL & API Key**
   - **SABnzbd URL & API Key**
   - **File Server URL:** `http://your-server-ip:3003`

4. **Files already downloaded** will stream instantly from the file server
5. **New downloads** will be queued via SABnzbd and streamed as they complete

---

## 🛠️ Configuration

### Uvicorn Workers

Adjust worker count based on your CPU cores:

- **2 cores:** `--workers 2`
- **4 cores:** `--workers 4` (default)
- **8+ cores:** `--workers 6-8`

**Rule of thumb:** `(2 x CPU cores) + 1`

### HTTP/2 Support

For HTTP/2, use Hypercorn instead of Uvicorn:

```bash
pip install hypercorn
hypercorn fastapi_file_server:app --bind 0.0.0.0:3003 --workers 4
```

### rar2fs Options

The server automatically mounts the source directory via rar2fs at `/mnt/rarfs`.

**Benefits:**
- Transparent RAR streaming (no extraction)
- Saves disk space
- Instant access to RAR contents

**Limitations:**
- Only supports RAR archives (not 7z)
- Requires `--privileged` Docker flag or FUSE permissions

---

## 📊 Monitoring

### Viewing Logs

```bash
# Docker logs
docker-compose logs -f usenet-server

# Filter for specific events
docker-compose logs usenet-server | grep "Streaming"
```

**Log Format:**
```
[2025-10-10 12:30:45] [INFO] [usenet-file-server] 🎬 Usenet File Server Starting
[2025-10-10 12:30:45] [INFO] [usenet-file-server] Pre-generating common error videos...
[2025-10-10 12:30:48] [INFO] [usenet-file-server] Pre-generated 10 common error videos
[2025-10-10 12:30:48] [INFO] [usenet-file-server] 📊 Found 127 video files, 15 RAR archives
[2025-10-10 12:31:15] [INFO] [usenet-file-server] Streaming: Movie.mkv (11.63 GB)
[2025-10-10 12:31:15] [INFO] [usenet-file-server] Range request: bytes=0-1048575
[2025-10-10 12:31:15] [INFO] [usenet-file-server] Streaming 0-1048575/12589934592 (1.00 MB)
```

### Health Monitoring

```bash
# Check server health
curl http://localhost:3003/health

# Response
{
  "status": "healthy",
  "timestamp": "2025-10-10T12:30:45.123456",
  "mount": "/mnt/rarfs",
  "source": "/downloads"
}
```

### Resource Usage

```bash
# Monitor Docker container stats
docker stats usenet-file-server

# Output:
CONTAINER ID   NAME                  CPU %     MEM USAGE / LIMIT     MEM %
abc123         usenet-file-server    2.5%      250MB / 8GB          3.1%
```

---

## 🐛 Troubleshooting

### rar2fs Not Mounting

**Symptom:** Server starts but RAR files don't stream

**Solution:**
```bash
# Check if FUSE device exists
ls -l /dev/fuse

# Ensure Docker has FUSE access
docker run --privileged --device /dev/fuse ...

# Check rar2fs mount
docker exec usenet-file-server mount | grep rar2fs
```

### Permission Denied Errors

**Symptom:** `Permission denied` when accessing files

**Solution:**
```bash
# Enable user_allow_other in /etc/fuse.conf
sudo echo "user_allow_other" >> /etc/fuse.conf

# Restart container
docker-compose restart usenet-server
```

### High Memory Usage

**Symptom:** Container using >1GB RAM

**Solution:**
```bash
# Reduce worker count
--workers 2

# Check for runaway processes
docker exec usenet-file-server ps aux

# Restart container
docker-compose restart usenet-server
```

### Slow Seeking/Buffering

**Symptom:** Video playback stutters or seeks slowly

**Possible Causes:**
1. **Slow disk I/O** - Check with `iostat -x 1`
2. **Network bottleneck** - Check with `iftop`
3. **rar2fs overhead** - RAR streaming is slower than direct files

**Solutions:**
```bash
# Test rar2fs performance
time ls -lh /mnt/rarfs/Release/

# Use direct files instead of RAR when possible
# Configure SABnzbd to not use RAR compression
```

### 7z Archives Not Supported

**Symptom:** "7z archives are not supported" error video

**Explanation:** rar2fs only supports RAR archives. 7z requires extraction.

**Solution:**
- Configure SABnzbd to prefer RAR or no compression
- Or manually extract 7z archives:
  ```bash
  7z x archive.7z -o/downloads/extracted/
  ```

---

## 🔧 Advanced Configuration

### For 100+ Concurrent Streams

```bash
# Increase workers and file descriptors
--workers 8
ulimit -n 65536

# Tune uvicorn
--limit-concurrency 200
--timeout-keep-alive 300
```

### For Low-Latency Streaming

```bash
# Use fewer workers with more efficient I/O
--workers 1

# Edit fastapi_file_server.py to reduce chunk size
chunk_size = 64 * 1024  # 64KB chunks (default: 256KB)
```

### Custom Error Videos

Error videos are pre-generated at startup. To add custom messages, edit `fastapi_file_server.py`:

```python
async def pregenerate_common_error_videos():
    common_errors = [
        "File not found",
        "Download failed",
        "Your custom error message here"  # Add your message
    ]
```

---

## 📁 Directory Structure

```
media-file-server/
├── README.md                    # This file
├── docker-compose.yml           # Docker Compose configuration
├── Dockerfile.fastapi           # FastAPI production Dockerfile
├── fastapi_file_server.py       # Main server application
├── requirements.txt             # Python dependencies
├── .env.example                 # Example environment variables
├── .env                         # Your environment variables (create this)
└── SECURITY.md                  # Security considerations
```

---

## 🔒 Security Considerations

1. **API Key Authentication**
   - Always set an API key in production
   - Use a strong, random key (min 32 characters)
   - Never commit `.env` to version control

2. **Network Exposure**
   - Bind to `127.0.0.1` if only local access is needed
   - Use a reverse proxy (nginx/Caddy) for HTTPS
   - Configure firewall rules appropriately

3. **File Access**
   - Server can read/delete any file in the mounted directory
   - Use restrictive volume mounts in Docker
   - Consider read-only mounts if deletion is not needed

See `SECURITY.md` for more details.

---

## 📝 License

Same as parent project (Sootio).

---

## 🤝 Contributing

Issues and pull requests welcome! This is part of the larger Sootio project.

---

## 📚 Additional Resources

- **FastAPI Documentation:** https://fastapi.tiangolo.com/
- **rar2fs GitHub:** https://github.com/hasse69/rar2fs
- **Uvicorn Documentation:** https://www.uvicorn.org/
- **SABnzbd Setup:** https://sabnzbd.org/
- **Stremio Addon Development:** https://github.com/Stremio/stremio-addon-sdk

---

**Made with ❤️ for seamless media streaming**
