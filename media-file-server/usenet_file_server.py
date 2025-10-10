#!/usr/bin/env python3
"""
Simple HTTP file server for Usenet streaming
Now with rar2fs support for streaming videos inside RAR archives
"""

import os
import sys
import re
import time
import argparse
import subprocess
import tempfile
import shutil
import atexit
import threading
import glob
import hashlib
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler with range request support for video seeking"""

    api_key = None  # Will be set by main()
    error_video_cache_dir = None  # Will be set by main()

    def check_auth(self):
        """Check if request has valid API key"""
        if not self.api_key:
            return True  # No auth required if api_key not set

        # Check for X-API-Key header
        provided_key = self.headers.get('X-API-Key')
        if provided_key == self.api_key:
            return True

        # Check query parameter as fallback (for direct file access from browsers/apps)
        if '?' in self.path:
            query = self.path.split('?', 1)[1]
            if f'key={self.api_key}' in query:
                return True

        # Check for Authorization header (Bearer token)
        auth_header = self.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header[7:]  # Remove 'Bearer ' prefix
            if token == self.api_key:
                return True

        return False

    def do_GET(self):
        """Handle GET requests with range support"""
        try:
            # Check authentication first
            if not self.check_auth():
                print(f"[AUTH] Unauthorized request from {self.client_address[0]}")
                self.send_response(401)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(b'Unauthorized: Invalid or missing API key')
                return

            # Log all incoming GET requests
            range_header = self.headers.get('Range')
            if range_header:
                print(f"[REQUEST] GET {self.path} - Range: {range_header}")
            else:
                print(f"[REQUEST] GET {self.path} - No range header")

            # Special endpoint: list all video files
            if self.path.startswith('/api/list'):
                return self.handle_list_files()

            # Special endpoint: check for 7z archives in a folder
            if self.path.startswith('/api/check-archives'):
                return self.handle_check_archives()

            # Special endpoint: generate error video
            if self.path.startswith('/error'):
                return self.handle_error_video()

            # Get the file path
            path = self.translate_path(self.path)

            # If path doesn't exist and it looks like a direct filename request (no subdirectories)
            # try to find it anywhere in the directory tree (flattened access)
            if not os.path.exists(path) and '/' not in self.path.strip('/'):
                filename = os.path.basename(self.path)
                if filename:
                    print(f"[FLATTEN] Looking for file by name: {filename}")
                    found_path = self.find_file_by_name(filename)
                    if found_path:
                        print(f"[FLATTEN] Found file at: {found_path}")
                        path = found_path

            # Check if file exists - if not, try to find it by filename
            if not os.path.exists(path):
                # Extract filename from the requested path
                filename = os.path.basename(path)
                print(f"[SEARCH] File not found at exact path: {path}")
                print(f"[SEARCH] Searching for file by name: {filename}")

                # Search for the file in the entire directory tree
                found_path = self.find_file_by_name(filename)
                if found_path:
                    print(f"[SEARCH] Found file at new location: {found_path}")
                    path = found_path
                else:
                    print(f"[SEARCH] File not found anywhere: {filename}")
                    self.send_error(404, "File not found")
                    return

            if os.path.isdir(path):
                # Let parent handle directory listing
                return super().do_GET()

            # Get file size
            file_size = os.path.getsize(path)

            # Check if file is sparse (rar2fs reports full size but hasn't extracted everything)
            # We can detect this by checking if the file is in a rar2fs mount
            is_rar2fs = '/mnt/rarfs' in path or '.rar' in path.lower()

            print(f"[FILE] Path: {path}")
            print(f"[FILE] Reported size: {file_size} bytes ({file_size / 1024 / 1024 / 1024:.2f} GB)")
            if is_rar2fs:
                print(f"[FILE] rar2fs mount detected - may have sparse/incomplete data")

            # Log connection info
            client_ip = self.client_address[0]
            print(f"[CONNECTION] Client {client_ip} requesting: {os.path.basename(path)}")

            # Check for Range header
            range_header = self.headers.get('Range')
            if range_header:
                print(f"[CONNECTION] Range: {range_header}")
            else:
                print(f"[CONNECTION] No range header (full file request)")

            # Parse range - if no range header, treat as bytes=0- to force 206 response
            start = 0
            end = file_size - 1
            has_range = False

            if range_header:
                has_range = True
                # Parse range header
                match = re.search(r'bytes=(\d+)-(\d*)', range_header)
                if match:
                    start = int(match.group(1))
                    end = int(match.group(2)) if match.group(2) else file_size - 1

                    seek_percent = (start / file_size * 100) if file_size > 0 else 0
                    print(f"[SEEK] Requested position: {start} bytes ({seek_percent:.1f}% of file)")
            else:
                # No range header - force 206 response to encourage range requests
                print(f"[NO-RANGE] Client didn't send range header, forcing 206 response")
                has_range = True  # Pretend we have a range to force 206

            # Validate range
            if start >= file_size:
                print(f"[ERROR] Range not satisfiable: start={start} >= file_size={file_size}")
                self.send_error(416, "Requested Range Not Satisfiable")
                return

            # Adjust end if necessary
            if end >= file_size:
                end = file_size - 1

            # For incomplete rar2fs files, limit response to small chunks to avoid long waits
            # This allows progressive streaming as data becomes available
            if is_rar2fs and 'incomplete' in path.lower():
                original_end = end
                max_chunk_for_incomplete = 10 * 1024 * 1024  # 10MB chunks for incomplete files
                requested_length = original_end - start + 1

                if requested_length > max_chunk_for_incomplete:
                    end = start + max_chunk_for_incomplete - 1
                    print(f"[INCOMPLETE] Limiting response from {requested_length} bytes ({requested_length/1024/1024:.1f}MB) to {max_chunk_for_incomplete} bytes (10MB)")

            content_length = end - start + 1

            # Send response headers - always use 206 to encourage range requests
            if has_range:
                # Partial content response (even if client didn't ask for it)
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            else:
                # This should never happen now, but keep as fallback
                self.send_response(200)

            self.send_header('Content-Length', str(content_length))
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            print(f"[STREAM] 📤 Starting stream: {start}-{end}/{file_size} ({content_length} bytes, {content_length/1024/1024:.2f} MB)")

            # Stream the file - send whatever rar2fs can provide
            chunk_size = 256 * 1024  # 256KB chunks
            bytes_sent = 0

            with open(path, 'rb') as f:
                f.seek(start)
                remaining = content_length
                eof_retries = 0
                # For rar2fs files, be more patient - extraction can be slow
                max_eof_retries = 60 if is_rar2fs else 10
                consecutive_empty_reads = 0

                while remaining > 0:
                    # Read chunk
                    to_read = min(chunk_size, remaining)
                    chunk = f.read(to_read)

                    if not chunk:
                        # Hit EOF - rar2fs doesn't have more data yet
                        consecutive_empty_reads += 1

                        # Check if client is still connected before waiting
                        # Try a zero-byte write to detect broken pipe early
                        try:
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            print(f"[STREAM] Client disconnected while waiting for data (sent {bytes_sent}/{content_length} bytes)")
                            break

                        # Wait and retry for rar2fs to extract more
                        if eof_retries < max_eof_retries:
                            eof_retries += 1
                            if eof_retries == 1:
                                current_pos = start + bytes_sent
                                pos_percent = (current_pos / file_size * 100) if file_size > 0 else 0
                                print(f"[STREAM] Hit EOF at {bytes_sent}/{content_length} bytes (file pos {pos_percent:.1f}%), waiting for rar2fs extraction...")
                            elif eof_retries % 10 == 0:
                                print(f"[STREAM] Still waiting... ({eof_retries}s elapsed)")

                            # Use exponential backoff for retries
                            wait_time = min(2, 0.1 * (1.5 ** min(eof_retries, 10)))
                            time.sleep(wait_time)
                            continue
                        else:
                            # Gave up waiting - send what we have
                            print(f"[STREAM] Timeout waiting for rar2fs after {max_eof_retries}s, sent {bytes_sent}/{content_length} bytes")
                            break

                    # Reset counters when we successfully read data
                    eof_retries = 0
                    consecutive_empty_reads = 0

                    # Send chunk
                    try:
                        self.wfile.write(chunk)
                        bytes_sent += len(chunk)
                        remaining -= len(chunk)
                    except BrokenPipeError:
                        print(f"[STREAM] Client disconnected after {bytes_sent} bytes")
                        break
                    except Exception as e:
                        print(f"[ERROR] Failed to send chunk: {e}")
                        break

            if bytes_sent == content_length:
                print(f"[STREAM] ✓ Completed: sent {bytes_sent} bytes")
            else:
                print(f"[STREAM] ⚠ Partial: sent {bytes_sent}/{content_length} bytes ({(bytes_sent/content_length*100):.1f}%)")

        except Exception as e:
            print(f"[ERROR] Exception in do_GET: {e}")
            import traceback
            traceback.print_exc()

    def find_file_by_name(self, filename):
        """Search for a file by name in the entire directory tree"""
        try:
            root_dir = os.getcwd()
            for root, dirs, files in os.walk(root_dir):
                if filename in files:
                    return os.path.join(root, filename)
        except Exception as e:
            print(f"[SEARCH] Error searching for file: {e}")
        return None

    def handle_check_archives(self):
        """Handle /api/check-archives?folder=xxx endpoint - check for 7z archives in a folder"""
        try:
            # Parse query parameters
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)

            folder_name = params.get('folder', [None])[0]
            if not folder_name:
                self.send_error(400, "Missing 'folder' parameter")
                return

            # Check both incomplete and personal directories
            root_dir = os.getcwd()
            check_paths = [
                os.path.join(root_dir, 'incomplete', folder_name),
                os.path.join(root_dir, 'personal', folder_name),
                os.path.join(root_dir, folder_name)
            ]

            has_7z = False
            has_rar = False
            found_folder = None

            for check_path in check_paths:
                if os.path.exists(check_path) and os.path.isdir(check_path):
                    found_folder = check_path
                    print(f"[CHECK-ARCHIVES] Checking folder: {check_path}")

                    try:
                        files = os.listdir(check_path)
                        for file in files:
                            lower = file.lower()
                            if lower.endswith('.7z') or re.match(r'.*\.7z\.\d+$', lower):
                                has_7z = True
                                print(f"[CHECK-ARCHIVES] Found 7z file: {file}")
                            elif lower.endswith('.rar') or re.match(r'.*\.r\d+$', lower) or re.match(r'.*\.part\d+\.rar$', lower):
                                has_rar = True
                                print(f"[CHECK-ARCHIVES] Found RAR file: {file}")
                    except Exception as e:
                        print(f"[CHECK-ARCHIVES] Error listing folder: {e}")
                    break

            if not found_folder:
                print(f"[CHECK-ARCHIVES] Folder not found: {folder_name}")

            # Send JSON response
            import json
            response = json.dumps({
                'folder': folder_name,
                'found': found_folder is not None,
                'has7z': has_7z,
                'hasRar': has_rar
            }, indent=2)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response.encode('utf-8'))

        except Exception as e:
            print(f"[CHECK-ARCHIVES] Error: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, f"Error checking archives: {str(e)}")

    def handle_list_files(self):
        """Handle /api/list endpoint - return JSON list of all video files"""
        try:
            video_extensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts']
            files = []
            seen_files = set()  # Track filenames to avoid duplicates

            # Scan current working directory (rar2fs mount or source dir)
            root_dir = os.getcwd()
            print(f"[LIST] Scanning primary directory: {root_dir}")
            for root, dirs, files_list in os.walk(root_dir):
                for filename in files_list:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in video_extensions:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, root_dir)

                        try:
                            stat = os.stat(full_path)
                            # Mark as complete if NOT in incomplete directory
                            is_complete = 'incomplete' not in rel_path.lower()

                            # Extract folder name (parent directory name)
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
                            print(f"[LIST] Error stating file {full_path}: {e}")

            # Also scan /downloads for regular (non-archived) video files
            downloads_dir = '/downloads'
            if os.path.exists(downloads_dir) and downloads_dir != root_dir:
                print(f"[LIST] Also scanning /downloads for non-archived files")
                for root, dirs, files_list in os.walk(downloads_dir):
                    for filename in files_list:
                        ext = os.path.splitext(filename)[1].lower()
                        if ext in video_extensions and filename not in seen_files:
                            full_path = os.path.join(root, filename)
                            rel_path = os.path.relpath(full_path, downloads_dir)

                            try:
                                stat = os.stat(full_path)
                                # Mark as complete if NOT in incomplete directory
                                is_complete = 'incomplete' not in rel_path.lower()

                                # Extract folder name (parent directory name)
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
                                print(f"[LIST] Error stating file {full_path}: {e}")

            # Sort by isComplete first (True before False), then by modification time
            files.sort(key=lambda x: (not x['isComplete'], -x['modified']))

            completed_count = sum(1 for f in files if f['isComplete'])
            incomplete_count = len(files) - completed_count
            print(f"[LIST] Total files found: {len(files)} ({completed_count} completed, {incomplete_count} in progress)")

            # Send JSON response
            import json
            response = json.dumps({'files': files}, indent=2)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response.encode('utf-8'))

        except Exception as e:
            print(f"[ERROR] Exception in handle_list_files: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, "Internal server error")

    def handle_error_video(self):
        """Handle /error endpoint - generate and stream cached error video"""
        try:
            # Parse query parameters for error message
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            error_message = params.get('message', ['An error occurred'])[0]
            error_message = unquote(error_message)

            # Generate cache key from message hash
            message_hash = hashlib.md5(error_message.encode('utf-8')).hexdigest()
            cache_file = os.path.join(self.error_video_cache_dir, f"error_{message_hash}.mp4")

            # Check if cached video exists
            if os.path.exists(cache_file):
                print(f"[ERROR-VIDEO] Using cached video: {cache_file}")
                # Stream cached file
                try:
                    file_size = os.path.getsize(cache_file)

                    self.send_response(200)
                    self.send_header('Content-Type', 'video/mp4')
                    self.send_header('Content-Length', str(file_size))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Cache-Control', 'public, max-age=86400')  # Cache for 24 hours
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()

                    with open(cache_file, 'rb') as f:
                        while True:
                            chunk = f.read(8192)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                    return
                except Exception as e:
                    print(f"[ERROR-VIDEO] Failed to read cached file: {e}")
                    # Fall through to regenerate

            print(f"[ERROR-VIDEO] Generating new error video: {error_message}")

            # Split text into multiple lines if too long (max 40 chars per line)
            max_chars_per_line = 40
            words = error_message.split(' ')
            lines = []
            current_line = ''

            for word in words:
                test_line = current_line + ' ' + word if current_line else word
                if len(test_line) > max_chars_per_line and current_line:
                    lines.append(current_line)
                    current_line = word
                else:
                    current_line = test_line
            if current_line:
                lines.append(current_line)

            # Create FFmpeg drawtext filter for multiple lines
            text_filters = []
            for index, line in enumerate(lines):
                y_pos = 360 + (index * 60)  # Center vertically with spacing
                # Escape special characters for FFmpeg
                escaped_line = line.replace("'", "\\'").replace(":", "\\:")
                text_filters.append(
                    f"drawtext=text='{escaped_line}':fontcolor=white:fontsize=32:"
                    f"box=1:boxcolor=black@0.7:boxborderw=10:x=(w-text_w)/2:y={y_pos}"
                )

            vf_filter = ','.join(text_filters)

            # Generate video to cache file
            ffmpeg_cmd = [
                'ffmpeg',
                '-f', 'lavfi',
                '-i', 'color=c=black:s=1280x720:r=30',  # Black background
                '-f', 'lavfi',
                '-i', 'anullsrc=r=44100:cl=stereo',  # Silent audio
                '-vf', vf_filter,
                '-t', '5',  # 5 seconds
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-f', 'mp4',
                '-movflags', 'frag_keyframe+empty_moov+faststart',
                cache_file
            ]

            # Generate the video file
            print(f"[ERROR-VIDEO] Running FFmpeg command: {' '.join(ffmpeg_cmd)}")
            process = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, stderr = process.communicate()

            if process.returncode != 0:
                print(f"[ERROR-VIDEO] FFmpeg failed with code {process.returncode}")
                print(f"[ERROR-VIDEO] FFmpeg stderr: {stderr.decode('utf-8')}")
                print(f"[ERROR-VIDEO] FFmpeg stdout: {stdout.decode('utf-8')}")
                try:
                    self.send_error(500, "Failed to generate error video")
                except (BrokenPipeError, ConnectionResetError):
                    print(f"[ERROR-VIDEO] Client already disconnected")
                return

            print(f"[ERROR-VIDEO] Generated and cached: {cache_file}")

            # Now stream the cached file to client
            try:
                file_size = os.path.getsize(cache_file)

                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', str(file_size))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()

                with open(cache_file, 'rb') as f:
                    while True:
                        chunk = f.read(8192)
                        if not chunk:
                            break
                        self.wfile.write(chunk)

                print(f"[ERROR-VIDEO] Streamed cached video successfully")

            except (BrokenPipeError, ConnectionResetError):
                print(f"[ERROR-VIDEO] Client disconnected while streaming")

        except (BrokenPipeError, ConnectionResetError) as e:
            print(f"[ERROR-VIDEO] Client disconnected: {e}")
        except Exception as e:
            print(f"[ERROR] Exception in handle_error_video: {e}")
            import traceback
            traceback.print_exc()
            try:
                self.send_error(500, "Failed to generate error video")
            except (BrokenPipeError, ConnectionResetError):
                print(f"[ERROR-VIDEO] Client already disconnected, cannot send error")

    def do_HEAD(self):
        """Handle HEAD requests"""
        try:
            path = self.translate_path(self.path)

            # If path doesn't exist and it looks like a direct filename request (no subdirectories)
            # try to find it anywhere in the directory tree (flattened access)
            if not os.path.exists(path) and '/' not in self.path.strip('/'):
                filename = os.path.basename(self.path)
                if filename:
                    found_path = self.find_file_by_name(filename)
                    if found_path:
                        path = found_path

            if not os.path.exists(path):
                self.send_error(404, "File not found")
                return

            if os.path.isdir(path):
                self.send_error(403, "Forbidden")
                return

            file_size = os.path.getsize(path)

            self.send_response(200)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

        except Exception as e:
            print(f"[ERROR] Exception in do_HEAD: {e}")
            self.send_error(500, "Internal server error")

    def do_OPTIONS(self):
        """Handle OPTIONS requests (CORS preflight)"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.end_headers()

    def do_DELETE(self):
        """Handle DELETE requests to remove files"""
        try:
            path = self.translate_path(self.path)

            if not os.path.exists(path):
                self.send_error(404, "File not found")
                return

            if os.path.isdir(path):
                shutil.rmtree(path)
                print(f"[DELETE] Removed directory: {path}")
            else:
                os.remove(path)
                print(f"[DELETE] Removed file: {path}")

            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

        except Exception as e:
            print(f"[ERROR] Exception in do_DELETE: {e}")
            self.send_error(500, "Internal server error")


