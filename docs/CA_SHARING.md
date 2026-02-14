# CA Certificate Sharing

Share a Certificate Authority across multiple Katulong instances so devices only need to trust one CA certificate.

## The Problem

When running multiple Katulong instances (work laptop, home server, Raspberry Pi, etc.), each generates its own CA certificate. This means:

- Your phone/browser must trust **3 different CAs**
- Managing certificates becomes tedious
- Each instance appears as a different "server" to devices

## The Solution

Share one CA across all instances on your network. Devices trust **one CA**, access **all instances**.

## Usage

### 1. Export CA from First Instance

On your primary Katulong instance:

```bash
katulong ca export > ca-bundle.txt
```

This creates a base64-encoded bundle containing:
- CA certificate
- CA private key
- Fingerprint for verification

### 2. Transfer to Other Instances

Copy the bundle to other machines:

```bash
# Via scp
scp ca-bundle.txt user@server:/tmp/

# Or copy/paste if you have terminal access
```

### 3. Import on Other Instances

On each additional instance:

```bash
katulong ca import < /tmp/ca-bundle.txt
```

The import process:
1. ✓ Validates the bundle structure
2. ✓ Verifies certificate is a valid CA
3. ✓ Checks private key matches certificate
4. ✓ Shows fingerprint for verification
5. ✓ Backs up existing CA (if present)
6. ✓ Installs new CA
7. ✓ Prompts to restart Katulong

### 4. Restart Katulong

```bash
katulong restart
```

Network certificates will be automatically regenerated using the shared CA.

## Verification

Check that all instances use the same CA:

```bash
katulong ca info
```

Compare the **Fingerprint** across all instances - they should match.

Example:
```
Certificate Authority

CA Certificate:
  Location: /Users/felix/katulong-data/tls/ca.crt
  Subject: Katulong Local CA
  Valid from: 2026-02-13T15:29:51.000Z
  Valid until: 2036-02-13T15:29:51.000Z
  Days remaining: 3651

  Fingerprint: SHA256:bb:30:19:6e:23:96:4e:af:c1:69:c6:38:14:df:9a:a6...

CA Private Key:
  Location: /Users/felix/katulong-data/tls/ca.key
  ⚠️  Keep this file secure - it can sign certificates
```

## Security Considerations

### CA Private Key

The CA private key is **extremely sensitive**:
- Anyone with it can sign certificates for any domain
- Should never be shared over untrusted networks
- Transfer only between your own machines
- Store securely (default: `DATA_DIR/tls/ca.key` with mode 0600)

### Transfer Methods

**Safe:**
- SCP/RSYNC over SSH
- Physical USB drive
- Secure file sharing within your network
- Copy/paste in secure terminal session

**Unsafe:**
- Unencrypted email
- Public file sharing services
- Unencrypted messaging apps

### Backup

Before importing a new CA, the old CA is automatically backed up:
```
ca.crt.backup-2026-02-14T...
ca.key.backup-2026-02-14T...
```

If something goes wrong, restore the backup and restart Katulong.

## Example Workflow

**Network Setup:**
- Work Laptop: 192.168.1.100
- Home Server: 192.168.1.200
- Raspberry Pi: 192.168.1.150

**Steps:**

```bash
# On Work Laptop (primary)
$ katulong ca export > /tmp/ca-bundle.txt
$ scp /tmp/ca-bundle.txt server:/tmp/
$ scp /tmp/ca-bundle.txt pi:/tmp/

# On Home Server
$ katulong ca import < /tmp/ca-bundle.txt
# Verify fingerprint matches
$ katulong restart

# On Raspberry Pi
$ katulong ca import < /tmp/ca-bundle.txt
# Verify fingerprint matches
$ katulong restart
```

**Result:**

Your phone/browser now:
- Trusts **one CA** (downloaded from any instance)
- Connects to **all 3 instances** without certificate warnings
- Sees each instance with its own name (via instance naming feature)

## Commands Reference

### `katulong ca info`

Show CA certificate details and fingerprint.

### `katulong ca export`

Export CA bundle to stdout (base64-encoded).

```bash
katulong ca export                    # Print to terminal
katulong ca export > ca-bundle.txt    # Save to file
```

### `katulong ca import`

Import CA bundle from stdin.

```bash
katulong ca import < ca-bundle.txt    # From file
katulong ca import --yes < bundle.txt # Skip confirmation
```

## Troubleshooting

### "CA fingerprints match - no action needed"

You're trying to import the same CA that's already installed. No changes needed.

### "Invalid CA bundle"

The bundle file is corrupted or invalid. Re-export from the source instance.

### "Private key does not match certificate"

The CA bundle is corrupted. The certificate and private key don't match.

### Devices still show certificate warnings

After importing a new CA:
1. Devices need to **re-trust the CA certificate**
2. Download from: `https://your-server:3100/connect/trust`
3. Old CA trust won't work with new CA

## Related

- [Certificate Management](../README.md#certificates)
- [Multi-Network Support](../README.md#network-mobility)
- [Instance Naming](./INSTANCE_NAMING.md) (coming soon)
