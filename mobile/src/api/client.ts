import { getBackendBaseUrl, setBackendBaseUrl } from "../config/env";

export { getBackendBaseUrl as getApiBaseUrl, setBackendBaseUrl as setCustomApiBaseUrl };
export { checkAIStatus as getAiStatus };

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
}

export interface AIStatusResponse {
  configured: boolean;
  model: string;
  mock_mode?: boolean;
}

export interface AITestResponse {
  status: string;
  model: string;
  prompt: string;
  response: string;
}

export interface AIVisionResponse {
  status: string;
  model: string;
  prompt: string;
  description: string;
  confidence?: number;
  uncertainties?: string[];
  unchecked_areas?: string[];
  needs_rescan?: boolean;
  extracted_text?: string;
}

export interface DetectedObject {
  label: string;
  relative_position?: string;
  confidence: number;
}

export interface DetectedTextItem {
  text: string;
  context?: string;
  confidence: number;
}

export interface SceneAnalysisResponse {
  status: string;
  model: string;
  spoken_description: string;
  objects: DetectedObject[];
  detected_texts: DetectedTextItem[];
  spatial_description?: string;
  uncertainties: string[];
  unchecked_areas: string[];
  image_quality: string;
  needs_rescan: boolean;
  confidence: number;
}

export interface TimetableItem {
  course_code: string;
  course_name: string;
  day_of_week: string;
  start_time: string;
  end_time: string;
  room: string;
  building?: string;
  confidence: number;
}

export interface DoorSignInfo {
  room_number: string;
  department?: string;
  occupants: string[];
  status?: string;
  confidence: number;
}

export interface NoticeItem {
  title: string;
  raw_date_text?: string;
  summary: string;
  urgency: string;
  confidence: number;
}

export interface CampusReadingResponse {
  status: string;
  reading_mode: string;
  spoken_summary: string;
  confidence: number;
  needs_rescan: boolean;
  source_text: string;
  door_sign?: DoorSignInfo;
  timetable_items: TimetableItem[];
  notices: NoticeItem[];
  uncertainties: string[];
  unchecked_areas: string[];
}

export interface ApiError {
  message: string;
  statusCode?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      const err = new Error("Request was cancelled by user.");
      err.name = "AbortError";
      throw err;
    }
    externalSignal.addEventListener("abort", () => {
      controller.abort();
    });
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    return response;
  } catch (error: any) {
    if (error.name === "AbortError") {
      if (timedOut) {
        throw new Error(
          `Connection timed out (${timeoutMs / 1000}s). Verify your phone and PC are on the same Wi-Fi network and firewall allows port 8000.`
        );
      }
      const cancelErr = new Error("Request cancelled.");
      cancelErr.name = "AbortError";
      throw cancelErr;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check backend health status (/api/v1/health).
 */
export async function checkBackendHealth(): Promise<HealthResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/health`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Backend returned HTTP status ${response.status}`);
    }
    return (await response.json()) as HealthResponse;
  } catch (error: any) {
    throw new Error(
      error.message || "Failed to connect to SAARTHI backend server."
    );
  }
}

/**
 * Check whether Gemini AI is configured on the backend (/api/v1/ai/status).
 */
export async function checkAIStatus(): Promise<AIStatusResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/status`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`AI status check failed with HTTP ${response.status}`);
    }
    return (await response.json()) as AIStatusResponse;
  } catch (error: any) {
    throw new Error(
      error.message || "Failed to query AI configuration status."
    );
  }
}

/**
 * Send a connectivity test prompt through the backend to Gemini (/api/v1/ai/test).
 */
export async function testAIConnectivity(
  prompt: string = "Say hello in 5 words or less."
): Promise<AITestResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/test`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      },
      12000 // Allow up to 12s for LLM upstream response
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as AITestResponse;
  } catch (error: any) {
    throw new Error(error.message || "Failed to execute AI test request.");
  }
}

/**
 * Send a captured image to the backend for multimodal scene analysis (/api/v1/ai/vision).
 */
