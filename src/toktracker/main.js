import { config } from '../config.js';
import { createTracker } from './tracker.js';
import { createServer } from './server.js';

const tracker = createTracker({
  tickMs: config.toktracker.tickMs,
  maxRequestsPerTick: config.toktracker.maxRequestsPerTick
});
const app = createServer();

app.listen(config.toktracker.port, '127.0.0.1', () => {
  console.log(`toktracker: http://127.0.0.1:${config.toktracker.port}`);
});

tracker.start().catch((error) => {
  console.error(`toktracker failed to start: ${error.message}`);
  process.exit(1);
});
