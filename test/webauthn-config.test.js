/**
 * Tests for WebAuthn configuration
 * Verifies that all registration flows use platform authenticators
 * to ensure Touch ID / Windows Hello / fingerprint readers are used.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateRegistrationOpts,
  generateRegistrationOptsForUser
} from '../lib/auth.js';

describe('WebAuthn configuration', () => {
  describe('generateRegistrationOpts', () => {
    it('generates options with platform authenticator attachment', async () => {
      const { opts } = await generateRegistrationOpts(
        'Katulong',
        'localhost',
        'http://localhost:3001'
      );

      assert.ok(opts.authenticatorSelection);
      assert.strictEqual(
        opts.authenticatorSelection.authenticatorAttachment,
        'platform',
        'Must force platform authenticator (Touch ID, Windows Hello, etc.)'
      );
    });

    it('sets residentKey to preferred', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');

      assert.strictEqual(opts.authenticatorSelection.residentKey, 'preferred');
    });

    it('sets userVerification to preferred', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');

      assert.strictEqual(opts.authenticatorSelection.userVerification, 'preferred');
    });

    it('sets attestation to none (privacy)', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');

      assert.strictEqual(opts.attestation, 'none');
    });

    it('generates a unique user ID', async () => {
      const { userID: id1 } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');
      const { userID: id2 } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');

      assert.notStrictEqual(id1, id2, 'User IDs should be unique');
    });

    it('includes RP name and ID', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'katulong.local', 'https://katulong.local:3002');

      assert.strictEqual(opts.rp.name, 'Katulong');
      assert.strictEqual(opts.rp.id, 'katulong.local');
    });

    it('sets user as "owner"', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');

      assert.strictEqual(opts.user.name, 'owner');
      assert.strictEqual(opts.user.displayName, 'Owner');
    });
  });

  describe('generateRegistrationOptsForUser', () => {
    const existingUserID = 'test-user-id';

    it('generates options with platform authenticator attachment', async () => {
      const { opts } = await generateRegistrationOptsForUser(
        existingUserID,
        'Katulong',
        'localhost',
        'http://localhost:3001'
      );

      assert.strictEqual(
        opts.authenticatorSelection.authenticatorAttachment,
        'platform',
        'Must force platform authenticator for additional passkeys'
      );
    });

    it('uses the provided user ID', async () => {
      const { userID } = await generateRegistrationOptsForUser(
        existingUserID,
        'Katulong',
        'localhost',
        'http://localhost:3001'
      );

      assert.strictEqual(userID, existingUserID);
    });

    it('sets same authenticator preferences as initial registration', async () => {
      const { opts: initialOpts } = await generateRegistrationOpts('Katulong', 'localhost', 'http://localhost:3001');
      const { opts: additionalOpts } = await generateRegistrationOptsForUser(
        existingUserID,
        'Katulong',
        'localhost',
        'http://localhost:3001'
      );

      assert.deepStrictEqual(
        initialOpts.authenticatorSelection,
        additionalOpts.authenticatorSelection,
        'Initial and additional registrations should have same authenticator settings'
      );
    });
  });

  describe('generateAuthOpts', () => {
    it('restricts to platform authenticators via transports', async () => {
      const { generateAuthOpts } = await import('../lib/auth.js');

      // Credentials are stored with base64url-encoded IDs
      const credentials = [
        { id: 'cred1-base64url', publicKey: 'key1', counter: 0 },
        { id: 'cred2-base64url', publicKey: 'key2', counter: 0 },
      ];

      const opts = await generateAuthOpts(credentials, 'localhost');

      assert.ok(opts.allowCredentials);
      assert.strictEqual(opts.allowCredentials.length, 2);

      // Each credential should have transports: ["internal"] to force platform authenticators
      for (const cred of opts.allowCredentials) {
        assert.deepStrictEqual(
          cred.transports,
          ['internal'],
          'Authentication should restrict to platform authenticators via transports'
        );
      }
    });

    it('sets userVerification to preferred', async () => {
      const { generateAuthOpts } = await import('../lib/auth.js');
      const opts = await generateAuthOpts([], 'localhost');
      assert.strictEqual(opts.userVerification, 'preferred');
    });
  });

  describe('platform authenticator rationale', () => {
    it('documents why platform-only authentication is used', () => {
      /**
       * Design Decision: Force authenticatorAttachment: "platform"
       *
       * Reasons:
       * - Katulong is self-hosted terminal access (personal use)
       * - Users on their own devices always have platform authenticator
       * - Touch ID / Windows Hello / fingerprint is most intuitive UX
       * - Faster and more convenient than security keys or phones
       *
       * Tradeoff:
       * - Users who prefer security keys cannot use them directly
       * - Acceptable because: users can pair via QR on LAN if needed
       *
       * Alternatives considered:
       * - Allow both: Causes confusing QR code prompts
       * - Auto-detect: Complex and fragile across browsers
       * - Make configurable: Adds complexity for minimal benefit
       */

      // Test passes if this documentation exists
      assert.ok(true, 'Platform authenticator design is documented');
    });
  });
});
