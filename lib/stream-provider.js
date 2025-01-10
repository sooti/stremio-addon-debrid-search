import Cinemeta from './util/cinemeta.js'
import DebridLink from './debrid-link.js'
import RealDebrid from './real-debrid.js'
import AllDebrid from './all-debrid.js'
import Premiumize from './premiumize.js'
import OffCloud from './offcloud.js'
import TorBox from './torbox.js'
import { BadRequestError } from './util/error-codes.js'
import { FILE_TYPES } from './util/file-types.js'

const STREAM_NAME_MAP = {
    debridlink: "[DL+] DebridSearch",
    realdebrid: "[RD+] DebridSearch",
    alldebrid: "[AD+] DebridSearch",
    premiumize: "[PM+] DebridSearch",
    torbox: "[TB+] DebridSearch",
    offcloud: "[OC+] OffCloud"
}

async function getMovieStreams(config, type, id) {
    const cinemetaDetails = await Cinemeta.getMeta(type, id)
    const searchKey = cinemetaDetails.name

    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey

    if (config.DebridLinkApiKey || config.DebridProvider == "DebridLink") {
        const torrents = await DebridLink.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const torrentIds = torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrent => torrent.id)

            if (torrentIds && torrentIds.length) {
                return await DebridLink.getTorrentDetails(apiKey, torrentIds.join())
                    .then(torrentDetailsList => {
                        return torrentDetailsList.map(torrentDetails => toStream(torrentDetails))
                    })
            }
        }
    } else if (config.DebridProvider == "RealDebrid") {
        let results = []
        const torrents = await RealDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterYear(torrent, cinemetaDetails))
                .map(torrent => {
                return RealDebrid.getTorrentDetails(apiKey, torrent.id)
                    .then(torrentDetails => toStream(torrentDetails))
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
                .map(download => {return toStream(download, type)}))
            results.push(...streams)
        }
        return results.filter(stream => stream)
    } else if (config.DebridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterYear(torrent, cinemetaDetails))
                    .map(torrent => {
                        return AllDebrid.getTorrentDetails(apiKey, torrent.id)
                            .then(torrentDetails => toStream(torrentDetails))
                            .catch(err => {
                                console.log(err)
                                Promise.resolve()
                            })
                    })
            )

            return streams.filter(stream => stream)
        }
    } else if (config.DebridProvider == "Premiumize") {
        const files = await Premiumize.searchFiles(apiKey, searchKey, 0.1)
        if (files && files.length) {
            const streams = await Promise.all(
                files
                    .filter(file => filterYear(file, cinemetaDetails))
                    .map(torrent => {
                        return Premiumize.getTorrentDetails(apiKey, torrent.id)
                            .then(torrentDetails => toStream(torrentDetails))
                            .catch(err => {
                                console.log(err)
                                Promise.resolve()
                            })
                    })
            )

            return streams.filter(stream => stream)
        }
    } else if (config.DebridProvider == "OffCloud") {
        const torrents = await OffCloud.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterYear(torrent, cinemetaDetails))
                    .map(torrentDetails => toStream(torrentDetails))
            )

            return streams.filter(stream => stream)
        }
    } else if (config.DebridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterYear(torrent, cinemetaDetails))
                    .map(torrentDetails => toStream(torrentDetails))
            )

            return streams.filter(stream => stream)
        }
    } else {
        return Promise.reject(BadRequestError)
    }

    return []
}

