FROM ubuntu:22.04

# Use BuildKit cache for faster rebuilds
# System deps + build tools for fuse-archive (universal archive support) + ffmpeg for error videos
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    fuse3 libfuse3-dev \
    libarchive-dev pkg-config \
    libboost-dev \
    build-essential g++ git \
    ffmpeg \
    wget ca-certificates

# Build fuse-archive from source for universal archive support (RAR, 7z, ZIP, TAR, ISO, etc.)
# Note: fuse-archive supports RAR natively via libarchive, so we don't need rar2fs
RUN cd /tmp && \
    git clone --depth 1 https://github.com/google/fuse-archive.git && \
    cd fuse-archive && \
    make -j$(nproc) && \
    cp out/fuse-archive /usr/local/bin/ && \
    chmod +x /usr/local/bin/fuse-archive && \
    cd / && \
    rm -rf /tmp/fuse-archive

# allow_other for FUSE mounts
RUN sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf || true

# Mount point for archive filesystem
RUN mkdir -p /mnt/archivefs

# App
WORKDIR /app
COPY usenet_file_server.py /app/usenet_file_server.py

VOLUME ["/mnt/archivefs"]
ENTRYPOINT ["python3", "/app/usenet_file_server.py"]