export async function analyzeSceneWithVision(
  imageBase64: string,
  prompt?: string,
  mimeType: string = "image/jpeg",
  signal?: AbortSignal
): Promise<AIVisionResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/vision`;

  const payload: {
    image_base64: string;
    prompt?: string;
    mime_type: string;
  } = {
    image_base64: imageBase64,
    mime_type: mimeType,
  };

  if (prompt && prompt.trim()) {
    payload.prompt = prompt.trim();
  }

  console.log(
    `[SAARTHI Vision Client] Sending request: b64_len=${imageBase64.length}, mimeType=${mimeType}, promptLen=${prompt?.length ?? 0}`
  );

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      30000, // Allow up to 30s for multimodal vision inference
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const result = data as AIVisionResponse;
    console.log(
      `[SAARTHI Vision Client] Response OK: model=${result.model}, descLen=${result.description.length}`
    );

    return result;
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.log("[SAARTHI Vision Client] Vision request aborted by user.");
      throw error;
    }
    throw new Error(error.message || "Failed to analyze image with Gemini Vision.");
  }
}

/**
 * Send extracted OCR text or image to the campus reading endpoint (/api/v1/campus/read).
 */
export async function readCampusText(
  params: {
    imageBase64?: string;
    ocrText?: string;
    readingMode?: "auto" | "timetable" | "sign" | "notice" | "surroundings";
  },
  signal?: AbortSignal
): Promise<CampusReadingResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/campus/read`;

  const payload = {
    image_base64: params.imageBase64,
    ocr_text: params.ocrText,
    reading_mode: params.readingMode || "auto",
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      25000,
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as CampusReadingResponse;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    throw new Error(error.message || "Failed to read campus text.");
  }
}

/**
 * Send a camera frame to the backend Live Scene Assist endpoint (/api/v1/ai/scene-assist).
 */
export async function analyzeSceneAssist(
  imageBase64: string,
  query?: string,
  mimeType: string = "image/jpeg",
  signal?: AbortSignal
): Promise<SceneAnalysisResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/scene-assist`;

  const payload: {
    image_base64: string;
    query?: string;
    mime_type: string;
  } = {
    image_base64: imageBase64,
    mime_type: mimeType,
  };

  if (query && query.trim()) {
    payload.query = query.trim();
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      20000,
      signal
    );

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail || `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return data as SceneAnalysisResponse;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw error;
    }
    throw new Error(error.message || "Failed to analyze scene with Gemma 4.");
  }
}

export interface SpeechStatusResponse {
  configured: boolean;
  voice_id: string;
  model_id: string;
}

/**
 * Checks whether backend ElevenLabs TTS is configured.
 */
export async function getSpeechStatus(): Promise<SpeechStatusResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/speech/status`;
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, 5000);
    if (!res.ok) {
      return { configured: false, voice_id: "", model_id: "" };
    }
    return await res.json();
  } catch {
    return { configured: false, voice_id: "", model_id: "" };
  }
}

/**
 * Synthesizes natural speech using backend ElevenLabs route.
 * Returns Base64 MP3 audio data or explicit error.
 */
export async function synthesizeSpeechAudio(
  text: string,
  voiceId?: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; audioBase64?: string; error?: string }> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/speech/synthesize`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: JSON.stringify({ text, voice_id: voiceId }),
      },
      15000,
      signal
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return { ok: false, error: errData.detail || `HTTP ${res.status}` };
    }

    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const resultStr = reader.result as string;
        const base64data = resultStr?.includes(",") ? resultStr.split(",")[1] : resultStr;
        resolve({ ok: true, audioBase64: base64data });
      };
      reader.onerror = () => {
        resolve({ ok: false, error: "Failed to read audio blob." });
      };
      reader.readAsDataURL(blob);
    });
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw err;
    }
    return { ok: false, error: err.message || "Network error synthesizing speech." };
  }
}

export interface GeneralQueryResponse {
  status: string;
  model: string;
  question: string;
  answer: string;
  confidence: number;
}

/**
 * Ask a general natural-language question to the backend AI model.
 */
export async function askGeneralQuery(
  question: string,
  signal?: AbortSignal
): Promise<GeneralQueryResponse> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/v1/ai/query`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      body: JSON.stringify({ question }),
    },
    15000,
    signal
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.detail || `HTTP ${res.status}`);
  }

  return data as GeneralQueryResponse;
}


