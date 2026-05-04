const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function isSafeMediaSrc(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;

  const compact = trimmed.replace(/\s+/g, '');
  const lower = compact.toLowerCase();

  if (lower.startsWith('/img/backups/') || lower.startsWith('/video/backups/')) return false;
  if (lower.startsWith('/img/') || lower.startsWith('/video/')) return true;
  if (lower.startsWith('https://') || lower.startsWith('http://')) return true;
  return SAFE_DATA_IMAGE_RE.test(compact);
}

function sanitizeHtml(html) {
  let s = html;
  const badTags = '(script|iframe|object|embed|form|base|link|meta|style|svg|math|noscript|template)';
  s = s.replace(new RegExp(`<\\s*${badTags}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gim'), '');
  s = s.replace(new RegExp(`<\\s*${badTags}\\b[^>]*>`, 'gim'), '');
  s = s.replace(new RegExp(`<\\s*\\/\\s*${badTags}\\s*>`, 'gim'), '');
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi, '');
  s = s.replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
  s = s.replace(/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
  s = s.replace(/data\s*:\s*text\/html/gi, '');

  s = s.replace(/<(img|video)\s+([^>]*?)src=["']?([^"'\s>]+)["']?([^>]*?)>/gi, (match, tag, _pre, src) => {
    if (!isSafeMediaSrc(src)) return '';
    return tag.toLowerCase() === 'video' ? `<video src="${src}" controls preload="none">` : match;
  });

  return s.replace(/\s+(srcdoc|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

export async function sanitizeContent(html) {
  if (typeof html !== 'string') return '';
  return sanitizeHtml(html);
}
