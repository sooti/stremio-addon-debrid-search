import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';

// ===================================================================================
// --- CONFIGURATION ---
// ===================================================================================
const ADDON_HOST = 'https://sooti.info';
// ===================================================================================

const STREAM_NAME_MAP = {
    debridlink: "[DL+] DebridSearch",
    realdebrid: "[RD+] DebridSearch",
    alldebrid: "[AD+] DebridSearch",
    premiumize: "[PM+] DebridSearch",
    torbox: "[TB+] DebridSearch",
    offcloud: "[OC+] DebridSearch"
}

// ===================================================================================
// --- HELPER FUNCTIONS ---
// ===================================================================================

function isValidUrl(url) {
    return url && 
           typeof url === 'string' && 
           url !== 'undefined' && 
           url !== 'null' && 
           url.length > 0 &&
           (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:'));
}

// **ENHANCED VIDEO FILE FILTERING**
function isVideo(filename) {
    if (!filename || typeof filename !== 'string') return false;
    
    const videoExtensions = [
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', 
        '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'
    ];
    
    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return videoExtensions.includes(extension);
}

function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024) {
    if (!fileName) return false;
    
    const decodedName = decodeURIComponent(fileName).toLowerCase();
    
    // Skip non-video files completely
    if (!isVideo(decodedName)) {
        return false;
    }
    
    // Skip samples, trailers, etc.
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+)\b/i.test(decodedName)) {
        return false;
    }
    
    // Skip executables and other non-media files
    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decodedName)) {
        return false;
    }
    
    // Skip small files
    if (fileSize && fileSize < minSize) {
        return false;
    }
    
    return true;
}

// ===================================================================================
// --- MAIN FUNCTIONS ---
// ===================================================================================

async function getMovieStreams(config, type, id) {
    const cinemetaDetails = await Cinemeta.getMeta(type, id);
    const searchKey = cinemetaDetails.name;
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;

    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

    if (debridProvider == "DebridLink") {
        const torrents = await DebridLink.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const torrentIds = torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrent => torrent.id)

            if (torrentIds && torrentIds.length) {
                return await DebridLink.getTorrentDetails(apiKey, torrentIds.join())
                    .then(torrentDetailsList => {
                        return torrentDetailsList
                            .map(torrentDetails => toStream(torrentDetails, type, config))
                            .filter(Boolean);
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        let results = []
        
        // **Use RealDebrid comprehensive search (includes scrapers + cache checking)**
        const torrents = await RealDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrent => {
                    console.log(`[STREAM] Processing: ${torrent.name} -> ${torrent.url?.substring(0, 50)}...`);
                    return toStream(torrent, type, config);
                })
                .filter(Boolean);
            
            results.push(...streams);
        }

        const downloads = await RealDebrid.searchDownloads(apiKey, searchKey, 0.1)
        if (downloads && downloads.length) {
            const streams = downloads
                .filter(download => filterYear(download, cinemetaDetails))
                .map(download => toStream(download, type, config))
                .filter(Boolean);
            results.push(...streams);
        }
        return results;
    } else if (debridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterYear(torrent, cinemetaDetails))
                    .map(torrent => {
                        return AllDebrid.getTorrentDetails(apiKey, torrent.id)
                            .then(torrentDetails => toStream(torrentDetails, type, config))
                            .catch(err => {
                                console.log(err)
                                Promise.resolve()
                            })
                    })
            )
            return streams.filter(stream => stream)
        }
    } else if (debridProvider == "Premiumize") {
        const files = await Premiumize.searchFiles(apiKey, searchKey, 0.1)
        if (files && files.length) {
            const streams = await Promise.all(
                files
                    .filter(file => filterYear(file, cinemetaDetails))
                    .map(torrent => {
                        return Premiumize.getTorrentDetails(apiKey, torrent.id)
                            .then(torrentDetails => toStream(torrentDetails, type, config))
                            .catch(err => {
                                console.log(err)
                                Promise.resolve()
                            })
                    })
            )
            return streams.filter(stream => stream)
        }
    } else if (debridProvider.toLowerCase() == "offcloud") {
        const torrents = await OffCloud.searchOffcloudTorrents(apiKey, type, id);
        if (torrents && torrents.length) {
            return torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrentDetails => toStream(torrentDetails, type, config))
                .filter(Boolean);
        }
    } else if (debridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterYear(torrent, cinemetaDetails))
                    .map(torrentDetails => toStream(torrentDetails, type, config))
            )
            return streams.filter(stream => stream)
        }
    } else {
        return Promise.reject(BadRequestError)
    }

    return []
}

