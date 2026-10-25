import test from 'node:test';
import assert from 'node:assert/strict';
import { domainKey, emailsFrom, extractWebsite, isHouzzProfile, profileKey, unwrapExternalUrl } from '../src/helpers.js';

test('identifies and keys Houzz professional profiles', () => {
  const url = 'https://www.houzz.com/professionals/general-contractors/example-builders-pfvwus-pf~1234567890';
  assert.equal(isHouzzProfile(url), true);
  assert.equal(profileKey(url), '1234567890');
});

test('unwraps an encoded Houzz external redirect', () => {
  const url = 'https://www.houzz.com/r/external?url=https%3A%2F%2Fwww.examplebuilders.com%2F';
  assert.equal(unwrapExternalUrl(url), 'https://www.examplebuilders.com/');
});

test('prioritizes a real website and blocks Houzz', () => {
  const website = extractWebsite('', [
    { text: 'Profile', href: 'https://www.houzz.com/pro/example' },
    { text: 'Website', href: 'https://examplebuilders.com/' }
  ]);
  assert.equal(domainKey(website), 'examplebuilders.com');
});

test('extracts unique public emails', () => {
  assert.deepEqual(emailsFrom('Info@Test.com and info@test.com, user@example.com'), ['info@test.com']);
});

test('decodes the real company website from a Houzz tracking link', () => {
  const html = '<div data-component="Website"><h3>Website</h3><a href="https://www.houzz.com/trk/aHR0cHM6Ly9wbGF0aW51bS1ob21lYnVpbGRlcnMuY29t/abc">platinum-homebuilders.com</a></div>';
  assert.equal(extractWebsite(html, []), 'https://platinum-homebuilders.com/');
});

test('rejects image filenames that resemble email addresses', () => {
  assert.deepEqual(emailsFrom('cover_placeholder_large@2x.png real.person@examplebuilder.com'), ['real.person@examplebuilder.com']);
});
