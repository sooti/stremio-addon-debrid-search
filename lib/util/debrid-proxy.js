import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * Debrid Services Proxy Manager
 * Allows selective proxying of HTTP requests for different debrid services
 */

class DebridProxyManager {
    constructor() {
        this.proxyUrl = process.env.DEBRID_HTTP_PROXY || null;
        this.perServiceProxies = this.parsePerServiceProxies(process.env.DEBRID_PER_SERVICE_PROXIES || '');
        this.proxyConfig = this.parseProxyConfig(process.env.DEBRID_PROXY_SERVICES || '*:false');
        this.agent = null;
        this.perServiceAgents = new Map();
        this.agentCreatedAt = null;
        this.perServiceAgentCreated = new Map();
        this.agentMaxAge = 5 * 60 * 1000; // Recreate agent every 5 minutes
        this.consecutiveErrors = 0;
        this.perServiceConsecutiveErrors = new Map();
        this.maxConsecutiveErrors = 3; // Recreate agent after 3 consecutive errors

        if (this.proxyUrl) {
            this.agent = this.createProxyAgent(this.proxyUrl);
            this.agentCreatedAt = Date.now();
            console.log(`[DEBRID-PROXY] Initialized with default proxy: ${this.proxyUrl}`);
        }
        
        // Initialize per-service agents
        for (const [serviceName, proxyUrl] of Object.entries(this.perServiceProxies)) {
            if (proxyUrl) {
                this.perServiceAgents.set(serviceName, this.createProxyAgent(proxyUrl, serviceName));
                this.perServiceAgentCreated.set(serviceName, Date.now());
                console.log(`[DEBRID-PROXY] Initialized per-service proxy for ${serviceName}: ${proxyUrl}`);
            }
        }
        
        console.log(`[DEBRID-PROXY] Services config:`, this.proxyConfig);
        console.log(`[DEBRID-PROXY] Per-service proxies:`, this.perServiceProxies);
    }