async function getSeriesStreams(config, type, id) {
    const [imdbId, season, episode] = id.split(":");
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
    const searchKey = cinemetaDetails.name;
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;

    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);
    
    if (debridProvider == "DebridLink") {
        const torrents = await DebridLink.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const torrentIds = torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => torrent.id)

            if (torrentIds && torrentIds.length) {
                return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
                    .then(torrentDetailsList => {
                        return torrentDetailsList
                            .filter(torrentDetails => filterEpisode(torrentDetails, season, episode))
                            .map(torrentDetails => toStream(torrentDetails, type, config))
                            .filter(Boolean);
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        let results = []
        
        // **Use comprehensive search with scrapers + cache checking for series**
        const torrents = await RealDebrid.searchRealDebridTorrents(apiKey, type, id);
        if (torrents && torrents.length) {
            const streams = torrents
                .filter(torrent => filterSeason(torrent, season))
                .filter(torrent => filterDownloadEpisode(torrent, season, episode))
                .map(torrent => {
                    console.log(`[STREAM] Series processing: ${torrent.name} -> ${torrent.url?.substring(0, 50)}...`);
                    return toStream(torrent, type, config);
                })
                .filter(Boolean);
            
            results.push(...streams);
        }

        const downloads = await RealDebrid.searchDownloads(apiKey, searchKey, 0.1)
        if (downloads && downloads.length) {
            const streams = downloads
                .filter(download => filterDownloadEpisode(download, season, episode))
                .map(download => toStream(download, type, config))
                .filter(Boolean);
            results.push(...streams);
        }
        return results;
    } else if (debridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return AllDebrid.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type, config)
                            }
                        })
                        .catch(err => {
                            console.log(err)
                            Promise.resolve()
                        })
                })
            )
            return streams.filter(stream => stream)
        }
    } else if (debridProvider == "Premiumize") {
        const torrents = await Premiumize.searchFiles(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return Premiumize.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type, config)
                            }
                        })
                        .catch(err => {
                            console.log(err)
                            Promise.resolve()
                        })
                })
            )
            return streams.filter(stream => stream)
        }
    } else if (debridProvider.toLowerCase() == "offcloud") {
        const torrents = await OffCloud.searchOffcloudTorrents(apiKey, type, id);
        if (torrents && torrents.length) {
            const bypassTorrents = torrents.filter(torrent => torrent.bypassFiltering === true);
            if (bypassTorrents.length > 0) {
                console.log(`[SERIES PROCESSOR] Found ${bypassTorrents.length} bypass torrents - returning ONLY these`);
                return bypassTorrents
                    .map(torrentDetails => toStream(torrentDetails, type, config))
                    .filter(Boolean);
            }
            
            const episodeRegex = new RegExp(`s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`, 'i');
            const realEpisodes = torrents.filter(torrent => episodeRegex.test(torrent.name));
            return realEpisodes
                .map(torrentDetails => toStream(torrentDetails, type, config))
                .filter(Boolean);
        }
    } else if (debridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterEpisode(torrent, season, episode))
                    .map(torrentDetails => toStream(torrentDetails, type, config))
            )
            return streams.filter(stream => stream)
        }
    } else {
        return Promise.reject(BadRequestError)
    }

    return []
}

