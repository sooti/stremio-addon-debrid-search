import { addonBuilder } from "stremio-addon-sdk"
import StreamProvider from './lib/stream-provider.js'
import CatalogProvider from './lib/catalog-provider.js'
import { getManifest } from './lib/util/manifest.js'

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 1 * 60 // 1 min
const STALE_REVALIDATE_AGE = 1 * 60 // 1 min
const STALE_ERROR_AGE = 1 * 24 * 60 * 60 // 1 days

const builder = new addonBuilder(getManifest())

const isDebugLog = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
const log = (...args) => { if (isDebugLog) console.log(...args); };

builder.defineCatalogHandler((args) => {
    return new Promise((resolve, reject) => {
        const debugArgs = structuredClone(args)
        if (args.config?.DebridApiKey)
            debugArgs.config.DebridApiKey = '*'.repeat(args.config.DebridApiKey.length)
        log("Request for catalog with args: " + JSON.stringify(debugArgs))

        // Request to Debrid Search
        if (args.id == 'debridsearch') {
            if (!((args.config?.DebridProvider && args.config?.DebridApiKey) || args.config?.DebridLinkApiKey)) {
                reject(new Error('Invalid Debrid configuration: Missing configs'))
            }

            // Search catalog request
            if (args.extra.search) {
                CatalogProvider.searchTorrents(args.config, args.extra.search)
                    .then(metas => {
                        log("Response metas: " + JSON.stringify(metas))
                        resolve({
                            metas,
                            ...enrichCacheParams()
                        })
                    })
                    .catch(err => reject(err))
            } else {
                // Standard catalog request
                CatalogProvider.listTorrents(args.config, args.extra.skip)
                    .then(metas => {
                        log("Response metas: " + JSON.stringify(metas))
                        resolve({
                            metas
                        })
                    })
                    .catch(err => reject(err))
            }
        } else {
            reject(new Error('Invalid catalog request'))
        }
    })
})


// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineStreamHandler.md
builder.defineStreamHandler(args => {
    return new Promise((resolve, reject) => {
        if (!args.id.match(/tt\d+/i)) {
            resolve({ streams: [] })
            return
        }

        const debugArgs = structuredClone(args)
        if (args.config?.DebridApiKey)
            debugArgs.config.DebridApiKey = '*'.repeat(args.config.DebridApiKey.length)
        log("Request for streams with args: " + JSON.stringify(debugArgs))

        switch (args.type) {
            case 'movie':
                StreamProvider.getMovieStreams(args.config, args.type, args.id)
                    .then(streams => {
                        log("Response streams: " + JSON.stringify(streams))
                        resolve({
                            streams,
                            ...enrichCacheParams()
                        })
                    })
                    .catch(err => reject(err))
                break
            case 'series':
                StreamProvider.getSeriesStreams(args.config, args.type, args.id)
                    .then(streams => {
                        log("Response streams: " + JSON.stringify(streams))
                        resolve({
                            streams,
                            ...enrichCacheParams()
                        })
                    })
                    .catch(err => reject(err))
                break
            default:
                results = resolve({ streams: [] })
                break
        }
    })
})

function enrichCacheParams() {
    return {
        cacheMaxAge: CACHE_MAX_AGE,
        staleError: STALE_ERROR_AGE
    }
}

export default builder.getInterface()
