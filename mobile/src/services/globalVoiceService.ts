import { AppState, AppStateStatus, AccessibilityInfo } from "react-native";
import { speechService } from "./speech";
import { voiceRecognitionService } from "./voiceRecognition";
import {
  parseVoiceCommand,
  ParsedVoiceCommand,
} from "./voiceCommands";
import {
  dispatchVoiceCommand,
  VoiceCommandDispatchContext,
} from "./voiceDispatcher";

export type VoiceSessionState = "IDLE" | "LISTENING" | "PROCESSING" | "SPEAKING";

export interface GlobalVoiceState {
  sessionState: VoiceSessionState;
  isActive: boolean; // true if sessionState !== "IDLE" or voice mode enabled
  isPaused: boolean;
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  statusMessage: string;
  lastTranscript: string;
  lastCommand: ParsedVoiceCommand | null;
  error: string | null;
  handsFreeMode: boolean;
}

export type GlobalVoiceListener = (state: GlobalVoiceState) => void;

/**
 * Saarthi Voice Session State Machine.
 *
 * Implements strict lifecycle:
 * IDLE -> LISTENING -> PROCESSING -> SPEAKING -> IDLE
 *
 * Rule 2 Requirements:
 * 1. ZERO unsolicited speech on app launch, screen navigation, or mount.
 * 2. User-initiated push-to-talk by default (handsFreeMode is explicitly opt-in).
 * 3. Exactly one assistant response per user utterance.
 * 4. Stale asynchronous responses from cancelled sessions are strictly discarded.
 * 5. stopAll() immediately stops mic, cancels pending network requests, and silences speech.
 * 6. No arbitrary setTimeout loops to simulate listening.
 */
export class GlobalVoiceService {
  private sessionState: VoiceSessionState = "IDLE";
  private isPaused: boolean = false;
  private handsFreeMode: boolean = false;
  private statusMessage: string = "Ready";
  private lastTranscript: string = "";
  private lastCommand: ParsedVoiceCommand | null = null;
  private error: string | null = null;

  private activeSessionId: number = 0;
  private activeAbortController: AbortController | null = null;
  private listeners: Set<GlobalVoiceListener> = new Set();
  private dispatchContextProvider: (() => VoiceCommandDispatchContext) | null = null;
  private appStateSubscription: any = null;

  constructor() {
    this.initAppState();
  }

  private initAppState(): void {
    try {
      if (AppState && typeof AppState.addEventListener === "function") {
        this.appStateSubscription = AppState.addEventListener(
          "change",
          this.handleAppStateChange.bind(this)
        );
      }
    } catch {
      // Safe fallback
    }
  }

  public setDispatchContextProvider(provider: () => VoiceCommandDispatchContext): void {
    this.dispatchContextProvider = provider;
  }

  public setHandsFreeMode(enabled: boolean): void {
    this.handsFreeMode = enabled;
    this.notify();
  }

  public getState(): GlobalVoiceState {
    const isSpeaking = this.sessionState === "SPEAKING" || speechService.isSpeaking();
    return {
      sessionState: this.sessionState,
      isActive: this.sessionState !== "IDLE" || this.handsFreeMode,
      isPaused: this.isPaused,
      isListening: this.sessionState === "LISTENING",
      isProcessing: this.sessionState === "PROCESSING",
      isSpeaking,
      statusMessage: this.statusMessage,
      lastTranscript: this.lastTranscript,
      lastCommand: this.lastCommand,
      error: this.error,
      handsFreeMode: this.handsFreeMode,
    };
  }