// **COMPLETELY FIXED RESOLVER FOR MAGNET LINKS**
async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp) {
    const provider = debridProvider.toLowerCase();
    
    if (!isValidUrl(hostUrl)) {
        console.error(`[RESOLVER] Invalid URL provided: ${hostUrl}`);
        return null;
    }
    
    if (provider == "debridlink" || provider == "premiumize") {
        return hostUrl;
    } else if (provider == "offcloud") {
        return OffCloud.resolveStream(debridApiKey, hostUrl);
    } else if (provider == "realdebrid") {
        
        // **COMPLETELY FIXED: Enhanced magnet link processing with correct API flow**
        if (hostUrl.startsWith('magnet:')) {
            console.log(`[RESOLVER] Processing magnet link for Real-Debrid`);
            
            try {
                const RD = new RealDebridClient(debridApiKey);
                
                // **API CALL 1: Add magnet**
                const addResponse = await RD.torrents.addMagnet(hostUrl);
                
                if (!addResponse?.data?.id) {
                    console.error(`[RESOLVER] Failed to add magnet to Real-Debrid`);
                    return null;
                }
                
                const torrentId = addResponse.data.id;
                console.log(`[RESOLVER] Added magnet to RD as torrent: ${torrentId}`);
                
                // **API CALL 2: Select files to start processing (CRITICAL FIX)**
                try {
                    await RD.torrents.selectFiles(torrentId); // Select all files
                    console.log(`[RESOLVER] Selected all files for processing`);
                } catch (selectError) {
                    console.log(`[RESOLVER] Failed to select files: ${selectError.message}`);
                    try { await RD.torrents.delete(torrentId); } catch {}
                    return null;
                }
                
                // **Wait for Real-Debrid to process the cached torrent**
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // **API CALL 3: Get torrent info to find video files**
                const torrentInfo = await RD.torrents.info(torrentId);
                
                if (!torrentInfo?.data?.files || !torrentInfo.data.links) {
                    console.log(`[RESOLVER] Torrent not ready yet or no files available`);
                    try { await RD.torrents.delete(torrentId); } catch {}
                    return null;
                }
                
                // **Enhanced video file detection (same as cache checking)**
                const videoFiles = torrentInfo.data.files
                    .filter(file => file.selected)
                    .filter(file => {
                        // Strict video file validation
                        const validExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts'];
                        const extension = file.path.toLowerCase().substring(file.path.lastIndexOf('.'));
                        
                        if (!validExtensions.includes(extension)) {
                            console.log(`[RESOLVER] Skipping non-video file: ${file.path}`);
                            return false;
                        }
                        
                        // Minimum size check (100MB)
                        if (file.bytes < 100 * 1024 * 1024) {
                            console.log(`[RESOLVER] Skipping small file: ${file.path} (${Math.round(file.bytes / 1024 / 1024)}MB)`);
                            return false;
                        }
                        
                        // Skip samples/trailers/executables
                        const fileName = file.path.toLowerCase();
                        if (/sample|trailer|promo|extra|bonus|behind.*scenes|\.exe|\.iso|\.zip|\.rar/i.test(fileName)) {
                            console.log(`[RESOLVER] Skipping unwanted file: ${file.path}`);
                            return false;
                        }
                        
                        return true;
                    });
                
                if (videoFiles.length === 0) {
                    console.log(`[RESOLVER] No valid video files found in torrent`);
                    try { await RD.torrents.delete(torrentId); } catch {}
                    return null;
                }
                
                // **Get the largest video file**
                const largestVideo = videoFiles.reduce((prev, current) => 
                    (prev.bytes > current.bytes) ? prev : current
                );
                
                console.log(`[RESOLVER] Selected video file: ${largestVideo.path} (${Math.round(largestVideo.bytes / 1024 / 1024)}MB)`);
                
                const fileIndex = torrentInfo.data.files.findIndex(f => f.id === largestVideo.id);
                const directUrl = torrentInfo.data.links[fileIndex];
                
                if (!directUrl || directUrl === 'undefined') {
                    console.log(`[RESOLVER] No direct URL for video file`);
                    try { await RD.torrents.delete(torrentId); } catch {}
                    return null;
                }
                
                console.log(`[RESOLVER] Got RD direct URL, now unrestricting...`);
                
                // **API CALL 4: Unrestrict the Real-Debrid URL**
                const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
                
                if (!unrestrictedUrl) {
                    console.error(`[RESOLVER] Failed to unrestrict RD URL`);
                    try { await RD.torrents.delete(torrentId); } catch {}
                    return null;
                }
                
                console.log(`[RESOLVER] ✅ Successfully resolved cached magnet to streaming URL`);
                return unrestrictedUrl;
                
            } catch (error) {
                console.error(`[RESOLVER] Error processing magnet link: ${error.message}`);
                return null;
            }
            
        } else {
            // **Handle regular Real-Debrid URLs**
            console.log(`[RESOLVER] Unrestricting Real-Debrid URL: ${hostUrl.substring(0, 50)}...`);
            
            try {
                const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
                
                if (!unrestrictedUrl) {
                    console.error(`[RESOLVER] Failed to unrestrict URL: ${hostUrl}`);
                    return null;
                }
                
                console.log(`[RESOLVER] Successfully unrestricted to: ${unrestrictedUrl.substring(0, 80)}...`);
                return unrestrictedUrl;
                
            } catch (error) {
                console.error(`[RESOLVER] Real-Debrid unrestrict error: ${error.message}`);
                return null;
            }
        }
        
    } else if (provider == "alldebrid") {
        return AllDebrid.unrestrictUrl(debridApiKey, hostUrl);
    } else if (provider == "torbox") {
        return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
    } else {
        return Promise.reject(BadRequestError);
    }
}

