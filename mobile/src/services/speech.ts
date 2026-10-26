import * as Speech from "expo-speech";
import { Platform } from "react-native";
import { getSpeechStatus, synthesizeSpeechAudio } from "../api/client";

// Import FileSystem safely to support both Jest test runner and native runtime
let FileSystem: any = null;
try {
  FileSystem = require("expo-file-system/legacy");
} catch {
  try {
    FileSystem = require("expo-file-system");
  } catch {
    FileSystem = null;
  }
}

// Import expo-audio safely to support both native runtime and headless test environments
let createAudioPlayer: any = null;
try {
  const audioModule = require("expo-audio");
  createAudioPlayer = audioModule.createAudioPlayer;
} catch {
  createAudioPlayer = null;
}

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  language?: string;
  force?: boolean;
  voiceId?: string;
  useElevenLabs?: boolean; // Default true (attempts ElevenLabs if configured)
  onDone?: () => void;
  onError?: (error: any) => void;
}

class SpeechService {
  private isSpeakingActive: boolean = false;
  private lastSpokenText: string | null = null;
  private speechEnabled: boolean = true;
  private preferredVoiceIdentifier: string | undefined = undefined;
  private preferredLanguage: string | undefined = undefined;
  private voicesInitialized: boolean = false;

  private activeAbortController: AbortController | null = null;
  private audioPlayer: any = null;
  private audioStatusSubscription: any = null;
  private elevenLabsStatusCache: { configured: boolean; voice_id: string; timestamp: number } | null = null;
  private playbackEndListeners: Set<() => void> = new Set();

  constructor() {
    this.initVoices();
    this.initAudioPlayer();
  }

  private initAudioPlayer(): void {
    if (createAudioPlayer && !this.audioPlayer) {
      try {
        this.audioPlayer = createAudioPlayer();
      } catch (err) {
        console.log("[SAARTHI Speech] Native AudioPlayer initialization deferred:", err);
      }
    }
  }

