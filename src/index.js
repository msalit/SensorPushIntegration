const express = require('express');
const { smarthome } = require('actions-on-google');
const { v4: uuidv4 } = require('uuid');
const SensorPushClient = require('./sensorpush');

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
    clientId: process.env.OAUTH_CLIENT_ID || 'sensorpush-google-home',
    clientSecret: process.env.OAUTH_CLIENT_SECRET || uuidv4(),
  },
};

// Validate required config
if (!CONFIG.sensorpush.email || !CONFIG.sensorpush.password) {
  console.error('ERROR: SENSORPUSH_EMAIL and SENSORPUSH_PASSWORD environment variables are required');
  process.exit(1);
}

// Initialize SensorPush client
const sensorPush = new SensorPushClient(CONFIG.sensorpush.email, CONFIG.sensorpush.password);

// In-memory token storage (for production, use a database)
const authCodes = new Map();
const accessTokens = new Map();

// Helper to convert Fahrenheit to Celsius
function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

// =============================================================================
// OAuth 2.0 Endpoints for Google Account Linking
// =============================================================================

// Authorization endpoint - Google redirects user here
app.get('/auth', (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query;

  console.log('OAuth /auth request:', { client_id, redirect_uri, state, response_type });

  // For simplicity, we auto-approve (in production, show a login/consent page)
  // Generate authorization code
  const code = uuidv4();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    createdAt: Date.now(),
  });

  // Redirect back to Google with the code
  const redirectUrl = `${redirect_uri}?code=${code}&state=${state}`;
  console.log('Redirecting to:', redirectUrl);
  res.redirect(redirectUrl);
});

// Token endpoint - Google exchanges code for tokens
app.post('/token', (req, res) => {
  const { grant_type, code, refresh_token, client_id, client_secret } = req.body;

  console.log('OAuth /token request:', { grant_type, code: code?.slice(0, 8), client_id });

  if (grant_type === 'authorization_code') {
    // Exchange authorization code for access token
    const authData = authCodes.get(code);
    if (!authData) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    authCodes.delete(code);

    const accessToken = uuidv4();
    const refreshToken = uuidv4();

    accessTokens.set(accessToken, {
      userId: 'sensorpush-user',
      createdAt: Date.now(),
    });
    accessTokens.set(refreshToken, {
      userId: 'sensorpush-user',
      isRefresh: true,
      createdAt: Date.now(),
    });

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
    const tokenData = accessTokens.get(refresh_token);
    if (!tokenData || !tokenData.isRefresh) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = uuidv4();
    accessTokens.set(accessToken, {
      userId: tokenData.userId,
      createdAt: Date.now(),
    });

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

const smartHomeApp = smarthome({
  debug: true,
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
  console.log('DISCONNECT request received');
  return {};
});

// Mount Smart Home fulfillment endpoint
app.post('/fulfillment', smartHomeApp);

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
  console.log(`OAuth Client Secret: ${CONFIG.oauth.clientSecret}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  OAuth Auth:   GET  /auth`);
  console.log(`  OAuth Token:  POST /token`);
  console.log(`  Fulfillment:  POST /fulfillment`);
  console.log(`  Health:       GET  /health`);
  console.log(`  Debug:        GET  /sensors`);
});
