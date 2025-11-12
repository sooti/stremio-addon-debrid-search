FROM ubuntu:22.04

# Use BuildKit cache for faster rebuilds
# Pure Python archive handling - no FUSE needed!
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    unrar-free \
    p7zip-full \
    ffmpeg \
    wget ca-certificates

# App directory
WORKDIR /app

# Copy Python requirements and install dependencies
COPY requirements.txt /app/
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy application
COPY usenet_file_server.py /app/usenet_file_server.py

ENTRYPOINT ["python3", "/app/usenet_file_server.py"]
