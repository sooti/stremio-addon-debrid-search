import Router from 'router'
import cors from 'cors'
import rateLimit from "express-rate-limit";
import requestIp from 'request-ip'
import https from 'https'
import addonInterface from "./addon.js"
import landingTemplate from "./lib/util/landingTemplate.js"
import StreamProvider from './lib/stream-provider.js'
import { decode } from 'urlencode'
import qs from 'querystring'
import { getManifest } from './lib/util/manifest.js'
import { parseConfiguration } from './lib/util/configuration.js'
import { BadTokenError, BadRequestError, AccessDeniedError } from './lib/util/error-codes.js'
import RealDebrid from './lib/real-debrid.js'

const router = new Router();
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 300, // limit each IP to 300 requests per windowMs
  headers: false,
  keyGenerator: (req) => requestIp.getClientIp(req)
})

router.use(cors())

router.get('/', (_, res) => {
    res.redirect('/configure')
    res.end();
})

router.get('/:configuration?/configure', (req, res) => {
    const config = parseConfiguration(req.params.configuration)
    const host = `${req.protocol}://${req.headers.host}`;
    const configValues = { ...config, host };
    const landingHTML = landingTemplate(addonInterface.manifest, configValues)
    res.setHeader('content-type', 'text/html')
    res.end(landingHTML)
})

router.get('/:configuration?/manifest.json', (req, res) => {
    const config = parseConfiguration(req.params.configuration)
    const host = `${req.protocol}://${req.headers.host}`;
    const configValues = { ...config, host };
    // For initial install (no configuration) or when ShowCatalog is explicitly disabled, serve manifest without catalogs
    const noCatalogs = Object.keys(config).length === 0 || config.ShowCatalog === false;
    
    // Set proper headers for Stremio compatibility (keeps the CORS fix)
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    res.end(JSON.stringify(getManifest(configValues, noCatalogs)))
})

router.get(`/:configuration?/:resource/:type/:id/:extra?.json`, limiter, (req, res, next) => {
    const { resource, type, id } = req.params
    const config = parseConfiguration(req.params.configuration)
    const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
    const host = `${req.protocol}://${req.headers.host}`;
    const clientIp = requestIp.getClientIp(req);

    // Combine all configuration values properly, including clientIp
    const fullConfig = { ...config, host, clientIp };

    addonInterface.get(resource, type, id, extra, fullConfig)
        .then(async (resp) => {
            if (fullConfig.DebridProvider === 'RealDebrid' && resp && resp.streams) {
                resp.streams = await RealDebrid.validatePersonalStreams(fullConfig.DebridApiKey, resp.streams);
            }

            let cacheHeaders = {
                cacheMaxAge: 'max-age',
                staleRevalidate: 'stale-while-revalidate',
                staleError: 'stale-if-error'
            }

            const cacheControl = Object.keys(cacheHeaders)
                .map(prop => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
                .filter(val => !!val).join(', ')

            res.setHeader('Cache-Control', `${cacheControl}, public`)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(resp))
        })
        .catch(err => {
            console.error(err)
            handleError(err, res)
        })
})

router.get('/resolve/:debridProvider/:debridApiKey/:id/:hostUrl', limiter, (req, res) => {
    const clientIp = requestIp.getClientIp(req)
    const decodedHostUrl = decode(req.params.hostUrl)

    // Validate hostUrl parameter
    if (!decodedHostUrl || decodedHostUrl === 'undefined') {
        console.error('[RESOLVER] Missing or invalid hostUrl parameter')
        return res.status(400).send('Missing or invalid hostUrl parameter')
    }

    StreamProvider.resolveUrl(req.params.debridProvider, req.params.debridApiKey, req.params.id, decodedHostUrl, clientIp)
        .then(url => {
            res.redirect(url)
        })
        .catch(err => {
            console.log(err)
            handleError(err, res)
        })
})

// Handle 3-parameter resolve URLs (compatibility with server.js format)
router.get('/resolve/:debridProvider/:debridApiKey/:url', limiter, (req, res) => {
    const { debridProvider, debridApiKey, url } = req.params;

    // Validate required parameters
    if (!url || url === 'undefined') {
        console.error('[RESOLVER] Missing or invalid URL parameter');
        return res.status(400).send('Missing or invalid URL parameter');
    }

    const decodedUrl = decodeURIComponent(url);
    const clientIp = requestIp.getClientIp(req);

    StreamProvider.resolveUrl(debridProvider, debridApiKey, null, decodedUrl, clientIp)
        .then(url => {
            if (url) {
                res.redirect(url)
            } else {
                res.status(404).send('Could not resolve link');
            }
        })
        .catch(err => {
            console.log(err)
            handleError(err, res)
        })
})

