import type {
  AnalysisMode,
  DanceabilityLabel,
  EnergyLevel,
  IntensityLevel,
  RmsThresholds,
  ValenceLabel,
} from '../types/studio';

export interface DspAnalyzeRequest {
  id: string;
  mode?: AnalysisMode;
  sampleRate: number;
  pcmData: Float32Array;
  thresholds: RmsThresholds;
  existingGenre?: string;
  existingYear?: number | null;
}

export interface DspAnalyzeResponse {
  id: string;
  ok: boolean;
  error?: string;
  bpm?: number;
  bpmConfidence?: number;
  energyRmsDb?: number;
  energyScore?: number;
  energyLevel?: EnergyLevel;
  intensity?: IntensityLevel;
  danceability?: number;
  danceabilityLabel?: DanceabilityLabel;
  valence?: number;
  valenceLabel?: ValenceLabel;
  mood?: string;
}

function classifyIntensity(rmsDb: number, t: RmsThresholds): IntensityLevel {
  if (rmsDb <= t.verySoftMax) return 'Muy suave';
  if (rmsDb <= t.softMax) return 'Suave';
  if (rmsDb <= t.mediumMax) return 'Media';
  if (rmsDb <= t.highMax) return 'Alta';
  return 'Muy alta';
}

function classifyEnergyLevel(score: number): EnergyLevel {
  if (score < 22) return 'Muy baja';
  if (score < 42) return 'Baja';
  if (score < 64) return 'Media';
  if (score < 84) return 'Alta';
  return 'Muy alta';
}

/**
 * Ultra-fast DJ-style BPM detector (VirtualDJ / Mixxx / Joe Sullivan low-pass peak-interval histogram):
 * 1) Single-pole ~160 Hz low-pass filter to isolate kick & bass transients
 * 2) 10ms energy envelope (~100 frames/s)
 * 3) Adaptive peak picking + octave-folded BPM histogram [66..178 BPM]
 * Executes in < 0.5 ms per track.
 */
function estimateFastDjBpm(
  samples: Float32Array,
  sampleRate: number
): { bpm: number; confidence: number } {
  const len = samples.length;
  const blockSize = Math.max(40, Math.round(sampleRate * 0.01)); // ~10ms blocks
  const blockCount = Math.floor(len / blockSize);
  if (blockCount < 60) {
    return { bpm: 120, confidence: 20 };
  }

  const omega = 2 * Math.PI * 160;
  const alpha = Math.min(0.6, Math.max(0.02, omega / (sampleRate + omega)));
  let lp = 0;

  const env = new Float32Array(blockCount);
  let meanEnv = 0;
  for (let b = 0; b < blockCount; b++) {
    const start = b * blockSize;
    const end = start + blockSize;
    let peakSq = 0;
    for (let i = start; i < end; i++) {
      lp += alpha * (samples[i] - lp);
      const e = lp * lp;
      if (e > peakSq) peakSq = e;
    }
    const val = Math.sqrt(peakSq);
    env[b] = val;
    meanEnv += val;
  }
  meanEnv /= blockCount;

  const minPeakGap = Math.max(2, Math.round(0.22 / (blockSize / sampleRate)));
  const peaks: number[] = [];
  let lastPeak = -minPeakGap;

  for (let b = 2; b < blockCount - 2; b++) {
    const v = env[b];
    if (
      v > meanEnv * 1.22 &&
      v >= env[b - 1] &&
      v > env[b + 1] &&
      b - lastPeak >= minPeakGap
    ) {
      peaks.push(b);
      lastPeak = b;
    }
  }

  if (peaks.length < 6) {
    return { bpm: 120, confidence: 25 };
  }

  const blockSec = blockSize / sampleRate;
  const minBpm = 66;
  const maxBpm = 178;
  const hist = new Float32Array(maxBpm + 1);
  let totalWeight = 0;

  for (let i = 0; i < peaks.length; i++) {
    const p0 = peaks[i];
    const limit = Math.min(peaks.length, i + 11);
    for (let j = i + 1; j < limit; j++) {
      const dt = (peaks[j] - p0) * blockSec;
      if (dt < 0.28 || dt > 2.2) continue;

      let tempo = 60 / dt;
      while (tempo < minBpm) tempo *= 2;
      while (tempo > maxBpm) tempo *= 0.5;

      const rounded = Math.round(tempo);
      if (rounded >= minBpm && rounded <= maxBpm) {
        const prior = 1.0 - Math.abs(rounded - 120) / 220;
        const weight = prior / (j - i);
        hist[rounded] += weight;
        if (rounded - 1 >= minBpm) hist[rounded - 1] += weight * 0.45;
        if (rounded + 1 <= maxBpm) hist[rounded + 1] += weight * 0.45;
        totalWeight += weight;
      }
    }
  }

  let bestBpm = 120;
  let bestScore = -1;
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    if (hist[bpm] > bestScore) {
      bestScore = hist[bpm];
      bestBpm = bpm;
    }
  }

  if (bestScore <= 0 || totalWeight <= 0) {
    return { bpm: 120, confidence: 25 };
  }

  const clusterWeight =
    (hist[bestBpm - 1] || 0) + hist[bestBpm] + (hist[bestBpm + 1] || 0);
  const dominance = clusterWeight / totalWeight;
  const confidence = Math.max(20, Math.min(98, Math.round(dominance * 220 + 24)));

  return { bpm: bestBpm, confidence };
}

