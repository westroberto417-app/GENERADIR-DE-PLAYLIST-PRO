import { db } from '../db/database';
import type {
  IntensityLevel,
  PlaylistGeneratorConfig,
  PlaylistItem,
  TrackRecord,
} from '../types/studio';
import { normalizeText } from './metadataParser';

export interface GenerationResult {
  items: PlaylistItem[];
  musicCount: number;
  spotCount: number;
  totalDuration: number;
  warnings: string[];
  eligiblePoolCount: number;
}

function intensityToNumeric(intensity: IntensityLevel | null): number {
  switch (intensity) {
    case 'Muy suave':
      return 18;
    case 'Suave':
      return 36;
    case 'Media':
      return 55;
    case 'Alta':
      return 76;
    case 'Muy alta':
      return 92;
    default:
      return 50;
  }
}

function getTrackEnergyMetric(t: TrackRecord): number {
  if (typeof t.energyScore === 'number') return t.energyScore;
  return intensityToNumeric(t.intensity);
}

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function trackToItem(track: TrackRecord, isSpot: boolean): PlaylistItem {
  return {
    uid: `${track.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    trackId: track.id,
    isSpot,
    title: track.title,
    artist: track.artist,
    duration: track.duration > 0 ? track.duration : 180,
    bpm: track.bpm,
    intensity: track.intensity,
    genre: track.genre,
    folderId: track.folderId,
    relativePath: track.relativePath,
    fileName: track.fileName,
    accessible: track.accessible,
  };
}

export function matchesTrackFilters(track: TrackRecord, cfg: PlaylistGeneratorConfig): boolean {
  // Never allow spot folder tracks inside the normal music pool
  if (track.isSpotFolder) return false;

  if (cfg.sourceScope === 'folder' && cfg.sourceFolderId) {
    if (track.folderId !== cfg.sourceFolderId) return false;
  }

  const genreNorm = normalizeText(track.genre);
  if (cfg.allowedGenres.length > 0) {
    const ok = cfg.allowedGenres.some((g) => genreNorm.includes(normalizeText(g)));
    if (!ok) return false;
  }
  if (cfg.excludedGenres.length > 0) {
    const bad = cfg.excludedGenres.some((g) => genreNorm.includes(normalizeText(g)));
    if (bad) return false;
  }

  if (cfg.decades.length > 0 && !cfg.decades.includes(track.decade)) {
    return false;
  }

  if (cfg.years && cfg.years.length > 0 && (!track.year || !cfg.years.includes(track.year))) {
    return false;
  }

  const artistNorm = normalizeText(track.artist);
  if (cfg.includedArtists.length > 0) {
    const ok = cfg.includedArtists.some((a) => artistNorm.includes(normalizeText(a)));
    if (!ok) return false;
  }
  if (cfg.excludedArtists.length > 0) {
    const bad = cfg.excludedArtists.some((a) => artistNorm.includes(normalizeText(a)));
    if (bad) return false;
  }

  if (cfg.bpmMin !== null && (track.bpm === null || track.bpm < cfg.bpmMin)) {
    return false;
  }
  if (cfg.bpmMax !== null && (track.bpm === null || track.bpm > cfg.bpmMax)) {
    return false;
  }

  const energy = getTrackEnergyMetric(track);
  if (cfg.energyMin !== null && energy < cfg.energyMin) return false;
  if (cfg.energyMax !== null && energy > cfg.energyMax) return false;

  if (cfg.energyLevels && cfg.energyLevels.length > 0) {
    if (!track.energyLevel || !cfg.energyLevels.includes(track.energyLevel)) {
      return false;
    }
  }

  if (cfg.intensities.length > 0) {
    if (!track.intensity || !cfg.intensities.includes(track.intensity)) {
      return false;
    }
  }

  if (cfg.moods.length > 0) {
    const moodNorm = normalizeText(track.mood);
    const ok = cfg.moods.some((m) => moodNorm === normalizeText(m));
    if (!ok) return false;
  }

  return true;
}

function getSegmentTargetEnergy(progress: number, segments: [number, number, number, number]): number {
  if (progress < 0.2) return segments[0];
  if (progress < 0.5) return segments[1];
  if (progress < 0.85) return segments[2];
  return segments[3];
}

export async function generateSmartPlaylist(
  cfg: PlaylistGeneratorConfig
): Promise<GenerationResult> {
  const warnings: string[] = [];
  const allTracks = await db.tracks.toArray();
  const musicOnly = allTracks.filter((t) => !t.isSpotFolder);

  const scopedMusic =
    cfg.sourceScope === 'folder' && cfg.sourceFolderId
      ? musicOnly.filter((t) => t.folderId === cfg.sourceFolderId)
      : musicOnly;

  if (cfg.sourceScope === 'folder' && !cfg.sourceFolderId) {
    return {
      items: [],
      musicCount: 0,
      spotCount: 0,
      totalDuration: 0,
      warnings: ['Selecciona una carpeta específica de música para mezclar desde ahí.'],
      eligiblePoolCount: 0,
    };
  }

  if (scopedMusic.length === 0) {
    return {
      items: [],
      musicCount: 0,
      spotCount: 0,
      totalDuration: 0,
      warnings: [
        cfg.sourceScope === 'folder'
          ? 'La carpeta seleccionada no contiene canciones musicales en el catálogo.'
          : 'No hay canciones musicales en la biblioteca. Importa una carpeta primero.',
      ],
      eligiblePoolCount: 0,
    };
  }

  // Filter by metadata/DSP criteria
  let candidates = scopedMusic.filter((t) => matchesTrackFilters(t, cfg));

  if (candidates.length === 0) {
    const accessibleCount = scopedMusic.filter((t) => t.accessible).length;
    if (accessibleCount === 0) {
      warnings.push(
        cfg.sourceScope === 'folder'
          ? 'Las pistas de la carpeta seleccionada están marcadas como inaccesibles. Re-conéctala antes de generar.'
          : 'Todas las pistas están marcadas como inaccesibles en esta sesión. Re-vincula la carpeta en Biblioteca.'
      );
    } else if (cfg.intensities.length > 0 || cfg.moods.length > 0 || (cfg.energyLevels?.length || 0) > 0) {
      const hasDsp = musicOnly.some((t) => t.intensity !== null || (t.mood && t.mood !== 'Desconocido'));
      if (!hasDsp) {
        warnings.push(
          'Los filtros de Intensidad/Ambiente/Energía requieren análisis "DSP Completo". Limpia esos filtros o ejecuta "DSP Completo" en el Analizador.'
        );
      } else {
        warnings.push('Ninguna canción coincide con los filtros de género, BPM, década, intensidad o ambiente.');
      }
    } else {
      warnings.push('Ninguna canción real de tu biblioteca cumple todos los filtros seleccionados.');
    }
  }

  // Filter inaccessible tracks cleanly with warning if some were excluded
  const accessibleCandidates = candidates.filter((t) => t.accessible);
  if (accessibleCandidates.length < candidates.length) {
    warnings.push(
      `Se omitieron ${candidates.length - accessibleCandidates.length} canciones marcadas como inaccesibles en esta sesión.`
    );
  }
  candidates = accessibleCandidates;

  // Anti-repetition history check
  const lastUsedAtMap = new Map<string, number>();
  let cooldownFallbackCandidates: TrackRecord[] = [];
  if (cfg.respectAntiRepeat && cfg.antiRepeatHours > 0) {
    const cutoff = Date.now() - cfg.antiRepeatHours * 3600 * 1000;
    const recentUsage = await db.usageHistory.where('usedAt').above(cutoff).toArray();
    for (const u of recentUsage) {
      const prev = lastUsedAtMap.get(u.trackId) ?? 0;
      if (u.usedAt > prev) lastUsedAtMap.set(u.trackId, u.usedAt);
    }
    const recentTrackIds = new Set(recentUsage.map((u) => u.trackId));
    const filteredByHistory = candidates.filter((t) => !recentTrackIds.has(t.id));
    if (cfg.fallbackToOldestOnExhaust) {
      cooldownFallbackCandidates = candidates
        .filter((t) => recentTrackIds.has(t.id))
        .sort((a, b) => (lastUsedAtMap.get(a.id) ?? 0) - (lastUsedAtMap.get(b.id) ?? 0));
    }
    if (filteredByHistory.length === 0 && candidates.length > 0 && !cfg.fallbackToOldestOnExhaust) {
      warnings.push(
        `Todas las ${candidates.length} canciones elegibles fueron usadas en las últimas ${cfg.antiRepeatHours}h. Ajusta la ventana anti-repetición o desactiva "Excluir canciones usadas".`
      );
    }
    candidates = filteredByHistory;
  }

  const eligiblePoolCount = candidates.length + cooldownFallbackCandidates.length;
  if (eligiblePoolCount === 0) {
    return {
      items: [],
      musicCount: 0,
      spotCount: 0,
      totalDuration: 0,
      warnings:
        warnings.length > 0
          ? warnings
          : ['Ninguna canción real de tu biblioteca cumple todos los filtros seleccionados.'],
      eligiblePoolCount: 0,
    };
  }

  // Load isolated Spots pool if enabled
  let spotPool: TrackRecord[] = [];
  if (cfg.spots.enabled) {
    if (!cfg.spots.spotFolderId) {
      warnings.push('Mezclador de spots activado pero no se ha seleccionado ninguna carpeta de spots.');
    } else {
      spotPool = allTracks.filter(
        (t) => t.folderId === cfg.spots.spotFolderId && t.accessible
      );
      if (spotPool.length === 0) {
        warnings.push('La carpeta de spots seleccionada no contiene archivos accesibles.');
      }
    }
  }

  // Sort or prepare candidate ordering according to generation mode
  const freshShuffled = shuffleArray(candidates);
  const combinedPool = [...freshShuffled, ...cooldownFallbackCandidates];
  const selectedMusic: TrackRecord[] = [];
  const usedIds = new Set<string>();
  const usedSongSignatures = new Set<string>();
  const usedArtists = new Set<string>();
  const targetSec = cfg.targetDurationMin * 60;
  const enforceNoRepeatTracks = cfg.noRepeatTracks !== false;
  const enforceNoRepeatArtists = Boolean(cfg.noRepeatArtists);

  let currentMusicSec = 0;
  let relaxedSeparationWarned = false;
  let usedCooldownPool = false;
  let cooldownUsedCount = 0;

  const isTargetReached = () => {
    if (cfg.targetType === 'count') return selectedMusic.length >= cfg.targetCount;
    if (cfg.targetType === 'duration') return currentMusicSec >= targetSec;
    return selectedMusic.length >= cfg.targetCount && currentMusicSec >= targetSec;
  };

  const getSongSignature = (track: TrackRecord): string => {
    const titleNorm = normalizeText(track.title);
    const artistNorm = normalizeText(track.artist);
    if (titleNorm && artistNorm && artistNorm !== 'desconocido') {
      return `${artistNorm}::${titleNorm}`;
    }
    return track.duplicateKey || track.id;
  };

  const canUseTrack = (track: TrackRecord, allowReuse = false): boolean => {
    if (enforceNoRepeatTracks) {
      if (usedIds.has(track.id)) return false;
      if (usedSongSignatures.has(getSongSignature(track))) return false;
      if (track.duplicateKey && usedSongSignatures.has(`dup:${track.duplicateKey}`)) return false;
      return true;
    }
    if (!allowReuse && usedIds.has(track.id)) return false;
    if (allowReuse && combinedPool.length > 1 && selectedMusic.length > 0) {
      const last = selectedMusic[selectedMusic.length - 1];
      if (last.id === track.id) return false;
    }
    return true;
  };

  const canUseArtist = (artist: string): boolean => {
    const norm = normalizeText(artist);
    if (!norm || norm === 'desconocido') return true;
    if (enforceNoRepeatArtists) {
      return !usedArtists.has(norm);
    }
    if (cfg.artistSeparation <= 0) return true;
    const recentSlice = selectedMusic.slice(-cfg.artistSeparation);
    return !recentSlice.some((prev) => normalizeText(prev.artist) === norm);
  };

  let reusedPoolWarned = false;
  const maxIterations = Math.max(combinedPool.length * 4, cfg.targetCount + 50, 200);
  let iterations = 0;

  // Mode-based selection loop: prefer fresh tracks first, only touch cooldownFallbackCandidates once fresh tracks are exhausted
  while (!isTargetReached() && iterations < maxIterations) {
    iterations++;
    if (enforceNoRepeatTracks && usedIds.size >= combinedPool.length) {
      break;
    }

    const progress =
      cfg.targetType === 'count'
        ? selectedMusic.length / Math.max(1, cfg.targetCount)
        : Math.min(0.99, currentMusicSec / Math.max(1, targetSec));

    let activePool = usedCooldownPool ? combinedPool : freshShuffled;
    let available = activePool.filter((t) => canUseTrack(t, false) && canUseArtist(t.artist));

    if (available.length === 0 && !usedCooldownPool && cooldownFallbackCandidates.length > 0) {
      usedCooldownPool = true;
      activePool = cooldownFallbackCandidates;
      available = activePool.filter((t) => canUseTrack(t, false) && canUseArtist(t.artist));
    }

    if (available.length === 0 && !enforceNoRepeatTracks) {
      // User explicitly allowed repeating tracks: allow reuse of pool
      available = shuffleArray(combinedPool).filter((t) => canUseTrack(t, true) && canUseArtist(t.artist));
      if (available.length > 0 && !reusedPoolWarned) {
        warnings.push(
          'Se reutilizaron temas del pool disponible para completar la meta (opción "No repetir temas" desactivada).'
        );
        reusedPoolWarned = true;
      }
    }

    if (available.length === 0) {
      // Never relax strict "noRepeatArtists" rule; only relax soft artistSeparation if needed
      if (!enforceNoRepeatArtists) {
        const remainingUnused = combinedPool.filter((t) => canUseTrack(t, false));
        const remainingReusable =
          remainingUnused.length > 0 || enforceNoRepeatTracks
            ? remainingUnused
            : shuffleArray(combinedPool).filter((t) => canUseTrack(t, true));
        if (remainingReusable.length > 0) {
          if (!relaxedSeparationWarned && cfg.artistSeparation > 0) {
            warnings.push(
              `Separación de artista (${cfg.artistSeparation} pistas) relajada en el tramo final por tamaño del pool disponible.`
            );
            relaxedSeparationWarned = true;
          }
          available = remainingReusable;
        } else {
          break;
        }
      } else {
        if (combinedPool.some((t) => canUseTrack(t, !enforceNoRepeatTracks))) {
          warnings.push(
            'Se detuvo la mezcla al alcanzar todos los cantantes únicos disponibles (regla "No repetir cantantes" activa).'
          );
        }
        break;
      }
    }

    let chosen: TrackRecord = available[0];

    if (cfg.mode === 'Progresivo') {
      const targetEnergy = getSegmentTargetEnergy(progress, cfg.progressiveCurve.segments);
      chosen = available.reduce((best, curr) => {
        const bestDiff = Math.abs(getTrackEnergyMetric(best) - targetEnergy);
        const currDiff = Math.abs(getTrackEnergyMetric(curr) - targetEnergy);
        return currDiff < bestDiff ? curr : best;
      }, available[0]);
    } else if (cfg.mode === 'Por BPM') {
      const prevBpm = selectedMusic.length > 0 ? selectedMusic[selectedMusic.length - 1].bpm : null;
      if (prevBpm) {
        chosen = available.reduce((best, curr) => {
          const bestDiff = best.bpm ? Math.abs(best.bpm - prevBpm) : 999;
          const currDiff = curr.bpm ? Math.abs(curr.bpm - prevBpm) : 999;
          return currDiff < bestDiff ? curr : best;
        }, available[0]);
      } else {
        chosen = [...available].sort((a, b) => (a.bpm ?? 999) - (b.bpm ?? 999))[0];
      }
    } else if (cfg.mode === 'Por intensidad') {
      chosen = [...available].sort(
        (a, b) => getTrackEnergyMetric(a) - getTrackEnergyMetric(b)
      )[0];
    } else if (cfg.mode === 'Por género') {
      const lastGenre = selectedMusic.length > 0 ? selectedMusic[selectedMusic.length - 1].genre : null;
      const sameGenre = lastGenre ? available.find((t) => t.genre === lastGenre) : undefined;
      chosen = sameGenre || available[0];
    } else if (cfg.mode === 'Por década') {
      chosen = [...available].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))[0];
    } else if (cfg.mode === 'Por ambiente' || cfg.mode === 'Combinado') {
      const lastMood = selectedMusic.length > 0 ? selectedMusic[selectedMusic.length - 1].mood : null;
      const smooth = lastMood
        ? available.find((t) => t.mood === lastMood)
        : undefined;
      chosen = smooth || available[0];
    } else {
      // Aleatorio
      chosen = available[0];
    }

    if (lastUsedAtMap.has(chosen.id)) {
      cooldownUsedCount++;
    }
    usedIds.add(chosen.id);
    if (enforceNoRepeatTracks) {
      usedSongSignatures.add(getSongSignature(chosen));
      if (chosen.duplicateKey) {
        usedSongSignatures.add(`dup:${chosen.duplicateKey}`);
      }
    }
    const chosenArtistNorm = normalizeText(chosen.artist);
    if (chosenArtistNorm && chosenArtistNorm !== 'desconocido') {
      usedArtists.add(chosenArtistNorm);
    }
    selectedMusic.push(chosen);
    currentMusicSec += chosen.duration > 0 ? chosen.duration : 180;
  }

  if (cooldownUsedCount > 0) {
    warnings.push(
      `Se completaron ${cooldownUsedCount} pista(s) con las canciones usadas hace más tiempo al agotarse las pistas sin uso en las últimas ${cfg.antiRepeatHours}h.`
    );
  }

  if (!isTargetReached()) {
    if (cfg.targetType === 'count') {
      warnings.push(
        `Solo se pudieron seleccionar ${selectedMusic.length} de ${cfg.targetCount} canciones solicitadas con los filtros actuales.`
      );
    } else {
      warnings.push(
        `Duración alcanzada: ${Math.round(currentMusicSec / 60)} min de ${cfg.targetDurationMin} min solicitados (sin canciones adicionales elegibles).`
      );
    }
  }

  // Interleave Spots / Jingles / Pisadores cleanly
  const finalItems: PlaylistItem[] = [];
  let spotSeqIdx = 0;
  let lastSpotId = '';

  const pickNextSpot = (): TrackRecord | null => {
    if (spotPool.length === 0) return null;
    if (cfg.spots.rotationMode === 'sequential') {
      const spot = spotPool[spotSeqIdx % spotPool.length];
      spotSeqIdx++;
      return spot;
    }
    // random-no-repeat
    if (spotPool.length === 1) return spotPool[0];
    const poolWithoutLast = spotPool.filter((s) => s.id !== lastSpotId);
    const picked = poolWithoutLast[Math.floor(Math.random() * poolWithoutLast.length)];
    lastSpotId = picked.id;
    return picked;
  };

  if (cfg.spots.enabled && spotPool.length > 0 && cfg.spots.insertIntroAtStart) {
    const intro = pickNextSpot();
    if (intro) finalItems.push(trackToItem(intro, true));
  }

  const everyN = Math.max(1, cfg.spots.everyNSongs || 3);
  selectedMusic.forEach((track, idx) => {
    finalItems.push(trackToItem(track, false));
    if (
      cfg.spots.enabled &&
      spotPool.length > 0 &&
      (idx + 1) % everyN === 0 &&
      idx < selectedMusic.length - 1
    ) {
      const spot = pickNextSpot();
      if (spot) finalItems.push(trackToItem(spot, true));
    }
  });

  const totalDuration = finalItems.reduce((sum, it) => sum + it.duration, 0);
  const spotCount = finalItems.filter((it) => it.isSpot).length;
  const musicCount = finalItems.length - spotCount;

  return {
    items: finalItems,
    musicCount,
    spotCount,
    totalDuration,
    warnings,
    eligiblePoolCount,
  };
}
