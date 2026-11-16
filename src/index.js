import cron from 'node-cron';
import { loadEndpoints, runEndpoint } from './collector.js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const backfillDays = args.includes('--backfill') ? Number(args[args.indexOf('--backfill') + 1]) || 30 : 0;

async function runAll() {
  const endpoints = loadEndpoints();
  for (const endpoint of endpoints) {
    try {
      if (backfillDays > 0 && endpoint.params?.date) {
        for (let i = 0; i < backfillDays; i++) {
          const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
          await runEndpoint({ ...endpoint, params: { ...endpoint.params, date } });
        }
      } else {
        await runEndpoint(endpoint);
      }
    } catch (error) {
      console.error(`FAIL ${endpoint.name}: ${error.message}`);
    }
  }
}

if (once || backfillDays > 0) {
  runAll().then(() => process.exit(0));
} else {
  console.log('Scheduler started. Runs endpoints by their cron schedule from config/endpoints.json.');
  for (const endpoint of loadEndpoints()) {
    if (!endpoint.schedule) continue;
    cron.schedule(endpoint.schedule, () => {
      runEndpoint(endpoint).catch((error) => console.error(`FAIL ${endpoint.name}: ${error.message}`));
    });
  }
}
