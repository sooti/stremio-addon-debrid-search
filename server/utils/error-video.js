/**
 * Error video streaming utility
 * Stream error video from Python server (proxy through Node)
 * TVs and some video players don't follow 302 redirects, so we proxy instead
 */

/**
 * Stream error video from Python server
 * @param {string} errorText - The error message to display
 * @param {object} res - Express response object
 * @param {string} fileServerUrl - Python file server URL
 */
export async function redirectToErrorVideo(errorText, res, fileServerUrl) {
    console.log(`[ERROR-VIDEO] Streaming error video: "${errorText}"`);

    try {
        const axios = (await import('axios')).default;

        // URL-encode the error message
        const encodedMessage = encodeURIComponent(errorText);

        // Construct error video URL on Python server
        const errorUrl = `${fileServerUrl.replace(/\/$/, '')}/error?message=${encodedMessage}`;

        console.log(`[ERROR-VIDEO] Fetching from: ${errorUrl}`);

        // Fetch the error video from Python server
        const response = await axios({
            method: 'GET',
            url: errorUrl,
            responseType: 'stream',
            timeout: 30000
        });

        // Copy headers from Python server
        res.status(200);
        res.set('Content-Type', response.headers['content-type'] || 'video/mp4');
        if (response.headers['content-length']) {
            res.set('Content-Length', response.headers['content-length']);
        }
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

        // Pipe the video stream to the client
        // Note: pipe() automatically ends the response when the source stream ends
        response.data.pipe(res);

        // Log when streaming completes
        response.data.on('end', () => {
            console.log(`[ERROR-VIDEO] ✓ Finished streaming error video`);
        });

        // Handle errors during streaming
        response.data.on('error', (err) => {
            console.error(`[ERROR-VIDEO] Stream error: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).end();
            }
        });

    } catch (error) {
        console.error(`[ERROR-VIDEO] Failed to fetch error video: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).send(`Error: ${errorText}`);
        }
    }
}

export default redirectToErrorVideo;
