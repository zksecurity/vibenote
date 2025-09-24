// PM2 ecosystem file for VibeNote backend
const path = require('path');
// Usage:
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save
//   pm2 startup   # (optional) generate system startup script
// Environments inherit from process.env loaded by the app (dotenv in env.ts)

module.exports = {
  apps: [
    {
      name: 'vibenote-api',
      script: 'server/src/index.ts',
      cwd: path.resolve(__dirname),
      // Node 22+ can execute TypeScript directly. We rely on that in production.
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      // Basic health / restart policies
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 2000,
      // Merge stdout/stderr for simpler journald capture
      combine_logs: true,
      time: true,
    },
  ],
};
