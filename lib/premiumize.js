import axios from 'axios'
import Fuse from 'fuse.js'
import { isVideo } from './util/extension-util.js'
import PTT from './util/parse-torrent-title.js'
import { BadTokenError, AccessDeniedError } from './util/error-codes.js'
import { encode } from 'urlencode'
import * as torrentUtils from './common/torrent-utils.js'

const BASE_URL = 'https://www.premiumize.me/api'

async function searchFiles(apiKey, searchKey, threshold = 0.3) {
    console.log("Search files with searchKey: " + searchKey)

    let files = await listFiles(apiKey)
    let torrents = files.map(file => toTorrent(file))
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

async function listFiles(apiKey) {
    try {
        const url = `${BASE_URL}/item/listall?apikey=${apiKey}`
        const response = await axios.get(url)

        if (response.data && response.data.status === 'success') {
            return response.data.files || []
        } else {
            console.error('Premiumize listFiles failed:', response.data)
            return []
        }
    } catch (err) {
        return handleError(err)
    }
}

async function getTorrentDetails(apiKey, id) {
    try {
        const url = `${BASE_URL}/transfer/directdl?apikey=${apiKey}&id=${id}`
        const response = await axios.get(url)

        if (response.data && response.data.status === 'success') {
            return toTorrentDetails({ ...response.data, id: id })
        } else {
            console.error(`Premiumize getTorrentDetails for id ${id} failed:`, response.data)
            return null
        }
    } catch (err) {
        return handleError(err)
    }
}

function toTorrent(item) {
    return {
        source: 'premiumize',
        id: item.id,
        name: item.name,
        type: 'other',
        info: PTT.parse(item.name),
        size: item.size,
        created: new Date(item.created_at * 1000),
    }
}

function toTorrentDetails(item) {
    const videos = (item.content || [])
        .filter(file => isVideo(file.path))
        .map(file => ({
            name: file.path.split('/').pop(),
            url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(file.stream_link)}`,
            size: file.size,
        }))

    if (videos.length === 0 && item.location && isVideo(item.filename)) {
        videos.push({
            name: item.filename,
            url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(item.location)}`,
            size: item.filesize,
        })
    }

    return {
        source: 'premiumize',
        id: item.id,
        name: item.filename,
        type: 'other',
        hash: item.id.toLowerCase(),
        size: item.filesize,
        videos: videos || []
    }
}

function handleError(err) {
    console.log(err)
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        return Promise.reject(BadTokenError)
    }
    return Promise.reject(err)
}

async function checkCache(apiKey, hashes) {
    if (!hashes || hashes.length === 0) {
        return []
    }

    try {
        const url = `${BASE_URL}/cache/check`
        const body = `apikey=${apiKey}&${hashes.map(h => `items[]=${h}`).join('&')}`
        const response = await axios.post(url, body)

        if (response.data && response.data.status === 'success') {
            const cached = []
            for (let i = 0; i < hashes.length; i++) {
                if (response.data.response[i]) {
                    cached.push({
                        infoHash: hashes[i],
                        name: response.data.filename[i],
                        size: torrentUtils.sizeToBytes(response.data.filesize[i]),
                        source: 'premiumize',
                    })
                }
            }
            return cached
        } else {
            console.error('Premiumize checkCache failed:', response.data)
            return []
        }
    } catch (err) {
        return handleError(err)
    }
}

export default { listFiles, searchFiles, getTorrentDetails, checkCache }
