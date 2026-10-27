const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Default configuration
const DEFAULTS = {
  accessTokenTtlMs: 60 * 60 * 1000,   // 1 hour, matches expires_in sent to Google
  authCodeTtlMs: 10 * 60 * 1000,      // 10 minutes
};

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// =============================================================================
// OAuth token store
//
// Access and refresh tokens are persisted to a JSON file so a container restart
// doesn't force re-linking Google Home. Only SHA-256 hashes of tokens are stored.
// Authorization codes are short-lived and kept in memory only.
// =============================================================================

class TokenStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.config = { ...DEFAULTS, ...options };
    this.authCodes = new Map();
    this.tokens = {};
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.tokens = data.tokens || {};
      console.log(`Token store: loaded ${Object.keys(this.tokens).length} tokens from ${this.filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Token store: could not read ${this.filePath}:`, error.message);
      }
      this.tokens = {};
    }
  }

  _save() {
    const now = Date.now();
    for (const [key, entry] of Object.entries(this.tokens)) {
      if (entry.expiresAt && entry.expiresAt < now) delete this.tokens[key];
    }

    // Write-then-rename so a crash never leaves a half-written file
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  // ---------------------------------------------------------------------------
  // Authorization codes
  // ---------------------------------------------------------------------------
  issueAuthCode(clientId, redirectUri) {
    const code = newSecret();
    this.authCodes.set(hash(code), {
      clientId,
      redirectUri,
      expiresAt: Date.now() + this.config.authCodeTtlMs,
    });
    return code;
  }

  // Single use: the code is removed whether or not it is valid
  consumeAuthCode(code) {
    const key = hash(code);
    const data = this.authCodes.get(key);
    this.authCodes.delete(key);
    if (!data || data.expiresAt < Date.now()) return null;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Access and refresh tokens
  // ---------------------------------------------------------------------------
  issueAccessToken(userId) {
    const token = newSecret();
    this.tokens[hash(token)] = {
      type: 'access',
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.accessTokenTtlMs,
    };
    this._save();
    return token;
  }

  issueRefreshToken(userId) {
    const token = newSecret();
    this.tokens[hash(token)] = {
      type: 'refresh',
      userId,
      createdAt: Date.now(),
    };
    this._save();
    return token;
  }

  _lookup(token, type) {
    if (!token) return null;
    const entry = this.tokens[hash(token)];
    if (!entry || entry.type !== type) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
    return entry;
  }

  validateAccessToken(token) {
    return this._lookup(token, 'access');
  }

  validateRefreshToken(token) {
    return this._lookup(token, 'refresh');
  }

  // Google DISCONNECT: the user unlinked, so nothing issued so far should work
  revokeAll() {
    this.tokens = {};
    this.authCodes.clear();
    this._save();
  }
}

module.exports = TokenStore;
