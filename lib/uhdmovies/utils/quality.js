// Function to extract clean quality information from verbose text
export function extractCleanQuality(fullQualityText) {
  if (!fullQualityText || fullQualityText === 'Unknown Quality') {
    return 'Unknown Quality';
  }

  const cleanedFullQualityText = fullQualityText.replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g, '').trim();
  const text = cleanedFullQualityText.toLowerCase();
  let quality = [];

  // Extract resolution
  if (text.includes('2160p') || text.includes('4k')) {
    quality.push('4K');
  } else if (text.includes('1080p')) {
    quality.push('1080p');
  } else if (text.includes('720p')) {
    quality.push('720p');
  } else if (text.includes('480p')) {
    quality.push('480p');
  }

  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('dolby vision') || text.includes('dovi') || /\bdv\b/.test(text)) {
    quality.push('DV');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }

  // If we found any quality indicators, join them
  if (quality.length > 0) {
    return quality.join(' | ');
  }

  // Fallback: try to extract a shorter version of the original text
  // Look for patterns like "Movie Name (Year) Resolution ..."
  const patterns = [
    /(\d{3,4}p.*?(?:x264|x265|hevc).*?)[[\(]/i,
    /(\d{3,4}p.*?)[[\(]/i,
    /((?:720p|1080p|2160p|4k).*?)$/i
  ];

  for (const pattern of patterns) {
    const match = cleanedFullQualityText.match(pattern);
    if (match && match[1].trim().length < 100) {
      return match[1].trim().replace(/x265/ig, 'HEVC');
    }
  }

  // Final fallback: truncate if too long
  if (cleanedFullQualityText.length > 80) {
    return cleanedFullQualityText.substring(0, 77).replace(/x265/ig, 'HEVC') + '...';
  }

  return cleanedFullQualityText.replace(/x265/ig, 'HEVC');
}

export function extractCodecs(rawQuality) {
  const codecs = [];
  const text = rawQuality.toLowerCase();

  if (text.includes('hevc') || text.includes('x265')) {
    codecs.push('H.265');
  } else if (text.includes('x264')) {
    codecs.push('H.264');
  }

  if (text.includes('10bit') || text.includes('10-bit')) {
    codecs.push('10-bit');
  }

  if (text.includes('atmos')) {
    codecs.push('Atmos');
  } else if (text.includes('dts-hd')) {
    codecs.push('DTS-HD');
  } else if (text.includes('dts')) {
    codecs.push('DTS');
  } else if (text.includes('ddp5.1') || text.includes('dd+ 5.1') || text.includes('eac3')) {
    codecs.push('EAC3');
  } else if (text.includes('ac3')) {
    codecs.push('AC3');
  }

  if (text.includes('dovi') || text.includes('dolby vision') || /\bdv\b/.test(text)) {
    codecs.push('DV');
  } else if (text.includes('hdr')) {
    codecs.push('HDR');
  }

  return codecs;
}
