import express from 'express';
import { resolve } from 'node:path';
import { createTokTrackerApi } from './api.js';

export function createServer() {
  const app = express();
  app.use(express.static(resolve(process.cwd(), 'src/toktracker/public')));

  for (const [method, path, handler] of createTokTrackerApi()) {
    app[method.toLowerCase()](path, handler);
  }

  return app;
}
