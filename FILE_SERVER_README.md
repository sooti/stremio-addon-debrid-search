# Usenet File Server

A lightweight, threaded HTTP file server with range request support for streaming video files from SABnzbd to Stremio.

## Features

- ✅ **HTTP Range Request Support** - Full video seeking/scrubbing capability
- ✅ **Concurrent Requests** - Threaded server handles multiple simultaneous streams
- ✅ **CORS Enabled** - Remote access from any origin
- ✅ **Auto Content-Type** - Proper MIME types for all video formats
- ✅ **Connection Resilience** - Gracefully handles client disconnections during seeking
- ✅ **Systemd Service** - Run as a background service with auto-restart

## Quick Start

### Manual Start

```bash
# Start the server (interactive mode)
python3 usenet_file_server.py /path/to/sabnzbd/complete

# Custom port and bind address
python3 usenet_file_server.py /path/to/sabnzbd/complete --port 9000 --bind 127.0.0.1
```

### Install as System Service

```bash
# Run the installation script
./install-file-server-service.sh

# The script will prompt for:
# - Directory to serve (SABnzbd complete directory)
# - Port (default: 8081)
# - Bind address (default: 0.0.0.0)
```

### Uninstall Service

```bash
./uninstall-file-server-service.sh
```

## Configuration

### Environment Variable

Set this in your Stremio addon environment:

```bash
export USENET_FILE_SERVER_URL=http://localhost:8081
```

### Command Line Options

```
usenet_file_server.py [-h] [--port PORT] [--bind BIND] directory

positional arguments:
  directory             Directory to serve (e.g., SABnzbd complete directory)

optional arguments:
  -h, --help            show this help message and exit
  --port PORT, -p PORT  Port to listen on (default: 8081)
  --bind BIND, -b BIND  Address to bind to (default: 0.0.0.0)
```

## Service Management

Once installed as a service:

```bash
# View logs in real-time
sudo journalctl -u usenet-file-server -f

# Check status
sudo systemctl status usenet-file-server

# Stop service
sudo systemctl stop usenet-file-server

# Start service
sudo systemctl start usenet-file-server

# Restart service
sudo systemctl restart usenet-file-server

# Disable service (prevent auto-start on boot)
sudo systemctl disable usenet-file-server

# Enable service (auto-start on boot)
sudo systemctl enable usenet-file-server
```

## How It Works

1. **Client Request**: Stremio or video player sends HTTP GET request with `Range` header
2. **Range Parsing**: Server parses the byte range (e.g., `bytes=0-999999`)
3. **Partial Content**: Server responds with `206 Partial Content` and requested bytes
4. **Streaming**: Video plays while download continues in background
5. **Seeking**: Player sends new range requests when user seeks forward/backward

## Technical Details

### Supported Video Formats

- MP4, MKV, AVI, MOV, WMV, FLV, WEBM
- M4V, MPG, MPEG, 3GP, OGV
- TS, M2TS (transport streams)

### HTTP Headers

**Request Headers:**
- `Range: bytes=start-end` - Requested byte range

**Response Headers:**
- `Accept-Ranges: bytes` - Server supports range requests
- `Content-Range: bytes start-end/total` - Current byte range
- `Content-Length: length` - Size of response body
- `Access-Control-Allow-Origin: *` - CORS enabled
- `Cache-Control: no-cache` - Disable caching for live files

### Status Codes

- `200 OK` - Full file request (no Range header)
- `206 Partial Content` - Range request successful
- `404 Not Found` - File doesn't exist
- `416 Range Not Satisfiable` - Invalid range request
- `500 Internal Server Error` - Server error

## Troubleshooting

### Port Already in Use

```bash
# Find what's using the port
sudo lsof -i :8081

# Kill the process or choose a different port
python3 usenet_file_server.py /path/to/dir --port 9000
```

### Permission Denied

```bash
# Make sure you have read access to the directory
ls -la /path/to/sabnzbd/complete

# Or run with appropriate user permissions
sudo -u sabnzbd python3 usenet_file_server.py /path/to/dir
```

### Can't Access from Other Devices

```bash
# Check firewall
sudo ufw allow 8081/tcp

# Make sure you're binding to 0.0.0.0 (not 127.0.0.1)
python3 usenet_file_server.py /path/to/dir --bind 0.0.0.0
```

### Video Won't Seek

Check logs for:
- `[SEEK]` entries with status `206` (seeking is working)
- `[STREAM]` entries with status `200` (initial request)
- Connection reset errors (normal during seeking)

## Performance

- **Concurrent Streams**: Unlimited (threaded design)
- **Memory Usage**: ~10-20 MB base + ~5 MB per active stream
- **CPU Usage**: Minimal (<1% per stream on modern hardware)
- **Network**: Limited only by disk I/O and network bandwidth

## Security Considerations

The file server is designed for **local network use only**. If exposing to the internet:

1. Use a reverse proxy (nginx/Apache) with authentication
2. Enable HTTPS/TLS
3. Restrict access by IP address
4. Consider using a VPN instead

## Requirements

- Python 3.6 or higher
- Linux with systemd (for service installation)
- Read access to SABnzbd directory

## License

This is part of the Sootio project.
