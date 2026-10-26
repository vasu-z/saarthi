import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Mock native ESM modules for Jest Node environment
jest.mock(
  "expo-speech",
  () => ({
    speak: jest.fn(),
    stop: jest.fn(),
    isSpeakingAsync: jest.fn(async () => false),
    getAvailableVoicesAsync: jest.fn(async () => []),
  }),
  { virtual: true }
);

jest.mock(
  "react-native",
  () => {
    let appStateListener: ((state: string) => void) | null = null;
    return {
      Platform: { OS: "android" },
      AccessibilityInfo: {
        announceForAccessibility: jest.fn(),
      },
      AppState: {
        currentState: "active",
        addEventListener: jest.fn((event: string, handler: (state: string) => void) => {
          appStateListener = handler;
          return {
            remove: jest.fn(() => {
              appStateListener = null;
            }),
          };
        }),
        _simulateStateChange: (newState: string) => {
          if (appStateListener) {
            appStateListener(newState);
          }
        },
      },
    };
  },
  { virtual: true }
);

import { globalVoiceService } from "./globalVoiceService";
import { speechService } from "./speech";
import { voiceRecognitionService } from "./voiceRecognition";
import { AppState } from "react-native";

describe("globalVoiceService — Voice Session State Machine (Rule 2)", () => {
  const advanceAndFlush = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.useFakeTimers();

    jest.spyOn(speechService, "speak").mockImplementation(async (text, opts) => {
      opts?.onDone?.();
    });
    jest.spyOn(speechService, "stop").mockImplementation(async () => {});
    jest.spyOn(speechService, "isSpeaking").mockReturnValue(false);
    jest.spyOn(speechService, "isSpeakingAsync").mockResolvedValue(false);

    jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({ available: true });
    jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(true);
    jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async () => {});
    jest.spyOn(voiceRecognitionService, "stopListening").mockImplementation(() => {});
    jest.spyOn(voiceRecognitionService, "cancelListening").mockImplementation(() => {});

    await globalVoiceService.stopAll();
    globalVoiceService.setHandsFreeMode(false);
  });

  afterEach(async () => {
    jest.clearAllTimers();
    jest.useRealTimers();
    await globalVoiceService.stopAll();
    globalVoiceService.setHandsFreeMode(false);
  });

  describe("Push-to-Talk Lifecycle & Zero Unsolicited Speech", () => {
    it("starts in IDLE state with no unsolicited speech", () => {
      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("IDLE");
      expect(state.isActive).toBe(false);
      expect(state.isListening).toBe(false);
      expect(state.isSpeaking).toBe(false);
      expect(state.statusMessage).toBe("Ready");
      expect(speechService.speak).not.toHaveBeenCalled();
    });

    it("starts voice session on user push-to-talk without speaking unprompted greeting", async () => {
      const listenSpy = jest.spyOn(voiceRecognitionService, "startListening");
      const speakSpy = jest.spyOn(speechService, "speak");

      const started = await globalVoiceService.startVoiceSession();
      expect(started).toBe(true);

      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("LISTENING");
      expect(state.isListening).toBe(true);
      expect(state.statusMessage).toBe("Listening...");

      // Verified: Zero unsolicited spoken greeting on activation!
      expect(speakSpy).not.toHaveBeenCalled();
      expect(listenSpy).toHaveBeenCalledTimes(1);
    });

    it("toggles off from LISTENING back to IDLE when tapped again", async () => {
      await globalVoiceService.startVoiceSession();
      expect(globalVoiceService.getState().isListening).toBe(true);

      const toggled = await globalVoiceService.toggleVoiceMode();
      expect(toggled).toBe(false);

      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("IDLE");
      expect(state.isListening).toBe(false);
      expect(state.statusMessage).toBe("Ready");
    });

    it("handles permission denial gracefully without unsolicited speech", async () => {
      jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(false);
      const speakSpy = jest.spyOn(speechService, "speak");

      const success = await globalVoiceService.startVoiceSession();
      expect(success).toBe(false);

      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("IDLE");
      expect(state.error?.toLowerCase()).toContain("permission was denied");
      expect(speakSpy).not.toHaveBeenCalled();
    });

    it("handles native speech engine unavailability gracefully", async () => {
      jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({
        available: false,
        reason: "Speech recognition requires a native Android build.",
      });
      const speakSpy = jest.spyOn(speechService, "speak");

      const success = await globalVoiceService.startVoiceSession();
      expect(success).toBe(false);

      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("IDLE");
      expect(state.error).toContain("Speech recognition requires a native Android build");
      expect(speakSpy).not.toHaveBeenCalled();
    });
  });

  describe("State Machine: IDLE -> LISTENING -> PROCESSING -> SPEAKING -> IDLE", () => {
    it("completes full command lifecycle and returns to IDLE without looping", async () => {
      const onNavigateScreen = jest.fn();
      globalVoiceService.setDispatchContextProvider(() => ({
        currentScreen: "home",
        onNavigateToScreen: onNavigateScreen,
      }));

      let capturedCallbacks: any = null;
      jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async (cbs) => {
        capturedCallbacks = cbs;
      });

      const speakSpy = jest.spyOn(speechService, "speak");

      await globalVoiceService.startVoiceSession();
      expect(capturedCallbacks).toBeTruthy();

      // Trigger final transcript
      capturedCallbacks.onResult({
        transcript: "open timetable",
        isFinal: true,
      });

      await advanceAndFlush(100);

      // Verify navigation occurred
      expect(onNavigateScreen).toHaveBeenCalledWith("timetable");

      // Verify exactly ONE spoken response
      expect(speakSpy).toHaveBeenCalledTimes(1);
      expect(speakSpy).toHaveBeenCalledWith(
        expect.stringMatching(/timetable/i),
        expect.objectContaining({ force: true })
      );

      // Verify it cleanly transitions to IDLE (no auto-restart loop)
      const finalState = globalVoiceService.getState();
      expect(finalState.sessionState).toBe("IDLE");
      expect(finalState.isListening).toBe(false);
      expect(finalState.statusMessage).toBe("Ready");
    });

    it("prevents duplicate submissions for duplicate results", async () => {
      let capturedCallbacks: any = null;
      jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async (cbs) => {
        capturedCallbacks = cbs;
      });
      const speakSpy = jest.spyOn(speechService, "speak");

      await globalVoiceService.startVoiceSession();

      // First final transcript
      capturedCallbacks.onResult({
        transcript: "what time is my next class",
        isFinal: true,
      });

      // Rapid secondary final transcript (simulated race)
      capturedCallbacks.onResult({
        transcript: "what time is my next class",
        isFinal: true,
      });

      await advanceAndFlush(100);

      // Exactly ONE response spoken
      expect(speakSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("STOP ALL & Cancellation (Rule 2)", () => {
    it("stopAll immediately cancels listening, stops playback, and resets to IDLE", async () => {
      const stopListenSpy = jest.spyOn(voiceRecognitionService, "stopListening");
      const stopSpeechSpy = jest.spyOn(speechService, "stop");

      await globalVoiceService.startVoiceSession();
      expect(globalVoiceService.getState().isListening).toBe(true);

      await globalVoiceService.stopAll();

      expect(stopListenSpy).toHaveBeenCalled();
      expect(stopSpeechSpy).toHaveBeenCalled();
      const state = globalVoiceService.getState();
      expect(state.sessionState).toBe("IDLE");
      expect(state.isListening).toBe(false);
      expect(state.statusMessage).toBe("Ready");
    });

    it("ignores stale asynchronous responses after session cancellation", async () => {
      let capturedCallbacks: any = null;
      jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async (cbs) => {
        capturedCallbacks = cbs;
      });

      // Setup an asynchronous dispatch context that simulates pending async work
      globalVoiceService.setDispatchContextProvider(() => ({
        currentScreen: "reader",
        onTriggerScan: () => new Promise((resolve) => setTimeout(resolve, 200)),
      }));

      const speakSpy = jest.spyOn(speechService, "speak");

      await globalVoiceService.startVoiceSession();

      // Trigger dispatch that does async work
      capturedCallbacks.onResult({
        transcript: "scan now",
        isFinal: true,
      });

      // User hits STOP ALL while command is still processing asynchronously
      await globalVoiceService.stopAll();

      // Advance timers to let the async work settle
      await advanceAndFlush(500);

      // Stale response must NOT be spoken!
      expect(speakSpy).not.toHaveBeenCalled();
      expect(globalVoiceService.getState().sessionState).toBe("IDLE");
    });

    it("stops everything when app goes to background without auto-resuming", async () => {
      const stopListenSpy = jest.spyOn(voiceRecognitionService, "stopListening");
      const listenSpy = jest.spyOn(voiceRecognitionService, "startListening");

      await globalVoiceService.startVoiceSession();
      expect(globalVoiceService.getState().isListening).toBe(true);

      // App backgrounded
      (AppState as any)._simulateStateChange("background");
      await advanceAndFlush(50);

      expect(stopListenSpy).toHaveBeenCalled();
      expect(globalVoiceService.getState().sessionState).toBe("IDLE");

      // App foregrounded: must NOT spontaneously start listening
      (AppState as any)._simulateStateChange("active");
      await advanceAndFlush(500);

      // Listening is NOT spontaneously restarted
      expect(listenSpy).toHaveBeenCalledTimes(1); // Only the initial one
      expect(globalVoiceService.getState().sessionState).toBe("IDLE");
    });
  });

  describe("Hands-Free Mode (Explicit Opt-In)", () => {
    it("restarts listening after speech finishes ONLY when handsFreeMode is explicitly enabled", async () => {
      globalVoiceService.setHandsFreeMode(true);

      let capturedCallbacks: any = null;
      let listenCount = 0;
      jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async (cbs) => {
        capturedCallbacks = cbs;
        listenCount++;
      });

      await globalVoiceService.startVoiceSession();
      expect(listenCount).toBe(1);

      // Process command
      capturedCallbacks.onResult({
        transcript: "open reader",
        isFinal: true,
      });

      await advanceAndFlush(200);

      // Because handsFreeMode is true, it re-enters LISTENING after speech completes
      expect(listenCount).toBe(2);
      expect(globalVoiceService.getState().sessionState).toBe("LISTENING");
    });
  });

  describe("Subscriptions and Clean Up", () => {
    it("notifies listeners on state transitions and unsubscribes cleanly", () => {
      const listener = jest.fn();
      const unsubscribe = globalVoiceService.subscribe(listener);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ sessionState: "IDLE", statusMessage: "Ready" })
      );

      unsubscribe();
      globalVoiceService.pauseListening();

      // No calls after unsubscribe
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
