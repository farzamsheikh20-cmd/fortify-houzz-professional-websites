import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { clean, domainKey, emailsFrom, extractWebsite, isHouzzProfile, normalizeUrl, profileKey, safeCampaignId } from './helpers.js';

await Actor.init();

const defaults = {
  startUrls: ['https://www.houzz.com/professionals/general-contractor/california-us-probr0-bo~t_11786~r_5332921'],
  maximumNewCompanies: 100,
  maximumProfilesVisited: 200,
  maximumListingPagesThisRun: 10,
  requireWebsite: true,
  collectEmails: true,
  visitCompanyWebsitesForEmails: false,
  useResidentialProxy: true,
  proxyCountryCode: 'US',
  campaignName: 'houzz-professional-websites',
  resetProgress: false,
  pageTimeoutSecs: 60,
  delayMillis: 1200
};
const input = { ...defaults, ...(await Actor.getInput()) };
input.startUrls = [...new Set((input.startUrls || []).map(normalizeUrl).filter(Boolean))];
const campaignId = safeCampaignId(input.campaignName);
const kv = await Actor.openKeyValueStore(`campaign-${campaignId}`);
let progress = input.resetProgress ? null : await kv.getValue('PROGRESS');
if (!progress || !Array.isArray(progress.pendingProfileUrls)) {
  progress = {
    pendingProfileUrls: [],
    listingQueue: input.startUrls.map(url => ({ url, sourceUrl: url })),
    seenListingUrls: [],
    discoveredProfiles: [],
    seenProfileKeys: [],
    seenDomains: [],
    totalOutput: 0,
    masterDatasetName: `master-${campaignId}`
  };
}
for (const url of input.startUrls) {
  if (!progress.seenListingUrls.includes(url) && !progress.listingQueue.some(item => item.url === url)) progress.listingQueue.push({ url, sourceUrl: url });
}
const pending = progress.pendingProfileUrls;
const seenListingUrls = new Set(progress.seenListingUrls);
const discoveredProfiles = new Set(progress.discoveredProfiles);
const seenProfileKeys = new Set(progress.seenProfileKeys);
const seenDomains = new Set(progress.seenDomains);
const master = await Actor.openDataset(progress.masterDatasetName);
const runDataset = await Actor.openDataset();

async function save() {
  progress.pendingProfileUrls = pending;
  progress.seenListingUrls = [...seenListingUrls];
  progress.discoveredProfiles = [...discoveredProfiles];
  progress.seenProfileKeys = [...seenProfileKeys];
  progress.seenDomains = [...seenDomains];
  await kv.setValue('PROGRESS', progress);
}
if (input.resetProgress) await save();

let browserProxy;
if (input.useResidentialProxy) {
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: input.proxyCountryCode || 'US'
  });
  if (!proxyConfiguration) throw new Error('Residential proxy could not be created. Enable Apify Proxy access for this Actor or set useResidentialProxy to false.');
  const proxyUrl = await proxyConfiguration.newUrl(`houzz${Date.now()}`);
  const parsedProxy = new URL(proxyUrl);
  browserProxy = {
    server: `${parsedProxy.protocol}//${parsedProxy.hostname}:${parsedProxy.port}`,
    username: decodeURIComponent(parsedProxy.username),
    password: decodeURIComponent(parsedProxy.password)
  };
  log.info('US residential proxy enabled');
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || process.env.APIFY_DEFAULT_BROWSER_PATH || '/usr/bin/google-chrome',
  args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
  ...(browserProxy ? { proxy: browserProxy } : {})
});
const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36' });
const page = await context.newPage();
page.setDefaultTimeout(Math.min(input.pageTimeoutSecs * 1000, 30000));

async function navigate(url, targetPage = page) {
  const response = await targetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: input.pageTimeoutSecs * 1000 });
  await targetPage.waitForTimeout(input.delayMillis);
  const title = await targetPage.title().catch(() => '');
  const text = clean(await targetPage.locator('body').innerText().catch(() => ''));
  if (/captcha|verify you are human|access denied|unusual traffic/i.test(`${title} ${text.slice(0, 1000)}`)) throw new Error('Houzz verification or access challenge detected. Stop the run and retry later.');
  return { status: response?.status() || null, title, bodyLength: text.length, finalUrl: targetPage.url() };
}

