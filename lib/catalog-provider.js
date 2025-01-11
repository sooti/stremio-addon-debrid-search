import DebridLink from './debrid-link.js'
import RealDebrid from './real-debrid.js'
import AllDebrid from './all-debrid.js'
import OffCloud from './offcloud.js'
import TorBox from './torbox.js'
import { BadRequestError } from './util/error-codes.js'

async function searchTorrents(config, searchKey) {
    let resultsPromise
    if (config.DebridLinkApiKey) {
        resultsPromise = DebridLink.searchTorrents(config.DebridLinkApiKey, searchKey)
    } else if (config.DebridProvider == "DebridLink") {
        resultsPromise = DebridLink.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "RealDebrid") {
        resultsPromise = RealDebrid.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "AllDebrid") {
        resultsPromise = AllDebrid.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "OffCloud") {
    resultsPromise = OffCloud.searchOffcloudTorrents(config.DebridApiKey, searchKey, 0.4)
    } else if (config.DebridProvider == "TorBox") {
        resultsPromise = Promise.resolve([])
    } else {
        return Promise.reject(BadRequestError)
    }

    return resultsPromise
        .then(torrents => torrents.map(torrent => toMeta(torrent)))
}

async function listTorrents(config, skip = 0) {
    if (!config.ShowCatalog) {
        return Promise.resolve([])
    }

    let resultsPromise

    if (config.DebridLinkApiKey) {
        resultsPromise = DebridLink.listTorrents(config.DebridLinkApiKey, skip)
    } else if (config.DebridProvider == "DebridLink") {
        resultsPromise = DebridLink.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "RealDebrid") {
        resultsPromise = RealDebrid.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "AllDebrid") {
        resultsPromise = AllDebrid.listTorrents(config.DebridApiKey)
    } else if (config.DebridProvider == "OffCloud") {
        console.log("trying to resolve")
        resultsPromise = OffCloud.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "TorBox") {
        resultsPromise = Promise.resolve([])
    } else {
        return Promise.reject(BadRequestError)
    }

    return resultsPromise
}

function toMeta(torrent) {
    const videoFileExtensions = /\.(mp4|mkv|flv|avi|mov|wmv|webm|m4v)$/i;

    // Check if `torrent.url` is a single string or an array
    const urls = Array.isArray(torrent.url) 
        ? torrent.url 
        : typeof torrent.url === 'string' 
        ? [torrent.url] 
        : [];

    // Filter valid video URLs
    const validUrls = urls.filter(url => videoFileExtensions.test(decodeURIComponent(url)));

    if (validUrls.length === 0) {
        // No valid URLs found
        console.warn('No valid video URLs found for torrent:', torrent);
        return null;
    }

    return {
        id: `${torrent.source}:${torrent.id}`,
        name: torrent.name,
        type: torrent.type,
        url: torrent.url, // Use validUrl directly
        // poster: `https://img.icons8.com/ios/256/video--v1.png`,
        // posterShape: 'square'
    };
}



export default { searchTorrents, listTorrents }