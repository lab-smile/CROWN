"use client";

// ---------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  "http://10.15.224.253:8100";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------
export interface PredictResponse {
  session_id: string;
  queue_position: number;
  models: string[];
  space: string;
}

export interface HealthResponse {
  redis: boolean;
  gpu_usage:
    | Array<{
        gpu: number;
        util: number;
        mem_used: number;
        mem_total: number;
      }>
    | string;
  queue_length: number;
  gpu_count: number;
  cpu_count: number;
  mem_total_mb: number;
  mem_available_mb: number;
}

export interface SSEEvent {
  type: "progress" | "complete" | "error";
  model?: string;
  progress?: number;
  message?: string;
  gpu?: number;
}

// ---------------------------------------------------------------------
// Tissue volume stats types
// ---------------------------------------------------------------------
export interface LabelStats {
  name: string;
  voxel_count: number;
  volume_mm3: number;
}

export interface ModelStatsResponse {
  session_id: string;
  model_name: string;
  voxel_volume_mm3: number;
  labels: Record<string, LabelStats>;
}

// ---------------------------------------------------------------------
// POST /predict
// ---------------------------------------------------------------------
export async function startPrediction(
  file: File,
  models: string[],
  space: string,
  convertToFs: boolean = false,
  workspaceJwt?: string,
  notifyEmail?: string
): Promise<PredictResponse> {
  console.log(models);
  console.log(space);
  const formData = new FormData();
  formData.append("file", file);
  formData.append("space", space);
  formData.append("convert_to_fs", convertToFs ? "true" : "false");
  if (notifyEmail) formData.append("notify_email", notifyEmail);

  if (models.length === 6) formData.append("models", "all");
  else formData.append("models", models.join(","));

  const headers: Record<string, string> = {};
  if (workspaceJwt) headers["Authorization"] = `Bearer ${workspaceJwt}`;

  const res = await fetch(`${API_BASE}/predict`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!res.ok) {
    let detail = "Failed to start job";
    try {
      const err = await res.json();
      detail = err.detail || detail;
    } catch {}
    throw new Error(detail);
  }

  return await res.json();
}

// ---------------------------------------------------------------------
// SSE → unified connectSSE wrapper
// ---------------------------------------------------------------------
export function connectSSE(
  sessionId: string,
  onEvent: (event: SSEEvent) => void,
  onDisconnect?: () => void
): EventSource {
  const evtSource = new EventSource(`${API_BASE}/stream/${sessionId}`);
  let errorCount = 0;
  let done = false;

  evtSource.onmessage = (e) => {
    errorCount = 0;
    try {
      const envelope = JSON.parse(e.data) as any;

      // Your backend sends { event: {...}, sig: "..." }
      const payload = envelope.event ?? envelope;

      // Map backend events -> UI events
      if (payload.event === "job_complete") {
        done = true;
        evtSource.close();
        onEvent({ type: "complete" });
        return;
      }

      if (payload.event === "job_failed" || payload.event === "model_error") {
        onEvent({
          type: "error",
          message: payload.error || payload.detail || "Job failed",
        });
        return;
      }

      if (typeof payload.progress === "number" && payload.model) {
        onEvent({
          type: "progress",
          model: payload.model,
          progress: payload.progress,
          gpu: payload.gpu,
        });
        return;
      }

      // ignore heartbeats/other events
    } catch (err) {
      console.error("Bad SSE message", err);
    }
  };

  evtSource.onerror = () => {
    if (done) return;
    errorCount++;
    if (errorCount > 5) {
      evtSource.close();
      onDisconnect?.();
    }
  };

  return evtSource;
}

// ---------------------------------------------------------------------
// GET /results/{session}/{model}
// ---------------------------------------------------------------------
export async function getResult(
  sessionId: string,
  model: string
): Promise<Blob> {
  const res = await fetch(`${API_BASE}/results/${sessionId}/${model}`);
  if (!res.ok) throw new Error(`Result not found for ${model}`);
  return await res.blob();
}

