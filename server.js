#!/usr/bin/env node
'use strict';
const http = require('http');
const { loadEnvFile, buildConfig } = require('./src/config');
const { createApp } = require('./src/app');

loadEnvFile();
const config = buildConfig(process.env);
const app = createApp(config);

const server = http.createServer((req, res) => {
  app(req, res).catch((err) => {
    console.error('[ghm-pool] unhandled', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
  });
});

server.listen(config.port, () => {
  console.log(`GHM Football Pool listening on http://localhost:${config.port}`);
  console.log(`  storage: ${config.storage}${config.storage === 'file' ? ` (${config.dataFile})` : ''}`);
  console.log(`  odds api key: ${config.oddsApiKey ? 'configured' : 'NOT SET - manual entry only'}`);
  console.log(`  admin page: http://localhost:${config.port}/admin`);
});

module.exports = server;
