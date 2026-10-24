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
