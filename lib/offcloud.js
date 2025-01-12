import OC from 'offcloud-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import { FILE_TYPES } from './util/file-types.js';
import axios from 'axios';

async function searchOffcloudTorrents(apiKey, searchKey, threshold = 0.6) {
    console.log(`Searching torrents on Offcloud with key: ${searchKey}`);

    const OCClient = new OC(apiKey);

    try {
        const history = await OCClient.cloud.history();
        const torrents = await processTorrents(OCClient, history, apiKey);

        const fuse = new Fuse(torrents, {
            keys: ['info.title'],
            threshold,
            minMatchCharLength: 1,
            ignoreLocation: true,
        });

        const searchResults = fuse.search(searchKey);
        return searchResults.map((result) => result.item);
    } catch (error) {
        console.error('Error searching torrents:', error);
        return [];
    }
}

async function listTorrents(apiKey) {
    const OCClient = new OC(apiKey);

    try {
        const history = await OCClient.cloud.history();
        return await processTorrents(OCClient, history, apiKey);
    } catch (error) {
        console.error('Error fetching torrent history:', error);
        throw error;
    }
}

async function processTorrents(client, history, apiKey) {
    const torrents = await Promise.all(
        history.map(async (item) => {
            try {
                const encodedUrlsArray = await getEncodedUrls(client, item.requestId, item);

                return Promise.all(
                    encodedUrlsArray.map(async (encodedUrl) => {
                        const fileName = extractFileNameFromUrl(encodedUrl.url);
                        const videoInfo = PTT.parse(fileName);

                        if (!isValidVideo(fileName, videoInfo)) {
                            return null;
                        }

                        const fullEncodedUrl = createEncodedUrl(encodedUrl.url);
                        const url = `${process.env.ADDON_URL}/resolve/OffCloud/${apiKey}/${item.requestId}/${encodeURIComponent(fullEncodedUrl)}`;

                        try {
                            // Retrieve file size using axios HEAD request
                            const response = await axios.head(encodedUrl.url);
                            const fileSize = response.headers['content-length'] ? parseInt(response.headers['content-length'], 10) : 0;

                            return {
                                source: 'offcloud',
                                id: item.requestId,
                                name: fileName,
                                type: 'other',
                                fileType: FILE_TYPES.VIDEOS,
                                hash: '',
                                info: videoInfo,
                                url,
                                size: fileSize,  // Update size with the file size from HEAD request
                                created: new Date(item.createdOn),
                            };
                        } catch (err) {
                            console.error(`Error retrieving file size for URL ${encodedUrl.url}:`, err);
                            return {
                                source: 'offcloud',
                                id: item.requestId,
                                name: fileName,
                                type: 'other',
                                fileType: FILE_TYPES.DOWNLOADS,
                                hash: '',
                                info: videoInfo,
                                url,
                                size: 0,  // Default to 0 if unable to retrieve size
                                created: new Date(item.createdOn),
                            };
                        }
                    })
                );
            } catch (error) {
                console.error(`Error processing item with requestId ${item.requestId}:`, error);
                return [];
            }
        })
    );

    return torrents.flat();
}

async function getEncodedUrls(client, torrentId, item) {
    try {
        const urls = await client.cloud.explore(torrentId);

        if (!Array.isArray(urls) || urls.length === 0) {
            return [];
        }

        return urls.map((url) => ({ url }));
    } catch (error) {
        if (error === 'Bad archive') {
            return [
                {
                    url: `https://${item.server}.offcloud.com/cloud/download/0/${item.requestId}/${item.fileName}`,
                },
            ];
        }

        console.error(`Error getting encoded URLs for torrent ID ${torrentId}:`, error);
        return [];
    }
}

function isValidVideo(fileName, videoInfo) {
    const isVideoFile = /(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(fileName.trim());
    return isVideoFile && videoInfo.container;
}

function createEncodedUrl(url) {
    const lastSegment = url.substring(url.lastIndexOf('/') + 1);
    const encodedSegment = encodeURIComponent(lastSegment);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    return baseUrl + encodedSegment;
}

function extractFileNameFromUrl(input) {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url || typeof url !== 'string') {
        throw new TypeError(`Expected a string but got ${typeof input}`);
    }

    const fileName = url.split('/').pop().split('?')[0].replace(/\./g, ' ');
    return fileName.trim();
}

export default { searchOffcloudTorrents, listTorrents };
