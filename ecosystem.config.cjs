// pm2 进程配置 —— suno-api
// 敏感配置(SUNO_COOKIE / TWOCAPTCHA_KEY)放在远端 .env 中,不进 git;
// Next.js 启动时会自动加载同目录 .env,故此处仅放非敏感项。
module.exports = {
  apps: [
    {
      name: 'suno-api',
      script: 'npm',
      args: 'run start',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
  ],
};
