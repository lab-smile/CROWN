"use client";

import { useEffect, useRef, useState, useCallback, useId, useMemo } from "react";
import { Niivue, cmapper } from "@niivue/niivue";
import { AlertTriangle, Eye, Palette, Info, ZoomIn, MapPin, Layers, Box, Download } from "lucide-react";
import { getSimulationResult } from "@/lib/api";
import { COLORMAPS } from "./ViewerControls";
import type { ColormapId } from "./ViewerControls";
import { cn } from "@/lib/utils";

const PANELS = [
  {
    type: "emag",
    label: "E-field Magnitude",
    unit: "V/m",
    description: "Electric field intensity in tissue",
    recommended: true,
    note: null,
  },
  {
    type: "jbrain",
    label: "Current Density (Brain)",
    unit: "A/m²",
    description: "Current density magnitude restricted to brain tissue",
    recommended: false,
    note: "J-map for brain tissue only. Shows how much current reaches cortical and subcortical regions.",
  },
  {
    type: "voltage",
    label: "Voltage",
    unit: "mV",
    description: "Electric potential distribution",
    recommended: false,
    note: "Voltage appears nearly uniform inside brain tissue — the skull (high resistance) absorbs most of the potential drop. Use E-field Magnitude above to assess stimulation strength in the brain.",
  },
] as const;

type OutputType = "emag" | "voltage" | "jbrain";

const OPACITY_PRESETS = [0, 0.25, 0.5, 0.75, 1] as const;

interface RoastViewerProps {
  inputUrl: string;
  sessionId: string;
  modelName: string;
  runId: string;
}

