import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { createHash } from "node:crypto";
import forge from "node-forge";
import { log } from "./log.js";

const MAX_NETWORKS = 10;
const SERVER_YEARS = 2;

/**
 * CertificateManager handles multi-certificate SNI architecture for network mobility
 * - Auto-generates certificates for new networks
 * - Zero-downtime certificate updates via hot-reload
 * - Network-specific certificate management
 */
export class CertificateManager {
  constructor(dataDir, instanceNameOrConfig) {
    this.dataDir = dataDir;

    // Support both string (legacy) and ConfigManager (dynamic)
    if (typeof instanceNameOrConfig === 'string') {
      this.instanceName = instanceNameOrConfig;
      this.configManager = null;
    } else {
      this.configManager = instanceNameOrConfig;
      this.instanceName = instanceNameOrConfig.getInstanceName();
    }

    this.tlsDir = join(dataDir, "tls");
    this.networksDir = join(this.tlsDir, "networks");
    this.certCache = new Map(); // networkId -> SecureContext
    this.metadataCache = new Map(); // networkId -> metadata
  }

  /**
   * Get current instance name (dynamic if using ConfigManager)
   */
  getCurrentInstanceName() {
    return this.configManager ? this.configManager.getInstanceName() : this.instanceName;
  }

  /**
   * Get current instance ID (dynamic if using ConfigManager)
   */
  getCurrentInstanceId() {
    // If using ConfigManager, get the ID from there
    // Otherwise, we don't have an ID (legacy behavior for tests)
    return this.configManager ? this.configManager.getInstanceId() : null;
  }

  /**
   * Initialize certificate manager - migrate old certs and load all network certs
   */
  async initialize() {
    // Ensure directories exist
    mkdirSync(this.networksDir, { recursive: true });

    // Migrate old single cert to network based on hostname FIRST
    await this.migrateOldCert();

    // Migrate old "default" network to proper network ID
    await this.migrateDefaultNetwork();

    // Clean up any orphaned old server.crt/key files that might still exist
    // (from previous migrations that didn't delete them)
    await this.cleanupOrphanedServerCerts();

    // Load all network certificates
    await this.loadAllNetworks();

    // Validate that all network certs are signed by the current CA
    // (catches upgrades where CA was regenerated but network certs weren't re-signed)
    await this.validateNetworkCerts();

    log.info("Certificate manager initialized", {
      networks: this.metadataCache.size,
    });
  }

