FROM ubuntu:22.04

# System deps + build tools for rar2fs + ffmpeg for error videos
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    fuse libfuse-dev \
    build-essential automake autoconf libtool \
    unrar libunrar-dev \
    ffmpeg \
    wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build UnRAR library from source (keep source for rar2fs headers)
RUN cd /tmp && \
    wget https://www.rarlab.com/rar/unrarsrc-6.2.12.tar.gz && \
    tar xzf unrarsrc-6.2.12.tar.gz && \
    cd unrar && \
    make lib && \
    make install-lib

# Build rar2fs from source (point to unrar source directory)
RUN cd /tmp && \
    wget https://github.com/hasse69/rar2fs/releases/download/v1.29.6/rar2fs-1.29.6.tar.gz && \
    tar xzf rar2fs-1.29.6.tar.gz && \
    cd rar2fs-1.29.6 && \
    autoreconf -f -i && \
    ./configure --with-unrar=/tmp/unrar --with-unrar-lib=/usr/local/lib && \
    make && \
    make install && \
    ldconfig && \
    cd / && \
    rm -rf /tmp/rar2fs-1.29.6* /tmp/unrar*

# allow_other for FUSE mounts
RUN sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf || true

# Mount point
RUN mkdir -p /mnt/rarfs

# App
WORKDIR /app
COPY usenet_file_server.py /app/usenet_file_server.py

VOLUME ["/mnt/rarfs"]
ENTRYPOINT ["python3", "/app/usenet_file_server.py"]
