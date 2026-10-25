const BLOCKED_HOSTS = ['houzz.com','feedburner.com','facebook.com','instagram.com','linkedin.com','pinterest.com','twitter.com','x.com','youtube.com','tiktok.com','google.com','apple.com'];

export const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function safeCampaignId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'houzz-professional-websites';
}

export function normalizeUrl(value) {
  try {
    let candidate = clean(value);
    const markdown = candidate.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
    if (markdown) candidate = markdown[2];
    candidate = candidate.replace(/\\~/g, '~');
    const url = new URL(candidate);
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function profileKey(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/-pf(?:vw\w*)?-pf~([^/?]+)/i) || url.pathname.match(/\/professionals\/[^/]+\/([^/]+)$/i);
    return match ? match[1].toLowerCase() : url.pathname.toLowerCase().replace(/\/+$/, '');
  } catch { return null; }
}

export function isHouzzProfile(value) {
  try {
    const url = new URL(value);
    return /(^|\.)houzz\.com$/i.test(url.hostname) && /^\/professionals\//i.test(url.pathname) && /-pf/i.test(url.pathname);
  } catch { return false; }
}

export function domainKey(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function decodeCandidate(value) {
  let result = String(value || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  try { result = decodeURIComponent(result); } catch {}
  return result;
}

export function unwrapExternalUrl(value) {
  try {
    let url = new URL(decodeCandidate(value));
    if (/(^|\.)houzz\.com$/i.test(url.hostname)) {
      const trackingToken = url.pathname.match(/^\/trk\/([^/]+)/i)?.[1];
      if (trackingToken) {
        try {
          const padded = trackingToken.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(trackingToken.length / 4) * 4, '=');
          const decoded = Buffer.from(padded, 'base64').toString('utf8');
          if (/^https?:\/\//i.test(decoded)) return normalizeUrl(decoded);
        } catch {}
      }
      for (const key of ['url','u','target','redirect','redirect_url','to']) {
        const nested = url.searchParams.get(key);
        if (nested && /^https?:/i.test(decodeCandidate(nested))) return normalizeUrl(decodeCandidate(nested));
      }
      return null;
    }
    return normalizeUrl(url.href);
  } catch { return null; }
}

export function isExternalWebsite(value) {
  const unwrapped = unwrapExternalUrl(value);
  const domain = domainKey(unwrapped);
  return Boolean(domain && !BLOCKED_HOSTS.some(host => domain === host || domain.endsWith(`.${host}`)));
}

export function extractWebsite(html, links = []) {
  const decodedHtml = decodeCandidate(html);
  const websiteSectionHref = decodedHtml.match(/data-component=["']Website["'][\s\S]{0,2000}?href=["']([^"']+)["']/i)?.[1];
  const websiteSectionUrl = unwrapExternalUrl(websiteSectionHref);
  if (isExternalWebsite(websiteSectionUrl)) return websiteSectionUrl;
  const prioritized = links.filter(link => /website|visit site|web site/i.test(clean(link.text))).map(link => unwrapExternalUrl(link.href)).find(isExternalWebsite);
  if (prioritized) return prioritized;
  const patterns = [
    /"(?:websiteUrl|website_url|businessWebsite|externalUrl)"\s*:\s*"(https?:[^"\\]+(?:\\.[^"\\]*)*)"/gi,
    /(?:Website|Visit Website)[\s\S]{0,500}?(https?:\/\/[^"'<>\s]+)/gi
  ];
  for (const pattern of patterns) {
    for (const match of decodedHtml.matchAll(pattern)) {
      const candidate = unwrapExternalUrl(match[1]);
      if (isExternalWebsite(candidate)) return candidate;
    }
  }
  return null;
}

export function emailsFrom(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(email => email.toLowerCase()).filter(email =>
    !/example\.(com|org|net)$/.test(email)
    && !/@(?:houzz|sentry|wixpress)\./.test(email)
    && !/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot)$/i.test(email)
  ))];
}
