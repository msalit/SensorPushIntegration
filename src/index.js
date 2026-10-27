const crypto = require('crypto');
const express = require('express');
const { smarthome } = require('actions-on-google');
const SensorPushClient = require('./sensorpush');
const TokenStore = require('./tokens');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment variables
const CONFIG = {
  port: process.env.PORT || 3000,
  sensorpush: {
    email: process.env.SENSORPUSH_EMAIL,
    password: process.env.SENSORPUSH_PASSWORD,
  },
  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    ownerPassword: process.env.OAUTH_OWNER_PASSWORD,
    projectId: process.env.OAUTH_PROJECT_ID,
  },
  tokenStorePath: process.env.TOKEN_STORE_PATH || '/data/tokens.json',
};

// Validate required config
const REQUIRED_ENV = [
  'SENSORPUSH_EMAIL', 'SENSORPUSH_PASSWORD',
  'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'OAUTH_OWNER_PASSWORD', 'OAUTH_PROJECT_ID',
];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`ERROR: required environment variables are not set: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// Google only ever redirects account linking back to these
const ALLOWED_REDIRECT_URIS = [
  `https://oauth-redirect.googleusercontent.com/r/${CONFIG.oauth.projectId}`,
  `https://oauth-redirect-sandbox.googleusercontent.com/r/${CONFIG.oauth.projectId}`,
];

// Initialize SensorPush client
const sensorPush = new SensorPushClient(CONFIG.sensorpush.email, CONFIG.sensorpush.password);

// OAuth codes and tokens (tokens persisted to disk)
const tokenStore = new TokenStore(CONFIG.tokenStorePath);

// Helper to convert Fahrenheit to Celsius
function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

// Constant-time string comparison (hashing first equalizes lengths)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// =============================================================================
// OAuth 2.0 Endpoints for Google Account Linking
// =============================================================================

// Throttle owner-password guesses: after too many failures, refuse logins for a while
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
let loginFailures = [];

function loginLockedOut() {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  loginFailures = loginFailures.filter((t) => t > cutoff);
  return loginFailures.length >= LOGIN_MAX_FAILURES;
}

// Returns an error message, or null if the request is a valid authorization request
function validateAuthRequest({ client_id, redirect_uri, response_type }) {
  if (response_type !== 'code') return 'unsupported response_type';
  if (!safeEqual(client_id, CONFIG.oauth.clientId)) return 'unknown client_id';
  if (!ALLOWED_REDIRECT_URIS.includes(redirect_uri)) return 'redirect_uri not allowed';
  return null;
}

