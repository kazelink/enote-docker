import sanitizeHtml from 'sanitize-html';

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

export async function sanitizeContent(html) {
  if (typeof html !== 'string') return '';

  // Use sanitize-html to safely parse and clean HTML
  return sanitizeHtml(html, {
    // Allow essential text formatting tags
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video']),
    
    // Whitelist safe attributes
    allowedAttributes: {
      '*': ['class', 'style'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'loading', 'width', 'height'],
      'video': ['src', 'controls', 'preload', 'width', 'height'],
      'iframe': ['src', 'width', 'height', 'frameborder', 'allow'],
      'source': ['src', 'type']
    },
    
    // Strict allowed schemes
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    
    // Enable URL filtering for media sources
    allowedSchemesAppliedToImg: ['http', 'https', 'data'],
    
    // Custom filter for img/video tags - validate media sources
    exclusiveFilter: (frame) => {
      if ((frame.tag === 'img' || frame.tag === 'video' || frame.tag === 'source') && frame.attribs?.src) {
        return !isSafeMediaSrc(frame.attribs.src);
      }
      return false;
    },
    
    // Disable data: URLs except for base64 images
    transformTags: {
      'img': (tagName, attribs) => {
        if (attribs.src && !isSafeMediaSrc(attribs.src)) {
          return { tagName: 'img', attribs: { alt: 'Blocked content' } };
        }
        return { tagName, attribs };
      },
      'video': (tagName, attribs) => {
        if (attribs.src && !isSafeMediaSrc(attribs.src)) {
          return { tagName: 'video', attribs: { controls: 'controls' } };
        }
        return { tagName, attribs };
      }
    },
    
    // Strict disallowedTagsMode
    disallowedTagsMode: 'discard'
  });
}
