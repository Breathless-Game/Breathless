// `node-fetch` for the browser (aliased in vite.config.ts). @metaplex-foundation/umi-http-fetch
// imports only its default `fetch`; bundling the real package drags in whatwg-url, tr46's tables,
// readable-stream and qs (~440 kB). Its extra options (follow, timeout) are ignored by native fetch.
const nodeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
export default nodeFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
