#!/usr/bin/env node

import cluster from 'cluster';
import os from 'os';
import { overrideConsole } from './lib/util/logger.js';

// Override console to respect LOG_LEVEL environment variable
overrideConsole();

const numCPUs = os.cpus().length;

// Determine number of workers: use CPU count as optimal default, with MAX_WORKERS override
const maxWorkers = parseInt(process.env.MAX_WORKERS) || numCPUs;
const workersToUse = Math.min(maxWorkers, numCPUs, 32); // Cap at 32 workers as a reasonable upper limit

// Optimize worker configuration for better performance
process.env.UV_THREADPOOL_SIZE = Math.max(4, Math.floor(numCPUs * 2)); // Increase thread pool for I/O

if (cluster.isMaster) {
    console.log(`Master process ${process.pid} is running`);
    console.log(`Number of CPUs: ${numCPUs}`);
    console.log(`Requested workers: ${maxWorkers}`);
    console.log(`Using ${workersToUse} worker processes (max: ${maxWorkers}, CPUs: ${numCPUs})`);
    console.log(`UV_THREADPOOL_SIZE set to: ${process.env.UV_THREADPOOL_SIZE}`);

    // Fork workers
    for (let i = 0; i < workersToUse; i++) {
        const worker = cluster.fork();
        console.log(`Worker ${i + 1}/${workersToUse} started (PID: ${worker.process.pid})`);
    }

    // Handle worker exits
    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died with code: ${code}, signal: ${signal}`);
        console.log('Starting a new worker...');
        cluster.fork();
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down master process...');
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        process.exit(0);
    });
} else {
    // Worker processes
    console.log(`Worker ${process.pid} started`);

    // Import server.js and start the server explicitly in worker process
    let mongoCache = null;
    let cacheDb = null;

    try {
        const { app, server, PORT, HOST } = await import('./server.js');

        // Import MongoDB modules for cleanup
        mongoCache = await import('./lib/common/mongo-cache.js');
        cacheDb = await import('./lib/util/cache-db.js');

        // Start server in worker if it's not already started
        if (!server || server === null) {
            const port = PORT;
            const host = HOST;

            const workerServer = app.listen(port, host, () => {
                console.log(`Worker ${process.pid} server listening on port ${port}`);
            });

            // Export server for the worker process to use for cleanup
            global.workerServer = workerServer;
        } else {
            console.log(`Worker ${process.pid} using existing server on port ${PORT}`);
        }
    } catch (error) {
        console.error(`Worker ${process.pid} failed to start:`, error);
        process.exit(1);
    }

    // Handle graceful shutdown for workers
    let workerShuttingDown = false;

    const gracefulWorkerShutdown = async (signal) => {
        if (workerShuttingDown) return;
        workerShuttingDown = true;

        console.log(`Worker ${process.pid} received ${signal}, shutting down gracefully...`);

        // Close MongoDB connections first
        try {
            if (mongoCache && cacheDb) {
                await Promise.all([
                    mongoCache.closeMongo(),
                    cacheDb.closeConnection()
                ]);
                console.log(`Worker ${process.pid} MongoDB connections closed`);
            }
        } catch (error) {
            console.error(`Worker ${process.pid} Error closing MongoDB: ${error.message}`);
        }

        // Then close HTTP server
        if (global.workerServer) {
            global.workerServer.close(() => {
                console.log(`Worker ${process.pid} server closed`);
                process.exit(0);
            });

            // Force exit after 5 seconds
            setTimeout(() => {
                console.error(`Worker ${process.pid} forced shutdown`);
                process.exit(1);
            }, 5000).unref();
        } else {
            process.exit(0);
        }
    };

    process.on('SIGINT', () => gracefulWorkerShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulWorkerShutdown('SIGTERM'));
}