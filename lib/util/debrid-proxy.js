import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * Debrid Services Proxy Manager
 * Allows selective proxying of HTTP requests for different debrid services
 */

class DebridProxyManager {
    constructor() {
        this.proxyUrl = process.env.DEBRID_HTTP_PROXY || null;
        this.proxyConfig = this.parseProxyConfig(process.env.DEBRID_PROXY_SERVICES || '*:false');
        this.agent = null;

        if (this.proxyUrl) {
            this.agent = this.createProxyAgent(this.proxyUrl);
            console.log(`[DEBRID-PROXY] Initialized with proxy: ${this.proxyUrl}`);
            console.log(`[DEBRID-PROXY] Services config:`, this.proxyConfig);
        }
    }

    /**
     * Parse proxy configuration string like "*:true" or "realdebrid:true,torbox:false"
     */
    parseProxyConfig(configString) {
        const config = {
            wildcard: false,
            services: {}
        };

        if (!configString) return config;

        const pairs = configString.split(',').map(s => s.trim());

        for (const pair of pairs) {
            const [service, enabled] = pair.split(':').map(s => s.trim());
            const isEnabled = enabled === 'true';

            if (service === '*') {
                config.wildcard = isEnabled;
            } else {
                // Normalize service names
                const normalizedService = service.toLowerCase().replace(/[.-]/g, '');
                config.services[normalizedService] = isEnabled;
            }
        }

        return config;
    }

    /**
     * Create appropriate proxy agent based on URL scheme
     */
    createProxyAgent(proxyUrl) {
        try {
            if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://')) {
                // socks5h:// = resolve hostnames through proxy (recommended for WARP)
                // socks5:// = resolve hostnames locally
                const usesRemoteResolution = proxyUrl.startsWith('socks5h://');
                console.log(`[DEBRID-PROXY] Creating SOCKS proxy agent (hostname resolution: ${usesRemoteResolution ? 'remote' : 'local'})`);
                return new SocksProxyAgent(proxyUrl);
            } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
                console.log(`[DEBRID-PROXY] Creating HTTP/HTTPS proxy agent`);
                return new HttpsProxyAgent(proxyUrl);
            } else {
                console.warn(`[DEBRID-PROXY] Unknown proxy scheme in ${proxyUrl}, defaulting to HTTP proxy`);
                return new HttpsProxyAgent(proxyUrl);
            }
        } catch (error) {
            console.error(`[DEBRID-PROXY] Error creating proxy agent:`, error.message);
            return null;
        }
    }

    /**
     * Check if proxy should be used for a specific service
     */
    shouldUseProxy(serviceName) {
        if (!this.proxyUrl || !this.agent) return false;

        const normalizedService = serviceName.toLowerCase().replace(/[.-]/g, '');

        // Check if service has specific configuration
        if (normalizedService in this.proxyConfig.services) {
            return this.proxyConfig.services[normalizedService];
        }

        // Fall back to wildcard setting
        return this.proxyConfig.wildcard;
    }

    /**
     * Get axios config with proxy agent if enabled for the service
     */
    getAxiosConfig(serviceName, baseConfig = {}) {
        if (this.shouldUseProxy(serviceName)) {
            console.log(`[DEBRID-PROXY] ✓ Using proxy for ${serviceName}: ${this.proxyUrl}`);
            return {
                ...baseConfig,
                httpAgent: this.agent,
                httpsAgent: this.agent,
                proxy: false // Disable axios built-in proxy handling
            };
        }
        return baseConfig;
    }

    /**
     * Get proxy agent for direct use (e.g., with fetch or other HTTP clients)
     */
    getProxyAgent(serviceName) {
        if (this.shouldUseProxy(serviceName)) {
            return this.agent;
        }
        return null;
    }

    /**
     * Get configuration for real-debrid-api client
     * The real-debrid-api package accepts a custom agent
     */
    getRealDebridConfig(serviceName = 'realdebrid') {
        const agent = this.getProxyAgent(serviceName);
        if (agent) {
            return { agent };
        }
        return {};
    }

    /**
     * Get status for debugging
     */
    getStatus() {
        return {
            enabled: !!this.proxyUrl,
            proxyUrl: this.proxyUrl,
            config: this.proxyConfig,
            agentType: this.agent?.constructor?.name || null
        };
    }
}

// Singleton instance
const debridProxyManager = new DebridProxyManager();

export default debridProxyManager;
