import DebridLinkClient from 'debrid-link-api'
import Fuse from 'fuse.js'
import { isVideo } from './util/extension-util.js'
import PTT from './util/parse-torrent-title.js'
import { BadTokenError, AccessDeniedError } from './util/error-codes.js'
import { encode } from 'urlencode'

async function searchTorrents(apiKey, searchKey, threshold = 0.3) {
    console.log("Search torrents with searchKey: " + searchKey)

    let torrentsResults = await listTorrentsParallel(apiKey)
    let torrents = torrentsResults.map(torrentsResult => toTorrent(torrentsResult))
    // console.log("torrents: " + JSON.stringify(torrents))
    const fuse = new Fuse(torrents, {
        keys: ['info.title'],
        threshold: threshold,
        minMatchCharLength: 2
    })

    const searchResults = fuse.search(searchKey)
    if (searchResults && searchResults.length) {
        return searchResults.map(searchResult => searchResult.item)
    } else {
        return []
    }
}

async function listTorrents(apiKey, skip = 0) {
    const DL = new DebridLinkClient(apiKey)
    const idParent = 'seedbox'
    let torrents = []

    let nextPage = Math.floor(skip / 50)

    await DL.files.list(idParent, nextPage)
        .then(result => {
            if (result.success) {
                torrents = torrents.concat(result.value)
            }
        })
        .catch(err => handleError(err))

    // Todo: Refactor with toMeta()
    const metas = torrents.map(torrent => {
        return {
            id: 'debridlink:' + torrent.id.split('-')[0],
            name: torrent.name,
            type: 'other',
        }
    })
    return metas || []
}

async function listTorrentsParallel(apiKey) {
    const DL = new DebridLinkClient(apiKey)
    const idParent = 'seedbox'
    let torrents = []
    let promises = []

    let nextPage = 0
    let totalPages = 0
    await DL.files.list(idParent)
        .then(result => {
            if (result.success) {
                torrents = torrents.concat(result.value)
                totalPages = Math.min(10, result.pagination.pages)
                nextPage = result.pagination.next
            }
        })
        .catch(err => handleError(err))

    while (nextPage != -1 && nextPage < totalPages) {
        promises.push(
            DL.files.list(idParent, nextPage)
                .then(result => {
                    if (result.success) {
                        torrents = torrents.concat(result.value)
                    }
                })
                .catch(err => handleError(err))
        )
        nextPage = nextPage + 1
    }

    await Promise.all(promises)
        .catch(err => handleError(err))

    return torrents
}

async function getTorrentDetails(apiKey, ids) {
    const DL = new DebridLinkClient(apiKey)

    return await DL.seedbox.list(ids)
        .then(result => result.value)
        .then(torrents => torrents.map(torrent => toTorrentDetails(torrent)))
        .catch(err => handleError(err))
}

function toTorrent(item) {
    return {
        source: 'debridlink',
        id: item.id.split('-')[0],
        name: item.name,
        type: 'other',
        info: PTT.parse(item.name),
        size: item.size,
        created: new Date(item.created * 1000),
    }
}

function toTorrentDetails(item) {
    const videos = item.files
        .filter(file => isVideo(file.name))
        .map(file => {
            const url = `${process.env.ADDON_URL}/resolve/DebridLink/null/${item.id}/${encode(file.downloadUrl)}`
            return {
                id: file.id,
                name: file.name,
                url: url,
                size: file.size,
                created: new Date(item.created * 1000),
                info: PTT.parse(file.name)
            }
        })

    return {
        source: 'debridlink',
        id: item.id,
        name: item.name,
        type: 'other',
        hash: item.hashString.toLowerCase(),
        size: item.totalSize,
        created: new Date(item.created * 1000),
        videos: videos || []
    }
}

function handleError(err) {
    console.log(err)
    if (err === 'badToken') {
        return Promise.reject(BadTokenError)
    }

    return Promise.reject(err)
}

export default { listTorrents, searchTorrents, getTorrentDetails }