// Easynews resolver endpoint for serverless deployment
router.get('/resolve/easynews/:encodedData', limiter, async (req, res) => {
    const { encodedData } = req.params;

    // Validate required parameters
    if (!encodedData || encodedData === 'undefined') {
        console.error('[EASYNEWS-RESOLVER] Missing or invalid encoded data parameter');
        return res.status(400).send('Missing or invalid encoded data parameter');
    }

    try {
        // Decode the base64 encoded stream data
        const decodedData = Buffer.from(decodeURIComponent(encodedData), 'base64').toString('utf-8');
        const streamData = JSON.parse(decodedData);

        // Extract stream information
        const { username, password, dlFarm, dlPort, postHash, ext, postTitle, downURL } = streamData;

        // Validate required fields
        if (!username || !password || !dlFarm || !dlPort || !postHash || !ext || !postTitle) {
            console.error('[EASYNEWS-RESOLVER] Missing required stream data fields');
            return res.status(400).send('Invalid stream data');
        }

        // Construct the Easynews download URL
        const baseUrl = downURL || 'https://members.easynews.com';
        const streamPath = `${postHash}${ext}/${postTitle}${ext}`;

        // Create URL with embedded credentials
        const finalUrl = `${baseUrl.replace('https://', `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`)}/${dlFarm}/${dlPort}/${streamPath}`;

        // Sanitize URL for logging - hide credentials
        const sanitizedUrl = finalUrl.replace(/https:\/\/[^:]+:[^@]+@/, 'https://***:***@');
        console.log(`[EASYNEWS-RESOLVER] Resolving: ${postTitle}${ext}`);
        console.log(`[EASYNEWS-RESOLVER] Verifying stream availability: ${sanitizedUrl}`);

        // Verify stream is ready by checking for 206 Partial Content response
        try {
            const streamReady = await new Promise((resolve, reject) => {
                const url = new URL(finalUrl);
                const options = {
                    method: 'HEAD',
                    hostname: url.hostname,
                    port: url.port || 443,
                    path: url.pathname,
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
                        'Range': 'bytes=0-0',  // Request first byte to trigger 206 response
                        'User-Agent': 'Stremio/1.0'
                    },
                    timeout: 10000  // 10 second timeout
                };

                const req = https.request(options, (streamRes) => {
                    console.log(`[EASYNEWS-RESOLVER] Stream status: ${streamRes.statusCode}`);
                    // Accept valid status codes:
                    // 200 (OK), 206 (Partial Content), 302 (Redirect to CDN), 416 (Range Not Satisfiable but file exists)
                    if (streamRes.statusCode === 200 || streamRes.statusCode === 206 ||
                        streamRes.statusCode === 302 || streamRes.statusCode === 416) {
                        resolve(true);
                    } else {
                        console.error(`[EASYNEWS-RESOLVER] Unexpected status: ${streamRes.statusCode}`);
                        resolve(false);
                    }
                    // Abort the request immediately after getting headers
                    req.abort();
                });

                req.on('error', (err) => {
                    console.error(`[EASYNEWS-RESOLVER] Stream verification error: ${err.message}`);
                    resolve(false);
                });

                req.on('timeout', () => {
                    console.error(`[EASYNEWS-RESOLVER] Stream verification timeout`);
                    req.abort();
                    resolve(false);
                });

                req.end();
            });

            if (streamReady) {
                console.log(`[EASYNEWS-RESOLVER] Stream ready, redirecting to: ${sanitizedUrl}`);
                res.redirect(302, finalUrl);
            } else {
                console.error(`[EASYNEWS-RESOLVER] Stream not ready or unavailable`);
                res.status(503).send('Stream not ready or unavailable');
            }
        } catch (verifyError) {
            console.error(`[EASYNEWS-RESOLVER] Error verifying stream: ${verifyError.message}`);
            // Fall back to redirect without verification
            console.log(`[EASYNEWS-RESOLVER] Falling back to redirect without verification`);
            res.redirect(302, finalUrl);
        }
    } catch (error) {
        console.error("[EASYNEWS-RESOLVER] Error occurred:", error.message);
        res.status(500).send("Error resolving Easynews stream.");
    }
})

router.get('/ping', (_, res) => {
    res.statusCode = 200
    res.end()
})

function handleError(err, res) {
    if (err == BadTokenError) {
        res.writeHead(401)
        res.end(JSON.stringify({ err: 'Bad token' }))
    } else if (err == AccessDeniedError) {
        res.writeHead(403)
        res.end(JSON.stringify({ err: 'Access denied' }))
    } else if (err == BadRequestError) {
        res.writeHead(400)
        res.end(JSON.stringify({ err: 'Bad request' }))
    } else {
        res.writeHead(500)
        res.end(JSON.stringify({ err: 'Server error' }))
    }
}

export default function (req, res) {
    router(req, res, function () {
        res.statusCode = 404;
        res.end();
    });
}
