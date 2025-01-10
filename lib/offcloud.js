import OffcloudClient from 'offcloud-api';
import Fuse from 'fuse.js'
import { isVideo } from './util/extension-util.js'
import PTT from './util/parse-torrent-title.js'
import { BadTokenError } from './util/error-codes.js'
import { FILE_TYPES } from './util/file-types.js'
import { encode } from 'urlencode'

async function searchTorrents(apiKey, searchKey, threshold = 0.3) {
    console.log("Search torrents with searchKey on offcloud: " + searchKey);

    const torrentsResults = await listTorrentsParallel(apiKey, 1, 1000);

    // Filter only torrents with the status 'downloaded'
    const downloadedTorrents = torrentsResults.filter(torrent => torrent.status === 'downloaded');

    let torrents = await Promise.all(
        downloadedTorrents.map(async (torrentsResult) => {
            return toTorrent(torrentsResult, apiKey); // Make sure to await here
        })
    );

const parsedTorrents = JSON.parse(JSON.stringify(torrents, null, 2)); // No-op but ensures clarity
const fuse = new Fuse(parsedTorrents, {
    keys: ['info.title'],
    threshold: threshold,
    minMatchCharLength: 2,
});


    const searchResults = fuse.search(searchKey);
    if (searchResults) {
        return searchResults.map(searchResult => searchResult.item);
    } else {
        return [];
    }
}

async function getTorrentDetails(apiKey, item) {
    const OC = new OffcloudClient(apiKey)

    return await toTorrentDetails(item)
}

async function toTorrentDetails(item) {
    const videos = item.url
        .filter(file => isVideo(file.name))
        .map(file => {
            return {
                id: file.id,
                name: file.name,
                url: file.url,
                size: file.size,
                created: new Date(item.created * 1000),
                info: PTT.parse(file.name)
            }
        })

    return {
        source: 'offcloud',
        id: item.id,
        name: item.name,
        type: 'other',
        hash: item.id.toLowerCase(),
        info: item.info,
        created: new Date(item.created_at * 1000),
        videos: videos || []
    }
}


async function toTorrent(item, apiKey) {
    const hash_decoder = item.originalLink.match(/btih:([a-fA-F0-9]{40})/)?.[1]
    const urls = await getFileUrls(item, apiKey);

    // Apply encodeURI to each URL
    const encodedUrls = urls.map(url => encodeURI(url));
    return {
        source: 'offcloud',
        id: item.requestId,
        name: item.fileName,
        type: 'other',
        fileType: FILE_TYPES.TORRENTS,
        hash: hash_decoder,
        info: PTT.parse(item.fileName),
        url: encodedUrls,
        size: 2342323232,
        created: new Date(item.createdOn),
    }
}



async function getFileUrls(item, apiKey) {
  const OC = new OffcloudClient(apiKey);

  try {
    // Await the result of the promise before logging or returning
    const result = await OC.cloud.explore(item.requestId);
    // console.log("MAZAL TOLVEW: \n", result)
    return result;
  } catch (error) {
    // Handle specific error case
    if (error === 'Bad archive') {
        console.log("BAD ARCHIVE!", item.fileName)
        console.log("CHECK IT OUT MY NEW FILE", [`https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`])
      return [`https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`]
    }
    // Re-throw for other unhandled errors
    throw error;
  }
}


async function listTorrents(apiKey) {
    let torrents = await listTorrentsParallel(apiKey)
    const metas = torrents.map(torrent => {
        return {
            id: 'offcloud:' + torrent.id,
            name: torrent.filename,
            type: 'other',
        }
    })
    return metas || []
}

async function listTorrentsParallel(apiKey) {
    const OC = new OffcloudClient(apiKey)

    const torrents = await OC.cloud.history()
    // console.log("OC HISTORY!!!\n", torrents)

    return torrents || []
}

function handleError(err) {
    console.log(err)
    if (err && err.code === 'AUTH_BAD_APIKEY') {
        return Promise.reject(BadTokenError)
    }
    return Promise.reject(err)
}

export default { listTorrents, searchTorrents, getTorrentDetails }