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
        resultsPromise = OffCloud.searchTorrents(config.DebridApiKey, searchKey)
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
        resultsPromise = OffCloud.listTorrents(config.DebridApiKey)
    } else if (config.DebridProvider == "TorBox") {
        resultsPromise = Promise.resolve([])
    } else {
        return Promise.reject(BadRequestError)
    }

    return resultsPromise
}

function toMeta(torrent) {
    return {
        id: torrent.source + ':' + torrent.id,
        name: torrent.name,
        type: torrent.type,
        // poster: `https://img.icons8.com/ios/256/video--v1.png`,
        // posterShape: 'square'
    }
}


export default { searchTorrents, listTorrents }