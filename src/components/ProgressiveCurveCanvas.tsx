import React, { useEffect, useRef } from 'react';

interface ProgressiveCurveCanvasProps {
  segments: [number, number, number, number];
  actualEnergies?: number[];
}

export const ProgressiveCurveCanvas: React.FC<ProgressiveCurveCanvasProps> = ({
  segments,
  actualEnergies = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 520;
    const height = canvas.clientHeight || 160;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const padL = 34;
    const padR = 14;
    const padT = 16;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    // Subtle grid & segment zones (0-20, 20-50, 50-85, 85-100)
    const bounds = [0, 0.2, 0.5, 0.85, 1.0];
    const zoneColors = [
      'rgba(56, 189, 248, 0.05)',
      'rgba(59, 130, 246, 0.05)',
      'rgba(139, 92, 246, 0.08)',
      'rgba(16, 185, 129, 0.05)',
    ];
    for (let i = 0; i < 4; i++) {
      const x1 = padL + bounds[i] * plotW;
      const x2 = padL + bounds[i + 1] * plotW;
      ctx.fillStyle = zoneColors[i];
      ctx.fillRect(x1, padT, x2 - x1, plotH);

      if (i > 0) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, padT);
        ctx.lineTo(x1, padT + plotH);
        ctx.stroke();
      }
    }

    // Horizontal Y grid
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    for (const val of [0, 50, 100]) {
      const y = padT + plotH - (val / 100) * plotH;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${val}`, 6, y + 3);
    }

    // X-axis labels
    const labels = ['0%', '20%', '50%', '85%', '100%'];
    bounds.forEach((b, i) => {
      const x = padL + b * plotW;
      ctx.fillText(labels[i], i === 4 ? x - 24 : x - 6, height - 6);
    });

    // Target curve polyline smoothed across segment midpoints
    const mids = [0.1, 0.35, 0.675, 0.925];
    const points = [
      { x: padL, y: padT + plotH - (segments[0] / 100) * plotH },
      ...mids.map((m, idx) => ({
        x: padL + m * plotW,
        y: padT + plotH - (segments[idx] / 100) * plotH,
      })),
      { x: padL + plotW, y: padT + plotH - (segments[3] / 100) * plotH },
    ];

    // Fill area under curve
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(6, 182, 212, 0.32)');
    grad.addColorStop(1, 'rgba(6, 182, 212, 0.02)');
    ctx.beginPath();
    ctx.moveTo(points[0].x, padT + plotH);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const xc = (points[i - 1].x + points[i].x) / 2;
      const yc = (points[i - 1].y + points[i].y) / 2;
      ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(points[points.length - 1].x, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Stroke curve
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const xc = (points[i - 1].x + points[i].x) / 2;
      const yc = (points[i - 1].y + points[i].y) / 2;
      ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Segment anchor dots
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Plot actual generated track energy points if available
    if (actualEnergies.length > 0) {
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      actualEnergies.forEach((val, idx) => {
        const px =
          padL +
          (actualEnergies.length === 1 ? 0.5 : idx / (actualEnergies.length - 1)) * plotW;
        const py = padT + plotH - (Math.max(0, Math.min(100, val)) / 100) * plotH;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }, [segments, actualEnergies]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-40 rounded-lg border border-slate-800 bg-[#090d16]"
    />
  );
};