def run_server(directory, port=8081, bind='0.0.0.0'):
    """Run the HTTP server"""

    # Change to the directory to serve
    os.chdir(directory)

    # Create handler
    handler = RangeRequestHandler

    # Create threaded server for concurrent requests
    server = ThreadingHTTPServer((bind, port), handler)
    server.daemon_threads = True  # Allow threads to exit when main thread exits

    # Count video files to show in startup message
    video_extensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts']
    video_count = 0
    rar_count = 0

    try:
        for root, dirs, files in os.walk(directory):
            for filename in files:
                ext = os.path.splitext(filename)[1].lower()
                if ext in video_extensions:
                    video_count += 1
                elif ext in ['.rar', '.zip'] or re.match(r'\.r\d+$', ext):
                    rar_count += 1
    except Exception as e:
        print(f"[WARN] Could not scan directory: {e}")

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║  🎬 Usenet File Server with rar2fs                          ║
╠══════════════════════════════════════════════════════════════╣
║  📂 Serving: {directory[:45]:<45} ║
║  🌐 Address: http://{bind}:{port:<39} ║
║  📊 Found {video_count} video files, {rar_count} RAR archives{' ' * (26 - len(str(video_count)) - len(str(rar_count)))}║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /<path>        - Stream file with range support     ║
║    GET  /api/list      - List all video files (JSON)        ║
║    HEAD /<path>        - Get file metadata                  ║
║                                                              ║
║  Press Ctrl+C to stop                                        ║
╚══════════════════════════════════════════════════════════════╝
""")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n🛑 Server stopped by user")
        server.shutdown()


def extract_7z_archives(download_dir):
    """
    Background task that monitors for 7z archives and extracts them automatically.
    Unlike RAR, 7z archives must be complete (or nearly complete) before extraction.
    Extracts to the same directory as the archive.
    """
    extracted_archives = set()  # Track what we've already extracted
    archive_stable_times = {}  # Track when archives stopped growing

    def monitor_loop():
        while True:
            try:
                # Find all 7z archives
                for root, dirs, files in os.walk(download_dir):
                    # Look for .7z files or .7z.001 (split archives)
                    for file in files:
                        if file.lower().endswith('.7z') or re.match(r'.*\.7z\.\d+$', file.lower()):
                            archive_path = os.path.join(root, file)

                            # Skip if already extracted
                            if archive_path in extracted_archives:
                                continue

                            # For split archives (.7z.001, .7z.002), only process the first part
                            is_split = re.match(r'.*\.7z\.\d+$', file.lower())
                            if is_split:
                                # Check if this is the first part (.001)
                                if not file.lower().endswith('.7z.001'):
                                    continue

                                # For split archives, check if all parts exist and are stable
                                base_name = file[:-8]  # Remove .7z.001
                                part_num = 1
                                all_parts_stable = True

                                while True:
                                    part_file = f"{base_name}.7z.{part_num:03d}"
                                    part_path = os.path.join(root, part_file)

                                    if not os.path.exists(part_path):
                                        # No more parts found
                                        break

                                    # Check if this part has stopped growing (stable for 30 seconds)
                                    current_size = os.path.getsize(part_path)
                                    current_time = time.time()

                                    if part_path not in archive_stable_times:
                                        archive_stable_times[part_path] = (current_size, current_time)
                                        all_parts_stable = False
                                    else:
                                        last_size, last_time = archive_stable_times[part_path]
                                        if current_size != last_size:
                                            # Still growing
                                            archive_stable_times[part_path] = (current_size, current_time)
                                            all_parts_stable = False
                                        elif current_time - last_time < 30:
                                            # Stable but not long enough
                                            all_parts_stable = False

                                    part_num += 1

                                if not all_parts_stable:
                                    print(f"[7Z] Split archive still downloading or not stable: {file}")
                                    continue

                                print(f"[7Z] All parts of split archive are stable: {file}")
                            else:
                                # Single archive - check if stable (stopped growing for 30 seconds)
                                current_size = os.path.getsize(archive_path)
                                current_time = time.time()

                                if archive_path not in archive_stable_times:
                                    archive_stable_times[archive_path] = (current_size, current_time)
                                    print(f"[7Z] Found new archive, waiting for stability: {file}")
                                    continue

                                last_size, last_time = archive_stable_times[archive_path]
                                if current_size != last_size:
                                    # Still growing
                                    archive_stable_times[archive_path] = (current_size, current_time)
                                    print(f"[7Z] Archive still growing: {file} ({current_size} bytes)")
                                    continue
                                elif current_time - last_time < 30:
                                    # Stable but not long enough
                                    print(f"[7Z] Archive stable for {int(current_time - last_time)}s, waiting for 30s: {file}")
                                    continue

                            print(f"[7Z] Archive is stable and ready for extraction: {archive_path}")

                            # Extract directory (same as archive location)
                            extract_dir = root

                            # Try to extract
                            try:
                                print(f"[7Z] Extracting to: {extract_dir}")
                                # Use 7z with -y (yes to all) and -aos (skip existing files)
                                result = subprocess.run(
                                    ['7z', 'x', '-y', '-aos', f'-o{extract_dir}', archive_path],
                                    capture_output=True,
                                    text=True,
                                    timeout=300  # 5 minutes for large archives
                                )

                                if result.returncode == 0:
                                    print(f"[7Z] ✓ Successfully extracted: {file}")
                                    extracted_archives.add(archive_path)
                                    # Clean up stability tracking
                                    if archive_path in archive_stable_times:
                                        del archive_stable_times[archive_path]
                                elif result.returncode == 2:
                                    print(f"[7Z] ⚠️  Archive incomplete or corrupted: {file}")
                                    print(f"[7Z] stderr: {result.stderr[:200]}")
                                    # Don't mark as extracted - will retry on next cycle
                                else:
                                    print(f"[7Z] ⚠️  Extraction failed (code {result.returncode}): {file}")
                                    print(f"[7Z] stderr: {result.stderr[:200]}")
                                    # Don't mark as extracted - will retry on next cycle

                            except subprocess.TimeoutExpired:
                                print(f"[7Z] ⏱️  Extraction timeout (very large file): {file}")
                                # Don't mark as extracted - will retry with longer timeout next time
                            except Exception as e:
                                print(f"[7Z] ❌ Error extracting {file}: {e}")

            except Exception as e:
                print(f"[7Z] Monitor error: {e}")

            # Check every 10 seconds
            time.sleep(10)

    # Start monitor thread
    monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
    monitor_thread.start()
    print("[7Z] Started 7z extraction monitor")


def mount_rar2fs(src_dir):
    """
    Mount the source directory via rar2fs to transparently extract RAR archives.
    Returns the mount point directory.
    """
    mount_point = "/mnt/rarfs"

    # Check if rar2fs is already mounted by looking in /proc/mounts
    try:
        with open('/proc/mounts', 'r') as f:
            mounts = f.read()
            if 'rar2fs' in mounts and mount_point in mounts:
                print(f"[RAR2FS] Already mounted at {mount_point}")
                return mount_point
    except:
        pass

    # Create mount point if it doesn't exist
    os.makedirs(mount_point, exist_ok=True)

    print(f"[RAR2FS] Mounting {src_dir} at {mount_point}")

    try:
        # Mount using rar2fs in background
        subprocess.Popen(
            ["rar2fs", "-o", "allow_other", src_dir, mount_point],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        # Give it a moment to mount
        time.sleep(2)

        print(f"[RAR2FS] Mount initiated, serving from {mount_point}")
        return mount_point

    except Exception as e:
        print(f"❌ Failed to mount rar2fs: {e}")
        return src_dir


def main():
    parser = argparse.ArgumentParser(
        description='Simple HTTP file server for Usenet streaming with rar2fs + range request support',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Serve from SABnzbd download directory on default port 8081
  python3 usenet_file_server.py /home/user/Videos

  # Use custom port
  python3 usenet_file_server.py /home/user/Videos --port 9000

  # Bind to specific interface (localhost only)
  python3 usenet_file_server.py /home/user/Videos --bind 127.0.0.1

  # Allow remote connections (bind to all interfaces)
  python3 usenet_file_server.py /home/user/Videos --bind 0.0.0.0
        """
    )

    parser.add_argument(
        'directory',
        help='Directory to serve (e.g., SABnzbd complete/download directory)'
    )

    parser.add_argument(
        '--port', '-p',
        type=int,
        default=8081,
        help='Port to listen on (default: 8081)'
    )

    parser.add_argument(
        '--bind', '-b',
        default='0.0.0.0',
        help='Address to bind to (default: 0.0.0.0 for all interfaces, use 127.0.0.1 for localhost only)'
    )

    parser.add_argument(
        '--api-key',
        default=None,
        help='API key for authentication (optional, uses X-API-Key header or ?key=XXX query param)'
    )

    args = parser.parse_args()

    # Check if directory exists
    if not os.path.exists(args.directory):
        print(f"❌ Error: Directory does not exist: {args.directory}")
        sys.exit(1)

    if not os.path.isdir(args.directory):
        print(f"❌ Error: Not a directory: {args.directory}")
        sys.exit(1)

    # Set API key for authentication
    if args.api_key:
        RangeRequestHandler.api_key = args.api_key
        print(f"🔒 API key authentication enabled")

    # Setup error video cache directory
    error_cache_dir = os.path.join(tempfile.gettempdir(), 'usenet_error_videos')
    os.makedirs(error_cache_dir, exist_ok=True)
    RangeRequestHandler.error_video_cache_dir = error_cache_dir

    # Clean up old cache files (keep max 50 files, delete oldest)
    try:
        cache_files = glob.glob(os.path.join(error_cache_dir, 'error_*.mp4'))
        if len(cache_files) > 50:
            # Sort by modification time
            cache_files.sort(key=lambda x: os.path.getmtime(x))
            # Delete oldest files
            for old_file in cache_files[:-50]:
                try:
                    os.remove(old_file)
                    print(f"📹 Cleaned up old cache file: {os.path.basename(old_file)}")
                except Exception as e:
                    print(f"⚠️  Failed to delete {old_file}: {e}")
    except Exception as e:
        print(f"⚠️  Error cleaning cache: {e}")

    print(f"📹 Error video cache: {error_cache_dir} ({len(glob.glob(os.path.join(error_cache_dir, 'error_*.mp4')))} cached)")

    # 7z extraction removed - only RAR and direct video files are supported

    # Mount RAR archives transparently using rar2fs
    rar2fs_mount = mount_rar2fs(args.directory)

    # Run server
    try:
        run_server(rar2fs_mount, args.port, args.bind)
    except PermissionError:
        print(f"❌ Error: Permission denied. Try using a port above 1024 or run with sudo")
        sys.exit(1)
    except OSError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