// ---------------------------------------------------------------------
// GET /results/{session}/input
// ---------------------------------------------------------------------
export async function getInput(sessionId: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/results/${sessionId}/input`);
  if (!res.ok) throw new Error("Input file not found");
  return await res.blob();
}

// ---------------------------------------------------------------------
// POST /simulate
// ---------------------------------------------------------------------
export interface SimulateResponse {
  session_id: string;
  status: "queued";
  run_id: string;
}

export async function startSimulation(
  sessionId: string,
  modelName: string,
  quality: "fast" | "standard" = "standard",
  recipe?: (string | number)[],
  electrode_type?: string[],
  segSource?: "nn" | "roast",
): Promise<SimulateResponse> {
  const body: Record<string, unknown> = { session_id: sessionId, model_name: modelName, quality };
  if (recipe) body.recipe = recipe;
  if (electrode_type) body.electrode_type = electrode_type;
  if (segSource) body.seg_source = segSource;

  const res = await fetch(`${API_BASE}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "Failed to start simulation";
    try { const err = await res.json(); detail = err.detail || detail; } catch {}
    throw new Error(detail);
  }
  return await res.json();
}

// ---------------------------------------------------------------------
// SSE for ROAST /stream/roast/{session_id}
// ---------------------------------------------------------------------
export interface ROASTSSEEvent {
  type: "progress" | "complete" | "error";
  event?: string;
  progress?: number;
  detail?: string;
}

export function connectROASTSSE(
  sessionId: string,
  onEvent: (event: ROASTSSEEvent) => void,
  onDisconnect?: () => void
): EventSource {
  const evtSource = new EventSource(`${API_BASE}/stream/roast/${sessionId}`);
  let errorCount = 0;
  let done = false;

  evtSource.onmessage = (e) => {
    errorCount = 0;
    try {
      const envelope = JSON.parse(e.data) as any;
      const payload = envelope.event ?? envelope;

      if (payload.event === "roast_complete") {
        done = true;
        evtSource.close();
        onEvent({ type: "complete", progress: 100 });
        return;
      }
      if (payload.event === "roast_error") {
        done = true;
        evtSource.close();
        onEvent({ type: "error", detail: payload.detail || "Simulation failed" });
        return;
      }
      if (typeof payload.progress === "number") {
        onEvent({ type: "progress", event: payload.event, progress: payload.progress });
        return;
      }
    } catch {}
  };

  evtSource.onerror = () => {
    if (done) return;
    errorCount++;
    if (errorCount > 5) {
      evtSource.close();
      onDisconnect?.();
    }
  };

  return evtSource;
}

// ---------------------------------------------------------------------
// GET /simulate/results/{session}/{model}/{output_type}
// ---------------------------------------------------------------------
export async function getSimulationResult(
  sessionId: string,
  modelName: string,
  runId: string,
  outputType: "voltage" | "efield" | "emag" | "mask_elec" | "mask_gel" | "jbrain"
): Promise<Blob> {
  const path = runId
    ? `${API_BASE}/simulate/results/${sessionId}/${modelName}/${runId}/${outputType}`
    : `${API_BASE}/simulate/results/${sessionId}/${modelName}/${outputType}`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Simulation result not found: ${outputType}`);
  return await res.blob();
}

// ---------------------------------------------------------------------
// GET /simulate/status/{session}/{model}
// ---------------------------------------------------------------------
export async function getSimulationStatus(sessionId: string, modelName: string): Promise<{ status: string; progress: number }> {
  const res = await fetch(`${API_BASE}/simulate/status/${sessionId}/${modelName}`);
  if (!res.ok) throw new Error("Failed to get simulation status");
  return await res.json();
}

// ---------------------------------------------------------------------
// DELETE /session/{session_id}  — immediately delete session data
// ---------------------------------------------------------------------
export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/session/${sessionId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------
// POST /session/notify  — request email restore link
// ---------------------------------------------------------------------
export async function requestNotification(
  sessionId: string,
  email: string,
  filename?: string,
): Promise<{ token: string; expires_in: number }> {
  const res = await fetch(`${API_BASE}/session/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, email, filename }),
  });
  if (!res.ok) {
    let detail = "Failed to request notification";
    try { const e = await res.json(); detail = e.detail || detail; } catch {}
    throw new Error(detail);
  }
  return await res.json();
}

