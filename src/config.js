import 'dotenv/config';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
};

export const config = {
  apiKey: () => required('TIKLEAP_API_KEY'),
  baseUrl: process.env.TIKLEAP_BASE_URL || 'https://www.tikleap.com',
  authStyle: process.env.TIKLEAP_AUTH_STYLE || 'bearer',
  rateLimitRps: Number(process.env.TIKLEAP_RATE_LIMIT_RPS || 1),
  dbPath: process.env.DB_PATH || './data/tikleap.db'
};
