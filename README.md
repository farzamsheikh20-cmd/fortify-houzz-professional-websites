# Fortify Houzz Professional Websites

GitHub-ready Apify Actor for public Houzz professional directories. Add Houzz contractor, architect, designer, builder, landscaper, remodeling, or trade-directory URLs. The Actor follows result-page pagination, opens public professional profiles, extracts external company websites and public contact details, and saves its queues for continuation runs.

## What it protects

- Persistent listing-page and profile queues
- Duplicate prevention by Houzz profile and normalized external website domain
- Progress saved after every listing page and every processed profile
- Product pages and Houzz-owned/social links excluded from website results
- Existing campaigns can accept additional directory URLs later

## First test input

```json
{
  "startUrls": [
    "https://www.houzz.com/professionals/general-contractor/california-us-probr0-bo~t_11786~r_5332921"
  ],
  "maximumNewCompanies": 20,
  "maximumProfilesVisited": 40,
  "maximumListingPagesThisRun": 2,
  "requireWebsite": true,
  "collectEmails": true,
  "visitCompanyWebsitesForEmails": false,
  "useResidentialProxy": true,
  "proxyCountryCode": "US",
  "campaignName": "houzz-california-test",
  "resetProgress": true,
  "pageTimeoutSecs": 60,
  "delayMillis": 1200
}
```

Use 2 GB memory, a 1,800-second timeout, and a $1 maximum cost for the first test. After the first run, keep the same campaign name and change `resetProgress` to `false`. Add more Houzz directory URLs to `startUrls` at any time; new URLs are appended to the saved campaign queue.

This Actor accesses public pages only. It does not sign in, submit contact forms, bypass access controls, or defeat verification challenges. If Houzz displays a challenge, the run stops safely and retains its saved work.
