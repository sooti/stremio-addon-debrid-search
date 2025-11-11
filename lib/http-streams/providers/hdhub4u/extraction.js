/**
 * HDHub4u Stream Extraction Module
 * Handles extraction of streams from HDHub4u redirect links
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { base64Decode, base64Encode, rot13 } from '../../utils/encoding.js';

/**
 * Gets redirect links for a stream
 * @param {string} link - Original link
 * @returns {Promise<string>} Redirect link or original link on failure
 */
export async function getRedirectLinksForStream(link) {
    try {
        const res = await makeRequest(link, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        });

        const resText = res.body;

        const regex = /ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = '';

        let match;
        while ((match = regex.exec(resText)) !== null) {
            combinedString += match[1];
        }

        // Use existing base64Decode and other helper functions
        const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
        const data = JSON.parse(decodedString);
        console.log('Redirect data:', data);

        const token = base64Encode(data?.data);
        const blogLink = data?.wp_http1 + '?re=' + token;

        // Wait for the required time
        const waitTime = (Number(data?.total_time) + 3) * 1000;
        console.log(`Waiting ${waitTime}ms before proceeding...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        console.log('Blog link:', blogLink);

        let vcloudLink = 'Invalid Request';
        let attempts = 0;
        const maxAttempts = 5;

        while (vcloudLink.includes('Invalid Request') && attempts < maxAttempts) {
            const blogRes = await makeRequest(blogLink, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const blogText = blogRes.body;

            if (blogText.includes('Invalid Request')) {
                console.log('Invalid request, retrying...');
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            } else {
                const reurlMatch = blogText.match(/var reurl = "([^"]+)"/);
                if (reurlMatch) {
                    vcloudLink = reurlMatch[1];
                    break;
                }
            }
        }

        return blogLink;
    } catch (err) {
        console.log('Error in getRedirectLinks:', err);
        return link;
    }
}

/**
 * Extracts stream from HDHub4u link
 * @param {string} link - HDHub4u link
 * @returns {Promise<Array>} Array of extracted streams
 */
export async function hdhub4uGetStream(link) {
    try {
        console.log('Processing HDHub4u stream link:', link);

        let hubcloudLink = '';

        // Handle hubcdn.fans links directly
        if (link.includes('hubcdn.fans')) {
            console.log('Processing hubcdn.fans link:', link);
            const hubcdnRes = await makeRequest(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const hubcdnText = hubcdnRes.body;

            // Extract reurl from script tag
            const reurlMatch = hubcdnText.match(/var reurl = "([^"]+)"/);
            if (reurlMatch && reurlMatch[1]) {
                const reurlValue = reurlMatch[1];
                console.log('Found reurl:', reurlValue);

                // Extract base64 encoded part after r=
                const urlMatch = reurlValue.match(/\?r=(.+)$/);
                if (urlMatch && urlMatch[1]) {
                    const base64Encoded = urlMatch[1];
                    console.log('Base64 encoded part:', base64Encoded);

                    try {
                        const decodedUrl = base64Decode(base64Encoded);
                        console.log('Decoded URL:', decodedUrl);

                        let finalVideoUrl = decodedUrl;
                        const linkMatch = decodedUrl.match(/[?&]link=(.+)$/);
                        if (linkMatch && linkMatch[1]) {
                            finalVideoUrl = decodeURIComponent(linkMatch[1]);
                            console.log('Extracted video URL:', finalVideoUrl);
                        }

                        return [
                            {
                                server: 'HDHub4u Direct',
                                link: finalVideoUrl,
                                type: 'mp4',
                                copyable: true,
                            },
                        ];
                    } catch (decodeError) {
                        console.error('Error decoding base64:', decodeError);
                    }
                }
            }
        }

        if (link.includes('hubdrive') || link.includes('hubcloud')) {
            hubcloudLink = link;
        } else {
            const res = await makeRequest(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const text = res.body;
            const encryptedString = text.split("s('o','")?.[1]?.split("',180")?.[0];
            console.log('Encrypted string:', encryptedString);

            if (!encryptedString) {
                throw new Error('Could not extract encrypted string from response');
            }

            // Use the decodeString function from link-processor
            const { decodeString } = await import('../../resolvers/link-processor.js');
            const decodedString = decodeString(encryptedString);
            console.log('Decoded string:', decodedString);

            if (!decodedString?.o) {
                throw new Error('Invalid decoded data structure');
            }

            link = base64Decode(decodedString.o);
            console.log('New link:', link);

            const redirectLink = await getRedirectLinksForStream(link);
            console.log('Redirect link:', redirectLink);

            // Check if the redirect link is already a hubcloud drive link
            if (redirectLink.includes('hubcloud') && redirectLink.includes('/drive/')) {
                hubcloudLink = redirectLink;
                console.log('Using redirect link as hubcloud link:', hubcloudLink);
            } else {
                // Fetch the redirect page to find download links
                const redirectLinkRes = await makeRequest(redirectLink, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    }
                });

                const redirectLinkText = redirectLinkRes.body;
                const $ = cheerio.load(redirectLinkText);

                // Try multiple selectors to find download/stream links
                hubcloudLink = $('h3:contains("1080p")').find('a').attr('href') ||
                    $('a[href*="hubdrive"]').first().attr('href') ||
                    $('a[href*="hubcloud"]').first().attr('href') ||
                    $('a[href*="drive"]').first().attr('href');

                // If still not found, try regex patterns
                if (!hubcloudLink) {
                    const hubcloudPatterns = [
                        /href="(https:\/\/hubcloud\.[^\/]+\/drive\/[^"]+)"/g,
                        /href="(https:\/\/[^"]*hubdrive[^"]*)"/g,
                        /href="(https:\/\/[^"]*drive[^"]*[a-zA-Z0-9]+)"/g
                    ];

                    for (const pattern of hubcloudPatterns) {
                        const matches = [...redirectLinkText.matchAll(pattern)];
                        if (matches.length > 0) {
                            hubcloudLink = matches[matches.length - 1][1];
                            break;
                        }
                    }
                }

                console.log('Extracted hubcloud link from page:', hubcloudLink);
            }
        }

        if (!hubcloudLink) {
            throw new Error('Could not extract hubcloud link');
        }

        console.log('Final hubcloud link:', hubcloudLink);

        // Extract the final video URL from hubcloud
        const hubcloudRes = await makeRequest(hubcloudLink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });

        const finalText = hubcloudRes.body;

        // Try to extract video URL from various patterns
        const videoUrlPatterns = [
            /sources:\s*\[\s*{\s*file:\s*"([^"]+)"/,
            /file:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /src:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /"file":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /"src":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /video[^>]*src="([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/
        ];

        for (const pattern of videoUrlPatterns) {
            const match = finalText.match(pattern);
            if (match && match[1]) {
                console.log('Found video URL:', match[1]);
                return [
                    {
                        server: 'HDHub4u Stream',
                        link: match[1],
                        type: 'mp4',
                        copyable: true,
                    }
                ];
            }
        }

        // If no direct video URL found, return the hubcloud link
        return [
            {
                server: 'HDHub4u Hubcloud',
                link: hubcloudLink,
                type: 'redirect',
                copyable: true,
            }
        ];

    } catch (error) {
        console.error('Error in HDHub4u stream extraction:', error);
        return [];
    }
}
