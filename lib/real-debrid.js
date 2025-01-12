import RealDebridClient from 'real-debrid-api'
import Fuse from 'fuse.js'
import { isVideo } from './util/extension-util.js'
import PTT from './util/parse-torrent-title.js'
import { BadTokenError, AccessDeniedError } from './util/error-codes.js'
import { FILE_TYPES } from './util/file-types.js'
import { encode } from 'urlencode'

async function searchFiles(fileType, apiKey, searchKey, threshold) {
    console.log("Search " + fileType.description + " with searchKey: " + searchKey)

    const files = await listFilesParrallel(fileType, apiKey, 1, 1000)
    let results = []
    if (fileType == FILE_TYPES.TORRENTS)
        results = files.map(result => {return toTorrent(result)})
    else if (fileType == FILE_TYPES.DOWNLOADS)
        results = files.map(result => {return toDownload(result)})
    results.map(result => result.fileType = fileType)
    // console.log(fileType.description + " " + JSON.stringify(results))
    const fuse = new Fuse(results, {
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

async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
    return searchFiles(FILE_TYPES.TORRENTS, apiKey, searchKey, threshold)
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
    return searchFiles(FILE_TYPES.DOWNLOADS, apiKey, searchKey, threshold)
}

async function getTorrentDetails(apiKey, id) {
    const RD = new RealDebridClient(apiKey)

    return await RD.torrents.info(id)
        .then(resp => toTorrentDetails(apiKey, resp.data))
        .catch(err => handleError(err))
}

async function toTorrentDetails(apiKey, item) {
    const videos = item.files
        .filter(file => file.selected)
        .filter(file => isVideo(file.path))
        .map((file, index) => {
            const hostUrl = item.links.at(index)
            const url = `${process.env.ADDON_URL}/resolve/RealDebrid/${apiKey}/${item.id}/${encode(hostUrl)}`

            return {
                id: `${item.id}:${file.id}`,
                name: file.path,
                url: url,
                size: file.bytes,
                created: new Date(item.added),
                info: PTT.parse(file.path)
            }
        })

    return {
        source: 'realdebrid',
        id: item.id,
        name: item.filename,
        type: 'other',
        hash: item.hash,
        info: PTT.parse(item.filename),
        size: item.bytes,
        created: new Date(item.added),
        videos: videos || []
    }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
    const options = getDefaultOptions(clientIp);
    const RD = new RealDebridClient(apiKey, options)

    return RD.unrestrict.link(hostUrl)
        .then(resp => resp.data.download)
        .catch(err => handleError(err))
}

function toTorrent(item) {
    return {
        source: 'realdebrid',
        id: item.id,
        name: item.filename,
        type: 'other',
        info: PTT.parse(item.filename),
        size: item.bytes,
        created: new Date(item.added),
    }
}

function toDownload(item) {
    return {
        source: 'realdebrid',
        id: item.id,
        url: item.download,
        name: item.filename,
        type: 'other',
        info: PTT.parse(item.filename),
        size: item.filesize,
        created: new Date(item.generated),
    }
}

async function listTorrents(apiKey, skip = 0) {
    let nextPage = Math.floor(skip / 50) + 1

    let torrents = await listFilesParrallel(FILE_TYPES.TORRENTS, apiKey, nextPage)
    const metas = torrents.map(torrent => {
        return {
            id: 'realdebrid:' + torrent.id,
            name: torrent.filename,
            type: 'other',
        }
    })
    return metas || []
}

async function listFilesParrallel(fileType, apiKey, page = 1, pageSize = 50) {
    const RD = new RealDebridClient(apiKey, {
        params: {
            page: page,
            limit: pageSize
        }
    })

    if (fileType == FILE_TYPES.TORRENTS) {
        return await RD.torrents.get(0, page, pageSize)
            .then(resp => resp.data)
            .catch(err => handleError(err))
    } else if (fileType == FILE_TYPES.DOWNLOADS) {
        let files = []
        let finished = false
        while (!finished) {
            const resp = await RD.downloads.get(0, page, 50)
                .catch(err => handleError(err))
            files.push(...resp.data)
            finished = resp.status == 204
            page++
        }
        // ignore the torrents returned by the downloads API
        return files.filter(f => f.host != 'real-debrid.com')
    }
}

function handleError(err) {
    console.log(err)
    const errData = err.response.data
    if (errData && errData.error_code === 8) {
        return Promise.reject(BadTokenError)
    }
    if (errData && accessDeniedError(errData)) {
        return Promise.reject(AccessDeniedError)
    }
    return Promise.reject(err)
}

function accessDeniedError(errData) {
    return [9, 20].includes(errData && errData.error_code)
}

function getDefaultOptions(ip) {
    return { ip };
}

export default { listTorrents, searchTorrents, getTorrentDetails, unrestrictUrl, searchDownloads }