async function getSeriesStreams(config, type, id) {
    const [imdbId, season, episode] = id.split(":")
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId)
    const searchKey = cinemetaDetails.name

    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey

    if (config.DebridLinkApiKey || config.DebridProvider == "DebridLink") {
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
                            .map(torrentDetails => toStream(torrentDetails, type))
                    })
            }
        }
    } else if (config.DebridProvider == "RealDebrid") {
        let results = []
        const torrents = await RealDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return RealDebrid.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type)
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
                .map(download => {return toStream(download, type)}))
            results.push(...streams)
        }
        return results.filter(stream => stream)
    } else if (config.DebridProvider == "AllDebrid") {
        const torrents = await AllDebrid.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return AllDebrid.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type)
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
    } else if (config.DebridProvider == "Premiumize") {
        const torrents = await Premiumize.searchFiles(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(torrents
                .filter(torrent => filterSeason(torrent, season))
                .map(torrent => {
                    return Premiumize.getTorrentDetails(apiKey, torrent.id)
                        .then(torrentDetails => {
                            if (filterEpisode(torrentDetails, season, episode)) {
                                return toStream(torrentDetails, type)
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
} else if (config.DebridProvider == "OffCloud") {
    function filterEpisodesOffCloud(torrent, cinemetaDetails) {
    // Decode the file name
    const decodedFileName = decodeURIComponent(torrent.name);

    // Create a regex to match SXXEYY
    const regex = new RegExp(`S${seasonFormatted}E${episodeFormatted}`, "i");

    // Check if the decoded file name matches the pattern
    return regex.test(decodedFileName);
}
    const [imdbId, season, episode] = id.split(":");

    const seasonFormatted = season.padStart(2, "0");
    const episodeFormatted = episode.padStart(2, "0");

    const torrents = await OffCloud.searchTorrents(apiKey, searchKey, 0.1);
    if (torrents && torrents.length) {
        const streams = await Promise.all(
            torrents
                .filter(torrent => filterEpisodesOffCloud(torrent, cinemetaDetails))
                .map(torrentDetails => toStream(torrentDetails))
        );

        return streams.filter(stream => stream);
} else {
    console.log("No torrents found or empty list.");


            console("Your stream:\n", streams)

            return streams.filter(stream => stream)
        }
    } else if (config.DebridProvider == "TorBox") {
        const torrents = await TorBox.searchTorrents(apiKey, searchKey, 0.1)
        if (torrents && torrents.length) {
            const streams = await Promise.all(
                torrents
                    .filter(torrent => filterEpisode(torrent, season, episode))
                    .map(torrentDetails => toStream(torrentDetails, type))
            )
            return streams.filter(stream => stream)
        }
    } else {
        return Promise.reject(BadRequestError)
    }

    return []
}

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp) {
    if (debridProvider == "DebridLink" || debridProvider == "Premiumize") {
        return hostUrl
    } else if (debridProvider == "RealDebrid") {
        return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp)
    } else if (debridProvider == "AllDebrid") {
        return AllDebrid.unrestrictUrl(debridApiKey, hostUrl)
    } else if (debridProvider == "TorBox") {
        return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp)
    } else {
        return Promise.reject(BadRequestError)
    }
}

function filterSeason(torrent, season) {
    return torrent?.info.season == season || torrent?.info.seasons?.includes(Number(season))
}

function filterEpisode(torrentDetails, season, episode) {
    torrentDetails.videos = torrentDetails.videos
        .filter(video => (season == video.info.season) && (episode == video.info.episode))

        return torrentDetails.videos && torrentDetails.videos.length
}

function filterYear(torrent, cinemetaDetails) {
    if (torrent?.info?.year && cinemetaDetails?.year) {
        return torrent.info.year == cinemetaDetails.year
    }

    return true
}

function filterDownloadEpisode(download, season, episode) {
    return download && download.info.season == season && download.info.episode == episode
}

function toStream(details, type) {

    console.log("dfdfdfd", details)

    // Ensure details.url is an array
    const urls = Array.isArray(details.url) ? details.url : [details.url];

    // Check if any URL in the array ends with a valid video file extension
    const videoFileExtensions = /\.(mp4|mkv|flv|avi|mov|wmv|webm|m4v)$/i;
    const validUrl = urls.find(url => videoFileExtensions.test(decodeURIComponent(url)));

    if (!validUrl) {
        // Return null or handle appropriately if no valid URL is found
        return null;
    }

    let icon = '💾';
    let title = details.name;

    // if (type === 'series') {
    //     title = title + '\n' + details.name;
    // }
    title = title + '\n' + icon;

    let name = STREAM_NAME_MAP[details.source];
    name = name + '\n' + details.info.resolution;

    let bingeGroup = details.source + '|' + details.id;

    return {
        name,
        title,
        url: validUrl, // Use the first valid URL found
        behaviorHints: {
            bingeGroup: bingeGroup
        }
    };
}



function formatSize(size) {
    if (!size) {
        return undefined
    }

    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024))
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i]
}

export default { getMovieStreams, getSeriesStreams, resolveUrl }