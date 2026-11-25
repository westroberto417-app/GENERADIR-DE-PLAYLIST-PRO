import { analyzeDspPcm, type DspAnalyzeRequest, type DspAnalyzeResponse } from './dspCore';

export type { DspAnalyzeRequest, DspAnalyzeResponse };

self.onmessage = (event: MessageEvent<DspAnalyzeRequest>) => {
  const res = analyzeDspPcm(event.data);
  self.postMessage(res);
};
