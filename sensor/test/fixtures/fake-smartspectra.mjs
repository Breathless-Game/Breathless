// Stands in for @smartspectra/node-sdk (and its /messages entry) in presage-off.test.mjs:
// enough of the API for index.mjs to build a session, no native code, no network. Each
// construction prints one line the test counts. The API key itself is never printed.

export const FrameTransform = { kNone: 0 };
export const PixelFormat = { kRGBA: 0 };
export const MetricType = { TALKING: 1, PULSE_RATE: 2 };
export const ProcessingStatus = { kIdle: 0, kRunning: 1 };
export const ValidationCode = { kOk: 0, kNoFaceFound: 1 };
export const breathingMetrics = [];

export class SmartSpectraSDK {
  constructor(opts) {
    console.log(`FAKE_SMARTSPECTRA constructed (api key ${opts?.apiKey ? 'set' : 'missing'})`);
  }
  on() {}
  useCustomInput() {}
  start() {}
  sendFrame() {}
  async stopAsync() {}
  async destroy() {}
}

export function decodeMetrics() {
  return {};
}
