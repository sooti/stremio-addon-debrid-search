FROM ubuntu:22.04

# Use BuildKit cache for faster rebuilds
# System deps + build tools for rar2fs + FUSE tools for universal archives + ffmpeg for error videos
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    fuse libfuse-dev \
    libarchive-dev pkg-config \
    build-essential g++ automake autoconf libtool git \
    unrar libunrar-dev \
    ffmpeg \
    wget ca-certificates

# Build UnRAR library from source (keep source for rar2fs headers)
# Note: UnRAR doesn't support parallel builds well, so we build without -j
RUN cd /tmp && \
    wget -q https://www.rarlab.com/rar/unrarsrc-6.2.12.tar.gz && \
    tar xzf unrarsrc-6.2.12.tar.gz && \
    cd unrar && \
    make lib && \
    make install-lib

# Build rar2fs from source (point to unrar source directory)
RUN cd /tmp && \
    wget -q https://github.com/hasse69/rar2fs/releases/download/v1.29.6/rar2fs-1.29.6.tar.gz && \
    tar xzf rar2fs-1.29.6.tar.gz && \
    cd rar2fs-1.29.6 && \
    autoreconf -f -i && \
    ./configure --with-unrar=/tmp/unrar --with-unrar-lib=/usr/local/lib && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    cd / && \
    rm -rf /tmp/rar2fs-1.29.6* /tmp/unrar*

# Build fuse-archive from source for universal archive support (RAR, 7z, ZIP, etc.)
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

# Mount points for archive filesystems
RUN mkdir -p /mnt/archivefs /mnt/rarfs

# App
WORKDIR /app
COPY usenet_file_server.py /app/usenet_file_server.py

VOLUME ["/mnt/archivefs", "/mnt/rarfs"]
ENTRYPOINT ["python3", "/app/usenet_file_server.py"]
