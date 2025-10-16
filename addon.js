import { addonBuilder } from "stremio-addon-sdk"
import StreamProvider from './lib/stream-provider.js'
import CatalogProvider from './lib/catalog-provider.js'
import { getManifest } from './lib/util/manifest.js'
import { obfuscateSensitive } from './lib/common/torrent-utils.js'

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 1 * 60 // 1 min
const STALE_REVALIDATE_AGE = 1 * 60 // 1 min
const STALE_ERROR_AGE = 1 * 24 * 60 * 60 // 1 days

const builder = new addonBuilder(getManifest())

builder.defineCatalogHandler((args) => {
    return new Promise((resolve, reject) => {
        const debugArgs = structuredClone(args)
        if (args.config?.DebridApiKey)
            debugArgs.config.DebridApiKey = '*'.repeat(args.config.DebridApiKey.length)
        if (args.config?.DebridServices && Array.isArray(args.config.DebridServices)) {
            debugArgs.config.DebridServices = args.config.DebridServices.map(s => ({
                provider: s.provider,
                apiKey: s.apiKey ? '*'.repeat(s.apiKey.length) : ''
            }))
        }
        console.log("Request for catalog with args: " + JSON.stringify(debugArgs))

        // Request to Debrid Search
        if (args.id == 'debridsearch') {
            const hasValidConfig = (
                (args.config?.DebridServices && Array.isArray(args.config.DebridServices) && args.config.DebridServices.length > 0) ||
                (args.config?.DebridProvider && args.config?.DebridApiKey) ||
                args.config?.DebridLinkApiKey
            )
            if (!hasValidConfig) {
                reject(new Error('Invalid Debrid configuration: Missing configs'))
            }

            // Search catalog request
            if (args.extra.search) {
                CatalogProvider.searchTorrents(args.config, args.extra.search)
                    .then(metas => {
                        console.log("Response metas: " + JSON.stringify(metas))
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
                        console.log("Response metas: " + JSON.stringify(metas))
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
        if (args.config?.DebridServices && Array.isArray(args.config.DebridServices)) {
            debugArgs.config.DebridServices = args.config.DebridServices.map(s => ({
                provider: s.provider,
                apiKey: s.apiKey ? '*'.repeat(s.apiKey.length) : ''
            }))
        }
        console.log("Request for streams with args: " + JSON.stringify(debugArgs))

        switch (args.type) {
            case 'movie':
                StreamProvider.getMovieStreams(args.config, args.type, args.id)
                    .then(streams => {
                        const keysToObfuscate = [
                            args.config?.DebridApiKey,
                            ...(Array.isArray(args.config?.DebridServices) ? args.config.DebridServices.map(s => s.apiKey) : [])
                        ].filter(Boolean);
                        console.log("Response streams: " + obfuscateSensitive(JSON.stringify(streams), keysToObfuscate))
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
                        const keysToObfuscate = [
                            args.config?.DebridApiKey,
                            ...(Array.isArray(args.config?.DebridServices) ? args.config.DebridServices.map(s => s.apiKey) : [])
                        ].filter(Boolean);
                        console.log("Response streams: " + obfuscateSensitive(JSON.stringify(streams), keysToObfuscate))
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
