/**
 * Converts Markdown-heavy LLM output into clean, compact plain text suitable for SMS.
 */
export function formatForSms(text: string): string {
  if (!text) {
    return '';
  }

  let formatted = text;

  // 1. Strip fenced code block markers (```lang ... ```) while keeping the inner content
  formatted = formatted.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code) => {
    return code.trim();
  });

  // 2. Strip inline code backticks (`code`)
  formatted = formatted.replace(/`([^`\n]+)`/g, '$1');

  // 3. Convert Markdown links [label](url) -> "label (url)" or just "url"
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return label.trim() === url.trim() ? url.trim() : `${label.trim()} (${url.trim()})`;
  });

  // 4. Strip Markdown heading prefixes (### Heading -> Heading)
  formatted = formatted.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, '$1');

  // 5. Normalize bullet points (* item -> - item) before stripping emphasis
  formatted = formatted.replace(/^([ \t]*)\*[ \t]+/gm, '$1- ');

  // 6. Strip bold/italic markers (**bold**, __bold__, *italic*)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '$1');
  formatted = formatted.replace(/__([^_]+)__/g, '$1');
  formatted = formatted.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1');

  // 7. Collapse 3+ consecutive newlines into a single blank line
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  return formatted.trim();
}

/**
 * Formats and splits a long text response into segments that fit comfortably within
 * Twilio's concatenated SMS limits (maximum 1600 characters per message).
 */
export function chunkMessage(text: string, maxLength: number = 1500): string[] {
  const trimmed = formatForSms(text);
  if (trimmed.length <= maxLength) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.trim());
      break;
    }

    // Try finding a good breaking point (paragraph, sentence, or whitespace)
    let breakPoint = -1;

    // 1. Try double newline (paragraph)
    const lastParagraph = remaining.lastIndexOf('\n\n', maxLength);
    if (lastParagraph > maxLength * 0.5) {
      breakPoint = lastParagraph + 2;
    } else {
      // 2. Try single newline
      const lastNewline = remaining.lastIndexOf('\n', maxLength);
      if (lastNewline > maxLength * 0.5) {
        breakPoint = lastNewline + 1;
      } else {
        // 3. Try sentence end (. ! ? followed by space)
        const sentenceMatch = remaining.substring(0, maxLength).match(/.*[.!?]\s+/s);
        if (sentenceMatch && sentenceMatch[0].length > maxLength * 0.5) {
          breakPoint = sentenceMatch[0].length;
        } else {
          // 4. Try whitespace
          const lastSpace = remaining.lastIndexOf(' ', maxLength);
          if (lastSpace > maxLength * 0.5) {
            breakPoint = lastSpace + 1;
          } else {
            // 5. Hard break
            breakPoint = maxLength;
          }
        }
      }
    }

    const chunk = remaining.substring(0, breakPoint).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.substring(breakPoint).trim();
  }

  // If multiple chunks, add part indicators (e.g., "[1/3]")
  if (chunks.length > 1) {
    return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
  }

  return chunks;
}
