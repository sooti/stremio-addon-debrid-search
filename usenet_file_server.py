#!/usr/bin/env python3
"""
Simple HTTP file server for Usenet streaming
Serves files from SABnzbd download directory with range request support
"""

import os
import sys
import re
import time
import argparse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler with range request support for video seeking"""

    def do_GET(self):
        """Handle GET requests with range support"""
        try:
            # Log all incoming GET requests
            range_header = self.headers.get('Range')
            if range_header:
                print(f"[REQUEST] GET {self.path} - Range: {range_header}")
            else:
                print(f"[REQUEST] GET {self.path} - No range header")

            # Special endpoint: list all video files
            if self.path == '/api/list':
                return self.handle_list_files()

            # Get the file path
            path = self.translate_path(self.path)

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

            # Check for Range header
            range_header = self.headers.get('Range')

            # Parse range - if no range header, default to full file (0-)
            start = 0
            end = file_size - 1

            if range_header:
                # Parse range header
                match = re.search(r'bytes=(\d+)-(\d*)', range_header)
                if match:
                    start = int(match.group(1))
                    end = int(match.group(2)) if match.group(2) else file_size - 1

            # Validate range
            if start >= file_size:
                self.send_error(416, "Requested Range Not Satisfiable")
                return

            # Adjust end if necessary
            end = min(end, file_size - 1)
            length = end - start + 1

            # Always send 206 Partial Content (even for full file)
            # This signals to clients that seeking is supported
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Range')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()

            # Send the requested range
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        # Client closed connection - this is normal during seeking
                        break
                    remaining -= len(chunk)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Client disconnected - this is normal during seeking
            pass
        except Exception as e:
            print(f"[ERROR] {e}")
            try:
                self.send_error(500, f"Internal Server Error: {e}")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # Can't send error response if client disconnected
                pass

    def do_HEAD(self):
        """Handle HEAD requests for file info"""
        try:
            path = self.translate_path(self.path)

            if not os.path.exists(path):
                self.send_error(404, "File not found")
                return

            if os.path.isdir(path):
                return super().do_HEAD()

            file_size = os.path.getsize(path)

            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Range')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()

        except Exception as e:
            print(f"[ERROR] HEAD request failed: {e}")
            try:
                self.send_error(500, f"Internal Server Error: {e}")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def find_file_by_name(self, filename):
        """Search for a file by name in the entire directory tree"""
        base_dir = os.getcwd()

        for root, dirs, files in os.walk(base_dir):
            if filename in files:
                return os.path.join(root, filename)

        return None

    def handle_list_files(self):
        """List all video files in the served directory"""
        import json

        video_extensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts']

        try:
            files = []
            base_dir = os.getcwd()

            # Walk through directory tree
            for root, dirs, filenames in os.walk(base_dir):
                for filename in filenames:
                    # Check if video file
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in video_extensions:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, base_dir)

                        # Get file stats
                        stat = os.stat(full_path)

                        files.append({
                            'name': filename,
                            'path': rel_path.replace('\\', '/'),  # Normalize path separators
                            'size': stat.st_size,
                            'modified': stat.st_mtime
                        })

            # Sort by modified time (newest first)
            files.sort(key=lambda x: x['modified'], reverse=True)

            # Send JSON response with strong no-cache headers
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()

            response = json.dumps({'files': files, 'timestamp': time.time()})
            self.wfile.write(response.encode('utf-8'))

        except Exception as e:
            print(f"[ERROR] Failed to list files: {e}")
            self.send_error(500, f"Error listing files: {e}")

    def do_DELETE(self):
        """Handle DELETE requests to remove files"""
        import json

        try:
            # Get the file path from URL
            path = self.translate_path(self.path)

            # Security check: ensure path is within served directory
            base_dir = os.getcwd()
            real_path = os.path.realpath(path)
            if not real_path.startswith(os.path.realpath(base_dir)):
                self.send_error(403, "Access denied")
                return

            # Check if file exists
            if not os.path.exists(path):
                self.send_error(404, "File not found")
                return

            # Delete the file
            if os.path.isfile(path):
                os.remove(path)
                print(f"[DELETE] Removed file: {path}")

                # Try to remove parent directory if empty
                try:
                    parent_dir = os.path.dirname(path)
                    if parent_dir != base_dir and os.path.isdir(parent_dir):
                        # Check if directory is empty
                        if not os.listdir(parent_dir):
                            os.rmdir(parent_dir)
                            print(f"[DELETE] Removed empty directory: {parent_dir}")
                except Exception as e:
                    print(f"[DELETE] Could not remove parent directory: {e}")

                # Send success response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()

                response = json.dumps({'success': True, 'message': 'File deleted'})
                self.wfile.write(response.encode('utf-8'))
            else:
                self.send_error(400, "Not a file")

        except Exception as e:
            print(f"[ERROR] Failed to delete file: {e}")
            self.send_error(500, f"Error deleting file: {e}")

    def do_OPTIONS(self):
        """Handle OPTIONS requests for CORS"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, DELETE, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        """Custom logging"""
        # Check if this was a range request
        range_header = self.headers.get('Range') if hasattr(self, 'headers') else None

        # Get path info
        path_info = args[0] if len(args) > 0 else "unknown"
        status_code = args[1] if len(args) > 1 else "???"

        if status_code == '206':
            if range_header:
                # Parse range to show seek position
                import re
                match = re.search(r'bytes=(\d+)-', range_header)
                if match:
                    seek_byte = int(match.group(1))
                    seek_mb = seek_byte / 1024 / 1024
                    print(f"[SEEK] {path_info} - Position: {seek_mb:.1f} MB (byte {seek_byte:,}) - {format % args}")
                else:
                    print(f"[SEEK] {path_info} - Range: {range_header} - {format % args}")
            else:
                print(f"[STREAM] {path_info} - Full file - {format % args}")
        elif status_code == '416':
            print(f"[ERROR-416] {path_info} - Range not satisfiable! - {format % args}")
            if range_header:
                print(f"           Requested range: {range_header}")
        else:
            print(f"[HTTP] {path_info} - Status {status_code} - {format % args}")


def run_server(directory, port=8081, bind='0.0.0.0'):
    """Run the HTTP server"""

    # Change to the directory to serve
    os.chdir(directory)

    # Create handler
    handler = RangeRequestHandler

    # Create threaded server for concurrent requests
    server = ThreadingHTTPServer((bind, port), handler)
    server.daemon_threads = True  # Allow threads to exit when main thread exits

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║           Usenet File Server for Stremio Streaming          ║
╚══════════════════════════════════════════════════════════════╝

📁 Serving directory: {directory}
🌐 Server address:    http://{bind}:{port}
🎬 Range requests:    ✓ Enabled (seeking supported)
🔓 CORS:              ✓ Enabled (remote access allowed)
⚡ Threading:         ✓ Enabled (concurrent requests supported)

📝 Set this environment variable in your addon:
   export USENET_FILE_SERVER_URL=http://localhost:{port}

⚠️  Press Ctrl+C to stop the server

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n🛑 Server stopped by user")
        server.shutdown()


def main():
    parser = argparse.ArgumentParser(
        description='Simple HTTP file server for Usenet streaming with range request support',
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

    args = parser.parse_args()

    # Check if directory exists
    if not os.path.exists(args.directory):
        print(f"❌ Error: Directory does not exist: {args.directory}")
        sys.exit(1)

    if not os.path.isdir(args.directory):
        print(f"❌ Error: Not a directory: {args.directory}")
        sys.exit(1)

    # Run server
    try:
        run_server(args.directory, args.port, args.bind)
    except PermissionError:
        print(f"❌ Error: Permission denied. Try using a port above 1024 or run with sudo")
        sys.exit(1)
    except OSError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
