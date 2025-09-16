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
const ADDON_HOST = process.env.ADDON_URL
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

// --- Universal Sorting Logic ---
function getResolutionFromName(name) {
    if (!name) return 'other';
    const lowerCaseName = name.toLowerCase();
    if (lowerCaseName.includes('2160p') || lowerCaseName.includes('4k') || lowerCaseName.includes('uhd')) return '2160p';
    if (lowerCaseName.includes('1080p')) return '1080p';
    if (lowerCaseName.includes('720p')) return '720p';
    if (lowerCaseName.includes('480p')) return '480p';
    return 'other';
}

const resolutionOrder = {
    '2160p': 4,
    '1080p': 3,
    '720p': 2,
    '480p': 1,
    'other': 0
};

function sortTorrents(a, b) {
    const nameA = a.name || a.title || '';
    const nameB = b.name || b.title || '';
    const resA = getResolutionFromName(nameA);
    const resB = getResolutionFromName(nameB);
    const rankA = resolutionOrder[resA] || 0;
    const rankB = resolutionOrder[resB] || 0;
    if (rankA !== rankB) {
        return rankB - rankA;
    }
    const sizeA = a.size || 0;
    const sizeB = b.size || 0;
    return sizeB - sizeA;
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
                            .sort(sortTorrents)
                            .map(torrentDetails => toStream(torrentDetails, type, config))
                            .filter(Boolean);
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        // This provider's module already sorts the results internally.
        const allResults = await RealDebrid.searchRealDebridTorrents(apiKey, type, id);

        if (!allResults || allResults.length === 0) {
            return [];
        }

        return allResults
            .filter(item => filterYear(item, cinemetaDetails))
            .map(item => toStream(item, type, config))
            .filter(Boolean);
    } else if (debridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .sort(sortTorrents)
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
                    .sort(sortTorrents)
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
                .sort(sortTorrents)
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrentDetails => toStream(torrentDetails, type, config))
                .filter(Boolean);
        }
    } else if (debridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .sort(sortTorrents)
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
                            .sort(sortTorrents)
                            .filter(torrentDetails => filterEpisode(torrentDetails, season, episode))
                            .map(torrentDetails => toStream(torrentDetails, type, config))
                            .filter(Boolean);
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        // This provider's module already sorts the results internally.
        const allResults = await RealDebrid.searchRealDebridTorrents(apiKey, type, id);

        if (!allResults || allResults.length === 0) {
            return [];
        }

        return allResults
            .filter(torrent => filterSeason(torrent, season))
            .filter(torrent => filterDownloadEpisode(torrent, season, episode))
            .map(torrent => toStream(torrent, type, config))
            .filter(Boolean);
    } else if (debridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .sort(sortTorrents)
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
                .sort(sortTorrents)
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
                    .sort(sortTorrents)
                    .map(torrentDetails => toStream(torrentDetails, type, config))
                    .filter(Boolean);
            }
            
            const episodeRegex = new RegExp(`s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`, 'i');
            const realEpisodes = torrents.filter(torrent => episodeRegex.test(torrent.name));
            return realEpisodes
                .sort(sortTorrents)
                .map(torrentDetails => toStream(torrentDetails, type, config))
                .filter(Boolean);
        }
    } else if (debridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .sort(sortTorrents)
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

    try {
        if (provider === "realdebrid") {
            // Your new, robust Real-Debrid logic
            if (hostUrl.startsWith('magnet:')) {
                // ... (the entire, working magnet polling logic for RD)
                console.log(`[RESOLVER] Processing magnet link for Real-Debrid`);
        
                const maxRetries = 10;
                const retryInterval = 5000; 
                
                const RD = new RealDebridClient(debridApiKey);
                let torrentId = null;

                try {
                    const addResponse = await RD.torrents.addMagnet(hostUrl);
                    if (!addResponse?.data?.id) { throw new Error("Failed to add magnet (no ID returned)."); }
                    torrentId = addResponse.data.id;
                    console.log(`[RESOLVER] Added magnet, received ID: ${torrentId}`);

                    await RD.torrents.selectFiles(torrentId, 'all');
                    console.log(`[RESOLVER] Selected all files. Now waiting for RD to prepare the stream...`);

                    let torrentInfo = null;
                    for (let i = 0; i < maxRetries; i++) {
                        torrentInfo = await RD.torrents.info(torrentId);
                        const status = torrentInfo?.data?.status;
                        console.log(`[RESOLVER] Poll #${i+1}: Torrent status is "${status}"`);

                        if (status === 'downloaded') {
                            console.log(`[RESOLVER] ✅ Torrent is ready!`);
                            break; 
                        }
                        
                        if (status === 'magnet_error' || status === 'error' || status === 'virus' || status === 'dead') {
                            throw new Error(`Torrent failed with status: ${status}`);
                        }
                        if (i === maxRetries - 1) {
                            throw new Error(`Torrent not ready after ${maxRetries * retryInterval / 1000} seconds.`);
                        }
                        await new Promise(resolve => setTimeout(resolve, retryInterval));
                    }

                    if (!torrentInfo?.data?.links?.length) {
                        throw new Error("Torrent is ready but no streamable links were found in the response.");
                    }
                    
                    const videoFiles = torrentInfo.data.files.filter(file => file.selected && isValidVideo(file.path, file.bytes));
                    if (videoFiles.length === 0) { throw new Error("No valid video files found in the torrent."); }

                    const largestVideo = videoFiles.reduce((prev, current) => (prev.bytes > current.bytes) ? prev : current);
                    console.log(`[RESOLVER] Selected video file: ${largestVideo.path}`);

                    const selectedFiles = torrentInfo.data.files.filter(f => f.selected === 1);
                    const linkIndex = selectedFiles.findIndex(f => f.id === largestVideo.id);

                    if (linkIndex === -1) {
                        throw new Error("Logic error: Could not find the largest video file within the selected files list.");
                    }

                    const directUrl = torrentInfo.data.links[linkIndex];
                    if (!directUrl || directUrl === 'undefined') {
                        throw new Error("Could not find a direct URL for the selected video file after matching indexes.");
                    }

                    console.log(`[RESOLVER] Unrestricting final link...`);
                    const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
                    if (!unrestrictedUrl) {
                        throw new Error("Failed to unrestrict the Real-Debrid URL.");
                    }
                    
                    console.log(`[RESOLVER] ✅✅✅ Successfully resolved magnet to streaming URL`);
                    return unrestrictedUrl;

                } catch (error) {
                    console.error(`[RESOLVER] ❌ Final error in magnet processing: ${error.message}`);
                    if (torrentId) {
                        try { await RD.torrents.delete(torrentId); } catch (e) {}
                    }
                    return null;
                }
            } else {
                return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
            }
        } else if (provider === "offcloud") {
            console.log(`[RESOLVER] Resolving OffCloud URL: ${hostUrl.substring(0, 50)}...`);
            const resolvedUrl = await OffCloud.resolveStream(debridApiKey, hostUrl);
            if (!resolvedUrl) {
                throw new Error("OffCloud.resolveStream returned an empty or invalid URL.");
            }
            console.log(`[RESOLVER] ✅ Successfully resolved OffCloud stream`);
            return resolvedUrl;
        } else if (provider === "debridlink" || provider === "premiumize") {
            // These providers may not require server-side resolving
            return hostUrl;
        } else if (provider === "alldebrid") {
            return AllDebrid.unrestrictUrl(debridApiKey, hostUrl);
        } else if (provider === "torbox") {
            return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
        } else {
            throw new Error(`Unsupported debrid provider: ${debridProvider}`);
        }
    } catch (error) {
        console.error(`[RESOLVER] A critical error occurred in resolver for ${debridProvider}: ${error.message}`);
        // Log the stack trace for more details if available
        if (error.stack) {
            console.error(error.stack);
        }
        return null; // Ensure a null is returned on any failure
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