    /**
     * Parse per-service proxy configuration string like "realdebrid:socks5://user:pass@proxy:1080,torbox:socks5://proxy2:1080"
     */
    parsePerServiceProxies(configString) {
        const proxies = {};

        if (!configString) return proxies;

        // Split by comma but be careful with colons in URLs
        const pairs = configString.split(',').map(s => s.trim());

        for (const pair of pairs) {
            // Find the first colon that separates service from URL (not in the URL scheme)
            const colonIndex = pair.indexOf(':');
            if (colonIndex === -1) continue; // Skip if no colon found
            
            const service = pair.substring(0, colonIndex).trim();
            const proxyUrl = pair.substring(colonIndex + 1).trim();
            
            if (service && proxyUrl) {
                // Normalize service names
                const normalizedService = service.toLowerCase().replace(/[.-]/g, '');
                proxies[normalizedService] = proxyUrl;
            }
        }

        return proxies;
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
    createProxyAgent(proxyUrl, serviceName = 'default') {
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
                console.log(`[DEBRID-PROXY] Creating SOCKS proxy agent for ${serviceName} (hostname resolution: ${usesRemoteResolution ? 'remote' : 'local'})`);
                return new SocksProxyAgent(proxyUrl, agentOptions);
            } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
                console.log(`[DEBRID-PROXY] Creating HTTP/HTTPS proxy agent for ${serviceName}`);
                return new HttpsProxyAgent(proxyUrl, agentOptions);
            } else {
                console.warn(`[DEBRID-PROXY] Unknown proxy scheme in ${proxyUrl}, defaulting to HTTP proxy for ${serviceName}`);
                return new HttpsProxyAgent(proxyUrl, agentOptions);
            }
        } catch (error) {
            console.error(`[DEBRID-PROXY] Error creating proxy agent for ${serviceName}:`, error.message);
            return null;
        }
    }

    /**
     * Check if proxy should be used for a specific service
     */
    shouldUseProxy(serviceName) {
        const normalizedService = serviceName.toLowerCase().replace(/[.-]/g, '');

        // Check if service has a custom proxy configured
        if (normalizedService in this.perServiceProxies) {
            return !!this.perServiceProxies[normalizedService];
        }

        // If no custom proxy for service, use the legacy config
        if (!this.proxyUrl) return false;

        // Check if service has specific configuration
        if (normalizedService in this.proxyConfig.services) {
            return this.proxyConfig.services[normalizedService];
        }

        // Fall back to wildcard setting
        return this.proxyConfig.wildcard;
    }

    /**
     * Get proxy URL for a specific service (custom or default)
     */
    getProxyUrl(serviceName) {
        const normalizedService = serviceName.toLowerCase().replace(/[.-]/g, '');

        // Return custom proxy if configured for this service
        if (normalizedService in this.perServiceProxies) {
            return this.perServiceProxies[normalizedService] || null;
        }
        
        // Otherwise return the global default proxy
        return this.proxyUrl;
    }

    /**
     * Get the appropriate agent for a specific service (custom or default)
     */
    getServiceAgent(serviceName) {
        const normalizedService = serviceName.toLowerCase().replace(/[.-]/g, '');

        // Check if service has a custom proxy configured
        if (normalizedService in this.perServiceProxies) {
            const customProxyUrl = this.perServiceProxies[normalizedService];
            if (!customProxyUrl) return null;
            
            // Check if custom agent needs recreation
            if (this.shouldRecreateAgent(normalizedService)) {
                this.recreatePerServiceAgent(normalizedService);
            }
            
            return this.perServiceAgents.get(normalizedService);
        }

        // Use default if no custom proxy for this service
        if (this.shouldUseProxy(serviceName)) {
            // Check if default agent needs recreation
            if (this.shouldRecreateAgent()) {
                this.recreateAgent();
            }
            return this.agent;
        }
        
        return null;
    }

    /**
     * Check if agent needs to be recreated
     */
    shouldRecreateAgent(serviceName = 'default') {
        let agent, createdAt;
        
        if (serviceName === 'default') {
            agent = this.agent;
            createdAt = this.agentCreatedAt;
        } else {
            agent = this.perServiceAgents.get(serviceName);
            createdAt = this.perServiceAgentCreated.get(serviceName);
        }
        
        if (!agent || !createdAt) return true;

        const agentAge = Date.now() - createdAt;
        if (agentAge > this.agentMaxAge) {
            console.log(`[DEBRID-PROXY] Agent for ${serviceName} is ${Math.round(agentAge / 1000)}s old, recreating...`);
            return true;
        }

        const consecutiveErrors = serviceName === 'default' 
            ? this.consecutiveErrors 
            : this.perServiceConsecutiveErrors.get(serviceName) || 0;
            
        if (consecutiveErrors >= this.maxConsecutiveErrors) {
            console.log(`[DEBRID-PROXY] Too many consecutive errors (${consecutiveErrors}) for ${serviceName}, recreating agent...`);
            return true;
        }

        return false;
    }

    /**
     * Recreate the default proxy agent
     */
    recreateAgent() {
        if (!this.proxyUrl) return;

        // Destroy old agent if it exists
        if (this.agent && typeof this.agent.destroy === 'function') {
            try {
                this.agent.destroy();
            } catch (error) {
                console.warn(`[DEBRID-PROXY] Error destroying old default agent:`, error.message);
            }
        }

        this.agent = this.createProxyAgent(this.proxyUrl);
        this.agentCreatedAt = Date.now();
        this.consecutiveErrors = 0;
        console.log(`[DEBRID-PROXY] Default agent recreated successfully`);
    }

    /**
     * Recreate a per-service proxy agent
     */
    recreatePerServiceAgent(serviceName) {
        const proxyUrl = this.perServiceProxies[serviceName];
        if (!proxyUrl) return;

        // Destroy old agent if it exists
        const oldAgent = this.perServiceAgents.get(serviceName);
        if (oldAgent && typeof oldAgent.destroy === 'function') {
            try {
                oldAgent.destroy();
            } catch (error) {
                console.warn(`[DEBRID-PROXY] Error destroying old ${serviceName} agent:`, error.message);
            }
        }

        this.perServiceAgents.set(serviceName, this.createProxyAgent(proxyUrl, serviceName));
        this.perServiceAgentCreated.set(serviceName, Date.now());
        this.perServiceConsecutiveErrors.set(serviceName, 0);
        console.log(`[DEBRID-PROXY] Per-service agent for ${serviceName} recreated successfully`);
    }

    /**
     * Get axios config with proxy agent if enabled for the service
     */
    getAxiosConfig(serviceName, baseConfig = {}) {
        const agent = this.getServiceAgent(serviceName);
        const proxyUrl = this.getProxyUrl(serviceName);
        
        if (agent) {
            const normalizedService = serviceName.toLowerCase().replace(/[.-]/g, '');
            const isCustomService = normalizedService in this.perServiceProxies;
            console.log(`[DEBRID-PROXY] ✓ Using ${isCustomService ? 'custom' : 'default'} proxy for ${serviceName}: ${proxyUrl}`);
            return {
                ...baseConfig,
                httpAgent: agent,
                httpsAgent: agent,
                proxy: false // Disable axios built-in proxy handling
            };
        }
        return baseConfig;
    }

    /**
     * Mark a successful request (resets error counter)
     */
    markSuccess(serviceName = 'default') {
        if (serviceName === 'default') {
            this.consecutiveErrors = 0;
        } else {
            this.perServiceConsecutiveErrors.set(serviceName, 0);
        }
    }

    /**
     * Mark a failed request (increments error counter)
     */
    markError(error, serviceName = 'default') {
        if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') {
            if (serviceName === 'default') {
                this.consecutiveErrors++;
                console.warn(`[DEBRID-PROXY] Connection error (${error.code}) for default proxy, consecutive errors: ${this.consecutiveErrors}`);
            } else {
                const currentErrors = this.perServiceConsecutiveErrors.get(serviceName) || 0;
                this.perServiceConsecutiveErrors.set(serviceName, currentErrors + 1);
                console.warn(`[DEBRID-PROXY] Connection error (${error.code}) for ${serviceName} proxy, consecutive errors: ${currentErrors + 1}`);
            }
        }
    }

    /**
     * Get proxy agent for direct use (e.g., with fetch or other HTTP clients)
     */
    getProxyAgent(serviceName) {
        return this.getServiceAgent(serviceName);
    }

    /**
     * Get configuration for real-debrid-api client
     * The real-debrid-api package accepts a custom agent
     */
    getRealDebridConfig(serviceName = 'realdebrid') {
        const agent = this.getServiceAgent(serviceName);
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
        const perServiceStatus = {};
        for (const [serviceName, agent] of this.perServiceAgents.entries()) {
            const created = this.perServiceAgentCreated.get(serviceName);
            perServiceStatus[serviceName] = {
                proxyUrl: this.perServiceProxies[serviceName],
                agentType: agent?.constructor?.name || null,
                agentAgeSeconds: created ? Math.round((Date.now() - created) / 1000) : null,
                consecutiveErrors: this.perServiceConsecutiveErrors.get(serviceName) || 0
            };
        }
        
        return {
            enabled: !!this.proxyUrl || Object.keys(this.perServiceProxies).length > 0,
            defaultProxyUrl: this.proxyUrl,
            perServiceProxies: this.perServiceProxies,
            defaultAgentType: this.agent?.constructor?.name || null,
            defaultAgentAgeSeconds: agentAge,
            defaultConsecutiveErrors: this.consecutiveErrors,
            perServiceAgents: perServiceStatus
        };
    }
}

// Singleton instance
const debridProxyManager = new DebridProxyManager();

export default debridProxyManager;
export { DebridProxyManager }; // Export the class for testing
