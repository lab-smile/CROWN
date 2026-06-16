"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Zap, Check, AlertTriangle, Construction,
  RotateCcw, ChevronDown, Cpu, MemoryStick,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useJob } from "@/context/JobContext";
import {
  MONTAGE_PRESETS,
  ALL_POSITIONS,
  buildRecipe,
  buildElectype,
  type ElectrodeConfig,
} from "@/app/components/wizard/steps/ElectrodeConfigPanel";
import SplitViewer from "@/app/components/viewer/SplitViewer";
import RoastViewer from "@/app/components/viewer/RoastViewer";
import LeaveGuardModal from "@/app/components/LeaveGuardModal";
import {
  startSimulation,
  connectROASTSSE,
  getHealth,
  getSimulationStatus,
  API_BASE,
  type HealthResponse,
} from "@/lib/api";
import { loadSegSession } from "@/context/JobContext";

// ─── localStorage key for job persistence across refreshes ───────────────────
const ACTIVE_SIM_KEY = "grace_active_sim";
type SavedSim = { sessionId: string; model: string; startedAt: number };

function saveActiveSim(s: SavedSim) {
  try { localStorage.setItem(ACTIVE_SIM_KEY, JSON.stringify(s)); } catch {}
}
function clearActiveSim() {
  try { localStorage.removeItem(ACTIVE_SIM_KEY); } catch {}
}
function loadActiveSim(): SavedSim | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SIM_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSim;
    // Discard jobs older than 4 hours
    if (Date.now() - s.startedAt > 4 * 3600 * 1000) { clearActiveSim(); return null; }
    return s;
  } catch { return null; }
}

// ─── Step label maps ──────────────────────────────────────────────────────────
const ROAST_STEP_LABELS: Record<string, string> = {
  roast_queued:              "Queued",
  roast_start:               "Starting",
  roast_prepare:             "Preparing files",
  roast_seg8:                "Registering T1 to template",
  roast_seg8_done:           "T1 registration complete",
  roast_step_csf_fix:        "Fixing CSF",
  roast_step_electrode:      "Placing electrodes",
  roast_step_el_measure:     "Measuring head size",
  roast_step_el_cap:         "Fitting electrode cap",
  roast_step_el_f3:          "Placing anode electrode",
  roast_step_el_f4:          "Placing cathode electrode",
  roast_step_el_cleanup:     "Finalizing electrode placement",
  roast_step_mesh:           "Generating mesh",
  roast_step_mesh_sizing:    "Computing mesh sizes",
  roast_step_mesh_done:      "Mesh generation complete",
  roast_step_mesh_saving:    "Saving mesh",
  roast_step_solve:          "Setting up FEM solver",
  roast_step_solve_pre:      "Pre-processing FEM system",
  roast_step_solve_gen:      "Assembling stiffness matrix",
  roast_step_solve_fem:      "Solving linear system",
  roast_step_solve_post:     "Post-processing FEM solution",
  roast_step_solve_save:     "Saving FEM solution",
  roast_step_postprocess:    "Post-processing",
  roast_step_post_convert:   "Converting results",
  roast_step_post_jroast:    "Computing current density",
  roast_step_post_save:      "Saving final results",
  roast_step_post_done:      "Results saved",
  roast_complete:            "Complete",
};

// ─── Types ────────────────────────────────────────────────────────────────────
type RunStatus = "pending" | "running" | "complete" | "error";

interface RunConfig {
  anode:         string;
  cathode:       string;
  currentMa:     number;
  electrodeType: string;
  quality:       "fast" | "standard";
}

interface RunState {
  status:      RunStatus;
  progress:    number;
  step:        string;
  error?:      string;
  config?:     RunConfig;
  completedAt?: number;
  runId?:      string;
}

type PanelView =
  | { type: "segmentation" }
  | { type: "roast"; model: string; runKey: string };

// Key includes anode+cathode so each distinct montage gets its own tab.
function runKey(model: string, anode: string, cathode: string) {
  return `${model}:roast:${anode}:${cathode}`;
}
function getDisplayName(model: string) {
  return model.replace("-native", "").replace("-fs", "").toUpperCase();
}
function getSpaceLabel(model: string) {
  if (model.includes("-native")) return "Native";
  if (model.includes("-fs"))     return "FS";
  return "";
}

