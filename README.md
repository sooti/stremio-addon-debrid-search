<p align="center">
  <img src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Cdefs%3E%3ClinearGradient%20id='grad'%20x1='0%25'%20y1='0%25'%20x2='100%25'%20y2='100%25'%3E%3Cstop%20offset='0%25'%20style='stop-color:%2364ffda;stop-opacity:1'%20/%3E%3Cstop%20offset='100%25'%20style='stop-color:%2300A7B5;stop-opacity:1'%20/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath%20fill='url(%23grad)'%20d='M50,5%20C74.85,5%2095,25.15%2095,50%20C95,74.85%2074.85,95%2050,95%20C35,95%2022.33,87.6%2015,76%20C25,85%2040,85%2050,80%20C60,75%2065,65%2065,50%20C65,35%2055,25%2040,25%20C25,25%2015,40%2015,50%20C15,55%2016,60%2018,64%20C8.5,58%205,45%205,50%20C5,25.15%2025.15,5%2050,5%20Z'/%3E%3C/svg%3E" alt="Sootio Logo" width="150">
</p>

<h1 align="center">Sootio - A Smart Stremio Debrid Addon</h1>

<p align="center">
  <i>Sootio isn’t just another Debrid addon — it’s an intelligent search and prioritization engine for Stremio, built to deliver the highest quality, instantly streamable cached torrents from your Debrid service.</i>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/build-passing-brightgreen.svg" alt="Build Status"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
</p>

---

## ✨ Features

- ⚡ **Instant Debrid Streaming**  
  Searches only for torrents already cached on your Debrid provider’s servers — no waiting, no buffering.

- 🧠 **Smart Tiered Prioritization**  
  Always see the best links first. Streams are sorted in tiers:  
  `Remux > BluRay > WEB-DL > Lower-quality rips`.

- 🔍 **Multi-Source Scraping**  
  Queries multiple torrent sources in parallel, including Jackett, Torrentio, Zilean, Bitmagnet, and more.

- ⚙️ **Advanced Filtering & Control**  
  Configure granular rules in `.env`, such as:  
  - Skip low-quality groups (e.g., YTS/YIFY).  
  - Filter out AAC/Opus audio codecs.  
  - Balance H.264 vs H.265 results.  
  - Set per-quality limits for results.

- 🚀 **Early Exit Optimization**  
  Stops searching as soon as enough high-quality results are found — faster responses, fewer wasted API calls.

- ☁️ **Personal Cloud Search**  
  Seamlessly integrates torrents from your Debrid cloud.

- 🎬 **Accurate Year Filtering**  
  Prevents mismatched torrents (wrong sequels/remakes) by cross-checking release years.

---

## 🛠️ How It Works

When you search for a movie or episode:

1. **Scrape All Sources** → Sends parallel requests to all enabled scrapers.  
2. **Group & Rank** → Categorizes results by quality & resolution.  
3. **Process in Tiers** → Starts cache checks with the highest-quality tier first.  
4. **Filter & Limit** → Applies your filtering rules (e.g., codecs, result caps).  
5. **Early Exit** → Immediately returns top-quality results once thresholds are met.

The result: streams are always ordered from *best → worst*, with reliability and quality prioritized.

---

## 🚀 Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v18+  
- [Git](https://git-scm.com/)

### Steps
```bash
# Clone the repository
git clone https://github.com/your-username/sootio-stremio-addon.git
cd sootio-stremio-addon

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### Run the Addon
```bash
npm start
```

### Add to Stremio
Open the URL shown in terminal (e.g. `http://127.0.0.1:PORT`), enter your API key, and click **Install Addon**.

---

## ⚙️ Configuration

All options are set via `.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBRID_PROVIDER` | Debrid service (`RealDebrid`, `OffCloud`, `AllDebrid`, etc.) | `RealDebrid` |
| `DEBRID_API_KEY` | API key for your Debrid provider | — |
| `MAX_RESULTS_REMUX` | Max Remux results per resolution | `4` |
| `MAX_RESULTS_BLURAY` | Max BluRay results per resolution | `4` |
| `MAX_RESULTS_WEBDL` | Max WEB-DL results per resolution | `2` |
| `PRIORITY_SKIP_WEBRIP_ENABLED` | Skip WEBRip/BRRip releases | `true` |
| `PRIORITY_SKIP_AAC_OPUS_ENABLED` | Skip AAC/Opus audio codecs | `true` |
| `DIVERSIFY_CODECS_ENABLED` | Enforce codec balancing | `true` |
| `MAX_H265_RESULTS_PER_QUALITY` | Max H.265 results per tier | `2` |
| `MAX_H264_RESULTS_PER_QUALITY` | Max H.264 results per tier | `2` |
| `RD_DEBUG_LOGS` | Enable verbose debugging logs | `false` |

---

## ⚠️ Notes & Current Issues

1. Only **Real-Debrid** and **OffCloud** currently support cache checking via torrent hashes.  
   Other providers fall back to personal cloud search.  

2. Torrent hashes are cached locally to reduce API calls and improve speed.  
   Initial searches on rare releases may take up to 30 seconds.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!  
Feel free to check the [issues page](../../issues).

Credit to [@MrMonkey42](https://github.com/MrMonkey42) for the original [Stremio Debrid Search addon](https://github.com/MrMonkey42/stremio-addon-debrid-search), which Sootio builds upon.

---

## 📝 License

This project is licensed under the [MIT License](LICENSE).
