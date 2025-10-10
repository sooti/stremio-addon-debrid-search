#!/usr/bin/env python3
"""
FastAPI-based file server for Usenet streaming with production features
- Async I/O for concurrent streams
- Automatic range request support
- rar2fs transparent RAR extraction
- API key authentication
- Structured logging
- Health checks
"""

import os
import sys
import re
import time
import asyncio
import subprocess
import tempfile
import shutil
import glob
import hashlib
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime

from fastapi import FastAPI, Header, HTTPException, Request, Response, Security, Depends
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
import aiofiles
import uvicorn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("usenet-file-server")

# Security
security = HTTPBearer(auto_error=False)

# App configuration
app = FastAPI(
    title="Usenet File Server",
    description="High-performance video streaming server with rar2fs support",
    version="2.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global configuration - use environment variables so workers inherit them
class Config:
    @property
    def API_KEY(self) -> Optional[str]:
        return os.environ.get('FASTAPI_API_KEY')

    @property
    def ERROR_VIDEO_CACHE_DIR(self) -> str:
        return os.environ.get('FASTAPI_CACHE_DIR', tempfile.gettempdir() + '/usenet_error_videos')

    @property
    def RAR2FS_MOUNT(self) -> str:
        return os.environ.get('FASTAPI_RAR2FS_MOUNT', '')

    @property
    def SOURCE_DIR(self) -> str:
        return os.environ.get('FASTAPI_SOURCE_DIR', '')

    VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts']

config = Config()


# === Authentication ===

async def verify_api_key(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    """Verify API key from various sources"""
    if not config.API_KEY:
        return True  # No auth required if API key not configured

    # Check X-API-Key header
    if x_api_key == config.API_KEY:
        return True

    # Check Authorization Bearer token
    if credentials and credentials.credentials == config.API_KEY:
        return True

    # Check query parameter
    query_params = dict(request.query_params)
    if query_params.get("key") == config.API_KEY:
        return True

    logger.warning(f"Unauthorized request from {request.client.host}")
    raise HTTPException(status_code=401, detail="Invalid or missing API key")


# === Helper Functions ===

def find_file_by_name(filename: str, root_dir: str) -> Optional[str]:
    """Search for a file by name in the entire directory tree"""
    try:
        for root, dirs, files in os.walk(root_dir):
            if filename in files:
                return os.path.join(root, filename)
    except Exception as e:
        logger.error(f"Error searching for file: {e}")
    return None


async def stream_file_range(
    file_path: str,
    start: int,
    end: int,
    chunk_size: int = 256 * 1024,
    is_rar2fs: bool = False
) -> bytes:
    """Stream a file range asynchronously with rar2fs support"""
    content_length = end - start + 1
    bytes_sent = 0
    file_size = os.path.getsize(file_path)

    # For rar2fs files, determine if we should wait for data or fail fast
    # If seeking near the end of file (>90%), don't wait long
    is_end_seek = is_rar2fs and (start / file_size > 0.9) if file_size > 0 else False

    # Smart retry logic:
    # - End seeks (>90%): only 3 retries (~0.5 seconds) - for player capability checks
    # - Normal seeks: 30 retries (~30 seconds) - give rar2fs time to extract
    # - Non-rar2fs: 10 retries
    max_eof_retries = 3 if is_end_seek else (30 if is_rar2fs else 10)
    eof_retries = 0

    async with aiofiles.open(file_path, 'rb') as f:
        await f.seek(start)
        remaining = content_length

        while remaining > 0:
            to_read = min(chunk_size, remaining)
            chunk = await f.read(to_read)

            if not chunk:
                # Hit EOF - rar2fs doesn't have more data yet
                pos_percent = ((start + bytes_sent) / file_size * 100) if file_size > 0 else 0

                # For end-of-file seeks, fail fast instead of blocking player
                if is_end_seek and eof_retries == 0:
                    logger.info(f"End seek at {pos_percent:.1f}% - returning available data ({bytes_sent} bytes)")
                    break

                # If we've sent some data already, we're making progress - keep going
                # Otherwise, check if we should give up
                if eof_retries >= max_eof_retries:
                    logger.warning(f"Timeout waiting for rar2fs after {max_eof_retries} retries, sent {bytes_sent}/{content_length} bytes")
                    break

                eof_retries += 1
                if eof_retries == 1:
                    logger.info(f"Hit EOF at {bytes_sent}/{content_length} bytes ({pos_percent:.1f}%), waiting for rar2fs...")

                # Exponential backoff, max 1 second per retry
                wait_time = min(1.0, 0.1 * (1.5 ** min(eof_retries, 10)))
                await asyncio.sleep(wait_time)
                continue

            # Reset EOF retry counter on successful read
            eof_retries = 0
            yield chunk
            bytes_sent += len(chunk)
            remaining -= len(chunk)


async def generate_error_video(error_message: str) -> str:
    """Generate a cached error video with FFmpeg"""
    # Generate cache key from message hash
    message_hash = hashlib.md5(error_message.encode('utf-8')).hexdigest()
    cache_file = os.path.join(config.ERROR_VIDEO_CACHE_DIR, f"error_{message_hash}.mp4")

    # Check if cached video exists
    if os.path.exists(cache_file):
        logger.info(f"Using cached error video: {cache_file}")
        return cache_file

    logger.info(f"Generating new error video: {error_message}")

    # Escape text for FFmpeg - need to escape special characters properly
    # Replace problematic characters
    safe_message = error_message.replace("'", "").replace(":", " -").replace("%", "pct")

    # Split into lines if too long (max 50 chars per line for readability)
    max_line_length = 50
    words = safe_message.split()
    lines = []
    current_line = ""

    for word in words:
        test_line = f"{current_line} {word}".strip() if current_line else word
        if len(test_line) <= max_line_length:
            current_line = test_line
        else:
            if current_line:
                lines.append(current_line)
            current_line = word

    if current_line:
        lines.append(current_line)

    # Limit to 3 lines max
    if len(lines) > 3:
        lines = lines[:3]
        lines[-1] += "..."

    # Build drawtext filters for each line
    drawtext_filters = []
    line_height = 60
    start_y = 540 - (len(lines) * line_height) // 2  # Center vertically

    for idx, line in enumerate(lines):
        y_pos = start_y + (idx * line_height)
        drawtext_filters.append(
            f"drawtext=text='{line}':"
            f"fontsize=42:"
            f"fontcolor=white:"
            f"borderw=4:"
            f"bordercolor=black:"
            f"x=(w-text_w)/2:"
            f"y={y_pos}"
        )

    vf_filter = ",".join(drawtext_filters)

    # Generate video to cache file (10 seconds)
    # Use frequent keyframes for better seeking/playback
    ffmpeg_cmd = [
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf', vf_filter,
        '-t', '10',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-x264-params', 'keyint=30:min-keyint=30',  # Keyframe every second
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-f', 'mp4',
        '-movflags', '+faststart+frag_keyframe',
        cache_file
    ]

    process = await asyncio.create_subprocess_exec(
        *ffmpeg_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        logger.error(f"FFmpeg failed: {stderr.decode('utf-8')}")
        raise HTTPException(status_code=500, detail="Failed to generate error video")

    logger.info(f"Generated and cached error video: {cache_file}")
    return cache_file


async def pregenerate_common_error_videos():
    """Pre-generate common error videos at startup for faster responses"""
    common_errors = [
        "File not found",
        "Download failed",
        "Extraction failed",
        "Network error",
        "Timeout error",
        "Invalid file format",
        "Access denied",
        "Server error",
        "File is still downloading",
        "Archive extraction in progress"
    ]

    logger.info("Pre-generating common error videos...")

    for error_msg in common_errors:
        try:
            await generate_error_video(error_msg)
        except Exception as e:
            logger.warning(f"Failed to pre-generate error video for '{error_msg}': {e}")

    logger.info(f"Pre-generated {len(common_errors)} common error videos")


# === API Endpoints ===

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "mount": config.RAR2FS_MOUNT,
        "source": config.SOURCE_DIR
    }


@app.get("/api/list")
async def list_files(
    authenticated: bool = Depends(verify_api_key)
) -> JSONResponse:
    """List all video files in the directory tree"""
    files = []
    seen_files = set()

    # Scan primary directory
    root_dir = config.RAR2FS_MOUNT or config.SOURCE_DIR
    logger.info(f"Scanning directory: {root_dir}")

    for root, dirs, files_list in os.walk(root_dir):
        for filename in files_list:
            ext = os.path.splitext(filename)[1].lower()
            if ext in config.VIDEO_EXTENSIONS:
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, root_dir)

                try:
                    stat = os.stat(full_path)
                    is_complete = 'incomplete' not in rel_path.lower()
                    folder_name = os.path.basename(os.path.dirname(full_path))

                    files.append({
                        'name': filename,
                        'path': rel_path.replace('\\', '/'),
                        'flatPath': filename,
                        'folderName': folder_name,
                        'size': stat.st_size,
                        'modified': stat.st_mtime,
                        'isComplete': is_complete
                    })
                    seen_files.add(filename)
                except Exception as e:
                    logger.error(f"Error stating file {full_path}: {e}")

    # Sort by completion status and modification time
    files.sort(key=lambda x: (not x['isComplete'], -x['modified']))

    completed_count = sum(1 for f in files if f['isComplete'])
    incomplete_count = len(files) - completed_count
    logger.info(f"Found {len(files)} files ({completed_count} completed, {incomplete_count} in progress)")

    return JSONResponse(content={'files': files})


@app.get("/api/check-archives")
async def check_archives(
    folder: str,
    authenticated: bool = Depends(verify_api_key)
) -> JSONResponse:
    """Check for 7z/RAR archives in a folder"""
    root_dir = config.RAR2FS_MOUNT or config.SOURCE_DIR
    check_paths = [
        os.path.join(root_dir, 'incomplete', folder),
        os.path.join(root_dir, 'personal', folder),
        os.path.join(root_dir, folder)
    ]

    has_7z = False
    has_rar = False
    found_folder = None

    for check_path in check_paths:
        if os.path.exists(check_path) and os.path.isdir(check_path):
            found_folder = check_path
            logger.info(f"Checking archives in: {check_path}")

            try:
                files = os.listdir(check_path)
                for file in files:
                    lower = file.lower()
                    if lower.endswith('.7z') or re.match(r'.*\.7z\.\d+$', lower):
                        has_7z = True
                        logger.info(f"Found 7z file: {file}")
                    elif lower.endswith('.rar') or re.match(r'.*\.r\d+$', lower):
                        has_rar = True
                        logger.info(f"Found RAR file: {file}")
            except Exception as e:
                logger.error(f"Error listing folder: {e}")
            break

    if not found_folder:
        logger.info(f"Folder not found: {folder}")

    return JSONResponse(content={
        'folder': folder,
        'found': found_folder is not None,
        'has7z': has_7z,
        'hasRar': has_rar
    })


@app.get("/error")
async def error_video(
    message: str = "An error occurred",
    authenticated: bool = Depends(verify_api_key)
):
    """Generate and stream an error video"""
    try:
        cache_file = await generate_error_video(message)
        return FileResponse(
            cache_file,
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=86400"
            }
        )
    except Exception as e:
        logger.error(f"Error generating error video: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/{file_path:path}")
