import OC from 'offcloud-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import { FILE_TYPES } from './util/file-types.js';
import { encode } from 'urlencode';
import { isVideo } from './util/extension-util.js'

async function searchOffcloudTorrents(apiKey, searchKey, threshold = 0.6) {
    console.log(`Searching torrents on Offcloud with key: ${searchKey}`);

    const OCClient = new OC(apiKey);

    try {
        const history = await OCClient.cloud.history();

        const torrents = await Promise.all(
            history.map(async (item) => {
                const encodedUrlsArray = await getEncodedUrls(OCClient, item.requestId, item);

                return encodedUrlsArray.map((encodedUrl) => {
                    const fileName = extractFileNameFromUrl(encodedUrl.url);
                    const videoInfo = PTT.parse(fileName);

                    // Extract the last part of the file name and validate the extension
                    const isVideoFile = /(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(fileName.trim());

                    // Check if the file name matches video extensions
                    if (!isVideoFile || !videoInfo.container) {
                        return null; // Skip non-video files
                    }

                    // Proceed with processing for video files

                    const lastSegment = encodedUrl.url.substring(encodedUrl.url.lastIndexOf('/') + 1);

                    // Encode the last segment
                    const encodedSegment = encodeURIComponent(lastSegment);

                    // Reattach the encoded segment to the base URL (everything before the last slash)
                    const baseUrl = encodedUrl.url.substring(0, encodedUrl.url.lastIndexOf('/') + 1);
                    const fullEncodedUrl = baseUrl + encodedSegment;
                    const url = `${process.env.ADDON_URL}/resolve/OffCloud/${apiKey}/${item.requestId}/${encodeURIComponent(fullEncodedUrl)}`


                    return {
                        source: 'offcloud',
                        id: item.requestId,
                        name: fileName, // Use the extracted fileName
                        type: 'other',
                        fileType: FILE_TYPES.DOWNLOADS,
                        hash: '', // Placeholder for hash decoding logic
                        info: videoInfo, // Use parsed video info
                        url: url,
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

    // Define valid video file extensions

    try {
        const history = await OCClient.cloud.history();

        const torrents = await Promise.all(
            history.map(async (item) => {
                try {
                    const encodedUrlsArray = await getEncodedUrls(OCClient, item.requestId, item);

                    return encodedUrlsArray
                        .map((encodedUrl) => {
                            const fileName = extractFileNameFromUrl(encodedUrl.url);
                            const videoInfo = PTT.parse(fileName);

                            // Extract the last part of the file name and validate the extension
                            const isVideoFile = /(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(fileName.trim());

                            // Check if the file name matches video extensions
                            if (!isVideoFile || !videoInfo.container) {
                                return null; // Skip non-video files
                            }

                            // Proceed with processing for video files

                            // Extract the part after the last slash
                            const lastSegment = encodedUrl.url.substring(encodedUrl.url.lastIndexOf('/') + 1);

                            // Encode the last segment
                            const encodedSegment = encodeURIComponent(lastSegment);

                            // Reattach the encoded segment to the base URL (everything before the last slash)
                            const baseUrl = encodedUrl.url.substring(0, encodedUrl.url.lastIndexOf('/') + 1);

                            // Construct the full URL with the encoded part
                            const fullEncodedUrl = baseUrl + encodedSegment;
                            const url = `${process.env.ADDON_URL}/resolve/OffCloud/${apiKey}/${item.requestId}/${encodeURIComponent(fullEncodedUrl)}`
                            return {
                                source: 'offcloud',
                                id: item.requestId,
                                name: fileName,
                                type: 'other',
                                fileType: FILE_TYPES.DOWNLOADS,
                                hash: '', // Placeholder for hash decoding logic
                                info: videoInfo,
                                url: url,
                                size: item.size || 0,
                                created: new Date(item.createdOn),
                            };
                        })
                        .filter((file) => file !== null); // Remove null entries
                } catch (error) {
                    console.error(`Error processing item with requestId ${item.requestId}:`, error);
                    return [];
                }
            })
        );

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



export default { searchOffcloudTorrents, listTorrents };
