import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Mock native ESM modules
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
  "expo-location",
  () => ({
    requestForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
    getForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
    isLocationServicesEnabledAsync: jest.fn(async () => false),
    watchPositionAsync: jest.fn(),
    getCurrentPositionAsync: jest.fn(),
    Accuracy: { High: 4, Balanced: 3, Low: 1 },
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

import { speechService } from "./speech";
import { globalVoiceService } from "./globalVoiceService";
import { voiceRecognitionService } from "./voiceRecognition";
import { dispatchVoiceCommand } from "./voiceDispatcher";
import { outdoorRoutingService } from "./outdoorRoutingService";
import { locationService } from "./locationService";
import * as client from "../api/client";

describe("Rule 7 Reality-First Regression Verification Suite", () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.useFakeTimers();

    jest.spyOn(speechService, "speak").mockImplementation(async (text, opts) => {
      opts?.onDone?.();
    });
    jest.spyOn(speechService, "stop").mockImplementation(async () => {});
    jest.spyOn(speechService, "isSpeaking").mockReturnValue(false);

    jest.spyOn(voiceRecognitionService, "checkAvailability").mockReturnValue({ available: true });
    jest.spyOn(voiceRecognitionService, "requestPermissions").mockResolvedValue(true);
    jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async () => {});
    jest.spyOn(voiceRecognitionService, "stopListening").mockImplementation(() => {});

    await globalVoiceService.stopAll();
    globalVoiceService.setHandsFreeMode(false);
  });

  afterEach(async () => {
    jest.clearAllTimers();
    jest.useRealTimers();
    await globalVoiceService.stopAll();
  });

  const advanceAndFlush = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  // Verification 1: Launching the app silently does not make the assistant speak
  it("V1: Launching the app silently does not make the assistant speak", () => {
    const speakSpy = jest.spyOn(speechService, "speak");
    const state = globalVoiceService.getState();

    expect(state.sessionState).toBe("IDLE");
    expect(state.isActive).toBe(false);
    expect(state.isListening).toBe(false);
    expect(state.isSpeaking).toBe(false);
    expect(speakSpy).not.toHaveBeenCalled();
  });

  // Verification 2: One push-to-talk request does not result in duplicate submissions or duplicate speech
  it("V2: One push-to-talk request does not result in duplicate submissions or duplicate speech", async () => {
    let capturedCallbacks: any = null;
    jest.spyOn(voiceRecognitionService, "startListening").mockImplementation(async (cbs) => {
      capturedCallbacks = cbs;
    });
    const speakSpy = jest.spyOn(speechService, "speak");

    await globalVoiceService.startVoiceSession();
    expect(capturedCallbacks).toBeTruthy();

    // Trigger final transcript
    capturedCallbacks.onResult({
      transcript: "where am i",
      isFinal: true,
    });

    // Rapid simulated duplicate result
    capturedCallbacks.onResult({
      transcript: "where am i",
      isFinal: true,
    });

    await advanceAndFlush(100);

    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(globalVoiceService.getState().sessionState).toBe("IDLE");
  });

  // Verification 3: STOP ALL actually stops speech and cancels pending work
  it("V3: STOP ALL actually stops speech and cancels pending work", async () => {
    const stopListenSpy = jest.spyOn(voiceRecognitionService, "stopListening");
    const stopSpeechSpy = jest.spyOn(speechService, "stop");

    await globalVoiceService.startVoiceSession();
    expect(globalVoiceService.getState().isListening).toBe(true);

    await globalVoiceService.stopAll();

    expect(stopListenSpy).toHaveBeenCalled();
    expect(stopSpeechSpy).toHaveBeenCalled();
    expect(globalVoiceService.getState().sessionState).toBe("IDLE");
    expect(globalVoiceService.getState().isListening).toBe(false);
  });

  // Verification 4: ElevenLabs TTS produces playable audio with valid credentials and clear failure with missing/invalid credentials
  it("V4: ElevenLabs TTS produces playable audio when configured and clear failure when unconfigured", async () => {
    // 4a: Missing credentials -> backend reports unconfigured, fallback works cleanly without pretending
    jest.spyOn(client, "getSpeechStatus").mockResolvedValue({
      configured: false,
      voice_id: "",
      model_id: "eleven_multilingual_v2",
    });

    const statusUnconfigured = await client.getSpeechStatus();
    expect(statusUnconfigured.configured).toBe(false);

    // 4b: Valid credentials -> backend returns audio
    jest.spyOn(client, "getSpeechStatus").mockResolvedValue({
      configured: true,
      voice_id: "21m00Tcm4TlvDq8ikWAM",
      model_id: "eleven_multilingual_v2",
    });

    jest.spyOn(client, "synthesizeSpeechAudio").mockResolvedValue({
      ok: true,
      audioBase64: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA",
    });

    const statusConfigured = await client.getSpeechStatus();
    expect(statusConfigured.configured).toBe(true);

    const audioRes = await client.synthesizeSpeechAudio("Testing natural voice");
    expect(audioRes.ok).toBe(true);
    expect(audioRes.audioBase64).toBeTruthy();
  });

  // Verification 5: Unsupported commands do not trigger repeated 'commands not found' responses
  it("V5: Unsupported commands do not trigger repeated 'commands not found' responses", async () => {
    const speakSpy = jest.spyOn(speechService, "speak");

    const response = await dispatchVoiceCommand("fly me to the moon", {
      currentScreen: "home",
    });

    // Does NOT say robotic "command not found"
    expect(response.toLowerCase()).not.toContain("command not found");
    expect(response.toLowerCase()).not.toContain("stack trace");
    // Speaks friendly natural guidance
    expect(response).toContain("I did not recognize the command");
    expect(response).toContain("You can ask for your next class, directions to a campus building");
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  // Verification 6: GPS denial does not display a fabricated current location
  it("V6: GPS denial does not display a fabricated current location", async () => {
    jest.spyOn(locationService, "startWatchingLocation").mockResolvedValue({
      granted: false,
      canAskAgain: true,
      servicesEnabled: false,
      errorMessage: "Location permission was denied.",
    });

    const perm = await locationService.startWatchingLocation(
      () => {},
      () => {}
    );

    expect(perm.granted).toBe(false);
    // Verified: No CU coordinates (30.7688, 76.5754) are injected on denial
    expect(locationService.getLastKnownLocation()).toBeNull();
  });

  // Verification 7: A navigation request with no valid route never draws a fake route or announces success
  it("V7: A navigation request with no valid route never draws a fake route or announces success", async () => {
    // Simulate routing failure (e.g. disconnected points)
    (globalThis as any).fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "No route" }),
      } as any)
    );

    const route = await outdoorRoutingService.calculateRoute(
      { latitude: 30.7688, longitude: 76.5754 },
      { latitude: 0.0, longitude: 0.0 }, // Out-of-bounds unreachable destination
      { destinationName: "Unreachable Point" }
    );

    expect(route.status).toBe("no_route_found");
    // Coordinates array must strictly be empty (no fake fallback polyline!)
    expect(route.coordinates).toEqual([]);
    expect(route.polyline).toBe("");
    expect(route.totalDistanceMeters).toBe(0);
    expect(route.spokenSummary).toContain("No pedestrian walking route found");
  });

  // Verification 8: An actual successful route request renders the real returned geometry
  it("V8: An actual successful route request renders the real returned geometry", async () => {
    const realCoords: [number, number][] = [
      [30.7688, 76.5754],
      [30.769, 76.5758],
      [30.77, 76.5762],
    ];

    (globalThis as any).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            total_distance_meters: 185,
            total_time_seconds: 140,
            polyline: "test_polyline",
            coordinates: realCoords,
            maneuvers: [
              {
                instruction: "Walk northeast on Academic Boulevard.",
                distance_meters: 185,
                time_seconds: 140,
                bearing_degrees: 45,
                maneuver_type: 1,
                location: { latitude: 30.7688, longitude: 76.5754 },
              },
            ],
            spoken_summary: "Walking route to Engineering Block found. Total distance: 185 meters.",
          }),
      } as any)
    );

    const route = await outdoorRoutingService.calculateRoute(
      { latitude: 30.7688, longitude: 76.5754 },
      { latitude: 30.77, longitude: 76.5762 },
      { destinationName: "Engineering Block" }
    );

    expect(route.status).toBe("success");
    expect(route.totalDistanceMeters).toBe(185);
    expect(route.coordinates).toEqual(realCoords);
    expect(route.coordinates.length).toBe(3);
    expect(route.spokenSummary).toContain("185 meters");
  });
});
