import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '..', 'public', 'trust.html'), 'utf-8');

describe('trust page', () => {
  it('has "Trust Certificate" heading', () => {
    assert.ok(html.includes('<h1>Trust Certificate</h1>'));
  });

  it('has a download button linking to ca.crt', () => {
    assert.ok(html.includes('class="download-btn"'));
    assert.ok(html.includes('href="/connect/trust/ca.crt"'));
    assert.ok(html.includes('Download Certificate'));
  });

  it('has iOS profile link to ca.mobileconfig', () => {
    assert.ok(html.includes('href="/connect/trust/ca.mobileconfig"'));
  });

  it('has Android install steps', () => {
    assert.ok(html.includes('Install a certificate'));
  });

  it('has macOS install steps with Always Trust', () => {
    assert.ok(html.includes('Always Trust'));
  });

  it('has collapsible uninstall instructions', () => {
    assert.ok(html.includes('<summary>Uninstall instructions</summary>'));
    assert.ok(html.includes('Remove Profile'));
  });
});
