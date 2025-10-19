#!/usr/bin/env node

import cluster from 'cluster';
import os from 'os';

const numCPUs = os.cpus().length;

// Determine number of workers: use CPU count as optimal default, with MAX_WORKERS override
const maxWorkers = parseInt(process.env.MAX_WORKERS) || numCPUs;
const workersToUse = Math.min(maxWorkers, numCPUs, 32); // Cap at 32 workers as a reasonable upper limit

if (cluster.isMaster) {
    console.log(`Master process ${process.pid} is running`);
    console.log(`Number of CPUs: ${numCPUs}`);
    console.log(`Requested workers: ${maxWorkers}`);
    console.log(`Using ${workersToUse} worker processes (max: ${maxWorkers}, CPUs: ${numCPUs})`);

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
    try {
        const { app, server, PORT, HOST } = await import('./server.js');
        
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
    process.on('SIGINT', () => {
        console.log(`Worker ${process.pid} received SIGINT, shutting down...`);
        if (global.workerServer) {
            global.workerServer.close(() => {
                console.log(`Worker ${process.pid} server closed`);
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });

    process.on('SIGTERM', () => {
        console.log(`Worker ${process.pid} received SIGTERM, shutting down...`);
        if (global.workerServer) {
            global.workerServer.close(() => {
                console.log(`Worker ${process.pid} server closed`);
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
}