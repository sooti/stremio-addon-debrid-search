# Usenet Streaming Feature

This add-on now supports **Usenet streaming** via Newznab indexers and SABnzbd downloader, alongside existing debrid services.

## Overview

The Usenet streaming feature allows you to:
- Search for content on Newznab-compatible indexers
- Automatically submit NZBs to SABnzbd for download
- **Start streaming as soon as 3% is downloaded** (progressive streaming)
- **Seek/skip forward in videos** even while still downloading (range request support)
- Stream from SABnzbd's incomplete folder for instant playback

## How It Works

1. **Search**: When you search for a movie or TV show, the add-on queries your Newznab indexer
2. **Selection**: You select a result, and the NZB is submitted to SABnzbd
3. **Progressive Download**: SABnzbd starts downloading the NZB
4. **Instant Streaming**: Once 3% is downloaded, streaming begins immediately
5. **Seeking Support**: You can skip ahead in the video - if that part isn't downloaded yet, you'll get a "please wait" message

## Configuration

### Prerequisites

1. **Newznab Indexer** (e.g., NZBGeek, NZBFinder, or your own)
   - Newznab server URL (e.g., `https://api.nzbgeek.info`)
   - API key from your indexer

2. **SABnzbd** installed and running
   - SABnzbd server URL (e.g., `http://localhost:8080`)
   - API key from SABnzbd settings
   - **CRITICAL FOR STREAMING**: Enable "Direct Unpack" in SABnzbd settings
     - Go to SABnzbd Web UI → Config → Switches → Enable "Direct Unpack"
     - Without this, files are only extracted AFTER download completes (no progressive streaming)
     - With this enabled, video files are extracted DURING download (streaming can start at ~15-20%)

3. **Usenet Provider** configured in SABnzbd
   - You need an active Usenet subscription (not included with this add-on)

4. **File Server** (Required):
   - You MUST run a file server to stream Usenet downloads
   - **Recommended**: Use the included Python script (`usenet_file_server.py`)
     - Zero dependencies, works out of the box
     - See setup instructions below
   - **Alternative**: Use nginx/Caddy (see "Alternative: Web Server Streaming" section)

### Setup Steps

**Step 1: Start the File Server**

Run the Python file server on your SABnzbd machine:
```bash
python3 usenet_file_server.py /home/sooti/Videos
```
Leave this running in the background. You should see:
```
Server address: http://0.0.0.0:8081
```

**Step 2: Configure Add-on**

1. Go to the add-on landing page
2. Add a new service and select **Usenet** from the dropdown
3. Enter your:
   - **Newznab API Key**
   - **Newznab Indexer URL** (e.g., `https://api.nzbgeek.info`)
   - **SABnzbd Server URL** (e.g., `http://localhost:8080`)
   - **SABnzbd API Key**
   - **File Server URL** (e.g., `http://localhost:8081`) ← **Required!**
4. Install the add-on in Stremio

## Features

### Progressive Streaming
- Streaming starts **as soon as the video file appears** in the `_UNPACK_` folder
- Only waits for 3% download to ensure the download has actually started
- Then continuously checks for extracted video files (up to 2 minutes)
- The video plays from SABnzbd's `_UNPACK_` folder in the main download directory
- When Direct Unpack is enabled, SABnzbd creates `_UNPACK_<name>` folders during download
- Download and extraction continue in the background while you watch
- Checks both `_UNPACK_` folder in main directory and incomplete folder for video files

### Range Request Support
- Full support for seeking/scrubbing through the video
- If you seek to a part that's not downloaded yet:
  - You'll see "Requested range not yet downloaded"
  - Wait a few seconds and try again
  - The download is sequential, so earlier parts are always available

### Smart File Detection
- Automatically finds video files in multi-file NZBs
- For TV shows: matches the correct episode by parsing filenames
- Picks the largest video file if multiple are present

### Download Management
- **Personal Cloud Integration**: Automatically checks SABnzbd queue and history for existing downloads
- Downloads already in SABnzbd are marked with 💾 "Personal" label for instant streaming
- If you request the same content twice, it reuses the existing download
- **Automatic cleanup**: Incomplete downloads are removed after 10 minutes of stream inactivity
- Completed downloads are kept (not auto-deleted)
- Storage space monitoring: Warns when disk space is below 10GB, blocks downloads when critically low (< 2GB)

