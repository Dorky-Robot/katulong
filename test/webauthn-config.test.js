/**
 * Tests for WebAuthn configuration
 * Verifies registration and authentication option generation,
 * including cross-device authentication (CDA) support via hybrid transport.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateRegistrationOpts } from '../lib/auth.js';

describe('WebAuthn configuration', () => {
  describe('generateRegistrationOpts — first device', () => {
    it('forces platform authenticator for first device', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost');

      assert.ok(opts.authenticatorSelection);
      assert.strictEqual(
        opts.authenticatorSelection.authenticatorAttachment,
        'platform',
        'First device must use platform authenticator (Touch ID, Windows Hello)'
      );
    });

    it('sets residentKey to preferred', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost');
      assert.strictEqual(opts.authenticatorSelection.residentKey, 'preferred');
    });

    it('sets userVerification to preferred', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost');
      assert.strictEqual(opts.authenticatorSelection.userVerification, 'preferred');
    });

    it('sets attestation to none (privacy)', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost');
      assert.strictEqual(opts.attestation, 'none');
    });

    it('generates a unique user ID', async () => {
      const { userID: id1 } = await generateRegistrationOpts('Katulong', 'localhost');
      const { userID: id2 } = await generateRegistrationOpts('Katulong', 'localhost');
      assert.notStrictEqual(id1, id2, 'User IDs should be unique');
    });

    it('includes RP name and ID', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'katulong.local');
      assert.strictEqual(opts.rp.name, 'Katulong');
      assert.strictEqual(opts.rp.id, 'katulong.local');
    });

    it('sets user as "owner" with Katulong display name', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost');
      assert.strictEqual(opts.user.name, 'owner');
      assert.strictEqual(opts.user.displayName, 'Katulong Owner');
    });
  });

  describe('generateRegistrationOpts — additional device (CDA)', () => {
    const existingUserID = 'test-user-id';

    it('omits authenticatorAttachment to allow hybrid/roaming authenticators', async () => {
      const { opts } = await generateRegistrationOpts('Katulong', 'localhost', existingUserID);

      assert.ok(opts.authenticatorSelection, 'authenticatorSelection should be present');
      assert.strictEqual(
        opts.authenticatorSelection.authenticatorAttachment,
        undefined,
        'Additional devices must NOT restrict authenticator type — allows hybrid (QR → phone) and roaming (security key)'
      );
    });

    it('uses the provided user ID', async () => {
      const { userID } = await generateRegistrationOpts('Katulong', 'localhost', existingUserID);
      assert.strictEqual(userID, existingUserID);
    });

    it('keeps residentKey and userVerification same as first device', async () => {
      const { opts: firstDevice } = await generateRegistrationOpts('Katulong', 'localhost');
      const { opts: additionalDevice } = await generateRegistrationOpts('Katulong', 'localhost', existingUserID);

      assert.strictEqual(
        additionalDevice.authenticatorSelection.residentKey,
        firstDevice.authenticatorSelection.residentKey,
        'residentKey should match between first and additional device'
      );
      assert.strictEqual(
        additionalDevice.authenticatorSelection.userVerification,
        firstDevice.authenticatorSelection.userVerification,
        'userVerification should match between first and additional device'
      );
    });

    it('differs from first device only in authenticatorAttachment', async () => {
      const { opts: firstDevice } = await generateRegistrationOpts('Katulong', 'localhost');
      const { opts: additionalDevice } = await generateRegistrationOpts('Katulong', 'localhost', existingUserID);

      assert.strictEqual(firstDevice.authenticatorSelection.authenticatorAttachment, 'platform');
      assert.strictEqual(additionalDevice.authenticatorSelection.authenticatorAttachment, undefined);
    });
  });

  describe('generateAuthOpts', () => {
    it('uses stored transports from credential with fallback to internal', async () => {
      const { generateAuthOpts } = await import('../lib/auth.js');

      const credentials = [
        { id: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: 'key1', counter: 0, transports: ['internal'] },
        { id: 'BBBBBBBBBBBBBBBBBBBBBB', publicKey: 'key2', counter: 0, transports: ['internal', 'hybrid'] },
        { id: 'CCCCCCCCCCCCCCCCCCCCCC', publicKey: 'key3', counter: 0 },
      ];

      const opts = await generateAuthOpts(credentials, 'localhost');

      assert.ok(opts.allowCredentials);
      assert.strictEqual(opts.allowCredentials.length, 3);

      // All credentials get "hybrid" appended for cross-device QR code auth.
      // Platform credential: stored transports + hybrid
      assert.deepStrictEqual(
        opts.allowCredentials[0].transports,
        ['internal', 'hybrid'],
        'Platform credential should include hybrid for cross-device QR code'
      );

      // Hybrid credential: already had hybrid, no duplicate
      assert.deepStrictEqual(
        opts.allowCredentials[1].transports,
        ['internal', 'hybrid'],
        'Hybrid credential should keep existing transports'
      );

      // Legacy credential without transports: internal + hybrid
      assert.deepStrictEqual(
        opts.allowCredentials[2].transports,
        ['internal', 'hybrid'],
        'Credentials without stored transports should get internal + hybrid'
      );
    });

    it('sets userVerification to preferred', async () => {
      const { generateAuthOpts } = await import('../lib/auth.js');
      const opts = await generateAuthOpts([], 'localhost');
      assert.strictEqual(opts.userVerification, 'preferred');
    });
  });

  describe('cross-device authentication rationale', () => {
    it('documents the CDA design decisions', () => {
      /**
       * Design Decision: Cross-Device Authentication (CDA) via WebAuthn hybrid transport
       *
       * Flow:
       * 1. First device registers with authenticatorAttachment: "platform" (localhost only)
       * 2. Additional devices register WITHOUT authenticatorAttachment constraint,
       *    allowing hybrid (phone QR → passkey) and roaming (security key) authenticators
       * 3. Registration captures credential.transports from the WebAuthn response
       * 4. Authentication sends stored transports back so the browser knows which
       *    transport methods to offer (e.g., QR code for hybrid, USB for roaming)
       *
       * Why this matters:
       * - Without hybrid transport, users can't authenticate from a new laptop
       *   by scanning a QR code with their phone (the standard WebAuthn CDA flow)
       * - Without capturing transports, the browser defaults to "internal" and
       *   never shows the cross-device QR code option
       * - The fallback to ["internal"] preserves backward compatibility with
       *   credentials registered before this change
       *
       * Security:
       * - First device still requires platform authenticator (biometric on localhost)
       * - Additional devices still require a valid setup token + WebAuthn registration
       * - The transport type doesn't weaken authentication — it only affects how
       *   the authenticator communicates with the browser
       */

      assert.ok(true, 'Cross-device authentication design is documented');
    });
  });
});