  /**
   * Clean up orphaned old server.crt/key files
   * These might exist from previous migrations that didn't delete them
   */
  async cleanupOrphanedServerCerts() {
    const oldCertPath = join(this.tlsDir, "server.crt");
    const oldKeyPath = join(this.tlsDir, "server.key");

    // Only clean up if network certs exist (migration already happened)
    // Check filesystem directly since metadata cache might not be loaded yet
    if (!existsSync(this.networksDir)) {
      return; // No networks directory yet
    }

    const networkDirs = readdirSync(this.networksDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    if (networkDirs.length === 0) {
      return; // No network certs yet, don't delete old files
    }

    // Delete old files if they exist
    let deleted = false;
    try {
      if (existsSync(oldCertPath)) {
        rmSync(oldCertPath);
        deleted = true;
      }
      if (existsSync(oldKeyPath)) {
        rmSync(oldKeyPath);
        deleted = true;
      }
      if (deleted) {
        log.info("Cleaned up orphaned old server.crt/key files (network certs now in use)");
      }
    } catch (error) {
      log.warn("Failed to clean up old certificate files", { error: error.message });
    }
  }

  /**
   * Migrate old single cert (tls/server.crt) to network based on hostname
   */
  async migrateOldCert() {
    const oldCertPath = join(this.tlsDir, "server.crt");
    const oldKeyPath = join(this.tlsDir, "server.key");

    // Check if old cert exists
    if (!existsSync(oldCertPath)) return;

    // Extract IPs from old cert to determine which network to migrate to
    try {
      const certPem = readFileSync(oldCertPath, "utf-8");
      const cert = forge.pki.certificateFromPem(certPem);

      // Extract IPs from SANs
      const sanExt = cert.getExtension("subjectAltName");
      const ips = [];
      if (sanExt && sanExt.altNames) {
        for (const altName of sanExt.altNames) {
          if (altName.type === 7) ips.push(altName.ip);
        }
      }

      // Filter out localhost IPs to get real network IPs
      const networkIps = ips.filter(ip => !ip.startsWith("127.") && ip !== "::1");

      // Use first network IP to determine network ID, or fallback to localhost
      const primaryIp = networkIps.length > 0 ? networkIps[0] : "127.0.0.1";
      const networkId = this.getNetworkIdForIp(primaryIp);
      const networkDir = join(this.networksDir, networkId);

      // Only migrate if this network doesn't already exist
      if (existsSync(networkDir)) {
        log.info("Network already exists, skipping migration", { networkId });
        return;
      }

      log.info("Migrating single certificate to network", { networkId, primaryIp });

      mkdirSync(networkDir, { recursive: true });

      // Copy cert and key to network
      const certContent = readFileSync(oldCertPath);
      const keyContent = readFileSync(oldKeyPath);

      writeFileSync(join(networkDir, "server.crt"), certContent);
      writeFileSync(join(networkDir, "server.key"), keyContent, { mode: 0o600 });

      // Generate metadata
      const instanceName = this.getCurrentInstanceName();
      const subnet = networkIps.length > 0
        ? networkIps[0].split('.').slice(0, 3).join('.')
        : '127.0.0';

      const metadata = {
        networkId,
        ips: networkIps.length > 0 ? [networkIps[0]] : ["127.0.0.1"],
        publicIp: null, // Will be fetched on next regenerate
        createdAt: cert.validity.notBefore.toISOString(),
        lastUsedAt: new Date().toISOString(),
        label: `Katulong ${instanceName} (${subnet}.*)`,
        autoGenerated: false,
      };

      this.writeMetadata(networkDir, metadata);
      log.info("Migration complete", { networkId, ips: metadata.ips });

      // Delete old files after successful migration
      // (keeping them causes the server to use them instead of network certs)
      try {
        rmSync(oldCertPath);
        rmSync(oldKeyPath);
        log.info("Deleted old server.crt and server.key after migration");
      } catch (err) {
        log.warn("Failed to delete old certificate files", { error: err.message });
      }
    } catch (error) {
      log.error("Failed to migrate old cert", { error: error.message });
    }
  }

  /**
   * Migrate old "default" network directory to proper network ID
   */
  async migrateDefaultNetwork() {
    const defaultDir = join(this.networksDir, "default");

    // Check if old "default" network exists
    if (!existsSync(defaultDir)) return;

    try {
      // Read metadata to get the IP
      const metadata = this.readMetadata(defaultDir);
      if (!metadata || !metadata.ips || metadata.ips.length === 0) {
        log.warn("Cannot migrate default network - no IP in metadata");
        return;
      }

      // Determine proper network ID from IP
      const primaryIp = metadata.ips[0];
      const networkId = this.getNetworkIdForIp(primaryIp);

      // If target network already exists, delete the default directory
      const targetDir = join(this.networksDir, networkId);
      if (existsSync(targetDir)) {
        log.info("Target network exists, removing duplicate default network", { networkId });
        rmSync(defaultDir, { recursive: true, force: true });
        return;
      }

      // Rename default directory to proper network ID
      log.info("Migrating default network to proper network ID", {
        from: "default",
        to: networkId,
        ip: primaryIp
      });

      renameSync(defaultDir, targetDir);

      // Update metadata with proper network ID and instance-name-based label
      const instanceName = this.getCurrentInstanceName();
      const subnet = primaryIp.split('.').slice(0, 3).join('.');
      metadata.networkId = networkId;
      metadata.label = `Katulong ${instanceName} (${subnet}.*)`;
      metadata.lastUsedAt = new Date().toISOString();

      this.writeMetadata(targetDir, metadata);

      log.info("Default network migration complete", { networkId });
    } catch (error) {
      log.error("Failed to migrate default network", { error: error.message });
    }

    // Keep old files for safety (don't delete them)
  }

  /**
   * Load all network certificates into cache
   */
  async loadAllNetworks() {
    if (!existsSync(this.networksDir)) return;

    const networks = readdirSync(this.networksDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const networkId of networks) {
      try {
        const networkDir = join(this.networksDir, networkId);
        const metadata = this.readMetadata(networkDir);

        if (metadata) {
          this.metadataCache.set(networkId, metadata);
          // Pre-load secure context
          this.loadSecureContext(networkId);
        }
      } catch (error) {
        log.warn(`Failed to load network ${networkId}`, { error: error.message });
      }
    }
  }

  /**
   * Validate that all network certificates are signed by the current CA.
   * If a mismatch is found (e.g. CA was regenerated but network certs weren't),
   * regenerate the network cert and hot-reload it.
   */
  async validateNetworkCerts() {
    const caCertPath = join(this.tlsDir, "ca.crt");
    if (!existsSync(caCertPath)) return;

    let caCert;
    try {
      const caCertPem = readFileSync(caCertPath, "utf-8");
      caCert = forge.pki.certificateFromPem(caCertPem);
    } catch (error) {
      log.warn("Failed to load CA cert for validation", { error: error.message });
      return;
    }

    // Get the CA's subject key to compare with each network cert's issuer
    const caSubjectHash = forge.pki.getPublicKeyFingerprint(caCert.publicKey, {
      encoding: "hex",
    });

    let regenerated = 0;

    for (const [networkId] of this.metadataCache.entries()) {
      const networkDir = join(this.networksDir, networkId);
      const certPath = join(networkDir, "server.crt");

      if (!existsSync(certPath)) continue;

      try {
        const certPem = readFileSync(certPath, "utf-8");
        const cert = forge.pki.certificateFromPem(certPem);

        // Verify the cert was signed by the current CA
        try {
          caCert.verify(cert);
        } catch {
          // Verification failed — cert was signed by a different CA
          log.info("Network cert not signed by current CA, regenerating", { networkId });
          await this.regenerateNetwork(networkId);
          await this.reloadCertificate(networkId);
          regenerated++;
        }
      } catch (error) {
        log.warn("Failed to validate network cert", { networkId, error: error.message });
      }
    }

    if (regenerated > 0) {
      log.info("Regenerated network certificates with current CA", { count: regenerated });
    }
  }

  /**
   * Get SNI callback for HTTPS server
   * @returns {Function} SNI callback (servername, callback) => void
   */
  getSNICallback() {
    return async (servername, callback) => {
      try {
        // Resolve servername to IP (it might be IP or hostname)
        const ip = this.resolveToIp(servername);
        const networkId = this.getNetworkIdForIp(ip);

        // Get or create certificate for this network
        let context = this.certCache.get(networkId);
        if (!context) {
          await this.ensureNetworkCert(ip);
          context = this.loadSecureContext(networkId);
        }

        // Update lastUsedAt
        await this.touchNetworkCert(networkId);

        callback(null, context);
      } catch (error) {
        log.error("SNI callback error", { servername, error: error.message });
        callback(error, null);
      }
    };
  }

  /**
   * Get secure context for a network
   * @param {string} networkId - Network ID
   * @returns {SecureContext} TLS secure context
   */
  getSecureContext(networkId) {
    let context = this.certCache.get(networkId);
    if (!context) {
      context = this.loadSecureContext(networkId);
    }
    return context;
  }

  /**
   * Load secure context from disk
   * @param {string} networkId - Network ID
   * @returns {SecureContext} TLS secure context
   */
  loadSecureContext(networkId) {
    const networkDir = join(this.networksDir, networkId);
    const certPath = join(networkDir, "server.crt");
    const keyPath = join(networkDir, "server.key");

    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new Error(`Certificate not found for network ${networkId}`);
    }

    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);

