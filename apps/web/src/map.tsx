// Map view for the command centre. Uses a tenant-configured tile server when set (no paid provider is bundled);
// otherwise draws positions on a plain projected grid. Stale positions are drawn hollow and dashed, never as live.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './ui.tsx';

export interface MapPoint { id: string; lat: number; lon: number; accuracyM?: number; label: string; state: string; freshness: string }
const TILE = 256;
const project = (lat: number, lon: number, z: number) => { const s = TILE * 2 ** z; const x = ((lon + 180) / 360) * s; const r = (lat * Math.PI) / 180; const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s; return { x, y }; };
const COLORS: Record<string, string> = { on_duty: '#1b6e3c', on_break: '#1d4f91', not_started: '#8a5300', exception: '#a4161a', sos: '#b00020', stale_offline: '#4a4f57', checked_out: '#55606e' };

export function LiveMap({ points, selected, onSelect, tileUrl, attribution }: { points: MapPoint[]; selected: string | null; onSelect(id: string): void; tileUrl: string; attribution: string }) {
  const { t } = useApp(); const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [view, setView] = useState<{ z: number; cx: number; cy: number } | null>(null);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  // Fit to the points the first time they arrive.
  useEffect(() => {
    if (view || !points.length) return;
    const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
    let z = 17; for (; z > 2; z--) { const a = project(Math.max(...lats), Math.min(...lons), z), b = project(Math.min(...lats), Math.max(...lons), z); if (b.x - a.x < size.w * 0.8 && b.y - a.y < size.h * 0.8) break; }
    const c = project((Math.max(...lats) + Math.min(...lats)) / 2, (Math.max(...lons) + Math.min(...lons)) / 2, z); setView({ z, cx: c.x, cy: c.y });
  }, [points, size, view]);
  const v = view ?? { z: 3, cx: project(24, 50, 3).x, cy: project(24, 50, 3).y };
  const toScreen = (lat: number, lon: number) => { const p = project(lat, lon, v.z); return { x: p.x - v.cx + size.w / 2, y: p.y - v.cy + size.h / 2 }; };
  const zoom = (d: number) => setView((o) => { const b = o ?? v; const z = Math.max(2, Math.min(19, b.z + d)); const f = 2 ** (z - b.z); return { z, cx: b.cx * f, cy: b.cy * f }; });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const tiles = useMemo(() => {
    if (!tileUrl) return [];
    const out: { key: string; src: string; left: number; top: number }[] = []; const n = 2 ** v.z;
    const x0 = Math.floor((v.cx - size.w / 2) / TILE), x1 = Math.floor((v.cx + size.w / 2) / TILE), y0 = Math.floor((v.cy - size.h / 2) / TILE), y1 = Math.floor((v.cy + size.h / 2) / TILE);
    for (let x = x0; x <= x1; x++) for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) { const wx = ((x % n) + n) % n; out.push({ key: `${v.z}/${x}/${y}`, src: tileUrl.replace('{z}', String(v.z)).replace('{x}', String(wx)).replace('{y}', String(y)), left: x * TILE - v.cx + size.w / 2, top: y * TILE - v.cy + size.h / 2 }); }
    return out;
  }, [tileUrl, v.z, v.cx, v.cy, size.w, size.h]);
  // Grid clustering (FR-CMD-006): nearby markers merge into one counted bubble; SOS and selected markers are never hidden in a cluster.
  const groups = useMemo(() => {
    const cell = 46; const cells = new Map<string, MapPoint[]>(); const singles: MapPoint[] = [];
    for (const p of points) { if (p.state === 'sos' || p.id === selected || points.length < 30) { singles.push(p); continue; } const sp = toScreen(p.lat, p.lon); const k = `${Math.floor(sp.x / cell)}:${Math.floor(sp.y / cell)}`; cells.set(k, [...(cells.get(k) ?? []), p]); }
    const clusters: { key: string; x: number; y: number; members: MapPoint[] }[] = [];
    for (const [k, m] of cells) { if (m.length === 1) { singles.push(m[0]!); continue; } const xs = m.map((p) => toScreen(p.lat, p.lon)); clusters.push({ key: k, x: xs.reduce((a, b) => a + b.x, 0) / xs.length, y: xs.reduce((a, b) => a + b.y, 0) / xs.length, members: m }); }
    return { singles, clusters };
  }, [points, selected, v.z, v.cx, v.cy, size.w, size.h]);
  const mPerPx = (lat: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** v.z;
  return <div className="map" ref={box} role="application" aria-label={t('common.mapView')}
    onPointerDown={(e: any) => { drag.current = { x: e.clientX, y: e.clientY }; }} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}
    onPointerMove={(e: any) => { if (!drag.current) return; const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y; drag.current = { x: e.clientX, y: e.clientY }; setView((o) => { const b = o ?? v; return { ...b, cx: b.cx - dx, cy: b.cy - dy }; }); }}
    onWheel={(e: any) => zoom(e.deltaY < 0 ? 1 : -1)}>
    <div className="tiles">{tiles.map((x) => <img key={x.key} src={x.src} alt="" style={{ left: x.left, top: x.top }} />)}</div>
    <svg viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
      {!tileUrl && Array.from({ length: 30 }, (_, i) => <g key={i}><line x1={i * 64} y1={0} x2={i * 64} y2={size.h} stroke="#c9d3de" /><line x1={0} y1={i * 64} x2={size.w} y2={i * 64} stroke="#c9d3de" /></g>)}
      {groups.clusters.map((c) => { const bad = c.members.filter((m) => m.state === 'exception' || m.freshness === 'stale' || m.freshness === 'unknown').length; return <g key={c.key} transform={`translate(${c.x},${c.y})`} onClick={() => zoom(2)} style={{ cursor: 'zoom-in' }}><circle r={16} fill="#0b4f7a" stroke="#fff" strokeWidth={3} /><text textAnchor="middle" dy={5} fontSize={13} fontWeight={700} fill="#fff">{c.members.length}</text>{bad > 0 && <circle cx={13} cy={-13} r={6} fill="#a4161a" />}</g>; })}
      {groups.singles.map((p) => { const s = toScreen(p.lat, p.lon); const stale = p.freshness === 'stale' || p.freshness === 'unknown'; const c = COLORS[p.state] ?? '#333'; const r = p.accuracyM ? Math.min(400, p.accuracyM / mPerPx(p.lat)) : 0;
        return <g key={p.id} transform={`translate(${s.x},${s.y})`} onClick={() => onSelect(p.id)} style={{ cursor: 'pointer' }}>
          {r > 4 && <circle r={r} fill={c} fillOpacity={0.08} stroke={c} strokeOpacity={0.3} />}
          {p.state === 'sos' && <circle r={18} fill="none" stroke={c} strokeWidth={3}><animate attributeName="r" values="10;22;10" dur="1.2s" repeatCount="indefinite" /></circle>}
          <circle r={selected === p.id ? 10 : 8} fill={stale ? '#fff' : c} stroke={c} strokeWidth={3} strokeDasharray={stale ? '3 2' : undefined} />
          <text y={-14} textAnchor="middle" fontSize={12} fontWeight={600} fill="#17212b" stroke="#fff" strokeWidth={3} paintOrder="stroke">{p.label}</text>
        </g>; })}
    </svg>
    <div className="ctl"><button onClick={() => zoom(1)} aria-label="Zoom in">+</button><button onClick={() => zoom(-1)} aria-label="Zoom out">−</button></div>
    <div className="legend">{tileUrl ? attribution : t('cmd.tilesOff')}</div>
  </div>;
}
