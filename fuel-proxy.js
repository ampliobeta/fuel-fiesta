// fuel-proxy.js
// Drop this on your Amplio server alongside fuel_control_v12.html
// Run with: node fuel-proxy.js
//
// Install dependencies first:
//   npm install express cors node-fetch
//
// Set your Anthropic API key as an environment variable:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node fuel-proxy.js
//
// Or on most hosting platforms, set ANTHROPIC_API_KEY in your environment/config panel.

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;
const KEY  = process.env.ANTHROPIC_API_KEY;

if (!KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// Serve the HTML tool as the root page
app.use(express.static(__dirname));

// Proxy endpoint — receives requests from the browser, forwards to Anthropic
app.post('/api/fuel', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            KEY,
        'anthropic-version':    '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

app.listen(PORT, () => {
  console.log('Fuel Control proxy running on port ' + PORT);
  console.log('Open http://localhost:' + PORT + '/fuel_control_v12.html');
});
