<p align="center">
  <img src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Cdefs%3E%3ClinearGradient%20id='grad'%20x1='0%25'%20y1='0%25'%20x2='100%25'%20y2='100%25'%3E%3Cstop%20offset='0%25'%20style='stop-color:%2364ffda;stop-opacity:1'%20/%3E%3Cstop%20offset='100%25'%20style='stop-color:%2300A7B5;stop-opacity:1'%20/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath%20fill='url(%23grad)'%20d='M50,5%20C74.85,5%2095,25.15%2095,50%20C95,74.85%2074.85,95%2050,95%20C35,95%2022.33,87.6%2015,76%20C25,85%2040,85%2050,80%20C60,75%2065,65%2065,50%20C65,35%2055,25%2040,25%20C25,25%2015,40%2015,50%20C15,55%2016,60%2018,64%20C8.5,58%205,45%205,50%20C5,25.15%2025.15,5%2050,5%20Z'/%3E%3C/svg%3E" alt="Sootio Logo" width="150">
</p>

<h1 align="center">Sootio - The Ultimate Stremio Debrid Addon</h1>

<p align="center">
  <i>Sootio is an intelligent, multi-source streaming engine for Stremio that delivers the highest quality cached torrents, Usenet downloads, and direct HTTP streams from your Debrid services with smart tiered prioritization.</i>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/version-1.4.7-blue.svg" alt="Version"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/node-%5E20.x-brightgreen.svg" alt="Node Version"></a>
</p>

---

## ✨ Key Features

### 🎯 Multiple Content Sources
- **7 Debrid Providers**: Real-Debrid, All-Debrid, TorBox, Premiumize, OffCloud, Debrid-Link, Debrider.app
- **14 Torrent Scrapers**: Jackett, Zilean, Torrentio, Comet, StremThru, Bitmagnet, Snowfl, 1337x, BTDigg, MagnetDL, TorrentGalaxy, Torrent9, Wolfmax4K, BluDV
- **Usenet Support**: Full Newznab + SABnzbd integration with progressive streaming
- **HTTP Streaming**: 4KHDHub, UHDMovies with PixelDrain/Google Drive support
- **Personal Cloud**: Home media server integration with fuzzy matching

### 🧠 Intelligent Stream Prioritization
- **Tiered Quality System**: Remux > BluRay > WEB-DL > WEBRip > Lower quality
- **Smart Codec Balancing**: Configurable H.264 vs H.265 distribution
- **Early Exit Optimization**: Stops searching when quality threshold is met
- **Per-Quality Limits**: Fine-grained control over results per tier
- **Audio Codec Filtering**: Skip AAC/Opus if desired
- **Junk Release Filtering**: Automatically filters YIFY, RARBG, and other low-quality groups

### ⚡ Performance & Scalability
- **Multi-Worker Clustering**: Up to 32 workers for high-load scenarios (configurable)
- **Dual-Layer Caching**: 5000-entry in-memory + MongoDB persistent cache
- **Rate Limiting**: Per-provider rate limit management (250 req/min for RD, 600/min for AD)
- **Progressive Results**: Returns cached results while fetching fresh data
- **Concurrent Processing**: Parallel scraper execution with smart coordination

### 🌍 Advanced Features
- **50+ Language Support**: Multi-audio detection with flag emojis (🇬🇧 🇫🇷 🇪🇸 🇩🇪 etc.)
- **Season Pack Inspection**: Smart episode extraction from season packs
- **Year-Based Filtering**: Prevents wrong sequel/remake matches
- **SOCKS5/HTTP Proxy Support**: Per-service proxy configuration (WARP-friendly)
- **MongoDB Cache**: Persistent cache with TTL and auto-cleanup
- **Usenet Progressive Streaming**: Starts streaming at 3% download completion
- **HTTP Range Requests**: Full seeking support for all streams
- **Docker Ready**: Complete Docker + docker-compose setup

### 📊 Monitoring & Debugging
- **Prometheus Metrics**: Built-in performance monitoring
- **Configurable Logging**: Debug, info, warn, error levels
- **Per-Provider Debug Logs**: Detailed debugging for each debrid service
- **Cache Hit/Miss Tracking**: Monitor cache efficiency

---

## 🛠️ How It Works

When you search for a movie or episode in Stremio:

1. **Parallel Scraping** → Queries all enabled scrapers simultaneously (Jackett, Zilean, 1337x, etc.)
2. **Quality Categorization** → Groups results by quality tier (Remux, BluRay, WEB-DL, WEBRip)
3. **Cache Checking** → Verifies torrent availability on your Debrid providers
4. **Smart Filtering** → Applies codec diversity, audio filtering, and quality limits
5. **Prioritized Ranking** → Sorts by tier, then resolution, then file size
6. **Early Exit** → Returns results as soon as quality threshold is reached
7. **Multi-Layer Caching** → Stores results in memory + MongoDB for instant future lookups

