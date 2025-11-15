import axios from 'axios';
import http from 'http';
import https from 'https';
import debridProxyManager from './debrid-proxy.js';

/**
 * Shared Axios Instance Manager
 *
 * This module provides a single shared axios instance for all scrapers
 * to prevent memory leaks from multiple HTTP agents and connection pools.
 *
 * Previous Issue:
 * - Each scraper module created its own axios instance
 * - With 14 scrapers and N workers, this created 14*N separate HTTP agents
 * - Each agent had maxSockets: 50, leading to thousands of potential sockets
 * - High timeout/error rates caused socket leaks, growing RSS to 3+ GB
 *
 * Solution:
 * - Single shared axios instance per service type
 * - Centralized HTTP agent configuration
 * - Better socket cleanup and lifecycle management
 */

class SharedAxiosManager {
    constructor() {
        this.instances = new Map();
        this.agents = new Map();
        this.lastRecreation = new Map();

        // Agent configuration
        this.agentMaxAge = 5 * 60 * 1000; // Recreate agents every 5 minutes to clear leaked sockets
        this.maxSockets = 100; // Increased from 50 since we're sharing across scrapers
        this.maxFreeSockets = 20; // Increased from 10
        this.socketTimeout = 60000; // 60 second socket timeout
        this.freeSocketTimeout = 30000; // Close idle sockets after 30s

        console.log('[SHARED-AXIOS] Initialized shared axios manager');
    }

    /**
     * Create HTTP/HTTPS agents with optimized settings
     */
    createAgents(serviceName) {
        const agentOptions = {
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: this.maxSockets,
            maxFreeSockets: this.maxFreeSockets,
            timeout: this.socketTimeout,
            freeSocketTimeout: this.freeSocketTimeout,
            // Ensure sockets are destroyed on timeout
            scheduling: 'fifo' // First in, first out - reuse oldest sockets first
        };

        const httpAgent = new http.Agent(agentOptions);
        const httpsAgent = new https.Agent(agentOptions);

        console.log(`[SHARED-AXIOS] Created new HTTP agents for ${serviceName} (maxSockets: ${this.maxSockets})`);

        return { httpAgent, httpsAgent };
    }

    /**
     * Get or create shared axios instance for a service
     */
    getAxiosInstance(serviceName = 'scrapers') {
        // Check if we need to recreate the instance
        if (this.shouldRecreateInstance(serviceName)) {
            this.recreateInstance(serviceName);
        }

        // Return existing instance or create new one
        if (!this.instances.has(serviceName)) {
            this.createInstance(serviceName);
        }

        return this.instances.get(serviceName);
    }

