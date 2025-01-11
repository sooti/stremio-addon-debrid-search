import OC from 'offcloud-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import { FILE_TYPES } from './util/file-types.js';
import { encode } from 'urlencode';

async function searchOffcloudTorrents(apiKey, searchKey, threshold = 0.6) {
    console.log(`Searching torrents on Offcloud with key: ${searchKey}`);

    const OCClient = new OC(apiKey);

    try {
        const history = await OCClient.cloud.history();

        const torrents = await Promise.all(
            history.map(async (item) => {
                const encodedUrlsArray = await getEncodedUrls(OCClient, item.requestId, item);

                return encodedUrlsArray.map((encodedUrl) => {
                    const fileName = extractFileNameFromUrl(encodedUrl); // Extract the filename here
                    const videoInfo = PTT.parse(fileName); // Parse file information here

                    return {
                        source: 'offcloud',
                        id: item.requestId,
                        name: fileName, // Use the extracted fileName
                        type: 'other',
                        fileType: FILE_TYPES.TORRENTS,
                        hash: '', // Placeholder for hash decoding logic
                        info: videoInfo, // Use parsed video info
                        url: encodedUrl.url,
                        size: item.size || 0, // Replace with actual size property if available
                        created: new Date(item.createdOn),
                    };
                });
            })
        );

        // Flatten the array of arrays
        const flattenedTorrents = torrents.flat();

        const fuse = new Fuse(flattenedTorrents, {
            keys: ['info.title'],
            threshold: threshold,
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

        console.log("ssdsdsdsds")

        const torrents = await Promise.all(
            history.map(async (item) => {
                try {
                    const encodedUrlsArray = await getEncodedUrls(OCClient, item.requestId, item);

                    return encodedUrlsArray.map((encodedUrl) => {
                        const fileName = extractFileNameFromUrl(encodedUrl.url);
                        const videoInfo = PTT.parse(fileName);

                        return {
                            source: 'offcloud',
                            id: item.requestId,
                            name: fileName,
                            type: 'other',
                            fileType: FILE_TYPES.TORRENTS,
                            hash: '', // Placeholder for hash decoding logic
                            info: videoInfo,
                            url: encodedUrl.url,
                            size: item.size || 0,
                            created: new Date(item.createdOn),
                        };
                    });
                } catch (error) {
                    console.error(`Error processing item with requestId ${item.requestId}:`, error);
                    return [];
                }
            })
        );

        console.log(torrents.flat())

        return torrents.flat(); // Flatten the nested array
    } catch (error) {
        console.error('Error fetching torrent history:', error);
        throw error;
    }
}


async function getEncodedUrls(client, torrentId, item) {
    try {
        const urls = await client.cloud.explore(torrentId);

        if (!Array.isArray(urls) || urls.length === 0) {
            return []; // Return an empty array if no URLs are found
        }

        return urls.map(url => {
            return {
                url: url,
            };
        });
    } catch (error) {
            // Handle specific error case
    if (error === 'Bad archive') {
      return [`https://${item.server}.offcloud.com/cloud/download/0/${item.requestId}/${item.fileName}`]
    }
        console.error(`Error getting encoded URLs for torrent ID ${torrentId}:`, error);
        return []; // Return an empty array in case of error
    }
}


function extractFileNameFromUrl(input) {
    // Extract url property if input is an object
    let url = typeof input === 'string' ? input : input?.url;
    if (!url || typeof url !== 'string') {
        throw new TypeError("Expected a string but got " + typeof input);
    }

    // Extract the file name
    const urlParts = url.split('/');
    let fileName = urlParts[urlParts.length - 1].split('?')[0];

    // Replace dots between words with spaces
    fileName = fileName.replace(/\./g, ' ');

    return fileName.trim();
}



export default { searchOffcloudTorrents };