function profileUrlsFromHtml(html) {
  const decoded = String(html || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  const absolute = [...decoded.matchAll(/https?:\/\/(?:www\.)?houzz\.com\/professionals\/[^"'<>\\s]+?-pf[^"'<>\\s]+/gi)].map(match => match[0]);
  const relative = [...decoded.matchAll(/(?:href=|"url"\s*:\s*)["']?(\/professionals\/[^"'<>\\s]+?-pf[^"'<>\\s]+)/gi)].map(match => `https://www.houzz.com${match[1]}`);
  return [...new Set([...absolute, ...relative])];
}

async function fetchListingHtml(url) {
  const response = await context.request.get(url, {
    failOnStatusCode: false,
    timeout: input.pageTimeoutSecs * 1000,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache'
    }
  });
  const html = await response.text();
  return { html, status: response.status(), finalUrl: response.url() };
}

async function discoverListings() {
  let pages = 0;
  while (progress.listingQueue.length && pages < input.maximumListingPagesThisRun) {
    const item = progress.listingQueue.shift();
    if (!item?.url || seenListingUrls.has(item.url)) continue;
    if (isHouzzProfile(item.url)) {
      const key = profileKey(item.url);
      if (key && !discoveredProfiles.has(key) && !seenProfileKeys.has(key)) {
        discoveredProfiles.add(key);
        pending.push({ url: item.url, sourceUrl: item.sourceUrl });
      }
      const recoveryUrl = normalizeUrl(item.sourceUrl);
      if (recoveryUrl && !isHouzzProfile(recoveryUrl) && !progress.listingQueue.some(queued => queued.url === recoveryUrl)) {
        seenListingUrls.delete(recoveryUrl);
        progress.listingQueue.unshift({ url: recoveryUrl, sourceUrl: recoveryUrl });
      }
      seenListingUrls.add(item.url);
      await save();
      log.warning('Removed a profile URL from the listing queue', { url: item.url });
      continue;
    }
    try {
      const navigation = await navigate(item.url);
      const links = await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ href: a.href, text: (a.innerText || '').trim(), rel: a.rel || '' })));
      const html = await page.content();
      let htmlProfileUrls = profileUrlsFromHtml(html);
      let fallbackStatus = null;
      let fallbackLength = 0;
      if (!links.length && !htmlProfileUrls.length) {
        const fallback = await fetchListingHtml(item.url);
        fallbackStatus = fallback.status;
        fallbackLength = fallback.html.length;
        htmlProfileUrls = profileUrlsFromHtml(fallback.html);
      }
      const profileCandidates = [...links.map(link => link.href), ...htmlProfileUrls];
      let added = 0;
      for (const candidate of profileCandidates) {
        const url = normalizeUrl(candidate);
        if (!url || !isHouzzProfile(url)) continue;
        const key = profileKey(url);
        if (!key || discoveredProfiles.has(key)) continue;
        discoveredProfiles.add(key);
        pending.push({ url, sourceUrl: item.sourceUrl });
        added++;
      }
      const currentListing = new URL(item.url);
      const next = links.find(link => {
        if (!/next page|next/i.test(link.text) && !/next/i.test(link.rel)) return false;
        const candidate = normalizeUrl(link.href);
        if (!candidate || isHouzzProfile(candidate)) return false;
        try { return new URL(candidate).pathname === currentListing.pathname; }
        catch { return false; }
      });
      let nextUrl = normalizeUrl(next?.href);
      if (!nextUrl && !isHouzzProfile(item.url) && profileCandidates.some(isHouzzProfile)) {
        const current = new URL(item.url);
        const currentOffset = Number.parseInt(current.searchParams.get('fi') || '0', 10);
        current.searchParams.set('fi', String(currentOffset + 15));
        nextUrl = current.href;
      }
      if (nextUrl && !seenListingUrls.has(nextUrl) && !progress.listingQueue.some(queued => queued.url === nextUrl)) progress.listingQueue.push({ url: nextUrl, sourceUrl: item.sourceUrl });
      seenListingUrls.add(item.url);
      pages++;
      await save();
      log.info('Houzz listing page discovered', {
        listingUrl: item.url,
        browserStatus: navigation.status,
        browserTitle: navigation.title,
        browserBodyLength: navigation.bodyLength,
        browserFinalUrl: navigation.finalUrl,
        fallbackStatus,
        fallbackLength,
        anchorsFound: links.length,
        htmlProfileCandidates: htmlProfileUrls.length,
        profilesAdded: added,
        pendingProfiles: pending.length,
        remainingListingPages: progress.listingQueue.length
      });
    } catch (error) {
      progress.listingQueue.unshift(item);
      await save();
      log.error('Houzz listing discovery stopped safely', { url: item.url, message: error.message });
      break;
    }
  }
}

