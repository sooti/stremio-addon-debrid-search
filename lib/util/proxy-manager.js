import axios from 'axios';
import { promisify } from 'util';
import { exec } from 'child_process';

const execPromise = promisify(exec);

/**
 * Free Proxy Manager for BTDigg scraper
 * Uses free proxy lists to rotate proxies and reduce blocking
 */

class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.lastFetch = 0;
        this.fetchInterval = 5 * 60 * 1000; // 5 minutes
        this.validatedProxies = new Map(); // proxy -> { lastUsed, failures, successes }
        this.maxFailures = 3; // Remove proxy after 3 failures
    }

    /**
     * Fetch fresh proxies from free proxy lists
     */
    async fetchProxies() {
        const now = Date.now();

        // Only fetch if cache is expired
        if (this.proxies.length > 0 && (now - this.lastFetch) < this.fetchInterval) {
            return this.proxies;
        }

        console.log('[PROXY] Fetching fresh proxy list...');
        const newProxies = [];

        // Try multiple free proxy sources
        const sources = [
            // ProxyScrape - HTTP proxies, updated every 5 minutes
            {
                name: 'ProxyScrape-HTTP',
                fetch: async () => {
                    try {
                        // Fetch HTTPS proxies (more compatible with btdig.com)
                        const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all', {
                            timeout: 10000
                        });
                        const lines = response.data.split('\n').filter(Boolean);
                        return lines.map(line => {
                            const [host, port] = line.trim().split(':');
                            return host && port ? `http://${host}:${port}` : null;
                        }).filter(Boolean);
                    } catch (error) {
                        console.log(`[PROXY] ProxyScrape-HTTP failed:`, error.message);
                        return [];
                    }
                }
            },
            // GetProxyList - Rotating proxy API
            {
                name: 'GetProxyList',
                fetch: async () => {
                    try {
                        const response = await axios.get('https://api.getproxylist.com/proxy?protocol[]=http&protocol[]=https&anonymity[]=elite&anonymity[]=anonymous', {
                            timeout: 10000
                        });
                        if (response.data && response.data.ip && response.data.port) {
                            return [`${response.data.ip}:${response.data.port}`];
                        }
                        return [];
                    } catch (error) {
                        console.log(`[PROXY] ${this.name} failed:`, error.message);
                        return [];
                    }
                }
            },
            // Proxifly GitHub - Large free proxy list
            {
                name: 'Proxifly-HTTP',
                fetch: async () => {
                    try {
                        const response = await axios.get('https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt', {
                            timeout: 10000
                        });
                        const lines = response.data.split('\n').filter(Boolean);
                        return lines.slice(0, 50).map(line => { // Limit to 50 best proxies
                            let trimmed = line.trim();
                            // Remove http:// prefix if present
                            trimmed = trimmed.replace(/^https?:\/\//, '');
                            const parts = trimmed.split(':');
                            if (parts.length >= 2) {
                                const host = parts[0];
                                const port = parts[1];
                                return host && port ? `http://${host}:${port}` : null;
                            }
                            return null;
                        }).filter(Boolean);
                    } catch (error) {
                        console.log(`[PROXY] Proxifly-HTTP failed:`, error.message);
                        return [];
                    }
                }
            },
            // Backup: SOCKS5 proxies
            {
                name: 'ProxyScrape-Socks5',
                fetch: async () => {
                    try {
                        const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&anonymity=elite,anonymous', {
                            timeout: 10000
                        });
                        const lines = response.data.split('\n').filter(Boolean);
                        return lines.slice(0, 20).map(line => { // Limit SOCKS5 as they're less reliable
                            const [host, port] = line.trim().split(':');
                            return host && port ? `socks5://${host}:${port}` : null;
                        }).filter(Boolean);
                    } catch (error) {
                        console.log(`[PROXY] ProxyScrape-Socks5 failed:`, error.message);
                        return [];
                    }
                }
            }
        ];

        // Fetch from all sources in parallel
        const results = await Promise.allSettled(sources.map(s => s.fetch()));

        results.forEach((result, idx) => {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                console.log(`[PROXY] ${sources[idx].name} returned ${result.value.length} proxies`);
                newProxies.push(...result.value);
            }
        });

        if (newProxies.length > 0) {
            this.proxies = [...new Set(newProxies)]; // Deduplicate
            this.lastFetch = now;
            console.log(`[PROXY] Loaded ${this.proxies.length} unique proxies`);
        } else {
            console.log('[PROXY] WARNING: No proxies fetched, using existing list');
        }

        return this.proxies;
    }

    /**
     * Get next proxy in rotation
     */
    async getNextProxy() {
        await this.fetchProxies();

        if (this.proxies.length === 0) {
            return null; // No proxies available
        }

        // Filter out proxies that have failed too many times
        const validProxies = this.proxies.filter(proxy => {
            const stats = this.validatedProxies.get(proxy);
            return !stats || stats.failures < this.maxFailures;
        });

        if (validProxies.length === 0) {
            // Reset failures if all proxies are exhausted
            console.log('[PROXY] All proxies failed, resetting failure counts');
            this.validatedProxies.clear();
            return this.proxies[0];
        }

        // Round-robin through valid proxies
        this.currentIndex = (this.currentIndex + 1) % validProxies.length;
        return validProxies[this.currentIndex];
    }

    /**
     * Mark a proxy as successful
     */
    markSuccess(proxy) {
        if (!proxy) return;

        const stats = this.validatedProxies.get(proxy) || { lastUsed: 0, failures: 0, successes: 0 };
        stats.successes++;
        stats.lastUsed = Date.now();
        this.validatedProxies.set(proxy, stats);
    }

    /**
     * Mark a proxy as failed
     */
    markFailure(proxy) {
        if (!proxy) return;

        const stats = this.validatedProxies.get(proxy) || { lastUsed: 0, failures: 0, successes: 0 };
        stats.failures++;
        stats.lastUsed = Date.now();
        this.validatedProxies.set(proxy, stats);

        if (stats.failures >= this.maxFailures) {
            console.log(`[PROXY] Proxy ${proxy} marked as bad (${stats.failures} failures)`);
        }
    }

    /**
     * Test if a proxy is working
     */
    async testProxy(proxy) {
        try {
            const proxyArg = proxy.startsWith('socks') ? `--socks5 ${proxy.replace('socks5://', '')}` : `-x ${proxy}`;
            const cmd = `curl -s -m 5 ${proxyArg} https://api.ipify.org?format=json`;

            const { stdout } = await execPromise(cmd, { timeout: 6000 });
            const data = JSON.parse(stdout);

            if (data.ip) {
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get proxy stats for debugging
     */
    getStats() {
        return {
            totalProxies: this.proxies.length,
            validatedProxies: this.validatedProxies.size,
            workingProxies: Array.from(this.validatedProxies.entries())
                .filter(([, stats]) => stats.failures < this.maxFailures).length,
            lastFetch: new Date(this.lastFetch).toISOString()
        };
    }
}

// Singleton instance
const proxyManager = new ProxyManager();

export default proxyManager;
