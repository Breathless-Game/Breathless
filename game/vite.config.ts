import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Umi and the Irys uploader still reach for Node built-ins (Buffer, stream, crypto).
  plugins: [nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'], globals: { Buffer: true, process: true, global: true } })],
  server: {
    port: 5173,
    host: true,
    // The PEARL market (sensor/market-server.mjs, `npm run market`); `npm start` serves /api/market same-origin.
    proxy: { '/api': `http://127.0.0.1:${process.env.MARKET_PORT ?? 8795}` },
  },
  build: { rollupOptions: { input: ['index.html', 'showcase.html'] } },
});
