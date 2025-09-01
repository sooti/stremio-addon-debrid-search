import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';

// ===================================================================================
// --- CONFIGURATION ---
// ===================================================================================
const ADDON_HOST = 'https://debrid.sooti.info';
// ===================================================================================


const STREAM_NAME_MAP = {
    debridlink: "[DL+] DebridSearch",
    realdebrid: "[RD+] DebridSearch",
    alldebrid: "[AD+] DebridSearch",
    premiumize: "[PM+] DebridSearch",
    torbox: "[TB+] DebridSearch",
    offcloud: "[OC+] DebridSearch"
}

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
                        return torrentDetailsList.map(torrentDetails => toStream(torrentDetails, type, config))
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        let results = []
        const torrents = await RealDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrent => {
                    return RealDebrid.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => toStream(torrentDetails, type, config))
                        .catch(err => {
                            console.log(err)
                            Promise.resolve()
                        })
                }))
            results.push(...streams)
        }

        const downloads = await RealDebrid.searchDownloads(apiKey, searchKey, 0.1)
        if (downloads && downloads.length) {
            const streams = await Promise.all(downloads
                .filter(download => filterYear(download, cinemetaDetails))
                .map(download => {return toStream(download, type, config)}))
            results.push(...streams)
        }
        return results.filter(stream => stream)
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
                .map(torrentDetails => toStream(torrentDetails, type, config));
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
                    })
            }
        }
    } else if (debridProvider == "RealDebrid") {
        let results = []
        const torrents = await RealDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return RealDebrid.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type, config)
                            }
                        })
                        .catch(err => {
                            console.log(err)
                            Promise.resolve()
                        })
                }))
            results.push(...streams)
        }

        const downloads = await RealDebrid.searchDownloads(apiKey, searchKey, 0.1)
        if (downloads && downloads.length) {
            const streams = await Promise.all(downloads
                .filter(download => filterDownloadEpisode(download, season, episode))
                .map(download => {return toStream(download, type, config)}))
            results.push(...streams)
        }
        return results.filter(stream => stream)
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
            const episodeRegex = new RegExp(`s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`, 'i');
            const realEpisodes = torrents.filter(torrent => episodeRegex.test(torrent.name));
            return realEpisodes
                .map(torrentDetails => toStream(torrentDetails, type, config));
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

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp) {
    const provider = debridProvider.toLowerCase();
    if (provider == "debridlink" || provider == "premiumize") {
        return hostUrl;
    } else if (provider == "offcloud") {
        return OffCloud.resolveStream(debridApiKey, hostUrl);
    } else if (provider == "realdebrid") {
        return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
    } else if (provider == "alldebrid") {
        return AllDebrid.unrestrictUrl(debridApiKey, hostUrl);
    } else if (provider == "torbox") {
        return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
    } else {
        return Promise.reject(BadRequestError);
    }
}

function filterSeason(torrent, season) {
    return torrent?.info.season == season || torrent?.info.seasons?.includes(Number(season));
}

function filterEpisode(torrentDetails, season, episode) {
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
    return download && download.info.season == season && download.info.episode == episode;
}

function toStream(details, type, config) {
    let video = details;
    let icon = details.isPersonal ? '☁️' : '💾';
    let personalTag = details.isPersonal ? '[Cloud] ' : '';

    let title = personalTag + details.name;
    if (type == 'series' && video.name && video.name !== details.name) {
        title = title + '\n' + video.name;
    }
    const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
    title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

    let name = STREAM_NAME_MAP[details.source] || "[DS+] DebridSearch";
    name = name + '\n' + (video.info.resolution || 'N/A');

    const streamUrl = details.isPersonal
        ? details.url
        : `${ADDON_HOST}/resolve/${details.source}/${config.DebridApiKey}/${encodeURIComponent(video.url)}`;

    return {
        name,
        title,
        url: streamUrl,
        behaviorHints: {
            bingeGroup: `${details.source}|${details.hash}`
        }
    }
}

function formatSize(size) {
    if (!size) return '';
    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

export default { getMovieStreams, getSeriesStreams, resolveUrl };