function renderLoginPage(res, params, { status = 200, error = null } = {}) {
  res.status(status)
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
    .set('X-Frame-Options', 'DENY')
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link SensorPush</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}
input,button{font-size:1rem;width:100%;padding:.5rem;margin:.25rem 0;box-sizing:border-box}
.error{color:#b00020}</style></head>
<body><h1>Link SensorPush to Google Home</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/auth">
<input type="hidden" name="client_id" value="${escapeHtml(params.client_id)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirect_uri)}">
<input type="hidden" name="state" value="${escapeHtml(params.state)}">
<input type="hidden" name="response_type" value="${escapeHtml(params.response_type)}">
<label>Owner password <input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">Link</button>
</form></body></html>`);
}

// Authorization endpoint - Google sends the user here; show the owner login
app.get('/auth', (req, res) => {
  const { client_id, redirect_uri, response_type } = req.query;
  console.log('OAuth /auth request:', { client_id, redirect_uri, response_type });

  // Never redirect to an unvalidated redirect_uri
  const invalid = validateAuthRequest(req.query);
  if (invalid) {
    console.log(`OAuth /auth rejected: ${invalid}`);
    return res.status(400).type('text').send(`Invalid authorization request: ${invalid}`);
  }

  renderLoginPage(res, req.query);
});

// Owner login submitted - check the password, then redirect back to Google with a code
app.post('/auth', (req, res) => {
  const { password, ...params } = req.body;

  const invalid = validateAuthRequest(params);
  if (invalid) {
    console.log(`OAuth /auth login rejected: ${invalid}`);
    return res.status(400).type('text').send(`Invalid authorization request: ${invalid}`);
  }

  if (loginLockedOut()) {
    console.log('OAuth /auth login refused: too many failed attempts');
    return renderLoginPage(res, params, { status: 429, error: 'Too many failed attempts. Try again later.' });
  }

  if (!safeEqual(password, CONFIG.oauth.ownerPassword)) {
    loginFailures.push(Date.now());
    console.log('OAuth /auth login failed: wrong password');
    return renderLoginPage(res, params, { status: 401, error: 'Wrong password.' });
  }

  const code = tokenStore.issueAuthCode(params.client_id, params.redirect_uri);
  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (params.state) redirectUrl.searchParams.set('state', params.state);

  console.log('OAuth /auth login ok, redirecting to Google');
  res.redirect(redirectUrl.toString());
});

// Client credentials may come in the body or as HTTP Basic auth
function clientCredentials(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, sep)),
        clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
      };
    }
  }
  return { clientId: req.body.client_id, clientSecret: req.body.client_secret };
}

// Token endpoint - Google exchanges code for tokens
app.post('/token', (req, res) => {
  const { grant_type, code, refresh_token, redirect_uri } = req.body;
  const { clientId, clientSecret } = clientCredentials(req);

  console.log('OAuth /token request:', { grant_type, client_id: clientId, has_redirect_uri: Boolean(redirect_uri) });

  if (!safeEqual(clientId, CONFIG.oauth.clientId) || !safeEqual(clientSecret, CONFIG.oauth.clientSecret)) {
    console.log('OAuth /token rejected: invalid client credentials');
    return res.status(401).json({ error: 'invalid_client' });
  }

  if (grant_type === 'authorization_code') {
    // Exchange authorization code for access token
    const authData = tokenStore.consumeAuthCode(code);
    if (!authData || authData.clientId !== clientId) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    // Codes are bound to the redirect_uri they were issued for
    if (redirect_uri && redirect_uri !== authData.redirectUri) {
      console.log('OAuth /token rejected: redirect_uri does not match the code');
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = tokenStore.issueAccessToken('sensorpush-user');
    const refreshToken = tokenStore.issueRefreshToken('sensorpush-user');

    console.log('Issued tokens for authorization_code grant');

    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    });
  }

  if (grant_type === 'refresh_token') {
    // Refresh the access token
    const tokenData = tokenStore.validateRefreshToken(refresh_token);
    if (!tokenData) {
      console.log('OAuth /token rejected: unknown refresh token');
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = tokenStore.issueAccessToken(tokenData.userId);

    console.log('Issued new access token for refresh_token grant');

    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: 3600,
    });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// =============================================================================
// Google Smart Home Fulfillment
// =============================================================================

// debug: true logs full request headers, including Google's bearer token
const smartHomeApp = smarthome({
  debug: false,
});

// SYNC - Return list of devices (sensors)
smartHomeApp.onSync(async (body, headers) => {
  console.log('SYNC request received');

  try {
    const sensorsWithReadings = await sensorPush.getAllSensorsWithReadings();

    const devices = sensorsWithReadings.map(({ id, sensor, reading }) => {
      return {
        id: id,
        type: 'action.devices.types.SENSOR',
        traits: [
          'action.devices.traits.SensorState',
          'action.devices.traits.TemperatureControl',
          'action.devices.traits.HumiditySetting',
        ],
        name: {
          defaultNames: [sensor.name],
          name: sensor.name,
          nicknames: [sensor.name, sensor.name.toLowerCase()],
        },
        roomHint: sensor.name, // Helps Google understand room context
        deviceInfo: {
          manufacturer: 'SensorPush',
          model: sensor.type,
          hwVersion: '1.0',
          swVersion: '1.0',
        },
        willReportState: false,
        attributes: {
          // TemperatureControl attributes
          temperatureUnitForUX: 'F',
          queryOnlyTemperatureControl: true,
          // HumiditySetting attributes
          queryOnlyHumiditySetting: true,
          // SensorState attributes
          sensorStatesSupported: [
            {
              name: 'HumidityLevel',
              numericCapabilities: {
                rawValueUnit: 'PERCENT',
              },
            },
          ],
        },
        customData: {
          sensorId: id,
        },
      };
    });

    console.log(`SYNC returning ${devices.length} devices`);

    return {
      requestId: body.requestId,
      payload: {
        agentUserId: 'sensorpush-user',
        devices,
      },
    };
  } catch (error) {
    console.error('SYNC error:', error.message);
    // Return empty device list rather than crashing - Google will retry
    return {
      requestId: body.requestId,
      payload: {
        agentUserId: 'sensorpush-user',
        devices: [],
      },
    };
  }
});

// QUERY - Return current state of requested devices
smartHomeApp.onQuery(async (body, headers) => {
  console.log('QUERY request received');

  try {
    const { devices } = body.inputs[0].payload;
    const sensorsWithReadings = await sensorPush.getAllSensorsWithReadings();

    const deviceStates = {};

    for (const device of devices) {
      const sensorData = sensorsWithReadings.find((s) => s.id === device.id);

      if (sensorData) {
        const { reading, sensor } = sensorData;

        // Temperature in Celsius for Google Smart Home API
        const tempC = fahrenheitToCelsius(reading.temperature);

        deviceStates[device.id] = {
          status: 'SUCCESS',
          online: sensor.active,
          // TemperatureControl state
          temperatureAmbientCelsius: Math.round(tempC * 10) / 10,
          temperatureSetpointCelsius: Math.round(tempC * 10) / 10,
          // HumiditySetting state
          humidityAmbientPercent: Math.round(reading.humidity),
          // SensorState state
          currentSensorStateData: [
            {
              name: 'HumidityLevel',
              rawValue: Math.round(reading.humidity * 10) / 10,
            },
          ],
        };

        console.log(`QUERY ${sensor.name}: ${reading.temperature}°F (${tempC.toFixed(1)}°C), ${reading.humidity}%`);
      } else {
        deviceStates[device.id] = {
          status: 'ERROR',
          errorCode: 'deviceNotFound',
        };
      }
    }

    return {
      requestId: body.requestId,
      payload: {
        devices: deviceStates,
      },
    };
  } catch (error) {
    console.error('QUERY error:', error.message);
    // Return offline status for all requested devices rather than crashing
    const { devices } = body.inputs[0].payload;
    const deviceStates = {};
    for (const device of devices) {
      deviceStates[device.id] = {
        status: 'ERROR',
        errorCode: 'transientError',
      };
    }
    return {
      requestId: body.requestId,
      payload: {
        devices: deviceStates,
      },
    };
  }
});

// EXECUTE - Handle commands (sensors don't have commands, but we need the handler)
smartHomeApp.onExecute(async (body, headers) => {
  console.log('EXECUTE request received');

  const { commands } = body.inputs[0].payload;
  const results = [];

  for (const command of commands) {
    for (const device of command.devices) {
      results.push({
        ids: [device.id],
        status: 'ERROR',
        errorCode: 'notSupported',
      });
    }
  }

  return {
    requestId: body.requestId,
    payload: {
      commands: results,
    },
  };
});

// DISCONNECT - User unlinked account
smartHomeApp.onDisconnect((body, headers) => {
  console.log('DISCONNECT request received; revoking all tokens');
  tokenStore.revokeAll();
  return {};
});

// Only requests carrying a bearer token we issued reach the Smart Home handlers
function requireAccessToken(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!tokenStore.validateAccessToken(token)) {
    console.log('Fulfillment rejected: missing or invalid bearer token');
    return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'invalid_token' });
  }
  next();
}

// Mount Smart Home fulfillment endpoint
app.post('/fulfillment', requireAccessToken, smartHomeApp);

// =============================================================================
// Health and Debug Endpoints
// =============================================================================

app.get('/health', async (req, res) => {
  const health = await sensorPush.checkHealth();
  health.timestamp = new Date().toISOString();
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/sensors', async (req, res) => {
  try {
    const sensorsWithReadings = await sensorPush.getAllSensorsWithReadings();
    const data = sensorsWithReadings.map(({ id, sensor, reading }) => ({
      id,
      name: sensor.name,
      type: sensor.type,
      temperature: reading.temperature,
      humidity: reading.humidity,
      observed: reading.observed,
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Start Server
// =============================================================================

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Give time for logs to flush, then exit (Docker restart policy will restart us)
  setTimeout(() => process.exit(1), 1000);
});

app.listen(CONFIG.port, () => {
  console.log(`SensorPush-Google Home connector running on port ${CONFIG.port}`);
  console.log(`OAuth Client ID: ${CONFIG.oauth.clientId}`);
  console.log(`OAuth redirect allowlist: ${ALLOWED_REDIRECT_URIS.join(', ')}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  OAuth Auth:   GET  /auth`);
  console.log(`  OAuth Token:  POST /token`);
  console.log(`  Fulfillment:  POST /fulfillment`);
  console.log(`  Health:       GET  /health`);
  console.log(`  Debug:        GET  /sensors`);
});