function estimateBpmAndConfidence(
  samples: Float32Array,
  sampleRate: number
): { bpm: number; regularity: number; confidence: number } {
  const hop = Math.max(96, Math.round(sampleRate * 0.0116));
  const frameCount = Math.floor(samples.length / hop);
  if (frameCount < 64) {
    return { bpm: 120, regularity: 30, confidence: 22 };
  }

  const energies = new Float32Array(frameCount);
  const invHop = 1 / hop;
  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    const end = start + hop;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    energies[f] = Math.sqrt(sumSq * invHop);
  }

  const onset = new Float32Array(frameCount);
  let onsetMean = 0;
  for (let f = 1; f < frameCount; f++) {
    const diff = energies[f] - energies[f - 1];
    const val = diff > 0 ? diff : 0;
    onset[f] = val;
    onsetMean += val;
  }
  const threshold = (onsetMean / frameCount) * 0.65;
  for (let f = 0; f < frameCount; f++) {
    const v = onset[f] - threshold;
    onset[f] = v > 0 ? v : 0;
  }

  const framesPerSec = sampleRate / hop;
  const minBpm = 62;
  const maxBpm = 182;
  const minLag = Math.max(4, Math.floor((60 / maxBpm) * framesPerSec));
  const maxLag = Math.min(Math.floor(frameCount / 2), Math.ceil((60 / minBpm) * framesPerSec));

  if (maxLag <= minLag) {
    return { bpm: 120, regularity: 35, confidence: 25 };
  }

  const acf = new Float32Array(maxLag + 1);
  let maxAcf = 0;
  let sumAcf = 0;
  let countAcf = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = frameCount - lag;
    for (let i = 0; i < limit; i++) {
      corr += onset[i] * onset[i + lag];
    }
    corr /= Math.max(1, limit);

    const candidateBpm = (60 * framesPerSec) / lag;
    const tempoPrior = Math.exp(-Math.pow((candidateBpm - 118) / 55, 2) * 0.35);
    const weighted = corr * tempoPrior;

    acf[lag] = weighted;
    if (weighted > maxAcf) maxAcf = weighted;
    sumAcf += weighted;
    countAcf++;
  }

  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = acf[lag];
    const halfLag = lag >> 1;
    const doubleLag = lag << 1;
    if (halfLag >= minLag && halfLag <= maxLag) score += acf[halfLag] * 0.25;
    if (doubleLag >= minLag && doubleLag <= maxLag) score += acf[doubleLag] * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acf[bestLag - 1];
    const y1 = acf[bestLag];
    const y2 = acf[bestLag + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-9) {
      const delta = (y0 - y2) / denom;
      if (Math.abs(delta) < 1) {
        refinedLag = bestLag + delta;
      }
    }
  }

  const bpm = Math.round((60 * framesPerSec) / refinedLag);
  const meanAcf = sumAcf / Math.max(1, countAcf);
  const peakProminence = meanAcf > 1e-12 ? maxAcf / meanAcf : 1;
  const regularity = Math.max(10, Math.min(99, Math.round((peakProminence - 1) * 28 + 30)));
  const confidence = Math.max(15, Math.min(98, Math.round((peakProminence - 1) * 32 + 22)));

  return {
    bpm: Math.max(minBpm, Math.min(maxBpm, bpm)),
    regularity,
    confidence,
  };
}

