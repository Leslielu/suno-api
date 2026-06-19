/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
    // Playwright 系依赖内部用 require.resolve 定位 core 目录,打进 webpack server bundle 时
    // require.resolve 会被替换成数字模块 ID,导致 path.dirname(number) 在 collect page data 报错。
    // 标为 external,运行时从 node_modules 直接 require。
    serverComponentsExternalPackages: ['rebrowser-playwright-core', 'ghost-cursor-playwright'],
  },
};  

export default nextConfig;
