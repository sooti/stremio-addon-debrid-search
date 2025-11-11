/**
 * Video file finding utilities for Usenet downloads
 * Supports both direct filesystem access and file server API (with rar2fs mounting)
 */

import fs from 'fs';
import path from 'path';

/**
 * Find video file via file server API (uses rar2fs mounted directory)
 * @param {string} fileServerUrl - File server URL
 * @param {string} releaseName - Release name to search for
 * @param {object} options - Options (season, episode)
 * @param {string} fileServerPassword - File server API key
 * @returns {object|null} File info {name, path, size} or null
 */
export async function findVideoFileViaAPI(fileServerUrl, releaseName, options = {}, fileServerPassword = null) {
    try {
        const axios = (await import('axios')).default;
        console.log(`[USENET] Querying file server for release: ${releaseName}`);

        const headers = {};
        const apiKey = fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const response = await axios.get(`${fileServerUrl.replace(/\/$/, '')}/api/list`, {
            timeout: 5000,
            validateStatus: (status) => status === 200,
            headers: headers
        });

        if (!response.data?.files || !Array.isArray(response.data.files)) {
            console.log('[USENET] No files returned from file server');
            return null;
        }

        console.log(`[USENET] File server returned ${response.data.files.length} total video files`);

        // Filter files that match the release name (normalize the folder path)
        const normalizedRelease = releaseName.toLowerCase();
        let matchingFiles = response.data.files.filter(file => {
            if (!file || !file.path) {
                console.log(`[USENET] Warning: Invalid file entry in response`);
                return false;
            }
            const filePath = file.path.toLowerCase();
            const fileName = file.name ? file.name.toLowerCase() : '';

            // Match if path contains release name OR filename contains release name
            // This helps find files in nested subdirectories
            const pathMatch = filePath.includes(normalizedRelease);
            const nameMatch = fileName.includes(normalizedRelease);

            return pathMatch || nameMatch;
        });

        console.log(`[USENET] Found ${matchingFiles.length} files matching release "${releaseName}"`);

        // Debug: show paths of all matching files
        if (matchingFiles.length > 0) {
            console.log(`[USENET] Matching file paths:`, matchingFiles.slice(0, 5).map(f => f.path));
            console.log(`[USENET] First match:`, JSON.stringify(matchingFiles[0]));
        } else {
            // Show what we got from API to debug why nothing matched
            console.log(`[USENET] No matches found. Sample of files from API (first 3):`);
            response.data.files.slice(0, 3).forEach(f => {
                console.log(`  - Path: "${f.path}" | Name: "${f.name}"`);
            });
            console.log(`[USENET] Looking for release: "${normalizedRelease}"`);
        }

        if (matchingFiles.length === 0) {
            return null;
        }

        // Exclude sample files, extras, and featurettes
        matchingFiles = matchingFiles.filter(f => {
            if (!f || !f.name) return false;
            const nameLower = f.name.toLowerCase();
            const pathLower = f.path ? f.path.toLowerCase() : '';

            // Exclude common non-main-feature files
            const excludeKeywords = ['sample', 'extra', 'featurette', 'deleted', 'trailer', 'bonus'];
            const shouldExclude = excludeKeywords.some(keyword =>
                nameLower.includes(keyword) || pathLower.includes(keyword)
            );

            if (shouldExclude) {
                console.log(`[USENET] Excluding: ${f.name} (contains ${excludeKeywords.find(k => nameLower.includes(k) || pathLower.includes(k))})`);
            }

            return !shouldExclude;
        });

        if (matchingFiles.length === 0) {
            console.log(`[USENET] No files left after filtering non-main-feature files`);
            return null;
        }

        console.log(`[USENET] ${matchingFiles.length} files after filtering (showing sizes):`);
        matchingFiles.slice(0, 5).forEach(f => {
            console.log(`  - ${f.name}: ${(f.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
        });

        // For series, try to match season/episode
        if (options.season && options.episode) {
            const PTT = (await import('../../lib/util/parse-torrent-title.js')).default;
            const matchedFile = matchingFiles.find(file => {
                const parsed = PTT.parse(file.name);
                return parsed.season === Number(options.season) && parsed.episode === Number(options.episode);
            });
            if (matchedFile) {
                console.log(`[USENET] Matched S${options.season}E${options.episode}: ${matchedFile.name}`);
                return {
                    name: matchedFile.name,
                    path: matchedFile.path, // Use full path with folder
                    size: matchedFile.size
                };
            }
        }

        // Return largest file
        matchingFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
        const largestFile = matchingFiles[0];

        if (!largestFile || !largestFile.name) {
            console.log(`[USENET] Error: largest file is invalid`);
            return null;
        }

        console.log(`[USENET] Selected largest file: ${largestFile.name} (${(largestFile.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);

        // Use full path with folder so rar2fs can find the extracted file
        return {
            name: largestFile.name,
            path: largestFile.path, // Use full path, not flatPath
            size: largestFile.size
        };

    } catch (error) {
        console.error('[USENET] Error querying file server:', error.message);
        return null;
    }
}

/**
 * Find video file in local filesystem directory
 * @param {string} baseDir - Base directory to search
 * @param {string} fileName - File name hint
 * @param {object} options - Options (season, episode)
 * @returns {string|null} Full path to video file or null
 */
export async function findVideoFile(baseDir, fileName, options = {}) {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg'];

    try {
        if (!fs.existsSync(baseDir)) {
            return null;
        }

        // Check if baseDir is directly a file
        const stat = fs.statSync(baseDir);
        if (stat.isFile()) {
            const ext = path.extname(baseDir).toLowerCase();
            if (videoExtensions.includes(ext)) {
                return baseDir;
            }
        }

        // Search in directory recursively
        const files = fs.readdirSync(baseDir, { withFileTypes: true, recursive: true });

        // Filter video files and exclude samples
        // Note: with recursive: true, dirent.name contains the relative path from baseDir
        let videoFiles = files
            .filter(f => f.isFile())
            .map(f => {
                // f.path is the parent directory, f.name is the filename (or relative path with recursive)
                // Join them correctly to get the full path
                const fullPath = path.join(f.path || baseDir, f.name);
                return fullPath;
            })
            .filter(p => videoExtensions.includes(path.extname(p).toLowerCase()))
            .filter(p => !path.basename(p).toLowerCase().includes('sample')); // Exclude sample files

        console.log(`[USENET] Found ${videoFiles.length} video files in ${baseDir}`);
        if (videoFiles.length > 0) {
            console.log('[USENET] Video files:', videoFiles.map(f => path.basename(f)).join(', '));
        }

        if (videoFiles.length === 0) {
            return null;
        }

        // For series, try to match season/episode
        if (options.season && options.episode) {
            const PTT = (await import('../../lib/util/parse-torrent-title.js')).default;
            const matchedFile = videoFiles.find(file => {
                const parsed = PTT.parse(path.basename(file));
                return parsed.season === Number(options.season) && parsed.episode === Number(options.episode);
            });
            if (matchedFile) return matchedFile;
        }

        // Return largest file
        const filesWithSize = videoFiles.map(f => ({ path: f, size: fs.statSync(f).size }));
        filesWithSize.sort((a, b) => b.size - a.size);
        return filesWithSize[0]?.path || null;

    } catch (error) {
        console.error('[USENET] Error finding video file:', error.message);
        return null;
    }
}

export default {
    findVideoFileViaAPI,
    findVideoFile
};