export default function RoastViewer({ inputUrl, sessionId, modelName, runId }: RoastViewerProps) {
  const canvasRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const nvRefs = useRef<(Niivue | null)[]>([null, null, null]);

  const [initialized, setInitialized]       = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.7);
  const [colormap, setColormap]             = useState<ColormapId>("jet");
  const [colormapOpen, setColormapOpen]     = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [loading, setLoading]               = useState(false);
  const [loadErrors, setLoadErrors]         = useState<Partial<Record<OutputType, string>>>({});
  const [calRanges, setCalRanges]           = useState<Partial<Record<OutputType, { min: number; max: number }>>>({});
  // When true, voltage colormap is clipped to the 5–99th percentile to reveal brain-tissue variation
  const [voltageZoomed, setVoltageZoomed]   = useState(false);

  // Electrode placement panels (ROAST only) — combined + two separate viewers
  const canvasElecRef      = useRef<HTMLCanvasElement>(null);
  const canvasGelRef       = useRef<HTMLCanvasElement>(null);
  const canvasCombinedRef  = useRef<HTMLCanvasElement>(null);
  const nvElecRef          = useRef<Niivue | null>(null);
  const nvGelRef           = useRef<Niivue | null>(null);
  const nvCombinedRef      = useRef<Niivue | null>(null);
  const [elecReady, setElecReady]           = useState(false);
  const [elecHasElec, setElecHasElec]       = useState(false);
  const [elecHasGel, setElecHasGel]         = useState(false);
  const [elecError, setElecError]           = useState(false);
  const [elecOpacity, setElecOpacity]       = useState(0.85);
  // Isolation: dim T1 to reveal only the mask
  const [elecIsolated, setElecIsolated]     = useState(false);
  const [gelIsolated, setGelIsolated]       = useState(false);
  // View mode for electrode panels
  const [elecViewMode, setElecViewMode]     = useState<"2d" | "3d">("2d");
  const [elecSlice, setElecSlice]           = useState<"multiplanar" | "axial" | "coronal" | "sagittal">("multiplanar");
  const MASK_BG_DIM = 0.08;

  const colormapDropRef  = useRef<HTMLDivElement>(null);
  const bufferCache      = useRef<Partial<Record<OutputType, ArrayBuffer>>>({});
  const elecBufferCache  = useRef<Partial<Record<"mask_elec" | "mask_gel", ArrayBuffer>>>({});
  const sliderId         = useId();

  // Close colormap dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (colormapDropRef.current && !colormapDropRef.current.contains(e.target as Node))
        setColormapOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const fetchOutput = useCallback(async (type: OutputType): Promise<ArrayBuffer | null> => {
    if (bufferCache.current[type]) return bufferCache.current[type]!;
    try {
      const blob = await getSimulationResult(sessionId, modelName, runId, type);
      const buf  = await blob.arrayBuffer();
      bufferCache.current[type] = buf;
      return buf;
    } catch {
      return null;
    }
  }, [sessionId, modelName, runId]);

  const handleDownload = useCallback(async (type: OutputType) => {
    let buf = bufferCache.current[type];
    if (!buf) buf = await fetchOutput(type) ?? undefined;
    if (!buf) return;
    const blob = new Blob([buf]);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${modelName}_${type}.nii`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fetchOutput, modelName]);

  const handleElecDownload = useCallback((type: "mask_elec" | "mask_gel") => {
    const buf = elecBufferCache.current[type];
    if (!buf) return;
    const blob = new Blob([buf]);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${modelName}_${type}.nii`;
    a.click();
    URL.revokeObjectURL(url);
  }, [modelName]);

  const loadOverlay = useCallback(async (
    nv: Niivue,
    type: OutputType,
    opacity: number,
    cmap: ColormapId,
  ): Promise<boolean> => {
    while (nv.volumes.length > 1) nv.removeVolumeByIndex(1);

    const buf = await fetchOutput(type);
    if (!buf || buf.byteLength === 0) return false;

    await nv.loadFromArrayBuffer(buf.slice(0), `${type}.nii`);
    if (nv.volumes.length < 2) return false;

    const vol = nv.volumes[1];

    // Fix solid-box rendering: ROAST outputs have ~0 values in air (outside the head).
    // colormapType=1 (ZERO_TO_MAX_TRANSPARENT_BELOW_MIN) makes voxels below cal_min
    // fully transparent. We also push cal_min to 1% of max to guarantee air falls below it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vol as any).colormapType = 1;
    const calMax = (vol.cal_max ?? 0) as number;
    const calMin = (vol.cal_min ?? 0) as number;
    if (calMax > 0 && calMin <= 0) {
      vol.cal_min = calMax * 0.01;
    }

    // Store physical range for the colorbar (0 → peak)
    setCalRanges(prev => ({ ...prev, [type]: { min: 0, max: calMax } }));

    nv.setColormap(vol.id, cmap); // calls updateGLVolume internally
    nv.setOpacity(1, opacity);
    nv.drawScene();
    return true;
  }, [fetchOutput]);

  // Initialise both viewers (2D multiplanar only)
  useEffect(() => {
    if (initialized) return;
    if (canvasRefs.some(r => !r.current)) return;
    if (nvRefs.current[0]) { setInitialized(true); return; }

    let mounted = true;

    const init = async () => {
      await new Promise(r => setTimeout(r, 150));
      if (!mounted) return;

      const opts = {
        show3Dcrosshair: true,
        isRadiologicalConvention: true,
        backColor:      [0, 0, 0, 1] as [number, number, number, number],
        crosshairColor: [1, 0, 0, 1] as [number, number, number, number],
      };

      const nvs = canvasRefs.map((ref, i) => {
        const nv = new Niivue(opts);
        nv.attachToCanvas(ref.current!);
        nvRefs.current[i] = nv;
        return nv;
      });

      // Load T1 into both panels
      const resp = await fetch(inputUrl);
      if (!resp.ok) throw new Error("Failed to fetch input image");
      const inputBuf = await resp.arrayBuffer();
      for (const nv of nvs) {
        await nv.loadFromArrayBuffer(inputBuf.slice(0), "input.nii.gz");
        nv.setOpacity(0, 1.0);
        nv.setSliceType(nv.sliceTypeMultiplanar); // 2D only
      }

      // Sync scroll/crosshair between panels
      nvs[0].broadcastTo([nvs[1]], { "2d": true, "3d": false });
      nvs[1].broadcastTo([nvs[0]], { "2d": true, "3d": false });

      if (!mounted) return;
      setInitialized(true);

      setLoading(true);
      const results = await Promise.allSettled(
        PANELS.map((panel, i) => loadOverlay(nvs[i], panel.type, overlayOpacity, colormap))
      );
      const errs: Partial<Record<OutputType, string>> = {};
      results.forEach((r, i) => {
        if (r.status === "rejected" || (r.status === "fulfilled" && !r.value))
          errs[PANELS[i].type] = "Failed to load";
      });
      if (Object.keys(errs).length) setLoadErrors(errs);
      setLoading(false);
    };

    init().catch(e => { if (mounted) setError(String(e)); });

    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputUrl, initialized]);

  // Electrode placement viewers — two panels, run once after main viewers init
  useEffect(() => {
    if (!initialized) return;
    if (nvElecRef.current || nvGelRef.current) return;
    if (!canvasElecRef.current || !canvasGelRef.current || !canvasCombinedRef.current) return;
    let mounted = true;

    const nvOpts = {
      show3Dcrosshair: true,
      isRadiologicalConvention: true,
      backColor:      [0, 0, 0, 1] as [number, number, number, number],
      crosshairColor: [1, 0, 0, 1] as [number, number, number, number],
    };

    const initElec = async () => {
      const nvE = new Niivue(nvOpts);
      const nvG = new Niivue(nvOpts);
      const nvC = new Niivue(nvOpts);
      nvE.attachToCanvas(canvasElecRef.current!);
      nvG.attachToCanvas(canvasGelRef.current!);
      nvC.attachToCanvas(canvasCombinedRef.current!);
      nvElecRef.current    = nvE;
      nvGelRef.current     = nvG;
      nvCombinedRef.current = nvC;

      // Load T1 into all three
      const resp = await fetch(inputUrl);
      if (!resp.ok || !mounted) return;
      const inputBuf = await resp.arrayBuffer();
      await nvE.loadFromArrayBuffer(inputBuf.slice(0), "input.nii.gz");
      await nvG.loadFromArrayBuffer(inputBuf.slice(0), "input.nii.gz");
      await nvC.loadFromArrayBuffer(inputBuf.slice(0), "input.nii.gz");
      nvE.setOpacity(0, 1.0); nvE.setSliceType(nvE.sliceTypeMultiplanar);
      nvG.setOpacity(0, 1.0); nvG.setSliceType(nvG.sliceTypeMultiplanar);
      nvC.setOpacity(0, 1.0); nvC.setSliceType(nvC.sliceTypeMultiplanar);

      // Sync all viewers (electrode + gel + combined + main field viewers)
      const all = [...nvRefs.current.filter(Boolean) as Niivue[], nvE, nvG, nvC];
      all.forEach(a => a.broadcastTo(all.filter(b => b !== a), { "2d": true, "3d": false }));

      // Fetch masks
      const fetchMask = async (type: "mask_elec" | "mask_gel"): Promise<ArrayBuffer | null> => {
        try {
          const blob = await getSimulationResult(sessionId, modelName, runId, type);
          const buf = await blob.arrayBuffer();
          return buf.byteLength > 0 ? buf : null;
        } catch { return null; }
      };

      const [elecBuf, gelBuf] = await Promise.all([fetchMask("mask_elec"), fetchMask("mask_gel")]);
      if (!mounted) return;

      if (!elecBuf && !gelBuf) { setElecError(true); return; }

      // Cache for download
      if (elecBuf) elecBufferCache.current["mask_elec"] = elecBuf;
      if (gelBuf)  elecBufferCache.current["mask_gel"]  = gelBuf;

      // Load into individual viewers + combined
      if (elecBuf) {
        await nvE.loadFromArrayBuffer(elecBuf.slice(0), "mask_elec.nii");
        if (nvE.volumes.length >= 2) {
          const vol = nvE.volumes[1];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (vol as any).colormapType = 1;
          vol.cal_min = 0.5; vol.cal_max = 1.0;
          nvE.setColormap(vol.id, "hot");
          nvE.setOpacity(1, elecOpacity);
        }
        // Combined: electrode at index 1
        await nvC.loadFromArrayBuffer(elecBuf.slice(0), "mask_elec.nii");
        if (nvC.volumes.length >= 2) {
          const vol = nvC.volumes[1];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (vol as any).colormapType = 1;
          vol.cal_min = 0.5; vol.cal_max = 1.0;
          nvC.setColormap(vol.id, "hot");
          nvC.setOpacity(1, elecOpacity);
        }
        setElecHasElec(true);
      }

      if (gelBuf) {
        await nvG.loadFromArrayBuffer(gelBuf.slice(0), "mask_gel.nii");
        if (nvG.volumes.length >= 2) {
          const vol = nvG.volumes[1];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (vol as any).colormapType = 1;
          vol.cal_min = 0.5; vol.cal_max = 1.0;
          nvG.setColormap(vol.id, "winter");
          nvG.setOpacity(1, elecOpacity);
        }
        // Combined: gel at index 2 (after electrode) or 1 (if no electrode)
        await nvC.loadFromArrayBuffer(gelBuf.slice(0), "mask_gel.nii");
        const gelIdx = nvC.volumes.length - 1;
        if (gelIdx >= 1) {
          const vol = nvC.volumes[gelIdx];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (vol as any).colormapType = 1;
          vol.cal_min = 0.5; vol.cal_max = 1.0;
          nvC.setColormap(vol.id, "winter");
          nvC.setOpacity(gelIdx, elecOpacity);
        }
        setElecHasGel(true);
      }

      nvE.drawScene(); nvG.drawScene(); nvC.drawScene();
      if (mounted) setElecReady(true);
    };

    initElec().catch(() => { if (mounted) setElecError(true); });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, inputUrl, sessionId, modelName, runId]);

  // Sync electrode mask opacity across all electrode viewers
  useEffect(() => {
    if (!elecReady) return;
    [nvElecRef, nvGelRef].forEach(ref => {
      if (ref.current && ref.current.volumes.length > 1) {
        ref.current.setOpacity(1, elecOpacity);
        ref.current.drawScene();
      }
    });
    // Combined viewer: sync all overlay volumes
    const nvC = nvCombinedRef.current;
    if (nvC) {
      for (let i = 1; i < nvC.volumes.length; i++) {
        nvC.setOpacity(i, elecOpacity);
      }
      nvC.drawScene();
    }
  }, [elecOpacity, elecReady]);

  // Sync view mode (2D/3D) and slice plane for electrode panels
  useEffect(() => {
    if (!elecReady) return;
    [nvElecRef, nvGelRef, nvCombinedRef].forEach(ref => {
      const nv = ref.current;
      if (!nv) return;
      let st: number;
      if (elecViewMode === "3d") {
        st = nv.sliceTypeRender;
      } else {
        st = elecSlice === "axial"    ? nv.sliceTypeAxial
           : elecSlice === "coronal"  ? nv.sliceTypeCoronal
           : elecSlice === "sagittal" ? nv.sliceTypeSagittal
           : nv.sliceTypeMultiplanar;
      }
      nv.setSliceType(st);
      nv.drawScene();
    });
  }, [elecViewMode, elecSlice, elecReady]);

  // Sync T1 dim when isolating electrode or gel
  useEffect(() => {
    if (!elecReady || !nvElecRef.current) return;
    nvElecRef.current.setOpacity(0, elecIsolated ? MASK_BG_DIM : 1.0);
    nvElecRef.current.drawScene();
  }, [elecIsolated, elecReady]);

  useEffect(() => {
    if (!elecReady || !nvGelRef.current) return;
    nvGelRef.current.setOpacity(0, gelIsolated ? MASK_BG_DIM : 1.0);
    nvGelRef.current.drawScene();
  }, [gelIsolated, elecReady]);

  // Sync opacity
  useEffect(() => {
    if (!initialized) return;
    nvRefs.current.forEach(nv => {
      if (nv && nv.volumes.length > 1) { nv.setOpacity(1, overlayOpacity); nv.drawScene(); }
    });
  }, [overlayOpacity, initialized]);

  // Sync colormap (re-apply transparent-below-min after each change)
  useEffect(() => {
    if (!initialized) return;
    nvRefs.current.forEach(nv => {
      if (nv && nv.volumes.length > 1) {
        const vol = nv.volumes[1];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vol as any).colormapType = 1;
        nv.setColormap(vol.id, colormap);
        nv.drawScene();
      }
    });
  }, [colormap, initialized]);

  // Apply / remove brain-range zoom on the voltage panel (find its index in PANELS)
  const voltageNv = nvRefs.current[PANELS.findIndex(p => p.type === "voltage")];
  useEffect(() => {
    if (!initialized || !voltageNv || voltageNv.volumes.length < 2) return;
    const vol = voltageNv.volumes[1];
    const fullRange = calRanges["voltage"];
    if (!fullRange) return;

    if (voltageZoomed) {
      // Compute 5th–99th percentile of non-zero voxels to reveal brain variation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const img = (vol as any).img as Float32Array | undefined;
      if (img) {
        const nonzero = Array.from(img).filter((v: number) => v > 0).sort((a: number, b: number) => a - b);
        if (nonzero.length > 0) {
          const p05 = nonzero[Math.floor(nonzero.length * 0.05)];
          const p99 = nonzero[Math.floor(nonzero.length * 0.99)];
          vol.cal_min = p05;
          vol.cal_max = p99;
          setCalRanges(prev => ({ ...prev, voltage: { min: p05, max: p99 } }));
        }
      }
    } else {
      // Restore full range
      vol.cal_min = fullRange.min > 0 ? fullRange.max * 0.01 : fullRange.min;
      vol.cal_max = fullRange.max;
      setCalRanges(prev => ({ ...prev, voltage: { min: 0, max: fullRange.max } }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vol as any).colormapType = 1;
    voltageNv.updateGLVolume();
    voltageNv.drawScene();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voltageZoomed, initialized]);

  const currentColormap = COLORMAPS.find(c => c.id === colormap) ?? COLORMAPS[0];

  // Build a CSS linear-gradient string from a Niivue colormap LUT
  const colormapGradient = useMemo(() => {
    try {
      const lut = cmapper.colormap(colormap);
      // Sample 12 evenly-spaced stops from the 256-entry LUT
      const stops = Array.from({ length: 12 }, (_, i) => {
        const idx = Math.round((i / 11) * 255) * 4;
        return `rgb(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]}) ${Math.round((i / 11) * 100)}%`;
      });
      return `linear-gradient(to right, ${stops.join(", ")})`;
    } catch {
      return "linear-gradient(to right, #000, #fff)";
    }
  }, [colormap]);

  return (
    <section aria-label="TES Simulation Viewer" className="space-y-4">
      {error && (
        <div role="alert" className="rounded-lg border border-error/50 bg-error/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-error flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-medium text-error mb-1">Viewer error</h4>
            <p className="text-sm text-error/80">{error}</p>
          </div>
          <button onClick={() => setError(null)} className="text-error/70 hover:text-error text-sm underline">Dismiss</button>
        </div>
      )}

      {/* Compact controls bar — colormap + opacity only (no 3D toggle) */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3">
        {/* Colormap */}
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-foreground-muted" />
          <span className="text-sm text-foreground-muted">Colors:</span>
          <div ref={colormapDropRef} className="relative">
            <button
              onClick={() => setColormapOpen(v => !v)}
              aria-haspopup="listbox"
              aria-expanded={colormapOpen}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <span className="font-medium">{currentColormap.label}</span>
              <svg className={cn("h-4 w-4 transition-transform", colormapOpen && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {colormapOpen && (
              <ul role="listbox" className="absolute left-0 top-full z-50 mt-1 max-h-60 w-48 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
                {COLORMAPS.map(cmap => (
                  <li
                    key={cmap.id}
                    role="option"
                    aria-selected={colormap === cmap.id}
                    onClick={() => { setColormap(cmap.id); setColormapOpen(false); }}
                    className={cn(
                      "cursor-pointer px-3 py-2 text-sm transition-colors hover:bg-surface-elevated",
                      colormap === cmap.id && "bg-accent/10 text-accent"
                    )}
                  >
                    <div className="font-medium">{cmap.label}</div>
                    <div className="text-xs text-foreground-muted">{cmap.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Opacity */}
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-foreground-muted" />
          <span className="text-sm text-foreground-muted" id={`${sliderId}-label`}>Overlay:</span>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
            {OPACITY_PRESETS.map(v => (
              <button
                key={v}
                onClick={() => setOverlayOpacity(v)}
                aria-pressed={Math.abs(overlayOpacity - v) < 0.01}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                  Math.abs(overlayOpacity - v) < 0.01
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground-secondary hover:text-foreground"
                )}
              >
                {Math.round(v * 100)}%
              </button>
            ))}
          </div>
          <input
            id={sliderId}
            type="range" min="0" max="1" step="0.05"
            value={overlayOpacity}
            onChange={e => setOverlayOpacity(parseFloat(e.target.value))}
            aria-labelledby={`${sliderId}-label`}
            className="h-2 w-24 cursor-pointer appearance-none rounded-lg bg-border accent-accent focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="w-10 text-right text-xs text-foreground-muted">{Math.round(overlayOpacity * 100)}%</span>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-foreground-muted ml-auto">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            Loading outputs...
          </div>
        )}
      </div>

      {/* Full-width stacked panels */}
      <div className="flex flex-col gap-4">
        {PANELS.map((panel, i) => (
          <article key={panel.type} className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden">
            <header className="border-b border-border px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{panel.label}</h3>
                    {panel.recommended && (
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-foreground-muted mt-0.5">{panel.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {panel.type === "voltage" && initialized && !loadErrors[panel.type] && (
                  <button
                    type="button"
                    onClick={() => setVoltageZoomed(v => !v)}
                    title={voltageZoomed ? "Reset to full range" : "Zoom colormap to brain-tissue range"}
                    className={cn(
                      "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                      voltageZoomed
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-background text-foreground-muted hover:border-accent/40 hover:text-foreground",
                    )}
                  >
                    <ZoomIn className="h-3 w-3" aria-hidden="true" />
                    {voltageZoomed ? "Zoomed" : "Zoom to brain"}
                  </button>
                )}
                <span className="text-xs font-mono text-foreground-muted bg-border/50 px-2 py-0.5 rounded">
                  {panel.unit}
                </span>
                <button
                  type="button"
                  onClick={() => handleDownload(panel.type)}
                  disabled={!!loadErrors[panel.type] || !initialized}
                  title={`Download ${panel.label}`}
                  className="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  .nii
                </button>
              </div>
            </header>

            {initialized && loadErrors[panel.type] ? (
              <div className="flex items-center gap-3 px-4 py-5 text-foreground-muted">
                <AlertTriangle className="h-4 w-4 shrink-0 text-foreground-muted/60" />
                <p className="text-sm">
                  {panel.label} output is not yet available — the simulation may still be running, or this file was not produced by the solver.
                </p>
              </div>
            ) : (
              <div className="relative bg-black" style={{ height: "500px" }}>
                <canvas
                  ref={canvasRefs[i]}
                  width={512}
                  height={512}
                  style={{ width: "100%", height: "100%" }}
                  aria-label={`${panel.label} ROAST viewer`}
                />
                {!initialized && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                      <span className="text-sm text-foreground-muted">Initializing viewer...</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Scalar colorbar */}
            {initialized && !loadErrors[panel.type] && (
              <div className="px-4 py-3 border-t border-border bg-surface space-y-2.5">
                <div className="flex items-center gap-3">
                  <span className="w-10 text-right text-xs font-mono text-foreground-muted tabular-nums">
                    {calRanges[panel.type] ? calRanges[panel.type]!.min.toFixed(2) : "0.00"}
                  </span>
                  <div
                    className="flex-1 h-4 rounded"
                    style={{ background: colormapGradient }}
                    aria-label={`${panel.label} colormap scale`}
                  />
                  <span className="w-14 text-left text-xs font-mono text-foreground-muted tabular-nums">
                    {calRanges[panel.type]
                      ? `${calRanges[panel.type]!.max.toFixed(2)} ${panel.unit}`
                      : `— ${panel.unit}`}
                  </span>
                </div>
                {panel.note && (
                  <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-background px-3 py-2">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-muted" aria-hidden="true" />
                    <p className="text-[11px] leading-snug text-foreground-muted">{panel.note}</p>
                  </div>
                )}
              </div>
            )}
          </article>
        ))}

        {/* Electrode placement panels */}
        <>
          {/* Controls bar */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-foreground-muted" aria-hidden="true" />
              <span className="text-sm font-semibold text-foreground">Electrode Placement</span>
            </div>

            {/* 2D / 3D toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
              <button
                onClick={() => setElecViewMode("2d")}
                aria-pressed={elecViewMode === "2d"}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                  elecViewMode === "2d" ? "bg-accent text-accent-foreground" : "text-foreground-secondary hover:text-foreground"
                )}
              >
                <Layers className="h-3 w-3" aria-hidden="true" />
                2D
              </button>
              <button
                onClick={() => setElecViewMode("3d")}
                aria-pressed={elecViewMode === "3d"}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                  elecViewMode === "3d" ? "bg-accent text-accent-foreground" : "text-foreground-secondary hover:text-foreground"
                )}
              >
                <Box className="h-3 w-3" aria-hidden="true" />
                3D
              </button>
            </div>

            {/* Slice plane selector (2D only) */}
            {elecViewMode === "2d" && (
              <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
                {(["multiplanar", "axial", "coronal", "sagittal"] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setElecSlice(s)}
                    aria-pressed={elecSlice === s}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                      elecSlice === s ? "bg-accent text-accent-foreground" : "text-foreground-secondary hover:text-foreground"
                    )}
                  >
                    {s === "multiplanar" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            )}

            {/* Overlay opacity */}
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-foreground-muted" />
              <span className="text-sm text-foreground-muted">Overlay:</span>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
                {OPACITY_PRESETS.map(v => (
                  <button
                    key={v}
                    onClick={() => setElecOpacity(v)}
                    aria-pressed={Math.abs(elecOpacity - v) < 0.01}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                      Math.abs(elecOpacity - v) < 0.01
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground-secondary hover:text-foreground"
                    )}
                  >
                    {Math.round(v * 100)}%
                  </button>
                ))}
              </div>
            </div>

            {!elecReady && !elecError && (
              <div className="ml-auto flex items-center gap-2 text-sm text-foreground-muted">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                Loading masks…
              </div>
            )}
          </div>

          {elecError ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-5 text-foreground-muted">
              <AlertTriangle className="h-4 w-4 shrink-0 text-foreground-muted/60" />
              <p className="text-sm">Electrode mask files not found — run the simulation to generate placement data.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Combined view — full-width primary panel showing both masks simultaneously */}
              <article className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden">
                <header className="border-b border-border px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#ff6000]" aria-hidden="true" />
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#0080ff]" aria-hidden="true" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">Combined Placement</h3>
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">Recommended</span>
                    <p className="text-xs text-foreground-muted hidden sm:block">Both electrode pad and gel layer overlaid on anatomy</p>
                  </div>
                </header>
                <div className="relative bg-black" style={{ height: elecViewMode === "3d" ? "600px" : "560px" }}>
                  <canvas
                    ref={canvasCombinedRef}
                    width={512}
                    height={512}
                    style={{ width: "100%", height: "100%" }}
                    aria-label="Combined electrode and gel placement viewer"
                  />
                  {!elecReady && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                        <span className="text-sm text-foreground-muted">Initializing viewer…</span>
                      </div>
                    </div>
                  )}
                </div>
                {/* Color legend */}
                <div className="border-t border-border px-4 py-3 flex items-center gap-6">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">Legend</span>
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-5 rounded-[3px] bg-[#ff6000]" aria-hidden="true" />
                    <span className="text-xs text-foreground-secondary">Electrode Pad</span>
                    <span className="text-xs font-mono text-foreground-muted bg-border/50 px-1.5 py-0.5 rounded">mask_elec</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-5 rounded-[3px] bg-[#0080ff]" aria-hidden="true" />
                    <span className="text-xs text-foreground-secondary">Gel Layer</span>
                    <span className="text-xs font-mono text-foreground-muted bg-border/50 px-1.5 py-0.5 rounded">mask_gel</span>
                  </div>
                  {elecViewMode === "3d" && (
                    <span className="ml-auto text-[11px] text-foreground-muted">Click + drag to rotate · Scroll to zoom</span>
                  )}
                </div>
              </article>

              {/* Individual panels — side by side */}
              <div className="grid gap-4 md:grid-cols-2">
                {/* Electrode rubber panel */}
                <article className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden">
                  <header className="border-b border-border px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#ff6000]" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-foreground">Electrode Pad</h3>
                      <p className="text-xs text-foreground-muted">Rubber contact mask</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-foreground-muted bg-border/50 px-2 py-0.5 rounded">mask_elec</span>
                      <button
                        type="button"
                        onClick={() => handleElecDownload("mask_elec")}
                        disabled={!elecHasElec}
                        title="Download electrode mask"
                        className="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Download className="h-3 w-3" aria-hidden="true" />
                        .nii
                      </button>
                    </div>
                  </header>
                  <div className="relative bg-black" style={{ height: elecViewMode === "3d" ? "500px" : "460px" }}>
                    <canvas
                      ref={canvasElecRef}
                      width={512}
                      height={512}
                      style={{ width: "100%", height: "100%" }}
                      aria-label="Electrode rubber placement viewer"
                    />
                    {!elecReady && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-2">
                          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                          <span className="text-sm text-foreground-muted">Initializing viewer…</span>
                        </div>
                      </div>
                    )}
                    {elecReady && !elecHasElec && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                        <p className="text-sm text-foreground-muted">No electrode mask available</p>
                      </div>
                    )}
                  </div>
                  {elecReady && elecHasElec && (
                    <div className="border-t border-border px-4 py-2.5 flex items-center gap-4">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">Isolate</span>
                      <button
                        type="button"
                        onClick={() => setElecIsolated(false)}
                        title="Show T1 anatomy"
                        className="flex items-center gap-1.5 text-xs transition-opacity focus:outline-none"
                        style={{ opacity: elecIsolated ? 0.3 : 1 }}
                      >
                        <span className="inline-block h-3 w-3 rounded-[3px] bg-foreground-muted/40 ring-1 ring-white/10" style={{ transform: !elecIsolated ? "scale(1.4)" : "scale(1)", boxShadow: !elecIsolated ? "0 0 0 2px white, 0 0 0 3px gray" : undefined }} />
                        <span className={cn("whitespace-nowrap", !elecIsolated ? "font-semibold text-foreground" : "text-foreground-secondary")}>T1 Anatomy</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setElecIsolated(true)}
                        title="Isolate electrode mask"
                        className="flex items-center gap-1.5 text-xs transition-opacity focus:outline-none"
                        style={{ opacity: !elecIsolated ? 0.5 : 1 }}
                      >
                        <span className="inline-block h-3 w-3 rounded-[3px] bg-[#ff6000] ring-1 ring-white/10" style={{ transform: elecIsolated ? "scale(1.4)" : "scale(1)", boxShadow: elecIsolated ? "0 0 0 2px white, 0 0 0 3px #ff6000" : undefined }} />
                        <span className={cn("whitespace-nowrap", elecIsolated ? "font-semibold text-foreground" : "text-foreground-secondary")}>Electrode Only</span>
                      </button>
                      {elecIsolated && (
                        <button type="button" onClick={() => setElecIsolated(false)} className="ml-auto text-[10px] text-foreground-muted hover:text-foreground underline underline-offset-2">
                          Show all
                        </button>
                      )}
                    </div>
                  )}
                </article>

                {/* Gel layer panel */}
                <article className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden">
                  <header className="border-b border-border px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#0080ff]" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-foreground">Gel Layer</h3>
                      <p className="text-xs text-foreground-muted">Conductive gel mask</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-foreground-muted bg-border/50 px-2 py-0.5 rounded">mask_gel</span>
                      <button
                        type="button"
                        onClick={() => handleElecDownload("mask_gel")}
                        disabled={!elecHasGel}
                        title="Download gel layer mask"
                        className="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Download className="h-3 w-3" aria-hidden="true" />
                        .nii
                      </button>
                    </div>
                  </header>
                  <div className="relative bg-black" style={{ height: elecViewMode === "3d" ? "500px" : "460px" }}>
                    <canvas
                      ref={canvasGelRef}
                      width={512}
                      height={512}
                      style={{ width: "100%", height: "100%" }}
                      aria-label="Gel layer placement viewer"
                    />
                    {!elecReady && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-2">
                          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                          <span className="text-sm text-foreground-muted">Initializing viewer…</span>
                        </div>
                      </div>
                    )}
                    {elecReady && !elecHasGel && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                        <p className="text-sm text-foreground-muted">No gel mask available</p>
                      </div>
                    )}
                  </div>
                  {elecReady && elecHasGel && (
                    <div className="border-t border-border px-4 py-2.5 flex items-center gap-4">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">Isolate</span>
                      <button
                        type="button"
                        onClick={() => setGelIsolated(false)}
                        title="Show T1 anatomy"
                        className="flex items-center gap-1.5 text-xs transition-opacity focus:outline-none"
                        style={{ opacity: gelIsolated ? 0.3 : 1 }}
                      >
                        <span className="inline-block h-3 w-3 rounded-[3px] bg-foreground-muted/40 ring-1 ring-white/10" style={{ transform: !gelIsolated ? "scale(1.4)" : "scale(1)", boxShadow: !gelIsolated ? "0 0 0 2px white, 0 0 0 3px gray" : undefined }} />
                        <span className={cn("whitespace-nowrap", !gelIsolated ? "font-semibold text-foreground" : "text-foreground-secondary")}>T1 Anatomy</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setGelIsolated(true)}
                        title="Isolate gel mask"
                        className="flex items-center gap-1.5 text-xs transition-opacity focus:outline-none"
                        style={{ opacity: !gelIsolated ? 0.5 : 1 }}
                      >
                        <span className="inline-block h-3 w-3 rounded-[3px] bg-[#0080ff] ring-1 ring-white/10" style={{ transform: gelIsolated ? "scale(1.4)" : "scale(1)", boxShadow: gelIsolated ? "0 0 0 2px white, 0 0 0 3px #0080ff" : undefined }} />
                        <span className={cn("whitespace-nowrap", gelIsolated ? "font-semibold text-foreground" : "text-foreground-secondary")}>Gel Only</span>
                      </button>
                      {gelIsolated && (
                        <button type="button" onClick={() => setGelIsolated(false)} className="ml-auto text-[10px] text-foreground-muted hover:text-foreground underline underline-offset-2">
                          Show all
                        </button>
                      )}
                    </div>
                  )}
                </article>
              </div>
            </div>
          )}
        </>
      </div>

      <p className="text-xs text-foreground-muted">
        Panels are scroll-synchronized. Results shown as overlay on T1 anatomy.
      </p>
    </section>
  );
}
