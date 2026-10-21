// PM2 設定。起動: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'webdock',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_restarts: 10,
    out_file: './webdock.log',
    error_file: './webdock.err.log',
  }],
};