## Technical Details

### Modules Created

1. **lib/newznab.js** - Newznab API integration
   - Search functionality
   - NZB content fetching
   - XML parsing

2. **lib/sabnzbd.js** - SABnzbd API integration
   - NZB submission
   - Download queue monitoring
   - Progress tracking
   - Configuration retrieval

3. **lib/usenet.js** - High-level Usenet service
   - Combines Newznab + SABnzbd
   - Search and download coordination
   - Progress monitoring
   - Streamable file detection

4. **Server endpoint: /usenet/stream/:nzbUrl/:title/:type/:id**
   - Progressive streaming from incomplete folder
   - HTTP range request support for seeking
   - Waits up to 2 minutes for file extraction
   - Automatically polls SABnzbd for file availability

5. **Server endpoint: /usenet/poll/:nzbUrl/:title/:type/:id**
   - JSON endpoint for checking video readiness
   - Returns: `{ ready: boolean, progress: number, status: string, message: string }`
   - Can be used by clients to poll before attempting to stream

### Streaming Workflow

```
User selects stream
       ↓
Check if already downloading
       ↓
Submit NZB to SABnzbd
       ↓
Wait for 3% download
       ↓
Find video file in incomplete folder
       ↓
Start streaming with range support
       ↓
Continue downloading in background
```

### Range Request Handling

When the player seeks:
1. Player sends HTTP Range header (e.g., `Range: bytes=1000000-2000000`)
2. Server checks if that byte range is downloaded
3. If available: Returns 206 Partial Content with requested bytes
4. If not available: Returns 416 Range Not Satisfiable
5. Player waits and retries automatically

## Limitations

- **Direct Unpack Required**: RAR/ZIP archives cannot be streamed directly
  - You MUST enable "Direct Unpack" in SABnzbd for progressive streaming to work
  - Without it, the entire file must download to 100% before extraction begins
  - This is a SABnzbd limitation - video files must be extracted from archives before playback
- **Sequential downloads only**: SABnzbd downloads sequentially, so you can't skip to the end immediately
- **Initial buffer**: Requires 3% download to start, then waits for video file to be extracted
- **File format**: Works best with MP4/MKV files that have headers at the beginning
- **Disk space**: Files are downloaded to SABnzbd's download folder

## Caching

The add-on implements MongoDB caching to reduce API calls:
- **Search results**: Cached for 1 hour
- **NZB file contents**: Cached for 24 hours

This means if you search for the same content multiple times, or if multiple users select the same NZB, the add-on won't waste API calls to your indexer.

## Troubleshooting

### No results from indexer
- **Different indexers have different content** - Try another show/movie or different indexer
- **Special characters** - The addon now auto-removes colons and special chars
- **Case sensitivity** - Some indexers are case-sensitive
- **API limits** - Check if you've hit your daily API call limit

### "Video file not yet available"
- The add-on automatically waits up to 2 minutes for file extraction after download starts (3%)
- Check SABnzbd web interface to see download status
- **Most Common Cause**: Direct Unpack is NOT enabled in SABnzbd
  - Go to SABnzbd Web UI → Config → Switches
  - Enable "Direct Unpack" checkbox
  - Click "Save Changes"
  - Without this, files only extract AFTER 100% download (no progressive streaming)
- RAR archives take longer to extract - the addon checks every 5 seconds for extracted files
- If still seeing this error after enabling Direct Unpack, the file may be heavily compressed or very large

### "Insufficient storage space"
- The add-on monitors disk space and will block downloads if space is critically low
- Warning threshold: 10GB available (logs warning, download continues)
- Critical threshold: 2GB available (downloads blocked)
- Free up space in your SABnzbd incomplete and complete directories
- Check SABnzbd settings to see where downloads are stored

### Seeking to middle doesn't work immediately
- **Smart waiting is enabled** - When you seek ahead, the system waits up to 60 seconds
- Watch the logs for progress: "Waiting for data... Current: 45%, Need: 60%"
- SABnzbd downloads sequentially, so you can't jump to the end immediately
- **Tip:** Let it download to 100% for full seeking capability

### Request timeout errors
- Indexer might be slow or overloaded
- The addon now retries automatically (2 attempts, 45 second timeout)
- Try again in a few minutes

