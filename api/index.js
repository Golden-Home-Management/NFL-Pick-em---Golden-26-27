'use strict';
// Vercel / Netlify serverless entry point. Every request is routed here by
// vercel.json, so the same app that runs under `npm start` also runs as a
// serverless function. Use STORAGE=postgres (Supabase) on these hosts - their
// filesystem is read-only.
const { buildConfig } = require('../src/config');
const { createApp } = require('../src/app');

const app = createApp(buildConfig(process.env));

module.exports = (req, res) => app(req, res);
