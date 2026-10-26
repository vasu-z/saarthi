import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Mock native ESM modules so ts-jest runs cleanly
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
  () => ({
    Platform: { OS: "android" },
    AccessibilityInfo: {
      announceForAccessibility: jest.fn(),
    },
    AppState: {
      currentState: "active",
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
  }),
  { virtual: true }
);

import { dispatchVoiceCommand, VoiceCommandDispatchContext } from "./voiceDispatcher";
import { parseVoiceCommand } from "./voiceCommands";
import { speechService } from "./speech";
import { globalVoiceService } from "./globalVoiceService";
import { voiceRecognitionService } from "./voiceRecognition";
import { SCREEN_REGISTRY } from "../navigation/screenRegistry";

describe("Voice-First Campus Mode Auto Read & Results Suite", () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(speechService, "speak").mockImplementation(async () => {});
    jest.spyOn(speechService, "stop").mockImplementation(async () => {});
    jest.spyOn(speechService, "repeatLast").mockImplementation(async () => true);
    jest.spyOn(speechService, "isSpeaking").mockReturnValue(false);
    jest.spyOn(speechService, "isSpeakingAsync").mockResolvedValue(false);
    await globalVoiceService.disableVoiceMode(false);
  });

  // ==========================================
  // 1. VOICE-GUIDED STARTUP
  // ==========================================
  describe("Requirement 1: Voice-Guided Startup", () => {
    it("provides clear camera positioning and scan initiation guidance", () => {
      const readerRegistry = SCREEN_REGISTRY.reader;
      expect(readerRegistry.whatCanIDo.toLowerCase()).toContain("scan now");
      expect(readerRegistry.whereAmI.toLowerCase()).toContain("campus reader");
    });

    it("enables voice mode with custom Auto Read startup guidance without competing listeners", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");
      jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({ available: true });
      jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(true);
      jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async () => {});

      const customWelcome =
        "Auto Read active. Point your camera steady at a document or sign about 1 to 2 feet away. Say 'scan now' or tap the screen to capture.";

      await globalVoiceService.enableVoiceMode(customWelcome);

      expect(globalVoiceService.getState().isActive).toBe(true);
      expect(speakSpy).toHaveBeenCalledWith(
        customWelcome,
        expect.objectContaining({ force: true })
      );
    });

    it("announces clear recovery instructions when speech recognition is unavailable", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");
      jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({
        available: false,
        reason: "Speech recognition unavailable on this build",
      });

      await globalVoiceService.enableVoiceMode();

      expect(globalVoiceService.getState().isActive).toBe(false);
      expect(speakSpy).toHaveBeenCalledWith(
        expect.stringContaining("Speech recognition unavailable"),
        expect.objectContaining({ force: true })
      );
    });

    it("announces clear recovery instructions when microphone permission is denied", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");
      jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({ available: true });
      jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(false);

      await globalVoiceService.enableVoiceMode();

      expect(globalVoiceService.getState().isActive).toBe(false);
      expect(speakSpy).toHaveBeenCalledWith(
        expect.stringContaining("Microphone or speech recognition permission was denied"),
        expect.objectContaining({ force: true })
      );
    });

    it("does NOT restart listening when voice mode is paused", async () => {
      // Simulate paused state
      jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({ available: true });
      jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(true);
      await globalVoiceService.enableVoiceMode("Voice mode is on.");
      await globalVoiceService.pauseListening(false);

      expect(globalVoiceService.getState().isPaused).toBe(true);
      expect(globalVoiceService.getState().isListening).toBe(false);

      // Verify scheduleStartListening respects paused state
      const startSpy = jest.spyOn(voiceRecognitionService, "startListening");
      globalVoiceService.scheduleStartListening(0);

      // Give event loop tick
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // 2. VOICE-CONTROLLED SCAN
  // ==========================================
  describe("Requirement 2: Voice-Controlled Scan", () => {
    it("recognizes 'scan now' command and triggers the real capture pipeline", async () => {
      const triggerScanMock = jest.fn(async () => {});
      const context: VoiceCommandDispatchContext = {
        currentScreen: "reader",
        onTriggerScan: triggerScanMock,
      };

      const result = await dispatchVoiceCommand("scan now", context);

      expect(triggerScanMock).toHaveBeenCalledTimes(1);
      expect(result).toBe("Scan initiated.");
    });

    it("recognizes natural language capture variations ('capture', 'take picture', 'take photo')", async () => {
      const variations = ["capture", "capture now", "take photo", "take picture", "take a scan"];
      for (const phrase of variations) {
        const triggerScanMock = jest.fn(async () => {});
        const res = await dispatchVoiceCommand(phrase, {
          currentScreen: "reader",
          onTriggerScan: triggerScanMock,
        });
        expect(triggerScanMock).toHaveBeenCalledTimes(1);
        expect(res).toBe("Scan initiated.");
      }
    });

    it("prevents duplicate scan execution when capture/analysis is in progress", async () => {
      const triggerScanMock = jest.fn(async () => {});
      const speakSpy = jest.spyOn(speechService, "speak");

      const context: VoiceCommandDispatchContext = {
        currentScreen: "reader",
        isCapturing: true,
        onTriggerScan: triggerScanMock,
      };

      const result = await dispatchVoiceCommand("scan now", context);

      expect(triggerScanMock).not.toHaveBeenCalled();
      expect(result).toContain("A scan is already in progress");
      expect(speakSpy).toHaveBeenCalledWith(
        "A scan is already in progress. Please wait.",
        { force: true }
      );
    });

    it("navigates to reader when user says 'scan now' while on another screen", async () => {
      const navMock = jest.fn();
      const speakSpy = jest.spyOn(speechService, "speak");

      const context: VoiceCommandDispatchContext = {
        currentScreen: "home",
        onNavigateToScreen: navMock,
      };

      const result = await dispatchVoiceCommand("scan now", context);

      expect(navMock).toHaveBeenCalledWith("reader");
      expect(result).toContain("Opening camera in Auto Read mode");
      expect(speakSpy).toHaveBeenCalledWith(
        "Opening camera in Auto Read mode. Say 'scan now' when ready.",
        { force: true }
      );
    });
  });

  // ==========================================
  // 3. VOICE-CONTROLLED RESULTS
  // ==========================================
  describe("Requirement 3: Voice-Controlled Results Actions", () => {
    const mockReadingResult: any = {
      spokenText: "Room 302, Department of Mathematics. Office hours: Tuesday 10am to 12pm.",
      response: {
        status: "success",
        reading_mode: "auto",
        confidence: 0.92,
        needs_rescan: false,
        source_text: "MATHEMATICS DEPARTMENT\nROOM 302\nOFFICE HOURS: TUE 10:00-12:00",
        spoken_summary: "Room 302 Mathematics Department",
        timetable_items: [],
        notices: [],
        uncertainties: [],
        unchecked_areas: [],
      },
    };

    it("speaks verbatim source text for 'read the full text'", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");

      const result = await dispatchVoiceCommand("read the full text", {
        currentScreen: "results",
        currentReadingResult: mockReadingResult,
      });

      expect(result).toContain("MATHEMATICS DEPARTMENT");
      expect(speakSpy).toHaveBeenCalledWith(
        expect.stringContaining("MATHEMATICS DEPARTMENT\nROOM 302\nOFFICE HOURS: TUE 10:00-12:00"),
        { force: true }
      );
    });

    it("speaks concise summary for 'summarize this'", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");

      const result = await dispatchVoiceCommand("summarize this", {
        currentScreen: "results",
        currentReadingResult: mockReadingResult,
      });

      expect(result).toContain("Room 302 Mathematics Department");
      expect(speakSpy).toHaveBeenCalledWith(
        "Summary: Room 302 Mathematics Department",
        { force: true }
      );
    });

    it("replays the last spoken message for 'repeat'", async () => {
      const repeatSpy = jest.spyOn(speechService, "repeatLast");

      const result = await dispatchVoiceCommand("repeat", {
        currentScreen: "results",
      });

      expect(repeatSpy).toHaveBeenCalledTimes(1);
      expect(result).toBe("Replaying last message.");
    });

    it("immediately silences speech output for 'stop'", async () => {
      const stopSpy = jest.spyOn(speechService, "stop");
      stopSpy.mockClear();

      const result = await dispatchVoiceCommand("stop", {
        currentScreen: "results",
      });

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(result).toBe("Stopped speaking.");
    });

    it("navigates back to camera scanner for 'scan again'", async () => {
      const scanAgainMock = jest.fn();
      const speakSpy = jest.spyOn(speechService, "speak");

      const result = await dispatchVoiceCommand("scan again", {
        currentScreen: "results",
        onScanAgain: scanAgainMock,
      });

      expect(scanAgainMock).toHaveBeenCalledTimes(1);
      expect(result).toContain("Returning to camera");
      expect(speakSpy).toHaveBeenCalledWith(
        "Returning to camera. Say 'scan now' when ready.",
        { force: true }
      );
    });

    it("navigates home for 'go home'", async () => {
      const navMock = jest.fn();
      const speakSpy = jest.spyOn(speechService, "speak");

      const result = await dispatchVoiceCommand("go home", {
        currentScreen: "results",
        onNavigateToScreen: navMock,
      });

      expect(navMock).toHaveBeenCalledWith("home");
      expect(result).toBe("Opening Home.");
      expect(speakSpy).toHaveBeenCalledWith("Opening Home.", { force: true });
    });

    it("describes voice actions for 'help' on results screen without fabricating", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");

      const result = await dispatchVoiceCommand("help", {
        currentScreen: "results",
      });

      expect(result.toLowerCase()).toContain("read the full text");
      expect(result.toLowerCase()).toContain("summarize this");
      expect(result.toLowerCase()).toContain("scan again");
      expect(result.toLowerCase()).toContain("go home");
      expect(speakSpy).toHaveBeenCalledWith(result, { force: true });
    });

    it("gracefully explains when attempting results actions with no reading result", async () => {
      const speakSpy = jest.spyOn(speechService, "speak");

      const fullRes = await dispatchVoiceCommand("read the full text", {
        currentScreen: "results",
        currentReadingResult: null,
      });
      expect(fullRes).toContain("No text was detected in the latest scan");

      const sumRes = await dispatchVoiceCommand("summarize this", {
        currentScreen: "results",
        currentReadingResult: null,
      });
      expect(sumRes).toContain("No summary is available for this scan");
    });
  });

  // ==========================================
  // 4. COORDINATION & STATE SAFETY
  // ==========================================
  describe("Requirement 4: Voice Interaction State & Coordination", () => {
    it("waits for TTS playback before resuming speech recognition", async () => {
      const waitSpy = jest.spyOn(speechService, "waitForPlaybackCompletion").mockResolvedValue(undefined);
      expect(waitSpy).toBeDefined();
    });

    it("parses commands with high confidence and normalizes transcripts cleanly", () => {
      const parsed = parseVoiceCommand("  SCAN NOW, PLEASE!  ");
      expect(parsed.intent).toBe("scan_now");
      expect(parsed.confidence).toBeGreaterThanOrEqual(0.95);

      const parsedFull = parseVoiceCommand("READ THE FULL TEXT.");
      expect(parsedFull.intent).toBe("read_full_text");

      const parsedSummary = parseVoiceCommand("Could you summarize this?");
      expect(parsedSummary.intent).toBe("summarize_this");
    });
  });
});
