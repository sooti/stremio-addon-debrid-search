// Function to extract language information from quality header text
export function extractLanguageInfoFromHeader(qualityHeaderText) {
  if (!qualityHeaderText || typeof qualityHeaderText !== 'string') {
    return [];
  }

  const text = qualityHeaderText.toLowerCase();
  const languages = [];

  // Common language indicators in torrent/stream titles
  const languagePatterns = [
    { pattern: /\b(hindi|हिंदी)\b/i, language: 'hindi' },
    { pattern: /\b(tamil|தமிழ்)\b/i, language: 'tamil' },
    { pattern: /\b(telugu|తెలుగు)\b/i, language: 'telugu' },
    { pattern: /\b(malayalam|മലയാളം)\b/i, language: 'malayalam' },
    { pattern: /\b(kannada|ಕನ್ನಡ)\b/i, language: 'kannada' },
    { pattern: /\b(bengali|বাংলা)\b/i, language: 'bengali' },
    { pattern: /\b(marathi|मराठी)\b/i, language: 'marathi' },
    { pattern: /\b(punjabi|ਪੰਜਾਬੀ)\b/i, language: 'punjabi' },
    { pattern: /\b(gujarati|ગુજરાતી)\b/i, language: 'gujarati' },
    { pattern: /\b(urdu|اُردُو)\b/i, language: 'urdu' },
    { pattern: /\b(english|eng|en)\b/i, language: 'english' },
    { pattern: /\b(spanish|español|esp)\b/i, language: 'spanish' },
    { pattern: /\b(french|français|fre|fr)\b/i, language: 'french' },
    { pattern: /\b(german|deutsch|ger|de)\b/i, language: 'german' },
    { pattern: /\b(italian|italiano|ita|it)\b/i, language: 'italian' },
    { pattern: /\b(portuguese|português|por|pt)\b/i, language: 'portuguese' },
    { pattern: /\b(chinese|中文|chi|zh)\b/i, language: 'chinese' },
    { pattern: /\b(japanese|日本語|jpn|ja)\b/i, language: 'japanese' },
    { pattern: /\b(korean|한국어|kor|ko)\b/i, language: 'korean' },
    { pattern: /\b(russian|русский|rus|ru)\b/i, language: 'russian' },
    { pattern: /\b(arabic|العربية|ara|ar)\b/i, language: 'arabic' },
    { pattern: /\b(dubbed|dub)\b/i, language: 'dubbed' },
    { pattern: /\b(subbed|subtitles|subs)\b/i, language: 'subbed' },
    { pattern: /\b(dual[-\s]audio)\b/i, language: 'dual audio' },
    { pattern: /\b(multi[-\s]audio)\b/i, language: 'multi audio' }
  ];

  // Check for language patterns in the text
  for (const { pattern, language } of languagePatterns) {
    if (pattern.test(text)) {
      languages.push(language);
    }
  }

  // Special handling for multi-language indicators
  if (/\b(multi|multi[-\s]lang|multi[-\s]language)\b/i.test(text)) {
    languages.push('multi');
  }

  // Remove duplicates and return
  return [...new Set(languages)];
}