// ===================================================================================
// --- FILTERING FUNCTIONS ---
// ===================================================================================

function filterSeason(torrent, season) {
    return torrent?.info?.season == season || torrent?.info?.seasons?.includes(Number(season));
}

function filterEpisode(torrentDetails, season, episode) {
    if (!torrentDetails.videos) {
        return false;
    }
    
    torrentDetails.videos = torrentDetails.videos
        .filter(video => (season == video.info.season) && (episode == video.info.episode));
    return torrentDetails.videos && torrentDetails.videos.length;
}

function filterYear(torrent, cinemetaDetails) {
    if (torrent?.info?.year && cinemetaDetails?.year) {
        return torrent.info.year == cinemetaDetails.year;
    }
    return true;
}

function filterDownloadEpisode(download, season, episode) {
    if (!download) return false;
    
    if (download.info && download.info.season == season && download.info.episode == episode) {
        return true;
    }
    
    const episodeRegex = new RegExp(`s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`, 'i');
    const altEpisodeRegex = new RegExp(`s${season}e${episode}`, 'i');
    
    const fileName = download.name || download.title || '';
    return episodeRegex.test(fileName) || altEpisodeRegex.test(fileName);
}

// ===================================================================================
// --- STREAM BUILDING FUNCTION ---
// ===================================================================================

function toStream(details, type, config) {
    let video = details;
    let icon = details.isPersonal ? '☁️' : '💾';
    let personalTag = details.isPersonal ? '[Cloud] ' : '';

    if (!isValidUrl(video.url)) {
        console.warn(`[STREAM] Skipping torrent with invalid URL: ${video.url}`);
        return null;
    }

    function shouldUseArchiveName(videoFileName, archiveName) {
        if (!videoFileName || !archiveName) return false;
        
        const meaningfulPatterns = [
            /s\d{2}e\d{2}/i,
            /1080p|720p|480p|2160p|4k/i,
            /bluray|web|hdtv|dvd|brrip/i,
            /x264|x265|h264|h265/i,
            /remaster|director|extended/i,
            /\d{4}/
        ];
        
        return !meaningfulPatterns.some(pattern => pattern.test(videoFileName));
    }

    let displayName = video.name || video.title || 'Unknown';
    if (video.searchableName && shouldUseArchiveName(video.name, video.searchableName)) {
        const archiveName = video.searchableName.split(' ')[0] || video.name;
        displayName = archiveName;
        console.log(`[STREAM] Using archive name "${archiveName}"`);
    }

    let title = personalTag + displayName;
    if (type == 'series' && video.name && video.name !== displayName) {
        title = title + '\n' + video.name;
    }
    const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
    title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

    let name = STREAM_NAME_MAP[details.source] || "[DS+] DebridSearch";
    name = name + '\n' + (video.info?.resolution || 'N/A');

    // **CRITICAL FIX: Always use resolver for Real-Debrid to ensure unrestricting**
    let streamUrl;
    
    if (details.source === 'realdebrid') {
        // **ALL Real-Debrid links must go through resolver**
        const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
        const encodedUrl = encodeURIComponent(video.url);
        streamUrl = `${ADDON_HOST}/resolve/realdebrid/${encodedApiKey}/${encodedUrl}`;
        
        console.log(`[STREAM] Routing RD through resolver: ${video.url.substring(0, 50)}...`);
        
    } else if (details.source === 'offcloud' && video.url.includes('offcloud.com/cloud/download/')) {
        streamUrl = video.url;
        console.log(`[STREAM] Using OffCloud direct link`);
        
    } else {
        const encodedApiKey = encodeURIComponent(config.DebridApiKey || config.DebridLinkApiKey || '');
        const encodedUrl = encodeURIComponent(video.url);
        streamUrl = `${ADDON_HOST}/resolve/${details.source}/${encodedApiKey}/${encodedUrl}`;
    }

    let streamObj = {
        name,
        title,
        url: streamUrl,
        behaviorHints: {
            bingeGroup: `${details.source}|${details.hash || details.id || 'unknown'}`
        }
    };

    if (details.bypassFiltering) {
        streamObj.bypassFiltering = true;
    }

    return streamObj;
}

function formatSize(size) {
    if (!size) return '';
    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

export default { getMovieStreams, getSeriesStreams, resolveUrl };