async def delete_file(
    file_path: str,
    authenticated: bool = Depends(verify_api_key)
):
    """Delete a file or directory"""
    root_dir = config.RAR2FS_MOUNT or config.SOURCE_DIR
    full_path = os.path.join(root_dir, file_path)

    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        if os.path.isdir(full_path):
            shutil.rmtree(full_path)
            logger.info(f"Deleted directory: {full_path}")
        else:
            os.remove(full_path)
            logger.info(f"Deleted file: {full_path}")

        return {"status": "success", "message": f"Deleted {file_path}"}
    except Exception as e:
        logger.error(f"Error deleting {full_path}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/{file_path:path}")
async def stream_file(
    file_path: str,
    request: Request,
    range: Optional[str] = Header(None),
    authenticated: bool = Depends(verify_api_key)
):
    """Stream a file with automatic range request support"""
    root_dir = config.RAR2FS_MOUNT or config.SOURCE_DIR
    full_path = os.path.join(root_dir, file_path)

    # If path doesn't exist, try to find by filename
    if not os.path.exists(full_path):
        filename = os.path.basename(file_path)
        logger.info(f"File not found at exact path, searching: {filename}")
        found_path = find_file_by_name(filename, root_dir)
        if found_path:
            logger.info(f"Found file at: {found_path}")
            full_path = found_path
        else:
            logger.warning(f"File not found: {filename}")
            raise HTTPException(status_code=404, detail="File not found")

    if os.path.isdir(full_path):
        raise HTTPException(status_code=400, detail="Cannot stream directory")

    # Get file info
    file_size = os.path.getsize(full_path)
    is_rar2fs = '/mnt/rarfs' in full_path or '.rar' in full_path.lower()

    logger.info(f"Streaming: {os.path.basename(full_path)} ({file_size / 1024 / 1024 / 1024:.2f} GB)")
    if is_rar2fs:
        logger.info("rar2fs mount detected - may have sparse data")

    # Parse range header
    start = 0
    end = file_size - 1

    if range:
        logger.info(f"Range request: {range}")
        match = re.search(r'bytes=(\d+)-(\d*)', range)
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = int(match.group(2))

            seek_percent = (start / file_size * 100) if file_size > 0 else 0
            logger.info(f"Seeking to {start} bytes ({seek_percent:.1f}% of file)")

    # Validate range
    if start >= file_size:
        logger.error(f"Range not satisfiable: start={start} >= file_size={file_size}")
        raise HTTPException(status_code=416, detail="Range Not Satisfiable")

    if end >= file_size:
        end = file_size - 1

    content_length = end - start + 1

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Type": "application/octet-stream"
    }

    logger.info(f"Streaming {start}-{end}/{file_size} ({content_length / 1024 / 1024:.2f} MB)")

    # Stream the file
    return StreamingResponse(
        stream_file_range(full_path, start, end, is_rar2fs=is_rar2fs),
        status_code=206,  # Partial Content
        headers=headers,
        media_type="application/octet-stream"
    )


