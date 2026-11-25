import { DEFAULT_SETTINGS } from '../db/database';
import {
  ENERGY_LEVELS,
  INTENSITY_LEVELS,
  type EnergyLevel,
  type GeneratorTemplate,
  type IntensityLevel,
  type PlaylistGeneratorConfig,
  type TrackRecord,
} from '../types/studio';
import { matchesTrackFilters } from './playlistEngine';

export interface FacetCount<T> {
  value: T;
  count: number;
}

export interface BpmRangeFacet {
  id: string;
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface LibraryFacets {
  totalAccessible: number;
  genres: FacetCount<string>[];
  decades: FacetCount<string>[];
  years: FacetCount<number>[];
  artists: FacetCount<string>[];
  bpmStats: {
    min: number;
    max: number;
    avg: number;
    taggedCount: number;
  } | null;
  bpmRanges: BpmRangeFacet[];
  energyLevels: FacetCount<EnergyLevel>[];
  intensities: FacetCount<IntensityLevel>[];
  moods: FacetCount<string>[];
  hasEnergyScores: boolean;
}

const BPM_BUCKETS: Array<{ id: string; title: string; min: number; max: number }> = [
  { id: 'slow', title: 'Lento', min: 1, max: 89 },
  { id: 'mid', title: 'Medio', min: 90, max: 109 },
  { id: 'groove', title: 'Groove', min: 110, max: 124 },
  { id: 'dance', title: 'Dance', min: 125, max: 138 },
  { id: 'fast', title: 'Rápido', min: 139, max: 300 },
];

export function extractLibraryFacets(musicTracks: TrackRecord[]): LibraryFacets {
  const accessibleTracks = musicTracks.filter((t) => t.accessible);
  const pool = accessibleTracks.length > 0 ? accessibleTracks : musicTracks;

  const genreMap = new Map<string, number>();
  const decadeMap = new Map<string, number>();
  const yearMap = new Map<number, number>();
  const artistMap = new Map<string, number>();
  const energyMap = new Map<EnergyLevel, number>();
  const intensityMap = new Map<IntensityLevel, number>();
  const moodMap = new Map<string, number>();

  const allBpms: number[] = [];
  let hasEnergyScores = false;

  for (const t of pool) {
    if (t.genre && t.genre !== 'Desconocido') {
      genreMap.set(t.genre, (genreMap.get(t.genre) || 0) + 1);
    }
    if (t.decade && t.decade !== 'Desconocida') {
      decadeMap.set(t.decade, (decadeMap.get(t.decade) || 0) + 1);
    }
    if (t.year && t.year >= 1920 && t.year <= 2099) {
      yearMap.set(t.year, (yearMap.get(t.year) || 0) + 1);
    }
    if (t.artist && t.artist !== 'Desconocido') {
      artistMap.set(t.artist, (artistMap.get(t.artist) || 0) + 1);
    }
    if (typeof t.bpm === 'number' && t.bpm > 0) {
      allBpms.push(t.bpm);
    }
    if (typeof t.energyScore === 'number') {
      hasEnergyScores = true;
    }
    if (t.energyLevel) {
      energyMap.set(t.energyLevel, (energyMap.get(t.energyLevel) || 0) + 1);
    }
    if (t.intensity) {
      intensityMap.set(t.intensity, (intensityMap.get(t.intensity) || 0) + 1);
    }
    if (t.mood && t.mood !== 'Desconocido') {
      moodMap.set(t.mood, (moodMap.get(t.mood) || 0) + 1);
    }
  }

  const genres = Array.from(genreMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const decades = Array.from(decadeMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));

  const years = Array.from(yearMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.value - a.value);

  const artists = Array.from(artistMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 40);

  let bpmStats: LibraryFacets['bpmStats'] = null;
  if (allBpms.length > 0) {
    const min = Math.min(...allBpms);
    const max = Math.max(...allBpms);
    const avg = Math.round(allBpms.reduce((s, n) => s + n, 0) / allBpms.length);
    bpmStats = { min, max, avg, taggedCount: allBpms.length };
  }

  const bpmRanges: BpmRangeFacet[] = [];
  for (const b of BPM_BUCKETS) {
    const inBucket = allBpms.filter((bpm) => bpm >= b.min && bpm <= b.max);
    if (inBucket.length > 0) {
      const realMin = Math.min(...inBucket);
      const realMax = Math.max(...inBucket);
      bpmRanges.push({
        id: b.id,
        label:
          realMin === realMax
            ? `${b.title} (${realMin} BPM)`
            : `${b.title} (${realMin}–${realMax} BPM)`,
        min: realMin,
        max: realMax,
        count: inBucket.length,
      });
    }
  }

  const energyLevels = ENERGY_LEVELS.filter((lvl) => (energyMap.get(lvl) || 0) > 0).map(
    (value) => ({ value, count: energyMap.get(value) || 0 })
  );

  const intensities = INTENSITY_LEVELS.filter((lvl) => (intensityMap.get(lvl) || 0) > 0).map(
    (value) => ({ value, count: intensityMap.get(value) || 0 })
  );

  const moods = Array.from(moodMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    totalAccessible: pool.length,
    genres,
    decades,
    years,
    artists,
    bpmStats,
    bpmRanges,
    energyLevels,
    intensities,
    moods,
    hasEnergyScores,
  };
}

function summarizeGroupStats(group: TrackRecord[]): {
  bpmMin: number | null;
  bpmMax: number | null;
  allHaveBpm: boolean;
  topDecades: string[];
  topGenres: string[];
} {
  const bpms = group.map((t) => t.bpm).filter((b): b is number => typeof b === 'number' && b > 0);
  const decMap = new Map<string, number>();
  const genMap = new Map<string, number>();

  for (const t of group) {
    if (t.decade && t.decade !== 'Desconocida') {
      decMap.set(t.decade, (decMap.get(t.decade) || 0) + 1);
    }
    if (t.genre && t.genre !== 'Desconocido') {
      genMap.set(t.genre, (genMap.get(t.genre) || 0) + 1);
    }
  }

  return {
    bpmMin: bpms.length > 0 ? Math.min(...bpms) : null,
    bpmMax: bpms.length > 0 ? Math.max(...bpms) : null,
    allHaveBpm: bpms.length === group.length && group.length > 0,
    topDecades: Array.from(decMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => d),
    topGenres: Array.from(genMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g),
  };
}

function buildTestConfig(patch: Partial<PlaylistGeneratorConfig>): PlaylistGeneratorConfig {
  return {
    name: 'Test',
    templateId: '',
    sourceScope: 'all',
    sourceFolderId: '',
    targetType: 'duration',
    targetDurationMin: 60,
    targetCount: 18,
    mode: 'Aleatorio',
    progressiveCurve: { preset: 'Ascendente', segments: [28, 52, 76, 92] },
    allowedGenres: [],
    excludedGenres: [],
    decades: [],
    years: [],
    includedArtists: [],
    excludedArtists: [],
    bpmMin: null,
    bpmMax: null,
    energyMin: null,
    energyMax: null,
    energyLevels: [],
    intensities: [],
    moods: [],
    noRepeatTracks: true,
    noRepeatArtists: false,
    respectAntiRepeat: false,
    antiRepeatHours: DEFAULT_SETTINGS.antiRepeatHours,
    artistSeparation: DEFAULT_SETTINGS.artistSeparation,
    spots: {
      enabled: false,
      spotFolderId: '',
      everyNSongs: 3,
      rotationMode: 'sequential',
      insertIntroAtStart: false,
    },
    ...patch,
  };
}

export function buildLibraryTemplates(
  musicTracks: TrackRecord[],
  facets: LibraryFacets
): GeneratorTemplate[] {
  const accessibleTracks = musicTracks.filter((t) => t.accessible);
  const pool = accessibleTracks.length > 0 ? accessibleTracks : musicTracks;
  if (pool.length === 0) return [];

  const templates: GeneratorTemplate[] = [];
  const seenSignatures = new Set<string>();

  const tryAdd = (
    id: string,
    name: string,
    description: string,
    patch: Partial<PlaylistGeneratorConfig>,
    tags: string[]
  ) => {
    const testCfg = buildTestConfig(patch);
    const matchingCount = pool.filter((t) => matchesTrackFilters(t, testCfg)).length;
    if (matchingCount === 0) return;

    const sig = JSON.stringify({
      g: patch.allowedGenres || [],
      d: patch.decades || [],
      y: patch.years || [],
      bmin: patch.bpmMin ?? null,
      bmax: patch.bpmMax ?? null,
      i: patch.intensities || [],
      m: patch.moods || [],
      mode: patch.mode || '',
    });
    if (seenSignatures.has(sig)) return;
    seenSignatures.add(sig);

    templates.push({
      id,
      name,
      description,
      matchingCount,
      tags,
      patch: {
        name,
        targetType: 'duration',
        targetDurationMin: 60,
        ...patch,
      },
    });
  };

  // 1. Top real genres detected in library (up to 4)
  const topGenres = facets.genres.slice(0, 4);
  for (const g of topGenres) {
    const gTracks = pool.filter((t) => t.genre === g.value);
    const stats = summarizeGroupStats(gTracks);
    const hasBpmRange = stats.allHaveBpm && stats.bpmMin !== null && stats.bpmMax !== null;
    const bpmText =
      stats.bpmMin !== null && stats.bpmMax !== null
        ? stats.bpmMin === stats.bpmMax
          ? `${stats.bpmMin} BPM`
          : `${stats.bpmMin}–${stats.bpmMax} BPM`
        : null;

    const tags = [g.value, ...(bpmText ? [bpmText] : []), ...stats.topDecades];
    const mode = facets.hasEnergyScores
      ? 'Progresivo'
      : stats.bpmMin !== null
      ? 'Por BPM'
      : 'Por género';

    tryAdd(
      `dyn-genre-${g.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      bpmText ? `${g.value} · ${bpmText}` : `Estilo ${g.value}`,
      `Extraído de ${g.count} pistas de ${g.value}${
        stats.topDecades.length > 0 ? ` (${stats.topDecades.join(', ')})` : ''
      }.`,
      {
        mode,
        allowedGenres: [g.value],
        bpmMin: hasBpmRange ? stats.bpmMin : null,
        bpmMax: hasBpmRange ? stats.bpmMax : null,
      },
      tags
    );
  }

  // 2. Top real decades detected in library (up to 2)
  const topDecades = [...facets.decades].sort((a, b) => b.count - a.count).slice(0, 2);
  for (const d of topDecades) {
    const dTracks = pool.filter((t) => t.decade === d.value);
    const stats = summarizeGroupStats(dTracks);
    const genreListText = stats.topGenres.length > 0 ? stats.topGenres.join(', ') : 'varios estilos';
    const bpmText =
      stats.bpmMin !== null && stats.bpmMax !== null
        ? `${stats.bpmMin}–${stats.bpmMax} BPM`
        : null;

    tryAdd(
      `dyn-decade-${d.value}`,
      `Época ${d.value}`,
      `${d.count} pistas reales de los ${d.value} (${genreListText}).`,
      {
        mode: stats.topGenres.length > 1 ? 'Por género' : 'Por década',
        decades: [d.value],
      },
      [d.value, ...stats.topGenres.slice(0, 2), ...(bpmText ? [bpmText] : [])]
    );
  }

  // 3. Real BPM tempo bands present in library (up to 2)
  const topBpmBands = [...facets.bpmRanges].sort((a, b) => b.count - a.count).slice(0, 2);
  for (const band of topBpmBands) {
    const bTracks = pool.filter(
      (t) => typeof t.bpm === 'number' && t.bpm >= band.min && t.bpm <= band.max
    );
    const stats = summarizeGroupStats(bTracks);
    const genreListText = stats.topGenres.length > 0 ? stats.topGenres.join(', ') : 'multi-género';

    tryAdd(
      `dyn-bpm-${band.id}`,
      `Ritmo ${band.label}`,
      `${band.count} pistas reales entre ${band.min} y ${band.max} BPM (${genreListText}).`,
      {
        mode: 'Por BPM',
        bpmMin: band.min,
        bpmMax: band.max,
      },
      [`${band.min}–${band.max} BPM`, ...stats.topGenres.slice(0, 2)]
    );
  }

  // 4. Real Mood / Intensity templates ONLY if DSP full analysis exists in library (up to 2)
  if (facets.moods.length > 0) {
    const topMood = facets.moods[0];
    const mTracks = pool.filter((t) => t.mood === topMood.value);
    const stats = summarizeGroupStats(mTracks);
    tryAdd(
      `dyn-mood-${topMood.value.toLowerCase()}`,
      `Ambiente ${topMood.value}`,
      `${topMood.count} pistas con ambiente ${topMood.value} detectado por DSP.`,
      {
        mode: 'Por ambiente',
        moods: [topMood.value],
      },
      [topMood.value, ...stats.topGenres.slice(0, 2)]
    );
  }

  if (facets.intensities.length > 0) {
    const highInt =
      facets.intensities.find((i) => i.value === 'Alta' || i.value === 'Muy alta') ||
      facets.intensities[0];
    tryAdd(
      `dyn-int-${highInt.value.toLowerCase().replace(/\s+/g, '-')}`,
      `Intensidad ${highInt.value}`,
      `${highInt.count} pistas medidas con intensidad ${highInt.value}.`,
      {
        mode: facets.hasEnergyScores ? 'Progresivo' : 'Por intensidad',
        intensities: [highInt.value],
      },
      [highInt.value]
    );
  }

  // 5. Real Full-Library Multi-Genre Mix (always works with everything in library)
  const defaultMixMode = facets.hasEnergyScores
    ? 'Progresivo'
    : facets.bpmStats
    ? 'Por BPM'
    : facets.genres.length > 1
    ? 'Por género'
    : 'Aleatorio';

  tryAdd(
    'dyn-library-mix',
    facets.genres.length > 1 ? 'Mix Multi-Género Real' : 'Selección del Catálogo',
    `Usa todo tu pool disponible (${pool.length} pistas${
      facets.genres.length > 0 ? ` en ${facets.genres.length} géneros` : ''
    }).`,
    {
      mode: defaultMixMode,
      ...(facets.hasEnergyScores
        ? { progressiveCurve: { preset: 'Onda radial', segments: [38, 82, 45, 86] } }
        : {}),
    },
    [
      `${pool.length} pistas`,
      ...(facets.genres.slice(0, 2).map((g) => g.value)),
      ...(facets.bpmStats ? [`${facets.bpmStats.min}–${facets.bpmStats.max} BPM`] : []),
    ]
  );

  return templates.slice(0, 10);
}