**Result**: Streams are ordered from *best → worst* with instant playback and no waiting.

---

## 🚀 Installation

### Method 1: Docker (Recommended)

#### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

#### Steps

1. **Clone the repository**
```bash
git clone https://github.com/sooti/sootio-stremio-addon.git
cd sootio-stremio-addon
```

2. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your settings (see Configuration section below)
nano .env  # or use your preferred editor
```

3. **Build and run**
```bash
# Basic setup (no MongoDB)
docker-compose up -d

# With MongoDB for persistent cache (recommended)
docker-compose --profile mongodb up -d
```

4. **Access the addon**
- Open `http://localhost:55771` (or your configured ADDON_URL)
- Configure your Debrid provider API keys
- Click **Install to Stremio**

#### Docker Management

```bash
# View logs
docker-compose logs -f

# Restart addon
docker-compose restart

# Stop addon
docker-compose down

# Rebuild after code changes
docker-compose up -d --build
```

---

### Method 2: Manual Installation

#### Prerequisites
- [Node.js](https://nodejs.org/) v20.x
- [pnpm](https://pnpm.io/) v9.x (recommended) or npm
- [Git](https://git-scm.com/)

#### Steps

1. **Clone the repository**
```bash
git clone https://github.com/your-username/sootio-stremio-addon.git
cd sootio-stremio-addon
```

2. **Install dependencies**
```bash
# Using pnpm (recommended)
pnpm install

# Or using npm
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your settings
nano .env  # or use your preferred editor
```

4. **Run the addon**
```bash
# Production mode with clustering (recommended)
npm start

# Single worker mode (for debugging)
npm run standalone

# Development mode with auto-reload
npm run dev
```

5. **Access the addon**
- Open `http://localhost:55771` (or your configured port)
- Configure your Debrid provider API keys
- Click **Install to Stremio**

---

### Method 3: Optional MongoDB Setup

MongoDB is **optional** but **highly recommended** for:
- Multi-user scenarios
- Persistent cache across restarts
- Better performance with frequent searches
- Shared cache across multiple addon instances

#### Local MongoDB with Docker
```bash
# Using docker-compose profile
docker-compose --profile mongodb up -d

# Or manually
docker run -d \
  --name sootio-mongodb \
  -p 27017:27017 \
  -v sootio-mongo-data:/data/db \
  mongo:7
```

#### Configure MongoDB in .env
```env
MONGO_CACHE_ENABLED=true
MONGO_URI=mongodb://localhost:27017
MONGO_DB_NAME=sootio
MONGO_CACHE_COLLECTION=magnet_cache
MONGO_CACHE_TTL_DAYS=180
```

---

## ⚙️ Configuration

Sootio is configured via the `.env` file. See `.env.example` for all available options.

### Essential Settings

```env
# Addon URL (your domain or localhost)
ADDON_URL=http://localhost:55771
PORT=55771

# Logging
LOG_LEVEL=error
DEBRID_DEBUG_LOGS=false
```

### Debrid Provider Configuration

Debrid providers are configured via the **Stremio UI** when installing the addon:
- Real-Debrid
- All-Debrid
- TorBox
- Premiumize
- OffCloud
- Debrid-Link
- Debrider.app

### Torrent Scrapers

Enable/disable scrapers individually:

```env
JACKETT_ENABLED=true
JACKETT_URL=http://your-jackett-ip:9117
JACKETT_API_KEY=your_api_key

ZILEAN_ENABLED=true
TORRENT_1337X_ENABLED=true
BTDIG_ENABLED=true
MAGNETDL_ENABLED=true
SNOWFL_ENABLED=false
TORRENTIO_ENABLED=false
COMET_ENABLED=false
STREMTHRU_ENABLED=false
BITMAGNET_ENABLED=false
TORRENT_GALAXY_ENABLED=false
TORRENT9_ENABLED=false
WOLFMAX4K_ENABLED=false
BLUDV_ENABLED=false

# Scraper timeout (ms)
SCRAPER_TIMEOUT=5000
```

### Quality & Filtering

```env
# Skip certain quality tiers
PRIORITY_SKIP_WEBRIP_ENABLED=true
PRIORITY_SKIP_AAC_OPUS_ENABLED=true

# Per-quality result limits
MAX_RESULTS_REMUX=2
MAX_RESULTS_BLURAY=2
MAX_RESULTS_WEBDL=2
MAX_RESULTS_WEBRIP=1

# Codec diversity
DIVERSIFY_CODECS_ENABLED=true
MAX_H265_RESULTS_PER_QUALITY=2
MAX_H264_RESULTS_PER_QUALITY=2

# Overall limits
TARGET_CODEC_COUNT=10
EARLY_EXIT_QUALITY_THRESHOLD=BluRay
```

### Performance Tuning

```env
# Clustering (auto uses cluster mode)
MAX_WORKERS=10

# Rate limits
RD_RATE_PER_MINUTE=250
RD_CONCURRENCY=10
AD_RATE_PER_MINUTE=600
AD_CONCURRENCY=50

# Caching
SCRAPER_CACHE_TTL_MOVIE_MIN=360
SCRAPER_CACHE_TTL_SERIES_MIN=60
```

### MongoDB Cache

```env
MONGO_CACHE_ENABLED=true
MONGO_URI=mongodb://localhost:27017
MONGO_DB_NAME=sootio
MONGO_CACHE_TTL_DAYS=180
```

### Proxy Support

```env
# Proxy URL (supports HTTP/HTTPS/SOCKS5)
DEBRID_HTTP_PROXY=socks5h://warp:1080

# Which services to proxy
DEBRID_PROXY_SERVICES=*:true
# Or specific: realdebrid:true,scrapers:true
```

### Usenet (Optional)

```env
USENET_FILE_SERVER_URL=http://localhost:8765
USENET_FILE_SERVER_API_KEY=your_api_key
```

Usenet services (Newznab indexers and SABnzbd) are configured via the **Stremio UI**.

### Advanced Options

See `.env.example` for 100+ additional configuration options including:
- HTTP streaming settings
- Season pack handling
- Cache TTL values
- Request timeouts and retries
- Debug options

---

## 📋 Supported Content Sources

### Debrid Providers (7)
| Provider | Cache Check | Personal Cloud | Season Packs | Notes |
|----------|-------------|----------------|--------------|-------|
| Real-Debrid | ✅ Hash-based | ✅ | ✅ | Full support |
| All-Debrid | ✅ Magnet-based | ✅ | ✅ | Full support |
| TorBox | ✅ | ✅ | ✅ | Usenet support |
| OffCloud | ✅ Hash-based | ✅ | ✅ | Full support |
| Premiumize | ✅ | ✅ | ✅ | Full support |
| Debrid-Link | ❌ | ✅ Seedbox | ❌ | Personal files only |
| Debrider.app | ✅ | ✅ | ✅ | Usenet support |

### Torrent Scrapers (14)
| Scraper | Type | Language | Notes |
|---------|------|----------|-------|
| Jackett | TorZNab API | Multi | Multi-indexer support |
| Zilean | DMM Database | Multi | Fast hash-based search |
| 1337x | HTML Scraper | English | Multi-page support |
| BTDigg | DHT | Multi | Optional proxy rotation |
| MagnetDL | HTML Scraper | English | Fast direct scraping |
| Snowfl | API | Multi | snowfl-api integration |
| TorrentGalaxy | Aggregator | Multi | Wide coverage |
| Wolfmax4K | Specialty | Multi | High-quality 4K content |
| Torrent9 | Regional | French | French content focus |
| BluDV | Regional | Portuguese | Brazilian content |
| Torrentio | Addon Bridge | Multi | Stremio integration |
| Comet | Debrid-focused | Multi | Optimized for debrid |
| StremThru | Premium | Multi | Premium service |
| Bitmagnet | Self-hosted | Multi | DHT crawler |

### HTTP Streaming (2)
- **4KHDHub**: PixelDrain, Google Drive/Workers.dev links
- **UHDMovies**: Direct HTTP streams with multi-quality support

### Usenet
- **Newznab**: Multi-indexer support with category-based search
- **SABnzbd**: Progressive streaming starting at 3% completion

---

## 🔧 Advanced Usage

### Clustering for High Load

```bash
# Single process (debugging)
npm run standalone

# Multi-worker with default settings
npm start

# Custom worker count
MAX_WORKERS=16 npm start
```

### Usenet Progressive Streaming Setup

1. **Install Python file server**
```bash
cd media-file-server
pip install -r requirements.txt  # if using FastAPI version
python usenet_file_server.py    # zero-dependency version
```

2. **Configure in .env**
```env
USENET_FILE_SERVER_URL=http://localhost:8765
USENET_FILE_SERVER_API_KEY=your_secret_key
```

3. **Configure via Stremio UI**
- Add Newznab indexer URLs and API keys
- Add SABnzbd URL and API key
- Streams will start at 3% download completion

### WARP Proxy for Debrid Services

Some regions may have debrid services blocked. Use Cloudflare WARP:

```yaml
# docker-compose.yml
services:
  warp:
    image: caomingjun/warp:latest
    container_name: warp
    restart: unless-stopped
    ports:
      - "1080:1080"
    environment:
      - WARP_SLEEP=2
```

```env
# .env
DEBRID_HTTP_PROXY=socks5h://warp:1080
DEBRID_PROXY_SERVICES=*:true
```

---

## ⚠️ Important Notes

### Cache Checking Support
| Provider | Method | Speed |
|----------|--------|-------|
| Real-Debrid | Hash-based instant | ⚡⚡⚡ Very Fast |
| All-Debrid | Magnet upload + check | ⚡⚡ Fast |
| OffCloud | Hash-based instant | ⚡⚡⚡ Very Fast |
| TorBox | Cache check API | ⚡⚡⚡ Very Fast |
| Premiumize | Cache check API | ⚡⚡⚡ Very Fast |
| Debrider.app | Cache check API | ⚡⚡⚡ Very Fast |
| Debrid-Link | Personal cloud only | ⚡ Moderate |

### First Search Performance
- Initial searches may take 10-30 seconds while caches warm up
- Subsequent searches are instant (served from cache)
- MongoDB cache persists across restarts

### Recommended Settings
- **Single user**: 4-6 workers, MongoDB optional
- **Multi-user (5-10)**: 10-16 workers, MongoDB required
- **High load (50+)**: 24-32 workers, MongoDB + Redis recommended

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Report Bugs**: Open an issue describing the bug and steps to reproduce
2. **Feature Requests**: Suggest new features or improvements
3. **Pull Requests**: Submit PRs with bug fixes or new features
4. **Documentation**: Help improve documentation and examples

### Development Setup

```bash
# Clone and install
git clone https://github.com/your-username/sootio-stremio-addon.git
cd sootio-stremio-addon
pnpm install

# Run in development mode
npm run dev

# Run tests (if available)
npm test
```

### Contribution Guidelines

- Follow existing code style
- Add comments for complex logic
- Test your changes thoroughly
- Update documentation as needed
- Keep PRs focused on a single feature/fix

---

## 📊 Architecture Overview

```
sootio-stremio-addon/
├── server.js              # Express server setup
├── cluster.js             # Multi-worker clustering
├── addon.js               # Stremio addon definition
├── lib/
│   ├── stream-provider.js      # Main stream orchestration
│   ├── catalog-provider.js     # Personal downloads catalog
│   ├── {provider}.js           # Debrid provider integrations (7)
│   ├── common/
│   │   ├── scrapers.js         # All torrent scrapers (14)
│   │   ├── mongo-cache.js      # MongoDB cache layer
│   │   └── debrid-cache-processor.js
│   ├── util/
│   │   ├── debrid-proxy.js     # Proxy management
│   │   ├── language-mapping.js # 50+ language support
│   │   ├── filter-torrents.js  # Quality filtering
│   │   └── ...
│   ├── http-streams.js         # 4KHDHub integration
│   ├── uhdmovies.js           # UHDMovies integration
│   ├── usenet.js              # Usenet orchestration
│   ├── newznab.js             # Newznab indexer support
│   ├── sabnzbd.js             # SABnzbd integration
│   └── home-media.js          # Personal media server
├── media-file-server/
│   ├── usenet_file_server.py   # Python HTTP file server
│   └── fastapi_file_server.py  # FastAPI alternative
└── .env                        # Configuration

Total: ~24,000 lines of code across 40+ modules
```

---

## 🙏 Credits

- **Original Concept**: Based on the [Stremio Debrid Search addon](https://github.com/MrMonkey42/stremio-addon-debrid-search) by [@MrMonkey42](https://github.com/MrMonkey42)
- **Parse Torrent Title**: Uses [@TheBeastLT's fork](https://github.com/TheBeastLT/parse-torrent-title) for enhanced title parsing
- **Stremio SDK**: Built with the official [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- **Community**: Thanks to all contributors and users providing feedback

---

## 🔗 Related Projects

- [Stremio](https://www.stremio.com/) - Official Stremio website
- [Torrentio](https://torrentio.strem.fun/) - Popular torrent addon for Stremio
- [Jackett](https://github.com/Jackett/Jackett) - Torrent indexer proxy
- [Zilean](https://github.com/iPromKnight/zilean) - DMM hash database
- [SABnzbd](https://sabnzbd.org/) - Usenet download client

---

## 📝 License

This project is licensed under the [MIT License](LICENSE).

---

## 💬 Support

For issues, questions, or feature requests:
- Open an [issue on GitHub](../../issues)
- Check existing issues for solutions
- Provide detailed information (logs, config, error messages)

---

<p align="center">
  Made with ❤️ by the Sootio community
</p>