# === Startup/Shutdown Events ===

@app.on_event("startup")
async def startup_event():
    """Initialize server on startup"""
    logger.info("=" * 70)
    logger.info("🎬 Usenet File Server Starting")
    logger.info("=" * 70)
    logger.info(f"📂 Source directory: {config.SOURCE_DIR}")
    logger.info(f"🔀 rar2fs mount: {config.RAR2FS_MOUNT}")
    logger.info(f"🔒 API authentication: {'Enabled' if config.API_KEY else 'Disabled'}")
    logger.info(f"📹 Error video cache: {config.ERROR_VIDEO_CACHE_DIR}")

    # Ensure error video cache directory exists
    os.makedirs(config.ERROR_VIDEO_CACHE_DIR, exist_ok=True)

    # Pre-generate common error videos
    await pregenerate_common_error_videos()

    # Count files
    video_count = 0
    rar_count = 0
    root_dir = config.RAR2FS_MOUNT or config.SOURCE_DIR

    try:
        for root, dirs, files in os.walk(root_dir):
            for filename in files:
                ext = os.path.splitext(filename)[1].lower()
                if ext in config.VIDEO_EXTENSIONS:
                    video_count += 1
                elif ext in ['.rar', '.zip'] or re.match(r'\.r\d+$', ext):
                    rar_count += 1
    except Exception as e:
        logger.warning(f"Could not scan directory: {e}")

    logger.info(f"📊 Found {video_count} video files, {rar_count} RAR archives")
    logger.info("=" * 70)


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on server shutdown"""
    logger.info("🛑 Server shutting down...")


# === Main Entry Point ===

def mount_rar2fs(src_dir: str) -> str:
    """Mount the source directory via rar2fs"""
    mount_point = "/mnt/rarfs"

    # Check if already mounted
    try:
        with open('/proc/mounts', 'r') as f:
            mounts = f.read()
            if 'rar2fs' in mounts and mount_point in mounts:
                logger.info(f"rar2fs already mounted at {mount_point}")
                return mount_point
    except:
        pass

    # Create mount point
    os.makedirs(mount_point, exist_ok=True)
    logger.info(f"Mounting {src_dir} at {mount_point}")

    try:
        subprocess.Popen(
            ["rar2fs", "-o", "allow_other", src_dir, mount_point],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        time.sleep(2)
        logger.info(f"rar2fs mounted successfully")
        return mount_point
    except Exception as e:
        logger.error(f"Failed to mount rar2fs: {e}")
        return src_dir


def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(
        description='FastAPI-based file server for Usenet streaming',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        'directory',
        help='Directory to serve (e.g., SABnzbd download directory)'
    )
    parser.add_argument(
        '--port', '-p', type=int, default=3003,
        help='Port to listen on (default: 3003)'
    )
    parser.add_argument(
        '--host', type=str, default='0.0.0.0',
        help='Host to bind to (default: 0.0.0.0)'
    )
    parser.add_argument(
        '--api-key', type=str, default=None,
        help='API key for authentication (optional)'
    )
    parser.add_argument(
        '--workers', type=int, default=4,
        help='Number of worker processes (default: 4)'
    )
    parser.add_argument(
        '--log-level', type=str, default='info',
        choices=['debug', 'info', 'warning', 'error'],
        help='Log level (default: info)'
    )

    args = parser.parse_args()

    # Validate directory
    if not os.path.exists(args.directory):
        logger.error(f"Directory does not exist: {args.directory}")
        sys.exit(1)

    if not os.path.isdir(args.directory):
        logger.error(f"Not a directory: {args.directory}")
        sys.exit(1)

    # Set environment variables so worker processes inherit them
    source_dir = os.path.abspath(args.directory)
    os.environ['FASTAPI_SOURCE_DIR'] = source_dir

    if args.api_key:
        os.environ['FASTAPI_API_KEY'] = args.api_key

    # Setup error video cache
    error_cache_dir = os.path.join(tempfile.gettempdir(), 'usenet_error_videos')
    os.makedirs(error_cache_dir, exist_ok=True)
    os.environ['FASTAPI_CACHE_DIR'] = error_cache_dir

    # Clean old cache files (keep max 50)
    try:
        cache_files = glob.glob(os.path.join(error_cache_dir, 'error_*.mp4'))
        if len(cache_files) > 50:
            cache_files.sort(key=lambda x: os.path.getmtime(x))
            for old_file in cache_files[:-50]:
                try:
                    os.remove(old_file)
                except:
                    pass
    except:
        pass

    # Mount rar2fs and store mount point in env var
    rar2fs_mount = mount_rar2fs(source_dir)
    os.environ['FASTAPI_RAR2FS_MOUNT'] = rar2fs_mount

    # Run server with uvicorn
    uvicorn.run(
        "fastapi_file_server:app",
        host=args.host,
        port=args.port,
        workers=args.workers,
        log_level=args.log_level,
        access_log=True,
        limit_concurrency=100,
        timeout_keep_alive=300
    )


if __name__ == '__main__':
    main()