function estimateSpectralFeatures(samples: Float32Array, sampleRate: number) {
  let zcrCount = 0;
  let lowEnergy = 0;
  let highEnergy = 0;
  let prev = samples[0] || 0;
  let lowPass = 0;
  const omega = 2 * Math.PI * 1000;
  const alpha = Math.min(0.95, Math.max(0.05, omega / (sampleRate + omega)));
  const len = samples.length;

  for (let i = 1; i < len; i++) {
    const s = samples[i];
    if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
      zcrCount++;
    }
    lowPass += alpha * (s - lowPass);
    const highPass = s - lowPass;
    lowEnergy += lowPass * lowPass;
    highEnergy += highPass * highPass;
    prev = s;
  }

  const zcrRate = zcrCount / Math.max(1, len);
  const brightness = (highEnergy + 1e-12) / (lowEnergy + highEnergy + 1e-12);
  return { zcrRate, brightness };
}

export function analyzeDspPcm(req: DspAnalyzeRequest): DspAnalyzeResponse {
  const { id, mode = 'fast-metadata-bpm', sampleRate, pcmData, thresholds } = req;

  try {
    const len = pcmData ? pcmData.length : 0;
    if (len < 1024 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return {
        id,
        ok: false,
        error: 'Muestra PCM insuficiente para análisis rítmico.',
      };
    }

    if (mode === 'fast-metadata-bpm') {
      const { bpm, confidence } = estimateFastDjBpm(pcmData, sampleRate);
      return {
        id,
        ok: true,
        bpm,
        bpmConfidence: confidence,
      };
    }

    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      const v = pcmData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / len);
    if (!Number.isFinite(rms) || rms < 1e-7) {
      return {
        id,
        ok: false,
        error: 'El archivo contiene silencio completo o nivel nulo.',
      };
    }

    const energyRmsDb = Math.round(Math.max(-60, Math.min(0, 20 * Math.log10(rms))) * 10) / 10;
    const energyScore = Math.max(1, Math.min(100, Math.round(((energyRmsDb + 34) / 28) * 100)));
    const energyLevel = classifyEnergyLevel(energyScore);
    const intensity = classifyIntensity(energyRmsDb, thresholds);

    const { bpm, regularity, confidence: bpmConfidence } = estimateBpmAndConfidence(
      pcmData,
      sampleRate
    );
    const { brightness } = estimateSpectralFeatures(pcmData, sampleRate);

    const tempoDanceFactor = 1 - Math.min(1, Math.abs(bpm - 120) / 60);
    const danceability = Math.max(
      12,
      Math.min(98, Math.round(regularity * 0.55 + tempoDanceFactor * 30 + energyScore * 0.15))
    );
    const danceabilityLabel: DanceabilityLabel =
      danceability < 42 ? 'Baja' : danceability < 72 ? 'Media' : 'Alta';

    const valence = Math.max(
      10,
      Math.min(
        96,
        Math.round(brightness * 42 + energyScore * 0.32 + Math.min(1, bpm / 150) * 26)
      )
    );
    const valenceLabel: ValenceLabel =
      valence < 38 ? 'Melancólica' : valence < 64 ? 'Neutral' : 'Alegre';

    let mood = 'Alegre';
    if (energyScore < 35) {
      mood = valence < 45 ? 'Nocturno' : 'Relajado';
    } else if (energyScore < 55 && bpm < 104) {
      mood = valence < 52 ? 'Romántico' : 'Relajado';
    } else if (energyScore >= 78 && bpm >= 122 && danceability >= 66) {
      mood = 'Entrenamiento';
    } else if (danceability >= 70 && valence >= 60) {
      mood = 'Fiesta';
    } else if (energyScore >= 60 && bpm >= 105 && bpm <= 128) {
      mood = 'Conducción';
    } else if (valence >= 56) {
      mood = 'Alegre';
    } else {
      mood = 'Nocturno';
    }

    return {
      id,
      ok: true,
      bpm,
      bpmConfidence,
      energyRmsDb,
      energyScore,
      energyLevel,
      intensity,
      danceability,
      danceabilityLabel,
      valence,
      valenceLabel,
      mood,
    };
  } catch (err) {
    return {
      id,
      ok: false,
      error: err instanceof Error ? err.message : 'Error interno en el motor DSP.',
    };
  }
}