// ---------------------------------------------------------------------
// GET /session/restore/{token}  — resolve restore token → session_id
// ---------------------------------------------------------------------
export async function restoreSession(
  token: string,
): Promise<{ session_id: string; models: string[] }> {
  const res = await fetch(`${API_BASE}/session/restore/${token}`);
  if (!res.ok) {
    let detail = "Invalid or expired restore link";
    try { const e = await res.json(); detail = e.detail || detail; } catch {}
    throw new Error(detail);
  }
  return await res.json();
}

// ---------------------------------------------------------------------
// GET /results/{session_id}/{model_name}/stats
// ---------------------------------------------------------------------
export async function getModelStats(
  sessionId: string,
  modelName: string,
): Promise<ModelStatsResponse> {
  const res = await fetch(`${API_BASE}/results/${sessionId}/${modelName}/stats`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to fetch volume stats");
  }
  return res.json();
}

// ---------------------------------------------------------------------
// POST /cancel/{session_id}
// ---------------------------------------------------------------------
export async function cancelJob(sessionId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/cancel/${sessionId}`, { method: "POST" });
  } catch {
    // best-effort: ignore network errors on cancel
  }
}

// ---------------------------------------------------------------------
// ADMIN — types
// ---------------------------------------------------------------------
export interface AdminJob {
  type: "gpu_seg" | "roast" | "simnibs";
  session_id: string;
  model: string;
  run_id: string | null;
  status: string;
  progress: number;
  gpu: string | null;
}

export interface AdminJobsResponse {
  jobs: AdminJob[];
  queue_depths: { gpu_seg: number; roast: number; simnibs: number };
}

export interface AuditResponse {
  events: [string, string, string, string, string][];
  total: number;
  offset: number;
  limit: number;
}

export interface SessionMeta {
  session_id: string;
  has_logs: boolean;
  created: number;
}

function authHeader(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------
// POST /admin/login
// ---------------------------------------------------------------------
export async function adminLogin(password: string): Promise<{ token: string }> {
  const res = await fetch(`${API_BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    let detail = "Login failed";
    try { const err = await res.json(); detail = err.detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// ---------------------------------------------------------------------
// GET /admin/jobs
// ---------------------------------------------------------------------
export async function getAdminJobs(token: string): Promise<AdminJobsResponse> {
  const res = await fetch(`${API_BASE}/admin/jobs`, { headers: authHeader(token) });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to fetch jobs");
  return res.json();
}

// ---------------------------------------------------------------------
// GET /admin/audit
// ---------------------------------------------------------------------
export async function getAdminAudit(
  token: string,
  offset = 0,
  limit = 100,
): Promise<AuditResponse> {
  const res = await fetch(
    `${API_BASE}/admin/audit?offset=${offset}&limit=${limit}`,
    { headers: authHeader(token) },
  );
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to fetch audit log");
  return res.json();
}

// ---------------------------------------------------------------------
// GET /logs  — list sessions (admin)
// ---------------------------------------------------------------------
export async function adminListSessions(token: string): Promise<{ sessions: SessionMeta[] }> {
  const res = await fetch(`${API_BASE}/logs`, { headers: authHeader(token) });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to list sessions");
  return res.json();
}

// ---------------------------------------------------------------------
// GET /admin/logs/{session_id}  — raw JSONL text
// ---------------------------------------------------------------------
export async function adminGetLogs(token: string, sessionId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/admin/logs/${sessionId}`, {
    headers: authHeader(token),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`No logs for ${sessionId}`);
  return res.text();
}

// ---------------------------------------------------------------------
// DELETE /session/{session_id}  — admin delete with auth
// ---------------------------------------------------------------------
export async function adminDeleteSession(token: string, sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/session/${sessionId}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
}

// ---------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------
export async function getHealth(): Promise<HealthResponse> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error("bad");
    return await res.json();
  } catch {
    return {
      redis: false,
      gpu_usage: [],
      queue_length: -1,
      gpu_count: 0,
      cpu_count: 0,
      mem_total_mb: 0,
      mem_available_mb: 0,
    };
  }
}