async function extractProfile(item) {
  await navigate(item.url);
  const html = await page.content();
  const bodyText = clean(await page.locator('body').innerText());
  const links = await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ href: a.href, text: (a.innerText || '').trim() })));
  const companyName = clean(await page.locator('h1').first().textContent().catch(() => '')) || clean((await page.title()).split('-')[0]);
  const website = extractWebsite(html, links);
  const phone = bodyText.match(/(?:Phone Number\s*)?(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/i)?.[1] || null;
  const address = bodyText.match(/(?:Address\s*)?([^|]{2,100},\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i)?.[1] || null;
  const categoryText = bodyText.match(/Category\s+(.{2,250}?)(?:Read More|Back to Navigation|Business Details)/i)?.[1] || '';
  const categories = [...new Set(categoryText.split(',').map(clean).filter(Boolean))].slice(0, 25);
  let emails = input.collectEmails ? emailsFrom(`${bodyText} ${html}`) : [];
  if (website && input.collectEmails && input.visitCompanyWebsitesForEmails) {
    const companyPage = await context.newPage();
    try {
      await navigate(website, companyPage);
      emails = [...new Set([...emails, ...emailsFrom(`${await companyPage.locator('body').innerText().catch(() => '')} ${await companyPage.content().catch(() => '')}`)])];
    } catch (error) {
      log.warning('Company website email visit failed; keeping Houzz data', { website, message: error.message });
    } finally { await companyPage.close(); }
  }
  return {
    companyName,
    website,
    websiteDomain: domainKey(website),
    email: emails[0] || null,
    allPublicEmails: emails,
    phone,
    address,
    categories,
    houzzProfileUrl: item.url,
    sourceDirectoryUrl: item.sourceUrl || null,
    collectedAt: new Date().toISOString()
  };
}

let output = 0;
let visited = 0;
try {
  if (!pending.length) await discoverListings();
  while (output < input.maximumNewCompanies && visited < input.maximumProfilesVisited) {
    if (!pending.length) {
      if (!progress.listingQueue.length) break;
      await discoverListings();
      if (!pending.length) break;
    }
    const item = pending.shift();
    const key = profileKey(item?.url);
    if (!key || seenProfileKeys.has(key)) { await save(); continue; }
    visited++;
    let row;
    try { row = await extractProfile(item); }
    catch (error) {
      pending.push(item);
      await save();
      log.warning('Houzz profile failed and remains queued', { url: item.url, message: error.message });
      continue;
    }
    seenProfileKeys.add(key);
    const domain = row.websiteDomain;
    if ((!domain && input.requireWebsite) || (domain && seenDomains.has(domain))) { await save(); continue; }
    if (domain) seenDomains.add(domain);
    await runDataset.pushData(row);
    await master.pushData(row);
    output++;
    progress.totalOutput++;
    await save();
    if (output % 10 === 0) log.info('Houzz companies collected', { companiesOutputThisRun: output, profilesVisited: visited, pendingProfiles: pending.length, totalOutput: progress.totalOutput });
  }
} finally {
  await save();
  await browser.close();
}

log.info('Houzz campaign run completed', {
  campaignId,
  profilesVisited: visited,
  companiesOutputThisRun: output,
  pendingProfiles: pending.length,
  remainingListingPages: progress.listingQueue.length,
  totalOutput: progress.totalOutput,
  masterDatasetId: master.id
});
await Actor.exit();
