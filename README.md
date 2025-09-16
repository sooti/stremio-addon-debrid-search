<p align="center">
<img src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Cdefs%3E%3ClinearGradient%20id='grad'%20x1='0%25'%20y1='0%25'%20x2='100%25'%20y2='100%25'%3E%3Cstop%20offset='0%25'%20style='stop-color:%2364ffda;stop-opacity:1'%20/%3E%3Cstop%20offset='100%25'%20style='stop-color:%2300A7B5;stop-opacity:1'%20/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath%20fill='url(%23grad)'%20d='M50,5%20C74.85,5%2095,25.15%2095,50%20C95,74.85%2074.85,95%2050,95%20C35,95%2022.33,87.6%2015,76%20C25,85%2040,85%2050,80%20C60,75%2065,65%2065,50%20C65,35%2055,25%2040,25%20C25,25%2015,40%2015,50%20C15,55%2016,60%2018,64%20C8.5,58%205,45%205,50%20C5,25.15%2025.15,5%2050,5%20Z'/%3E%3C/svg%3E" alt="Sootio Logo" width="150">
</p>

<h1 align="center">Sootio - A Smart Stremio Debrid Addon</h1>

<p align="center">
Sootio isn't just another Debrid addon. It's an intelligent search and prioritization engine for Stremio, designed to find the highest quality, instantly streamable cached torrents from your Debrid service. It uses a sophisticated, tiered scoring system to ensure you always get the best possible links first.
</p>

<p align="center">
<a href="#">
<img src="https://img.shields.io/badge/build-passing-brightgreen.svg" alt="Build Status">
</a>
<a href="#">
<img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
</a>
</p>

✨ Key Features

    ⚡ Instant Debrid Streaming: Sootio exclusively searches for torrents already cached (downloaded) on your Debrid service's servers, ensuring every link starts playing instantly with no waiting or buffering.

    🧠 Smart Tiered Prioritization: This is the core of Sootio. Instead of a random list, results are processed in quality-based tiers. It checks for Remux and BluRay files first, then WEB-DLs, and finally lower-quality rips. This means the highest fidelity streams always appear at the top of your list.

    🔍 Multi-Source Scraping: The addon simultaneously queries a wide range of torrent sources (including Jackett, Torrentio, Zilean, Bitmagnet, and more) to build a comprehensive list of all available cached torrents.

    ⚙️ Advanced Filtering & Control: Through a simple configuration file, you have granular control over the results. You can:

        Set the maximum number of results for each quality type (e.g., Remux, BluRay).

        Automatically skip low-quality releases from groups like YTS/YIFY.

        Filter out releases with undesirable audio codecs like AAC/Opus.

        Diversify results by setting limits on the number of H.264 vs. H.265 (x265) files.

    🚀 Highly Efficient "Early Exit": To provide results as fast as possible, Sootio stops searching as soon as it has found a sufficient number of top-tier streams (as defined by you in the settings). This saves time and reduces unnecessary API calls.

    ☁️ Personal Cloud Search: Sootio also searches your personal Debrid cloud, finding files you have previously downloaded or added, and seamlessly integrates them into the results.

    🎬 Accurate Year Filtering: For movies, the addon cross-references the release year to filter out mismatched torrents (e.g., incorrect sequels or remakes), ensuring you get the right movie every time.

🛠️ How It Works: The Prioritization Engine

When you search for a movie or episode, Sootio performs a multi-stage process to build the perfect stream list:

    Scrape All Sources: It sends out parallel requests to all enabled scrapers to find every potential torrent hash.

    Group & Rank: It takes all the results and categorizes them by quality (Remux, BluRay, WEB-DL, etc.) and resolution (2160p, 1080p, etc.). Within each category, results are sorted by size (largest first).

    Process in Tiers: It begins checking the torrent hashes against your Debrid service's cache, but only for the highest quality tier first (e.g., 4K/1080p Remuxes and BluRays).

    Filter & Limit: As it checks, it applies your advanced filtering rules (skipping certain codecs, diversifying results) and respects the maximum result limits you've set for each category.

    Early Exit: Once the limits for the top-tier categories are met, the process stops and immediately returns the high-quality links it has found, without wasting time checking lower-quality rips. If the top tiers don't yield enough results, it proceeds to the next tier down (e.g., WEB-DLs) and repeats the process.

This method guarantees that the list of streams you see in Stremio is always ordered from best to worst, with a strong emphasis on quality and reliability.

🚀 Installation & Configuration

Prerequisites

    Node.js (v18 or higher recommended)

    Git

Steps

    Clone the Repository:
    Bash

1. git clone https://github.com/your-username/sootio-stremio-addon.git
2. cd sootio-stremio-addon

Install Dependencies:
Bash

1. npm install

Configure: Create a file named .env in the project root by copying the .env.example file. Then, edit the .env file with your settings. See the Configuration Details section below for an explanation of all options.
Code snippet

# --- SCRAPER SETTINGS ---
JACKETT_URL=YOUR_JACKET_URL
JACKETT_API_KEY=YOUR_JACKETT_API_KEY
Enable any further scrapers you want in the .env file, torrentio, comet and all public services are disabled by default to discourage overflowing public services (On my public instance as well, I use self hosted trackers and scrapers) but if you want to do a self hosted you can enable public scraping

# --- See Configuration Details below for all options ---

Run the Addon:
Bash

    npm start

    Install in Stremio: Open the provided http://127.0.0.1:PORT address in your browser, configure your API key on the landing page, and click the "Install Addon" button.

⚙️ Configuration Details

All configuration is done via the .env file.
Variable	Description	Default
DEBRID_PROVIDER	Your primary Debrid service. Options: RealDebrid, OffCloud, AllDebrid, etc.	RealDebrid
DEBRID_API_KEY	The API key for your chosen Debrid service.	
MAX_RESULTS_REMUX	Max number of Remux results per resolution (4K, 1080p) before the Early Exit may trigger.	4
MAX_RESULTS_BLURAY	Max number of BluRay results per resolution before the Early Exit may trigger.	4
MAX_RESULTS_WEBDL	Max number of WEB-DL results per resolution.	2
PRIORITY_SKIP_WEBRIP_ENABLED	If true, completely ignores lower-quality WEBRip and BRRip releases.	true
PRIORITY_SKIP_AAC_OPUS_ENABLED	If true, skips releases that primarily feature lower-quality AAC or Opus audio.	true
DIVERSIFY_CODECS_ENABLED	If true, enables the codec limit rules below.	true
MAX_H265_RESULTS_PER_QUALITY	Max number of H.265 (x265/HEVC) results to return for each quality/resolution combination.	2
MAX_H264_RESULTS_PER_QUALITY	Max number of H.264 (x264/AVC) results to return for each quality/resolution combination.	2
RD_DEBUG_LOGS	If true, enables verbose logging for debugging the prioritization and filtering process.	false

* Notes on current issues:
1. Only Real-Debrid & Offcloud currently support cache checking on the debrid services using hashes, the rest use the original functions of searching the personal cloud, I may add it in the future but I would need some help paying for at least a few months of service for other debrid services to look at their APIs and develop + test
2. Hashes are cached for a set amount of time locally to reduce API request strain and improve search time on RD but initial searches can take up to 30 seconds on non popular releases so keep in mind.
🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the issues page.
Original add-on that this project is forked from is https://github.com/MrMonkey42/stremio-addon-debrid-search, credit to @MrMonkey42 for the initial cloud searching functions

📝 License

This project is MIT licensed.