  /**
   * Enumerate available TTS voices on the device and pick the most natural English/Hindi voice.
   */
  public async initVoices(): Promise<void> {
    if (this.voicesInitialized) return;
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      this.voicesInitialized = true;
      if (voices && voices.length > 0) {
        // Look for English or Hindi voices, preferring Enhanced quality
        const enhancedVoice = voices.find(
          (v) =>
            (v.language.toLowerCase().startsWith("en") || v.language.toLowerCase().startsWith("hi")) &&
            v.quality === "Enhanced"
        );
        const standardVoice = voices.find(
          (v) =>
            v.language.toLowerCase().startsWith("en") || v.language.toLowerCase().startsWith("hi")
        );

        const chosen = enhancedVoice || standardVoice;
        if (chosen) {
          this.preferredVoiceIdentifier = chosen.identifier;
          this.preferredLanguage = chosen.language;
          console.log(
            `[SAARTHI Speech] Selected native voice: "${chosen.name}" (${chosen.language})`
          );
        }
      }
    } catch (err) {
      console.warn("[SAARTHI Speech] Error querying available voices:", err);
    }
  }

  public isEnabled(): boolean {
    return this.speechEnabled;
  }

  public setEnabled(enabled: boolean): void {
    this.speechEnabled = enabled;
    if (!enabled) {
      this.stop();
    }
  }

  /**
   * Checks if backend ElevenLabs TTS is configured (cached for 30s).
   */
  private async checkElevenLabsConfigured(): Promise<boolean> {
    const now = Date.now();
    if (this.elevenLabsStatusCache && now - this.elevenLabsStatusCache.timestamp < 30000) {
      return this.elevenLabsStatusCache.configured;
    }

    try {
      const status = await getSpeechStatus();
      this.elevenLabsStatusCache = {
        configured: Boolean(status.configured),
        voice_id: status.voice_id,
        timestamp: now,
      };
      return Boolean(status.configured);
    } catch {
      return false;
    }
  }

  /**
   * Speak a message aloud.
   * Priority: Official ElevenLabs natural TTS when backend key is configured.
   * Fallback: Native device text-to-speech if unconfigured, offline, or on error.
   */
  public async speak(text: string, options?: SpeakOptions): Promise<void> {
    if (!text || !text.trim()) {
      return;
    }

    if (!this.speechEnabled && !options?.force) {
      return;
    }

    const cleanText = text.trim();
    this.lastSpokenText = cleanText;

    // Immediately stop any active speech/audio to prevent overlapping voices
    await this.stop();

    this.isSpeakingActive = true;
    this.activeAbortController = new AbortController();

    const shouldUseElevenLabs = options?.useElevenLabs !== false;
    let playedWithElevenLabs = false;

    if (shouldUseElevenLabs && createAudioPlayer) {
      try {
        const isConfigured = await this.checkElevenLabsConfigured();
        if (isConfigured && !this.activeAbortController.signal.aborted) {
          const result = await synthesizeSpeechAudio(
            cleanText,
            options?.voiceId,
            this.activeAbortController.signal
          );

          if (result.ok && result.audioBase64 && !this.activeAbortController.signal.aborted) {
            const cacheFile = `${FileSystem.cacheDirectory || ""}saarthi_speech.mp3`;
            await FileSystem.writeAsStringAsync(cacheFile, result.audioBase64, {
              encoding: FileSystem.EncodingType.Base64,
            });

            if (!this.audioPlayer) {
              this.initAudioPlayer();
            }

            if (this.audioPlayer) {
              console.log("[SAARTHI Speech] Playing audio via ElevenLabs TTS.");
              this.audioPlayer.replace({ uri: cacheFile });

              // Subscribe to playback end
              if (this.audioStatusSubscription?.remove) {
                this.audioStatusSubscription.remove();
              }

              this.audioStatusSubscription = this.audioPlayer.addListener(
                "playbackStatusUpdate",
                (status: any) => {
                  if (status?.didJustFinish || (!status?.playing && status?.currentTime >= (status?.duration || 0) && status?.duration > 0)) {
                    if (this.audioStatusSubscription?.remove) {
                      this.audioStatusSubscription.remove();
                      this.audioStatusSubscription = null;
                    }
                    this.notifyPlaybackEnd();
                    options?.onDone?.();
                  }
                }
              );

              this.audioPlayer.play();
              playedWithElevenLabs = true;
              return;
            }
          } else if (result.error) {
            console.log(`[SAARTHI Speech] ElevenLabs synthesis fallback: ${result.error}`);
          }
        }
      } catch (err: any) {
        if (err.name === "AbortError") {
          this.notifyPlaybackEnd();
          return;
        }
        console.log("[SAARTHI Speech] ElevenLabs error, falling back to native TTS:", err.message);
      }
    }

    if (this.activeAbortController?.signal.aborted) {
      this.notifyPlaybackEnd();
      return;
    }

    // Native Device TTS Fallback
    console.log("[SAARTHI Speech] Playing audio via native device TTS synthesizer.");
    const speechOptions: Speech.SpeechOptions = {
      rate: options?.rate ?? (Platform.OS === "ios" ? 0.92 : 0.95),
      pitch: options?.pitch ?? 1.0,
      volume: 1.0,
      useApplicationAudioSession: false,
      onStart: () => {
        this.isSpeakingActive = true;
      },
      onDone: () => {
        this.notifyPlaybackEnd();
        options?.onDone?.();
      },
      onStopped: () => {
        this.notifyPlaybackEnd();
      },
      onError: (err) => {
        this.notifyPlaybackEnd();
        options?.onError?.(err);
      },
    };

    if (options?.language) {
      speechOptions.language = options.language;
    } else if (this.preferredLanguage) {
      speechOptions.language = this.preferredLanguage;
    }

    if (this.preferredVoiceIdentifier) {
      speechOptions.voice = this.preferredVoiceIdentifier;
    }

    try {
      Speech.speak(cleanText, speechOptions);
    } catch (err) {
      this.notifyPlaybackEnd();
      options?.onError?.(err);
    }
  }

  public addPlaybackEndListener(listener: () => void): () => void {
    this.playbackEndListeners.add(listener);
    return () => {
      this.playbackEndListeners.delete(listener);
    };
  }

  private notifyPlaybackEnd(): void {
    this.isSpeakingActive = false;
    this.playbackEndListeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // Safe ignore
      }
    });
  }

  public async waitForPlaybackCompletion(timeoutMs: number = 4500): Promise<void> {
    const isSpeaking = await this.isSpeakingAsync();
    if (!isSpeaking) {
      return;
    }

    return new Promise<void>((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (timer) clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          resolve();
        }
      };

      unsubscribe = this.addPlaybackEndListener(finish);
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Immediately cut off and stop any playing speech or audio.
   */
  public async stop(): Promise<void> {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    if (this.audioPlayer) {
      try {
        this.audioPlayer.pause();
      } catch {
        // Safe isolate
      }
    }

    if (this.audioStatusSubscription?.remove) {
      this.audioStatusSubscription.remove();
      this.audioStatusSubscription = null;
    }

    try {
      await Speech.stop();
    } catch {
      // Safe isolate
    } finally {
      this.notifyPlaybackEnd();
    }
  }

  public async repeatLast(): Promise<boolean> {
    if (this.lastSpokenText && this.lastSpokenText.trim()) {
      await this.speak(this.lastSpokenText, { force: true });
      return true;
    }
    return false;
  }

  public async repeat(): Promise<boolean> {
    return this.repeatLast();
  }

  public getLastSpoken(): string | null {
    return this.lastSpokenText;
  }

  public isSpeaking(): boolean {
    return this.isSpeakingActive;
  }

  public async isSpeakingAsync(): Promise<boolean> {
    try {
      const nativeSpeaking = await Speech.isSpeakingAsync();
      const audioPlaying = Boolean(this.audioPlayer?.playing);
      return this.isSpeakingActive || Boolean(nativeSpeaking) || audioPlaying;
    } catch {
      return this.isSpeakingActive;
    }
  }
}

export const speechService = new SpeechService();