### Streaming starts but stutters
- Your Usenet connection may be slow
- Download is not keeping up with playback
- Wait for more of the file to buffer

### Can't find the video file
- Multi-RAR archives need to be extracted first
- Check SABnzbd's complete folder
- Ensure video file extensions are recognized (see `findVideoFile` in `server.js`)

## Performance

- **Search**: 1-3 seconds (depends on Newznab indexer, cached searches are instant)
- **NZB submission**: <1 second (cached NZBs are instant)
- **Time to start**: 10-90 seconds (waits for 3% download + file extraction to begin)
  - With Direct Unpack: Usually starts at 5-10% download
  - Without Direct Unpack: Must wait for 100% download
- **Seeking**: Instant (for downloaded parts)

## Security Notes

- API keys are passed in query parameters (consider URL encoding)
- Files are stored locally on the SABnzbd server
- No external access to your SABnzbd instance is created
- Clean up old downloads regularly to save disk space

## Future Enhancements

Possible improvements:
- [ ] Support for NZBs with PAR2 repair
- [ ] Automatic retry on failed downloads
- [ ] Download priority for sought ranges
- [x] Cache Newznab search results (✓ Implemented - 1 hour TTL)
- [x] Cache NZB file contents (✓ Implemented - 24 hour TTL)
- [ ] Support for multiple Newznab indexers
- [ ] Progress bar showing download percentage in player
- [x] Polling endpoint for video readiness (✓ Implemented at `/usenet/poll`)

## Alternative: Direct File Server Streaming

If you don't want to stream through Node.js, you can serve files directly from the SABnzbd machine:

### Option A: Python Script (Recommended - Easiest!)

A simple Python script is included that serves files with range request support (seeking).

1. **Run the Python file server** on your SABnzbd machine:
   ```bash
   python3 usenet_file_server.py /home/sooti/Videos
   ```

2. **Enter the file server URL in the add-on landing page**:
   - Go to the add-on configuration page
   - In the Usenet section, enter the file server URL (e.g., `http://localhost:8081`)
   - Save and install the add-on

3. **Streaming will now use the file server** instead of Node.js

**Command-line options:**
```bash
# Custom port
python3 usenet_file_server.py /home/sooti/Videos --port 9000

# Localhost only (more secure)
python3 usenet_file_server.py /home/sooti/Videos --bind 127.0.0.1

# Allow remote connections
python3 usenet_file_server.py /home/sooti/Videos --bind 0.0.0.0
```

**Features:**
- ✅ Zero dependencies (uses Python's built-in HTTP server)
- ✅ Range request support (seeking works perfectly)
- ✅ CORS enabled (remote access allowed)
- ✅ Simple logging of streams and seeks
- ✅ Works with Python 3.6+

### Option B: Quick Setup with Caddy

1. **Install Caddy**:
   ```bash
   # On Ubuntu/Debian
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install caddy
   ```

2. **Configure Caddy** (edit `/etc/caddy/Caddyfile`):
   ```
   :8081 {
       root * /home/sooti/Videos
       file_server browse
   }
   ```

3. **Restart Caddy**:
   ```bash
   sudo systemctl restart caddy
   ```

4. **Enter URL in add-on landing page**:
   - Go to add-on configuration
   - Enter `http://localhost:8081` in the File Server URL field
   - Save and install

### Setup with nginx

1. **Install nginx**:
   ```bash
   sudo apt install nginx
   ```

2. **Configure nginx** (create `/etc/nginx/sites-available/usenet-files`):
   ```nginx
   server {
       listen 8081;
       server_name localhost;

       location / {
           root /home/sooti/Videos;
           autoindex on;
       }
   }
   ```

3. **Enable and restart**:
   ```bash
   sudo ln -s /etc/nginx/sites-available/usenet-files /etc/nginx/sites-enabled/
   sudo systemctl restart nginx
   ```

4. **Enter URL in add-on landing page**:
   - Go to add-on configuration
   - Enter `http://localhost:8081` in the File Server URL field
   - Save and install

The addon will automatically redirect to the file server instead of streaming through Node.js.

## Credits

Built on:
- [Newznab API](https://newznab.readthedocs.io/)
- [SABnzbd API](https://sabnzbd.org/wiki/advanced/api)
- Node.js with Express
- Stremio Add-on SDK