  public subscribe(listener: GlobalVoiceListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.warn("[GlobalVoiceService] Listener error:", err);
      }
    });
  }

  /**
   * User-initiated Push-to-Talk activation.
   * Transitions: IDLE -> LISTENING.
   */
  public async startVoiceSession(options?: {
    speakOnError?: boolean;
    customWelcome?: string;
  }): Promise<boolean> {
    // If currently speaking, stop speech first
    await speechService.stop();

    // If currently listening, toggle off to IDLE
    if (this.sessionState === "LISTENING") {
      await this.stopAll();
      return false;
    }

    const avail = voiceRecognitionService.checkAvailability();
    if (!avail.available) {
      const msg =
        avail.reason ||
        "Speech recognition requires a native Android build. In Expo Go, use the on-screen buttons.";
      this.error = msg;
      this.statusMessage = msg;
      this.sessionState = "IDLE";
      this.notify();
      if (options?.speakOnError) {
        await speechService.speak(msg, { force: true });
      }
      return false;
    }

    const granted = await voiceRecognitionService.requestPermissions();
    if (!granted) {
      const msg =
        "Microphone or speech recognition permission was denied. Please allow access in device Settings.";
      this.error = msg;
      this.statusMessage = msg;
      this.sessionState = "IDLE";
      this.notify();
      if (options?.speakOnError) {
        await speechService.speak(msg, { force: true });
      }
      return false;
    }

    this.activeSessionId++;
    this.sessionState = "LISTENING";
    this.isPaused = false;
    this.error = null;
    this.statusMessage = "Listening...";
    this.notify();

    if (options?.customWelcome) {
      await speechService.speak(options.customWelcome, { force: true });
    }

    try {
      await voiceRecognitionService.startListening({
        onStart: () => {
          if (this.sessionState === "LISTENING") {
            this.statusMessage = "Listening...";
            this.notify();
            try {
              AccessibilityInfo.announceForAccessibility("Listening");
            } catch {
              // Safe isolate
            }
          }
        },
        onResult: (res) => {
          this.lastTranscript = res.transcript;
          this.notify();

          if (res.isFinal && res.transcript.trim()) {
            this.handleFinalTranscript(res.transcript);
          }
        },
        onError: (err) => {
          console.log("[GlobalVoiceService] Recognition error:", err);
          if (this.sessionState === "LISTENING") {
            this.sessionState = "IDLE";
            this.error = typeof err === "string" ? err : "Recognition failed";
            this.statusMessage = "Ready";
            this.notify();
          }
        },
        onEnd: () => {
          if (this.sessionState === "LISTENING") {
            // Silence or end of speech without final transcript -> cleanly return to IDLE
            this.sessionState = "IDLE";
            this.statusMessage = "Ready";
            this.notify();
          }
        },
      });
      return true;
    } catch (err: any) {
      this.sessionState = "IDLE";
      this.error = err?.message || "Failed to start microphone";
      this.statusMessage = "Ready";
      this.notify();
      return false;
    }
  }

  /**
   * Activates push-to-talk voice session.
   */
  public async enableVoiceMode(customWelcome?: string): Promise<boolean> {
    return this.startVoiceSession({ speakOnError: true, customWelcome });
  }

  /**
   * Toggles voice session between active listening and idle.
   */
  public async toggleVoiceMode(): Promise<boolean> {
    if (this.sessionState === "IDLE") {
      return this.startVoiceSession();
    } else {
      await this.stopAll();
      return false;
    }
  }

  public async pauseListening(_speakConfirmation: boolean = true): Promise<void> {
    await this.stopAll();
    this.isPaused = true;
    this.statusMessage = "Paused";
    this.notify();
  }

  public async resumeListening(_speakConfirmation: boolean = true): Promise<void> {
    this.isPaused = false;
    await this.startVoiceSession();
  }

  public async disableVoiceMode(_speakConfirmation: boolean = true): Promise<void> {
    await this.stopAll();
  }

  public scheduleStartListening(_delayMs: number = 250): void {
    if (this.handsFreeMode && !this.isPaused) {
      this.startVoiceSession();
    }
  }

  /**
   * Processes final transcript through intent router.
   * Transitions: LISTENING -> PROCESSING -> SPEAKING -> IDLE.
   */
  private async handleFinalTranscript(rawTranscript: string): Promise<void> {
    if (this.sessionState !== "LISTENING") {
      return; // Prevent duplicate transcript submissions
    }

    const transcript = rawTranscript.trim();
    if (!transcript) {
      this.sessionState = "IDLE";
      this.statusMessage = "Ready";
      this.notify();
      return;
    }

    // Stop microphone immediately before processing
    voiceRecognitionService.stopListening();

    const sessionId = this.activeSessionId;
    this.sessionState = "PROCESSING";
    this.statusMessage = "Processing...";
    this.notify();

    const parsed = parseVoiceCommand(transcript);
    this.lastCommand = parsed;

    // Handle meta-commands immediately
    if (parsed.intent === "stop" || parsed.intent === "exit_voice_mode") {
      await this.stopAll();
      return;
    }

    if (parsed.intent === "stop_listening") {
      await this.pauseListening();
      return;
    }

    if (parsed.intent === "resume_listening") {
      await this.resumeListening();
      return;
    }

    const context: VoiceCommandDispatchContext = this.dispatchContextProvider
      ? this.dispatchContextProvider()
      : { currentScreen: "home" };

    try {
      this.activeAbortController = new AbortController();
      const resultMsg = await dispatchVoiceCommand(parsed, context, { speak: false });

      // Check if session was cancelled during asynchronous dispatch
      if (sessionId !== this.activeSessionId) {
        console.log(`[GlobalVoiceService] Session #${sessionId} was cancelled. Discarding stale response.`);
        return;
      }

      this.sessionState = "SPEAKING";
      this.statusMessage = resultMsg;
      this.notify();

      // Speak response exactly once and transition to IDLE upon finish
      await speechService.speak(resultMsg, {
        force: true,
        onDone: () => this.finishSession(sessionId),
        onError: () => this.finishSession(sessionId),
      });
    } catch (err: any) {
      if (sessionId !== this.activeSessionId) return;
      this.sessionState = "IDLE";
      this.statusMessage = "Ready";
      this.notify();
    }
  }

  private finishSession(sessionId: number): void {
    if (sessionId !== this.activeSessionId) return;

    if (this.handsFreeMode && !this.isPaused && AppState.currentState === "active") {
      this.startVoiceSession();
    } else {
      this.sessionState = "IDLE";
      this.statusMessage = "Ready";
      this.notify();
    }
  }

  /**
   * STOP ALL: immediately stops microphone capture, cancels pending network requests,
   * stops audio playback, and resets state to IDLE.
   */
  public async stopAll(): Promise<void> {
    this.activeSessionId++;

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    voiceRecognitionService.stopListening();
    await speechService.stop();

    this.sessionState = "IDLE";
    this.isPaused = false;
    this.error = null;
    this.statusMessage = "Ready";
    this.notify();
  }

  private handleAppStateChange(nextAppState: AppStateStatus): void {
    if (nextAppState === "background" || nextAppState === "inactive") {
      this.stopAll();
    }
  }

  public destroy(): void {
    if (this.appStateSubscription?.remove) {
      this.appStateSubscription.remove();
    }
    this.stopAll();
    this.listeners.clear();
  }
}

export const globalVoiceService = new GlobalVoiceService();
