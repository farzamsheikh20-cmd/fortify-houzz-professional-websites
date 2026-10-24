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

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36' });
const page = await context.newPage();
page.setDefaultTimeout(Math.min(input.pageTimeoutSecs * 1000, 30000));

async function navigate(url, targetPage = page) {
  await targetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: input.pageTimeoutSecs * 1000 });
  await targetPage.waitForTimeout(input.delayMillis);
  const title = await targetPage.title().catch(() => '');
  const text = clean(await targetPage.locator('body').innerText().catch(() => ''));
  if (/captcha|verify you are human|access denied|unusual traffic/i.test(`${title} ${text.slice(0, 1000)}`)) throw new Error('Houzz verification or access challenge detected. Stop the run and retry later.');
}

async function discoverListings() {
  let pages = 0;
  while (progress.listingQueue.length && pages < input.maximumListingPagesThisRun) {
    const item = progress.listingQueue.shift();
    if (!item?.url || seenListingUrls.has(item.url)) continue;
    try {
      await navigate(item.url);
      const links = await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ href: a.href, text: (a.innerText || '').trim(), rel: a.rel || '' })));
      let added = 0;
      for (const link of links) {
        const url = normalizeUrl(link.href);
        if (!url || !isHouzzProfile(url)) continue;
        const key = profileKey(url);
        if (!key || discoveredProfiles.has(key)) continue;
        discoveredProfiles.add(key);
        pending.push({ url, sourceUrl: item.sourceUrl });
        added++;
      }
      const next = links.find(link => /next page|next/i.test(link.text) || /next/i.test(link.rel));
      const nextUrl = normalizeUrl(next?.href);
      if (nextUrl && !seenListingUrls.has(nextUrl) && !progress.listingQueue.some(queued => queued.url === nextUrl)) progress.listingQueue.push({ url: nextUrl, sourceUrl: item.sourceUrl });
      seenListingUrls.add(item.url);
      pages++;
      await save();
      log.info('Houzz listing page discovered', { listingUrl: item.url, profilesAdded: added, pendingProfiles: pending.length, remainingListingPages: progress.listingQueue.length });
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
