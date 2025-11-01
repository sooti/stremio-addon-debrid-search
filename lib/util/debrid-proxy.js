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
        this.agentCreatedAt = null;
        this.agentMaxAge = 5 * 60 * 1000; // Recreate agent every 5 minutes
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 3; // Recreate agent after 3 consecutive errors

        if (this.proxyUrl) {
            this.agent = this.createProxyAgent(this.proxyUrl);
            this.agentCreatedAt = Date.now();
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
            const agentOptions = {
                // Keep connections alive to reuse sockets
                keepAlive: true,
                keepAliveMsecs: 1000,
                // Connection timeouts
                timeout: 10000, // 10 second connection timeout
                // Socket limits
                maxSockets: 50, // Max concurrent connections per host
                maxFreeSockets: 10, // Max idle connections to keep
                // Cleanup idle sockets
                freeSocketTimeout: 30000, // Close idle sockets after 30s
            };

            if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://')) {
                // socks5h:// = resolve hostnames through proxy (recommended for WARP)
                // socks5:// = resolve hostnames locally
                const usesRemoteResolution = proxyUrl.startsWith('socks5h://');
                console.log(`[DEBRID-PROXY] Creating SOCKS proxy agent (hostname resolution: ${usesRemoteResolution ? 'remote' : 'local'})`);
                return new SocksProxyAgent(proxyUrl, agentOptions);
            } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
                console.log(`[DEBRID-PROXY] Creating HTTP/HTTPS proxy agent`);
                return new HttpsProxyAgent(proxyUrl, agentOptions);
            } else {
                console.warn(`[DEBRID-PROXY] Unknown proxy scheme in ${proxyUrl}, defaulting to HTTP proxy`);
                return new HttpsProxyAgent(proxyUrl, agentOptions);
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
     * Check if agent needs to be recreated
     */
    shouldRecreateAgent() {
        if (!this.agent || !this.agentCreatedAt) return true;

        const agentAge = Date.now() - this.agentCreatedAt;
        if (agentAge > this.agentMaxAge) {
            console.log(`[DEBRID-PROXY] Agent is ${Math.round(agentAge / 1000)}s old, recreating...`);
            return true;
        }

        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            console.log(`[DEBRID-PROXY] Too many consecutive errors (${this.consecutiveErrors}), recreating agent...`);
            return true;
        }

        return false;
    }

    /**
     * Recreate the proxy agent
     */
    recreateAgent() {
        if (!this.proxyUrl) return;

        // Destroy old agent if it exists
        if (this.agent && typeof this.agent.destroy === 'function') {
            try {
                this.agent.destroy();
            } catch (error) {
                console.warn(`[DEBRID-PROXY] Error destroying old agent:`, error.message);
            }
        }

        this.agent = this.createProxyAgent(this.proxyUrl);
        this.agentCreatedAt = Date.now();
        this.consecutiveErrors = 0;
        console.log(`[DEBRID-PROXY] Agent recreated successfully`);
    }

    /**
     * Get axios config with proxy agent if enabled for the service
     */
    getAxiosConfig(serviceName, baseConfig = {}) {
        if (this.shouldUseProxy(serviceName)) {
            // Check if agent needs recreation
            if (this.shouldRecreateAgent()) {
                this.recreateAgent();
            }

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
     * Mark a successful request (resets error counter)
     */
    markSuccess() {
        this.consecutiveErrors = 0;
    }

    /**
     * Mark a failed request (increments error counter)
     */
    markError(error) {
        if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') {
            this.consecutiveErrors++;
            console.warn(`[DEBRID-PROXY] Connection error (${error.code}), consecutive errors: ${this.consecutiveErrors}`);
        }
    }

    /**
     * Get proxy agent for direct use (e.g., with fetch or other HTTP clients)
     */
    getProxyAgent(serviceName) {
        if (this.shouldUseProxy(serviceName)) {
            // Check if agent needs recreation
            if (this.shouldRecreateAgent()) {
                this.recreateAgent();
            }
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
        const agentAge = this.agentCreatedAt ? Math.round((Date.now() - this.agentCreatedAt) / 1000) : null;
        return {
            enabled: !!this.proxyUrl,
            proxyUrl: this.proxyUrl,
            config: this.proxyConfig,
            agentType: this.agent?.constructor?.name || null,
            agentAgeSeconds: agentAge,
            consecutiveErrors: this.consecutiveErrors
        };
    }
}

// Singleton instance
const debridProxyManager = new DebridProxyManager();

export default debridProxyManager;