// ─── Small helpers ────────────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-accent">
      {"// "}{children}
    </p>
  );
}

function RunCard({ label, badge, state }: {
  label: string;
  badge: string;
  state: RunState;
}) {
  const { status, progress, step, error } = state;
  const isRunning  = status === "running";
  const isComplete = status === "complete";
  const isError    = status === "error";
  const isPending  = status === "pending";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground-muted">
          {label}
          <span className={cn(
            "ml-1.5 rounded px-1 py-0.5 text-[10px] font-semibold",
            isComplete ? "bg-success/15 text-success" :
            isError    ? "bg-error/15 text-error" :
            isRunning  ? "bg-accent/15 text-accent" :
                         "bg-border/60 text-foreground-muted",
          )}>
            {badge}
          </span>
        </span>
        <span className={cn(
          "text-[11px] font-medium tabular-nums",
          isComplete ? "text-success" :
          isError    ? "text-error" :
          isRunning  ? "text-accent" :
                       "text-foreground-muted",
        )}>
          {isComplete ? "✓" : isError ? "✗" : `${progress}%`}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            isComplete ? "bg-success" :
            isError    ? "bg-error" :
                         "bg-accent",
          )}
          style={{ width: `${isError ? 100 : progress}%` }}
        />
      </div>
      <p className="truncate text-[10px] text-foreground-muted">
        {isRunning  && step}
        {isPending  && "Waiting in queue…"}
        {isError    && error}
        {isComplete && "Done"}
      </p>
    </div>
  );
}