    /**
     * Create a new axios instance for a service
     */
    createInstance(serviceName) {
        console.log(`[SHARED-AXIOS] Creating new axios instance for ${serviceName}`);

        // Get proxy configuration from debrid proxy manager
        const proxyConfig = debridProxyManager.getAxiosConfig(serviceName, {});

        // Create fresh HTTP agents if not using proxy
        let httpAgent = null;
        let httpsAgent = null;

        if (!proxyConfig.httpAgent && !proxyConfig.httpsAgent) {
            const agents = this.createAgents(serviceName);
            httpAgent = agents.httpAgent;
            httpsAgent = agents.httpsAgent;
            this.agents.set(serviceName, agents);
        } else {
            // Using proxy agents from debridProxyManager
            httpAgent = proxyConfig.httpAgent;
            httpsAgent = proxyConfig.httpsAgent;
        }

        // Create axios instance with optimized configuration
        const instance = axios.create({
            ...proxyConfig,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            // Default timeout (can be overridden per request)
            timeout: 60000,
            // Disable automatic retries (we handle this manually)
            maxRedirects: 5,
            // Better error handling
            validateStatus: null, // Don't throw on any status code
        });

        // Add request interceptor to handle errors and cleanup
        instance.interceptors.request.use(
            (config) => {
                // Request sent successfully
                return config;
            },
            (error) => {
                console.error(`[SHARED-AXIOS] Request setup error for ${serviceName}:`, error.message);
                return Promise.reject(error);
            }
        );

        // Add response interceptor to track errors and trigger cleanup
        instance.interceptors.response.use(
            (response) => {
                // Mark success for proxy manager
                debridProxyManager.markSuccess(serviceName);
                return response;
            },
            (error) => {
                // Log error and mark for proxy manager
                if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                    console.warn(`[SHARED-AXIOS] Timeout error for ${serviceName}:`, error.message);
                } else if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                    console.warn(`[SHARED-AXIOS] Connection error for ${serviceName}:`, error.message);
                }

                debridProxyManager.markError(error, serviceName);

                // Destroy socket if it exists to prevent leaks
                if (error.request?.socket && !error.request.socket.destroyed) {
                    try {
                        error.request.socket.destroy();
                    } catch (e) {
                        // Ignore destruction errors
                    }
                }

                return Promise.reject(error);
            }
        );

        this.instances.set(serviceName, instance);
        this.lastRecreation.set(serviceName, Date.now());

        console.log(`[SHARED-AXIOS] Created shared axios instance for ${serviceName}`);

        return instance;
    }

    /**
     * Check if instance should be recreated (age-based cleanup)
     */
    shouldRecreateInstance(serviceName) {
        const lastRecreated = this.lastRecreation.get(serviceName);
        if (!lastRecreated) return false;

        const age = Date.now() - lastRecreated;
        if (age > this.agentMaxAge) {
            console.log(`[SHARED-AXIOS] Instance for ${serviceName} is ${Math.round(age / 1000)}s old, recreating...`);
            return true;
        }

        return false;
    }

    /**
     * Recreate instance to clear any leaked resources
     */
    recreateInstance(serviceName) {
        console.log(`[SHARED-AXIOS] Recreating instance for ${serviceName}`);

        // Destroy old agents if they exist
        const oldAgents = this.agents.get(serviceName);
        if (oldAgents) {
            try {
                if (oldAgents.httpAgent && typeof oldAgents.httpAgent.destroy === 'function') {
                    oldAgents.httpAgent.destroy();
                }
                if (oldAgents.httpsAgent && typeof oldAgents.httpsAgent.destroy === 'function') {
                    oldAgents.httpsAgent.destroy();
                }
                console.log(`[SHARED-AXIOS] Destroyed old agents for ${serviceName}`);
            } catch (error) {
                console.warn(`[SHARED-AXIOS] Error destroying old agents for ${serviceName}:`, error.message);
            }
        }

        // Remove old instance
        this.instances.delete(serviceName);
        this.agents.delete(serviceName);

        // Create new instance (will happen on next getAxiosInstance call)
    }

    /**
     * Manual cleanup for shutdown
     */
    shutdown() {
        console.log('[SHARED-AXIOS] Shutting down all axios instances');

        for (const [serviceName, agents] of this.agents.entries()) {
            try {
                if (agents.httpAgent && typeof agents.httpAgent.destroy === 'function') {
                    agents.httpAgent.destroy();
                }
                if (agents.httpsAgent && typeof agents.httpsAgent.destroy === 'function') {
                    agents.httpsAgent.destroy();
                }
                console.log(`[SHARED-AXIOS] Destroyed agents for ${serviceName}`);
            } catch (error) {
                console.warn(`[SHARED-AXIOS] Error destroying agents for ${serviceName}:`, error.message);
            }
        }

        this.instances.clear();
        this.agents.clear();
        this.lastRecreation.clear();

        console.log('[SHARED-AXIOS] Shutdown complete');
    }

    /**
     * Get status for debugging
     */
    getStatus() {
        const status = {};
        for (const [serviceName, instance] of this.instances.entries()) {
            const lastRecreated = this.lastRecreation.get(serviceName);
            const age = lastRecreated ? Math.round((Date.now() - lastRecreated) / 1000) : null;

            status[serviceName] = {
                exists: true,
                ageSeconds: age,
                hasAgents: this.agents.has(serviceName)
            };
        }
        return status;
    }
}

// Create singleton instance
const sharedAxiosManager = new SharedAxiosManager();

// Export convenience function
export function getSharedAxios(serviceName = 'scrapers') {
    return sharedAxiosManager.getAxiosInstance(serviceName);
}

export default sharedAxiosManager;
export { SharedAxiosManager };
