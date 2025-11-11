import { URL } from 'url';

// Function to encode URLs for streaming, being careful not to over-encode existing encoded URLs
export function encodeUrlForStreaming(url) {
  if (!url) return url;

  // Don't re-encode already encoded URLs
  if (url.includes('%')) {
    // If it's already partially encoded, return as-is to avoid double encoding
    return url;
  }

  // For URLs with special characters that need encoding
  try {
    // Use URL constructor to handle the encoding properly
    const urlObj = new URL(url);
    // The URL constructor already handles proper encoding
    return urlObj.toString();
  } catch (e) {
    // If URL is malformed, do selective encoding
    return url
      .replace(/ /g, '%20')  // Encode spaces
      .replace(/#/g, '%23')  // Encode hash (fragment identifier)
      .replace(/\[/g, '%5B') // Encode brackets
      .replace(/\]/g, '%5D')
      .replace(/{/g, '%7B') // Encode braces
      .replace(/}/g, '%7D');
  }
}