// ─── TESPage ──────────────────────────────────────────────────────────────────
export default function TESPage() {
  const router = useRouter();
  const { sessionId: ctxSessionId, models: ctxModels, inputBlobUrl } = useJob();

  // Recover from localStorage if context was cleared (page reload / deployment)
  const [recovered] = useState(() => loadSegSession());
  const sessionId = ctxSessionId ?? recovered?.sessionId ?? null;
  const models    = ctxModels.length > 0 ? ctxModels : (recovered?.models ?? []);
  // Use blob URL when available; fall back to API endpoint after reload
  const inputUrl  = inputBlobUrl ?? (sessionId ? `${API_BASE}/results/${sessionId}/input` : null);

  // Config
  const [selectedModels, setSelectedModels]     = useState<string[]>([]);
  const [quality, setQuality]                   = useState<"fast" | "standard">("fast");
  const [segSource, setSegSource]               = useState<"nn" | "roast">("nn");
  const [electrodeConfig, setElectrodeConfig]   = useState<ElectrodeConfig>({
    anode: "F3", cathode: "F4", currentMa: 2, electrodeType: "pad",
  });

  // Run state
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const runQueueRef = useRef<{ model: string; key: string }[]>([]);
  const runningRef  = useRef(false);

  // Right-panel view
  const [panelView, setPanelView] = useState<PanelView>({ type: "segmentation" });

  // Leave guard
  const [leaveGuardOpen, setLeaveGuardOpen] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);

  // Show leave guard before running away from the page
  const guardedBack = useCallback(() => {
    setLeaveGuardOpen(true);
    pendingLeaveRef.current = () => router.back();
  }, [router]);

  // Guard both browser back (popstate) and tab/window close (beforeunload).
  // Next.js App Router handles back-button as client-side popstate navigation,
  // so beforeunload alone does not intercept it.
  useEffect(() => {
    // Push a duplicate history entry so the first back-press lands here
    // instead of immediately leaving; we then show the modal.
    window.history.pushState(null, "", window.location.href);

    const onPopState = () => {
      // Re-push to stay on this page, then open the guard modal.
      window.history.pushState(null, "", window.location.href);
      setLeaveGuardOpen(true);
      pendingLeaveRef.current = () => {
        // Remove listener before navigating so we don't loop.
        window.removeEventListener("popstate", onPopState);
        router.back();
        // back() will pop twice: our synthetic entry + the real one.
        router.back();
      };
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [router]);

  // ── Reconnect state (for page-refresh recovery) ───────────────────────────
  type ReconnectStatus = "checking" | "running" | "complete" | "none";
  const [reconnect, setReconnect] = useState<{ sim: SavedSim; status: ReconnectStatus; progress: number; step: string } | null>(null);

  useEffect(() => {
    if (sessionId) return; // already have a session, no need to recover
    const sim = loadActiveSim();
    if (!sim) return;
    setReconnect({ sim, status: "checking", progress: 0, step: "" });
    getSimulationStatus(sim.sessionId, sim.model)
      .then(({ status, progress }) => {
        if (status === "running" || status === "queued") {
          setReconnect(r => r && ({ ...r, status: "running", progress }));
          // Reattach SSE to show live progress
          connectROASTSSE(sim.sessionId, (evt) => {
            if (evt.type === "progress") {
              setReconnect(r => r && ({ ...r, progress: evt.progress ?? 0, step: evt.event ? (ROAST_STEP_LABELS[evt.event] ?? evt.event) : "" }));
            }
            if (evt.type === "complete") {
              clearActiveSim();
              setReconnect(r => r && ({ ...r, status: "complete", progress: 100, step: "Complete" }));
            }
            if (evt.type === "error") {
              clearActiveSim();
              setReconnect(null);
            }
          });
        } else if (status === "complete") {
          clearActiveSim();
          setReconnect(r => r && ({ ...r, status: "complete", progress: 100, step: "Complete" }));
        } else {
          clearActiveSim();
          setReconnect(null);
        }
      })
      .catch(() => { clearActiveSim(); setReconnect(null); });
  }, [sessionId]);

  // Resource health
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    const load = async () => setHealth(await getHealth());
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // ── Queue helpers ─────────────────────────────────────────────────────────
  const setRunState = useCallback((key: string, patch: Partial<RunState>) => {
    setRunStates(prev => ({
      ...prev,
      [key]: { ...{ status: "pending", progress: 0, step: "" }, ...prev[key], ...patch },
    }));
  }, []);

  const processQueue = useCallback(async () => {
    if (runningRef.current) return;
    const next = runQueueRef.current.shift();
    if (!next) { runningRef.current = false; return; }

    runningRef.current = true;
    const key      = next.key;
    const recipe   = buildRecipe(electrodeConfig);
    const electype = buildElectype(electrodeConfig);

    setRunState(key, { status: "running", progress: 2, step: "Starting…" });
    try {
      const { run_id } = await startSimulation(sessionId!, next.model, quality, recipe, electype, segSource);
      setRunState(key, { status: "running", progress: 2, step: "Starting…", runId: run_id });
    } catch (e: unknown) {
      setRunState(key, { status: "error", error: (e as Error).message });
      runningRef.current = false;
      processQueue();
      return;
    }
    saveActiveSim({ sessionId: sessionId!, model: next.model, startedAt: Date.now() });
    connectROASTSSE(sessionId!, (evt) => {
      if (evt.type === "progress") {
        setRunState(key, {
          status: "running", progress: evt.progress ?? 0,
          step: evt.event ? (ROAST_STEP_LABELS[evt.event] ?? evt.event) : "",
        });
      }
      if (evt.type === "complete") {
        clearActiveSim();
        setRunState(key, { status: "complete", progress: 100, step: "Complete", completedAt: Date.now() });
        setPanelView({ type: "roast", model: next.model, runKey: key });
        runningRef.current = false;
        processQueue();
      }
      if (evt.type === "error") {
        clearActiveSim();
        setRunState(key, { status: "error", error: evt.detail || "ROAST error" });
        runningRef.current = false;
        processQueue();
      }
    }, () => {
      // SSE dropped without complete/error — unblock the queue
      clearActiveSim();
      setRunState(key, { status: "error", error: "Connection lost — simulation may still be running." });
      runningRef.current = false;
      processQueue();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, quality, electrodeConfig, segSource]);

  const startAllRuns = useCallback(() => {
    if (!sessionId || selectedModels.length === 0) return;

    const configSnapshot: RunConfig = {
      anode:         electrodeConfig.anode,
      cathode:       electrodeConfig.cathode,
      currentMa:     electrodeConfig.currentMa,
      electrodeType: electrodeConfig.electrodeType,
      quality,
    };

    const queue: { model: string; key: string }[] = [];
    const init: Record<string, RunState> = {};
    for (const m of selectedModels) {
      const k = runKey(m, configSnapshot.anode, configSnapshot.cathode);
      queue.push({ model: m, key: k });
      init[k] = { status: "pending", progress: 0, step: "Queued", config: configSnapshot };
    }
    // Merge into existing state so previously completed runs keep their tabs.
    setRunStates(prev => ({ ...prev, ...init }));
    runQueueRef.current = queue;
    runningRef.current  = false;
    processQueue();
  }, [selectedModels, processQueue, sessionId, electrodeConfig, quality]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const runEntries = Object.entries(runStates);
  const hasRuns    = runEntries.length > 0;
  const isRunning  = runEntries.some(([, r]) => r.status === "running");
  const allDone    = hasRuns && runEntries.every(([, r]) => r.status === "complete" || r.status === "error");

  // Each distinct model:anode:cathode run gets its own tab.
  type VisibleRun = { key: string; model: string; state: RunState };
  const visibleRuns: VisibleRun[] = runEntries
    .filter(([, s]) => s.status === "complete" || s.status === "running")
    .map(([key, state]) => ({ key, model: key.split(":")[0], state }));
  const completedCount = visibleRuns.filter(r => r.state.status === "complete").length;

  // ── No-session guard ──────────────────────────────────────────────────────
  if (!sessionId || !inputUrl) {
    // If we found a saved job, show reconnect UI instead of error
    if (reconnect && reconnect.status !== "none") {
      const { sim, status, progress, step } = reconnect;
      const modelLabel = sim.model.replace("-native", "").replace("-fs", "").toUpperCase();
      const isChecking = status === "checking";
      const isRunning  = status === "running";
      const isDone     = status === "complete";

      return (
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-6">
          <div className="w-full max-w-md space-y-5 rounded-2xl border border-border bg-surface p-6">
            <div className="space-y-1">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-accent">
                {isChecking ? "Reconnecting…" : isRunning ? "Simulation in progress" : "Simulation complete"}
              </p>
              <p className="text-sm text-foreground-muted">
                {isDone
                  ? `Your ROAST simulation for ${modelLabel} finished while you were away.`
                  : `Your ROAST simulation for ${modelLabel} is still running in the background.`}
              </p>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-foreground-muted">
                <span>{isChecking ? "Checking status…" : step || (isDone ? "Done" : "Running…")}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-border overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", isDone ? "bg-success" : "bg-accent")}
                  style={{ width: `${isChecking ? 0 : progress}%` }}
                />
              </div>
            </div>

            {isDone && (
              <div className="grid grid-cols-4 gap-2">
                {["voltage", "emag", "efield", "jbrain"].map(t => (
                  <a
                    key={t}
                    href={`${API_BASE}/simulate/results/${sim.sessionId}/${sim.model}/${t}`}
                    download
                    className="flex flex-col items-center gap-1 rounded-lg border border-border bg-background p-2 text-center text-[10px] font-mono font-bold uppercase tracking-widest text-foreground hover:border-accent hover:text-accent transition-colors"
                  >
                    <span className="text-base">⬇</span>
                    {t}
                  </a>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="flex-1 text-xs" onClick={() => { clearActiveSim(); setReconnect(null); }}>
                Dismiss
              </Button>
              <Button variant="accent" size="sm" className="flex-1 text-xs" onClick={() => router.push("/")}>
                New segmentation
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <div className="space-y-4 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-warning" />
          <p className="text-foreground-secondary">No active session. Run a segmentation first.</p>
          <Button variant="accent" onClick={() => router.push("/")}>Go to Segmentation</Button>
        </div>
      </div>
    );
  }

  // ── Tab helpers ───────────────────────────────────────────────────────────
  const isPanelActive = (v: PanelView) => {
    if (panelView.type !== v.type) return false;
    if ("runKey" in panelView && "runKey" in v) return panelView.runKey === (v as { runKey: string }).runKey;
    if ("model" in panelView && "model" in v) return panelView.model === v.model;
    return true;
  };

  const tabCls = (active: boolean) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-all focus:outline-none focus:ring-2 focus:ring-ring",
    active
      ? "bg-accent/10 text-accent"
      : "text-foreground-muted hover:bg-surface-elevated hover:text-foreground",
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">

      {/* ═══════════════════════ LEFT PANEL ═══════════════════════════════ */}
      <aside className="flex w-[22rem] shrink-0 flex-col border-r border-border bg-surface">

        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <button
            onClick={guardedBack}
            className="flex items-center gap-1.5 text-sm text-foreground-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="ml-auto flex items-center gap-2">
            <div className="rounded-md bg-accent/15 p-1">
              <Zap className="h-3.5 w-3.5 text-accent" />
            </div>
            <span className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">tDCS Simulation</span>
          </div>
        </div>

        {/* Scrollable config */}
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">

          {/* ── Models ── */}
          <div>
            <SectionLabel>Models</SectionLabel>
            <div className="space-y-1.5">
              {models.map(model => {
                const on = selectedModels.includes(model);
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() =>
                      setSelectedModels(prev =>
                        prev.includes(model) ? prev.filter(m => m !== model) : [...prev, model],
                      )
                    }
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                      on
                        ? "border-accent/50 bg-accent/10 text-foreground"
                        : "border-border bg-background text-foreground-muted hover:border-accent/30 hover:text-foreground",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border-2",
                        on ? "border-accent bg-accent" : "border-border",
                      )}>
                        {on && <Check className="h-2.5 w-2.5 text-white" />}
                      </div>
                      <span className="font-mono font-semibold tracking-wide">{getDisplayName(model)}</span>
                    </div>
                    <span className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      on ? "bg-accent/15 text-accent" : "bg-border/50 text-foreground-muted",
                    )}>
                      {getSpaceLabel(model)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Montage presets ── */}
          <div>
            <SectionLabel>Montage Preset</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {MONTAGE_PRESETS.map(preset => {
                const active =
                  preset.anode     === electrodeConfig.anode &&
                  preset.cathode   === electrodeConfig.cathode &&
                  preset.currentMa === electrodeConfig.currentMa;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    title={`${preset.label} — ${preset.description}`}
                    onClick={() =>
                      setElectrodeConfig(prev => ({
                        ...prev,
                        anode:     preset.anode,
                        cathode:   preset.cathode,
                        currentMa: preset.currentMa,
                      }))
                    }
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] font-medium transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-background text-foreground-muted hover:border-accent/30 hover:text-foreground",
                    )}
                  >
                    {preset.anode}→{preset.cathode}
                  </button>
                );
              })}
            </div>
            {(() => {
              const match = MONTAGE_PRESETS.find(
                p => p.anode === electrodeConfig.anode && p.cathode === electrodeConfig.cathode,
              );
              return match
                ? <p className="mt-1.5 text-[11px] text-foreground-muted">{match.description}</p>
                : null;
            })()}
          </div>

          {/* ── Anode / Cathode ── */}
          <div>
            <SectionLabel>Electrodes</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {(["anode", "cathode"] as const).map(role => (
                <div key={role}>
                  <label className="mb-1 block text-[11px] text-foreground-muted">
                    {role === "anode" ? "Anode (+)" : "Cathode (−)"}
                  </label>
                  <div className="relative">
                    <select
                      value={electrodeConfig[role]}
                      onChange={e =>
                        setElectrodeConfig(prev => ({ ...prev, [role]: e.target.value }))
                      }
                      className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2 pr-7 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {ALL_POSITIONS.filter(
                        p => p !== (role === "anode" ? electrodeConfig.cathode : electrodeConfig.anode),
                      ).map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Current ── */}
          <div>
            <SectionLabel>Current — {electrodeConfig.currentMa} mA</SectionLabel>
            <div className="flex gap-1.5">
              {[0.5, 1, 1.5, 2, 3, 4].map(mA => (
                <button
                  key={mA}
                  type="button"
                  onClick={() => setElectrodeConfig(prev => ({ ...prev, currentMa: mA }))}
                  className={cn(
                    "flex-1 rounded-md border py-1.5 text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                    electrodeConfig.currentMa === mA
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border bg-background text-foreground-muted hover:border-accent/30",
                  )}
                >
                  {mA}
                </button>
              ))}
            </div>
          </div>

          {/* ── Electrode type ── */}
          <div>
            <SectionLabel>Electrode Type</SectionLabel>
            <div className="flex gap-2">
              {(["pad", "ring"] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setElectrodeConfig(prev => ({ ...prev, electrodeType: t }))}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                    electrodeConfig.electrodeType === t
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border bg-background text-foreground-muted hover:border-accent/30",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "h-3 w-3 shrink-0 rounded-full border-2",
                      electrodeConfig.electrodeType === t ? "border-accent bg-accent" : "border-border",
                    )} />
                    <div>
                      <div className="font-medium">{t === "pad" ? "Pad" : "Ring"}</div>
                      <div className="text-[10px] opacity-60">{t === "pad" ? "70×50 mm" : "8 / 40 mm"}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* ── ROAST quality ── */}
          <div>
            <div>
              <SectionLabel>ROAST Quality</SectionLabel>
              <div className="flex gap-1.5">
                {(["fast", "standard"] as const).map(q => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuality(q)}
                    className={cn(
                      "flex-1 rounded-lg border py-2 text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                      quality === q
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-background text-foreground-muted hover:border-accent/30",
                    )}
                  >
                    {q === "fast" ? "⚡ Fast" : "🎯 Standard"}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-foreground-muted">
                {quality === "fast" ? "~10–15 min, coarser mesh" : "~20–30 min, full resolution"}
                {" · "}
                <span className="opacity-60">first run may be 3–5 min longer</span>
              </p>
            </div>
          </div>

          {/* ── Segmentation source ── */}
          <div>
            <div>
              <SectionLabel>Segmentation Source</SectionLabel>
              <div className="flex gap-2">
                {(["nn", "roast"] as const).map(src => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setSegSource(src)}
                    className={cn(
                      "flex-1 rounded-lg border py-2 text-xs font-medium transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                      segSource === src
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-background text-foreground-muted hover:border-accent/30",
                    )}
                  >
                    {src === "nn" ? "Neural Network" : "ROAST"}
                  </button>
                ))}
              </div>
              {segSource === "roast" ? (
                <div className="mt-2 flex gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
                  <Construction className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <div className="space-y-0.5">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-warning">
                      Requires Segmentation Rerun 
                    </p>
                    <p className="text-[11px] leading-snug text-foreground-muted">
                      Using SPM segmentation requires longer wait times. Estimated time 25-40 min per session.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-foreground-muted">
                  Uses the neural network segmentation from your selected model
                </p>
              )}
            </div>
          </div>

          {/* ── Config summary pill ── */}
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5 text-[11px] text-foreground-muted">
            <span className="font-medium text-foreground">
              {electrodeConfig.anode}(+{electrodeConfig.currentMa}mA)
              {" → "}
              {electrodeConfig.cathode}(−{electrodeConfig.currentMa}mA)
            </span>
            {" · "}{electrodeConfig.electrodeType}
            {" · "}ROAST
            {selectedModels.length > 0 && (
              <>{" · "}{selectedModels.length} model{selectedModels.length > 1 ? "s" : ""}</>
            )}
          </div>

        </div>{/* end scrollable */}

        {/* ── Footer: progress + action ── */}
        <div className="space-y-3 border-t border-border px-4 py-4">

          {hasRuns && (
            <div className="space-y-3">
              {runEntries.map(([key, state]) => {
                const model = key.split(":")[0];
                return (
                  <RunCard
                    key={key}
                    label={`${getDisplayName(model)} · ${getSpaceLabel(model)}`}
                    badge="ROAST"
                    state={state}
                  />
                );
              })}
            </div>
          )}

          {/* Resource indicator */}
          {health && (health.cpu_count > 0 || health.mem_total_mb > 0) && (
            <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2">
              {health.cpu_count > 0 && (
                <span className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
                  <Cpu className="h-3 w-3" />
                  {health.cpu_count} CPU
                </span>
              )}
              {health.mem_total_mb > 0 && (
                <span className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
                  <MemoryStick className="h-3 w-3" />
                  {Math.round((health.mem_total_mb - health.mem_available_mb) / 1024)}/
                  {Math.round(health.mem_total_mb / 1024)} GB RAM
                </span>
              )}
              {health.mem_total_mb > 0 && (
                <div className="ml-auto h-1.5 w-16 overflow-hidden rounded-full bg-border">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      (health.mem_total_mb - health.mem_available_mb) / health.mem_total_mb > 0.85
                        ? "bg-warning" : "bg-success"
                    )}
                    style={{ width: `${Math.round(((health.mem_total_mb - health.mem_available_mb) / health.mem_total_mb) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {allDone ? (
            <Button
              variant="outline"
              size="sm"
              onClick={startAllRuns}
              disabled={selectedModels.length === 0}
              className="w-full gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Run Again (new config)
            </Button>
          ) : (
            <Button
              variant="accent"
              onClick={startAllRuns}
              disabled={selectedModels.length === 0 || isRunning}
              className="w-full gap-2"
            >
              <Zap className="h-4 w-4" />
              {isRunning ? "Simulating…" : "Start Simulation"}
            </Button>
          )}

        </div>
      </aside>

      {/* ═══════════════════════ RIGHT PANEL ══════════════════════════════ */}
      <div className="flex flex-1 flex-col overflow-hidden">

        {/* Tab bar */}
        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-surface px-3 py-2">
          <button
            type="button"
            onClick={() => setPanelView({ type: "segmentation" })}
            className={tabCls(panelView.type === "segmentation")}
          >
            Segmentation
          </button>

          {visibleRuns.map(({ key, model, state }) => {
            const cfg = state.config;
            const space = getSpaceLabel(model);
            const isRunning = state.status === "running";
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPanelView({ type: "roast", model, runKey: key })}
                className={tabCls(isPanelActive({ type: "roast", model, runKey: key }))}
              >
                {isRunning
                  ? <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  : <Check className="h-3 w-3 text-success shrink-0" />
                }
                <span className="font-semibold">{getDisplayName(model)}</span>
                {space && (
                  <span className="rounded bg-border/60 px-1 py-0.5 text-[10px] font-medium text-foreground-muted">{space}</span>
                )}
                <span className="text-foreground-muted">·</span>
                <span>ROAST</span>
                {cfg && (
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {cfg.anode}→{cfg.cathode} {cfg.currentMa}mA
                  </span>
                )}
                {cfg && !isRunning && (
                  <span className="rounded bg-border/40 px-1 py-0.5 text-[10px] text-foreground-muted">{cfg.quality}</span>
                )}
              </button>
            );
          })}

          {completedCount > 0 && (
            <div className="ml-auto shrink-0 pl-4 text-[11px] text-foreground-muted">
              {completedCount} run{completedCount > 1 ? "s" : ""} complete
            </div>
          )}
        </div>

        {/* Viewer */}
        <div className="flex-1 overflow-auto">
          {panelView.type === "segmentation" && (
            <div className="h-full p-4">
              <SplitViewer inputUrl={inputUrl} sessionId={sessionId} models={models} />
            </div>
          )}
          {panelView.type === "roast" && (
            <div className="h-full p-4">
              {runStates[panelView.runKey]?.status !== "complete" ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-foreground-muted">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  <p className="text-sm">Simulation in progress — results will appear here when complete.</p>
                </div>
              ) : (
                <RoastViewer
                  key={`${panelView.runKey}:${runStates[panelView.runKey]?.completedAt ?? ""}`}
                  inputUrl={inputUrl}
                  sessionId={sessionId}
                  modelName={panelView.model}
                  runId={runStates[panelView.runKey]?.runId ?? ""}
                />
              )}
            </div>
          )}
        </div>

      </div>

      {/* Leave guard modal */}
      <LeaveGuardModal
        open={leaveGuardOpen}
        sessionId={sessionId ?? ""}
        filename={undefined}
        onStay={() => setLeaveGuardOpen(false)}
        onLeave={() => {
          setLeaveGuardOpen(false);
          pendingLeaveRef.current?.();
        }}
      />
    </div>
  );
}
