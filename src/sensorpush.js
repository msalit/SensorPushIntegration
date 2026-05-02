const fetch = require('node-fetch');

const API_BASE = 'https://api.sensorpush.com/api/v1';

// Default configuration
const DEFAULTS = {
  requestTimeoutMs: 10000,       // 10s timeout per API call
  maxRetries: 3,                 // retry up to 3 times
  retryBaseDelayMs: 1000,        // 1s base delay (exponential backoff)
  cacheTtlMs: 60000,             // 1 minute cache TTL
  staleTtlMs: 15 * 60 * 1000,   // serve stale data up to 15 minutes
  tokenRefreshBufferMs: 60 * 60 * 1000, // refresh token 1 hour before expiry
};

class SensorPushClient {
  constructor(email, password, options = {}) {
    this.email = email;
    this.password = password;
    this.config = { ...DEFAULTS, ...options };

    // Auth state
    this.accessToken = null;
    this.tokenExpiry = null;
    this._authPromise = null; // mutex for concurrent auth

    // Cache state
    this._sensorsCache = null;
    this._sensorsCacheTime = 0;
    this._readingsCache = null;
    this._readingsCacheTime = 0;
    this._combinedCache = null;
    this._combinedCacheTime = 0;
  }

  // ---------------------------------------------------------------------------
  // Retry with exponential backoff
  // ---------------------------------------------------------------------------
  async _fetchWithRetry(url, options, retryCount = 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`HTTP ${response.status}: ${body}`);
        err.status = response.status;
        throw err;
      }

      return await response.json();
    } catch (error) {
      // Don't retry on auth failures (400/401/403) or abort
      const noRetryStatuses = [400, 401, 403];
      if (noRetryStatuses.includes(error.status) || error.name === 'AbortError' && retryCount >= this.config.maxRetries) {
        if (error.name === 'AbortError') {
          throw new Error(`Request to ${url} timed out after ${this.config.requestTimeoutMs}ms`);
        }
        throw error;
      }

      if (retryCount < this.config.maxRetries) {
        const delay = this.config.retryBaseDelayMs * Math.pow(2, retryCount);
        const jitter = Math.random() * delay * 0.3;
        console.log(`Retry ${retryCount + 1}/${this.config.maxRetries} for ${url} in ${Math.round(delay + jitter)}ms`);
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
        return this._fetchWithRetry(url, options, retryCount + 1);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication with mutex to prevent concurrent auth attempts
  // ---------------------------------------------------------------------------
  async authenticate() {
    // Step 1: Get authorization code
    const authData = await this._fetchWithRetry(`${API_BASE}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    // Step 2: Exchange for access token
    const tokenData = await this._fetchWithRetry(`${API_BASE}/oauth/accesstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization: authData.authorization }),
    });

    this.accessToken = tokenData.accesstoken;
    // SensorPush tokens are valid for ~12 hours; refresh with buffer
    this.tokenExpiry = Date.now() + (12 * 60 * 60 * 1000) - this.config.tokenRefreshBufferMs;

    console.log('SensorPush authentication successful');
    return this.accessToken;
  }

  async ensureAuthenticated() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return;
    }

    // Mutex: if auth is already in progress, wait for it
    if (this._authPromise) {
      return this._authPromise;
    }

    this._authPromise = this.authenticate()
      .finally(() => {
        this._authPromise = null;
      });

    return this._authPromise;
  }

  // ---------------------------------------------------------------------------
  // API calls with auth retry (re-auth once on 401)
  // ---------------------------------------------------------------------------
  async _authenticatedFetch(url, body = {}) {
    await this.ensureAuthenticated();

    try {
      return await this._fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.accessToken,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // If we got a 401, force re-auth and try once more
      if (error.status === 401) {
        console.log('Got 401, re-authenticating...');
        this.accessToken = null;
        this.tokenExpiry = null;
        await this.ensureAuthenticated();

        return await this._fetchWithRetry(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.accessToken,
          },
          body: JSON.stringify(body),
        });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Cached API methods
  // ---------------------------------------------------------------------------
  async getSensors() {
    const now = Date.now();
    if (this._sensorsCache && (now - this._sensorsCacheTime) < this.config.cacheTtlMs) {
      return this._sensorsCache;
    }

    try {
      const data = await this._authenticatedFetch(`${API_BASE}/devices/sensors`);
      this._sensorsCache = data;
      this._sensorsCacheTime = now;
      return data;
    } catch (error) {
      // Return stale data if available
      if (this._sensorsCache && (now - this._sensorsCacheTime) < this.config.staleTtlMs) {
        console.warn(`getSensors failed, returning stale data (${Math.round((now - this._sensorsCacheTime) / 1000)}s old): ${error.message}`);
        return this._sensorsCache;
      }
      throw error;
    }
  }

  async getLatestReadings() {
    const now = Date.now();
    if (this._readingsCache && (now - this._readingsCacheTime) < this.config.cacheTtlMs) {
      return this._readingsCache;
    }

    try {
      const data = await this._authenticatedFetch(`${API_BASE}/samples`, { limit: 1 });
      this._readingsCache = data;
      this._readingsCacheTime = now;
      return data;
    } catch (error) {
      // Return stale data if available
      if (this._readingsCache && (now - this._readingsCacheTime) < this.config.staleTtlMs) {
        console.warn(`getLatestReadings failed, returning stale data (${Math.round((now - this._readingsCacheTime) / 1000)}s old): ${error.message}`);
        return this._readingsCache;
      }
      throw error;
    }
  }

  async getAllSensorsWithReadings() {
    const now = Date.now();
    if (this._combinedCache && (now - this._combinedCacheTime) < this.config.cacheTtlMs) {
      return this._combinedCache;
    }

    const [sensors, readings] = await Promise.all([
      this.getSensors(),
      this.getLatestReadings(),
    ]);

    const result = [];

    for (const [id, sensor] of Object.entries(sensors)) {
      const sensorReadings = readings.sensors?.[id];
      if (sensorReadings && sensorReadings.length > 0) {
        result.push({
          id,
          sensor,
          reading: sensorReadings[0],
        });
      }
    }

    this._combinedCache = result;
    this._combinedCacheTime = now;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Health check - test connectivity to SensorPush API
  // ---------------------------------------------------------------------------
  async checkHealth() {
    try {
      await this.ensureAuthenticated();
      const sensors = await this.getSensors();
      const sensorCount = Object.keys(sensors).length;
      return {
        status: 'ok',
        sensorCount,
        tokenValid: this.accessToken != null && Date.now() < this.tokenExpiry,
        cacheAge: {
          sensors: this._sensorsCacheTime ? Math.round((Date.now() - this._sensorsCacheTime) / 1000) : null,
          readings: this._readingsCacheTime ? Math.round((Date.now() - this._readingsCacheTime) / 1000) : null,
        },
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        tokenValid: this.accessToken != null && Date.now() < this.tokenExpiry,
        hasStaleSensors: this._sensorsCache != null,
        hasStaleReadings: this._readingsCache != null,
      };
    }
  }
}

module.exports = SensorPushClient;
