module.exports = {
  apps: [
    {
      name: 'md2pdf',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '700M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3011,
      },
    },
  ],
};