    const context = createSecureContext({ cert, key });
    this.certCache.set(networkId, context);

    return context;
  }

  /**
   * Get fallback cert/key for HTTPS server (used when no SNI is sent, e.g. IP connections)
   * Returns the most recently used network's certificate.
   * Note: Server initialization must ensure at least one network exists before calling this.
   * @returns {{ cert: Buffer, key: Buffer }} Fallback certificate and key
   */
  getDefaultCertKey() {
    // Get all networks sorted by lastUsedAt (most recent first)
    const networks = Array.from(this.metadataCache.values())
      .sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));

    if (networks.length === 0) {
      throw new Error("No network certificates available - server should ensure at least one cert exists during initialization");
    }

    // Use the most recently used network as fallback
    const fallbackNetwork = networks[0];
    const networkDir = join(this.networksDir, fallbackNetwork.networkId);
    const certPath = join(networkDir, "server.crt");
    const keyPath = join(networkDir, "server.key");

    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  }

  /**
   * List all networks with metadata
   * @returns {Array} Array of network metadata objects
   */
  async listNetworks() {
    const networks = [];

    for (const [networkId, metadata] of this.metadataCache.entries()) {
      networks.push({ ...metadata });
    }

    // Sort by lastUsedAt descending
    networks.sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));

    return networks;
  }

  /**
   * Fetch public IP address
   * @returns {string|null} Public IP or null if unavailable
   */
  async getPublicIp() {
    try {
      const response = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(3000)
      });
      const data = await response.json();
      return data.ip;
    } catch (error) {
      log.warn("Failed to fetch public IP", { error: error.message });
      return null;
    }
  }

  /**
   * Ensure certificate exists for a network (auto-generate if missing)
   * @param {string} ip - IP address
   * @returns {string} Network ID
   */
  async ensureNetworkCert(ip) {
    const networkId = this.getNetworkIdForIp(ip);
    const networkDir = join(this.networksDir, networkId);

    // Check if cert already exists
    if (existsSync(join(networkDir, "server.crt"))) {
      return networkId;
    }

    // Check network limit
    if (this.metadataCache.size >= MAX_NETWORKS && !this.metadataCache.has(networkId)) {
      throw new Error(`Maximum of ${MAX_NETWORKS} networks reached`);
    }

    log.info("Auto-generating certificate for new network", { ip, networkId });

    // Create network directory
    mkdirSync(networkDir, { recursive: true });

    // Load CA
    const caCertPath = join(this.tlsDir, "ca.crt");
    const caKeyPath = join(this.tlsDir, "ca.key");

    if (!existsSync(caCertPath) || !existsSync(caKeyPath)) {
      throw new Error("CA certificate not found");
    }

    const caCertPem = readFileSync(caCertPath, "utf-8");
    const caKeyPem = readFileSync(caKeyPath, "utf-8");
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);

    // Generate network certificate with subnet IPs
    const subnetIps = this.getSubnetIps(ip);
    const { certPem, keyPem } = this.generateNetworkCert(caCert, caKey, subnetIps);

    // Write cert and key atomically
    const certTmp = join(networkDir, "server.crt.tmp");
    const keyTmp = join(networkDir, "server.key.tmp");

    writeFileSync(certTmp, certPem);
    writeFileSync(keyTmp, keyPem, { mode: 0o600 });

    renameSync(certTmp, join(networkDir, "server.crt"));
    renameSync(keyTmp, join(networkDir, "server.key"));

    // Ensure correct permissions
    try {
      chmodSync(join(networkDir, "server.key"), 0o600);
    } catch {
      // Best-effort on platforms that don't support chmod
    }

    // Fetch public IP
    const publicIp = await this.getPublicIp();

    // Write metadata
    const instanceName = this.getCurrentInstanceName();
    const subnet = ip.split('.').slice(0, 3).join('.');
    const metadata = {
      networkId,
      ips: [ip],
      publicIp: publicIp || null,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      label: `Katulong ${instanceName} (${subnet}.*)`,
      autoGenerated: true,
    };

    this.writeMetadata(networkDir, metadata);
    this.metadataCache.set(networkId, metadata);

    // Load into cache
    this.loadSecureContext(networkId);

    return networkId;
  }

  /**
   * Regenerate certificate for a specific network
   * @param {string} networkId - Network ID
   */
  async regenerateNetwork(networkId) {
    const networkDir = join(this.networksDir, networkId);
    const metadata = this.metadataCache.get(networkId);

    if (!metadata) {
      throw new Error(`Network ${networkId} not found`);
    }

    log.info("Regenerating certificate for network", { networkId });

    // Load CA
    const caCertPath = join(this.tlsDir, "ca.crt");
    const caKeyPath = join(this.tlsDir, "ca.key");
    const caCertPem = readFileSync(caCertPath, "utf-8");
    const caKeyPem = readFileSync(caKeyPath, "utf-8");
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);

    // Get subnet IPs based on existing metadata
    const primaryIp = metadata.ips[0];
    const subnetIps = this.getSubnetIps(primaryIp);

    // Generate new certificate
    const { certPem, keyPem } = this.generateNetworkCert(caCert, caKey, subnetIps);

    // Write atomically
    const certTmp = join(networkDir, "server.crt.tmp");
    const keyTmp = join(networkDir, "server.key.tmp");

    writeFileSync(certTmp, certPem);
    writeFileSync(keyTmp, keyPem, { mode: 0o600 });

    renameSync(certTmp, join(networkDir, "server.crt"));
    renameSync(keyTmp, join(networkDir, "server.key"));

    try {
      chmodSync(join(networkDir, "server.key"), 0o600);
    } catch {
      // Best-effort
    }

    // Fetch and update public IP
    const publicIp = await this.getPublicIp();

    // Update metadata
    metadata.publicIp = publicIp || metadata.publicIp || null;
    metadata.lastUsedAt = new Date().toISOString();
    this.writeMetadata(networkDir, metadata);
  }

  /**
   * Revoke (delete) a network certificate
   * @param {string} networkId - Network ID
   */
  async revokeNetwork(networkId) {
    const networkDir = join(this.networksDir, networkId);

    if (!existsSync(networkDir)) {
      throw new Error(`Network ${networkId} not found`);
    }

    log.info("Revoking network certificate", { networkId });

    // Remove from cache
    this.certCache.delete(networkId);
    this.metadataCache.delete(networkId);

    // Delete directory
    rmSync(networkDir, { recursive: true, force: true });
  }

  /**
   * Update network label
   * @param {string} networkId - Network ID
   * @param {string} label - New label
   */
  async updateNetworkLabel(networkId, label) {
    const networkDir = join(this.networksDir, networkId);
    const metadata = this.metadataCache.get(networkId);

    if (!metadata) {
      throw new Error(`Network ${networkId} not found`);
    }

    metadata.label = label;
    metadata.lastUsedAt = new Date().toISOString();

    this.writeMetadata(networkDir, metadata);
    this.metadataCache.set(networkId, metadata);
  }

  /**
   * Hot-reload certificate (invalidate cache and reload from disk)
   * @param {string} networkId - Network ID
   */
  async reloadCertificate(networkId) {
    log.info("Hot-reloading certificate", { networkId });

    // Invalidate cache
    this.certCache.delete(networkId);

    // Reload from disk
    this.loadSecureContext(networkId);

    // Update metadata cache
    const networkDir = join(this.networksDir, networkId);
    const metadata = this.readMetadata(networkDir);
    if (metadata) {
      this.metadataCache.set(networkId, metadata);
    }
  }

  /**
   * Update lastUsedAt timestamp for a network
   * @param {string} networkId - Network ID
   */
  async touchNetworkCert(networkId) {
    const metadata = this.metadataCache.get(networkId);
    if (!metadata) return;

    // Only update if more than 1 hour old to avoid excessive writes
    const lastUsed = new Date(metadata.lastUsedAt);
    const now = new Date();
    if (now - lastUsed < 3600000) return;

    metadata.lastUsedAt = now.toISOString();
    const networkDir = join(this.networksDir, networkId);
    this.writeMetadata(networkDir, metadata);
  }

  /**
   * Get network ID from IP address (based on subnet)
   * @param {string} ip - IP address
   * @returns {string} Network ID
   */
  getNetworkIdForIp(ip) {
    // Normalize localhost to 127.0.0.1
    if (ip === "::1" || ip === "localhost") {
      ip = "127.0.0.1";
    }

    // Extract subnet (e.g., 192.168.1.x -> net-192-168-1-0, 127.0.0.x -> net-127-0-0-0)
    const parts = ip.split('.');
    if (parts.length === 4) {
      const subnet = `${parts[0]}-${parts[1]}-${parts[2]}-0`;
      return `net-${subnet}`;
    }

    // IPv6 or other - use hash
    const hash = createHash('sha256').update(ip).digest('hex').slice(0, 8);
    return `net-${hash}`;
  }

  /**
   * Get all IPs in a subnet (for certificate SANs)
   * @param {string} ip - Single IP address
   * @returns {Array} Array of IPs in subnet
   */
  getSubnetIps(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return [ip];

    // Just return the single IP - we'll only add the specific IP to SANs
    // (not all 254 IPs in subnet)
    return [ip];
  }

  /**
   * Resolve servername to IP (might be hostname or IP)
   * @param {string} servername - Server name from SNI
   * @returns {string} IP address
   */
  resolveToIp(servername) {
    // If it's already an IP, return it
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(servername)) {
      return servername;
    }

    // For localhost/hostname, normalize to localhost IP
    return "127.0.0.1";
  }

  /**
   * Generate network-specific certificate
   * @param {object} caCert - CA certificate
   * @param {object} caKey - CA private key
   * @param {Array} ips - IPs to include in SANs
   * @returns {object} { certPem, keyPem }
   */
  generateNetworkCert(caCert, caKey, ips) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = Math.floor(Math.random() * 1000000).toString();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + SERVER_YEARS,
    );

    const primaryIp = ips.find(ip => ip !== "127.0.0.1" && ip !== "::1") || "localhost";
    const attrs = [
      { name: "organizationName", value: this.instanceName },
      { name: "commonName", value: primaryIp },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(caCert.subject.attributes);

    // Build SANs: localhost, loopback, network IPs
    const altNames = [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "::1" },
    ];

    // Add network IPs
    for (const ip of ips) {
      if (ip !== "127.0.0.1" && ip !== "::1") {
        altNames.push({ type: 7, ip });
      }
    }

    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: "extKeyUsage",
        serverAuth: true,
      },
      {
        name: "subjectAltName",
        altNames,
      },
    ]);

    cert.sign(caKey, forge.md.sha256.create());

    return {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  /**
   * Read metadata.json from network directory
   * @param {string} networkDir - Network directory path
   * @returns {object|null} Metadata object or null if not found
   */
  readMetadata(networkDir) {
    const metadataPath = join(networkDir, "metadata.json");
    if (!existsSync(metadataPath)) return null;

    try {
      const content = readFileSync(metadataPath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      log.warn("Failed to read metadata", { path: metadataPath, error: error.message });
      return null;
    }
  }

  /**
   * Write metadata.json to network directory (atomic)
   * @param {string} networkDir - Network directory path
   * @param {object} metadata - Metadata object
   */
  writeMetadata(networkDir, metadata) {
    const metadataPath = join(networkDir, "metadata.json");
    const tmpPath = join(networkDir, "metadata.json.tmp");

    writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));
    renameSync(tmpPath, metadataPath);
  }

}
