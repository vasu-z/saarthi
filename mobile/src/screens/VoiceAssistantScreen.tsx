import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  AccessibilityInfo,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { voiceRecognitionService } from "../services/voiceRecognition";
import { parseVoiceCommand, ParsedVoiceCommand } from "../services/voiceCommands";
import { readingPipeline } from "../services/readingPipeline";

import type { AppScreen } from "../../App";
import { dispatchVoiceCommand } from "../services/voiceDispatcher";
import { globalVoiceService } from "../services/globalVoiceService";

export interface VoiceAssistantScreenProps {
  currentScreen?: AppScreen;
  screenHistory?: AppScreen[];
  hasReadingResult?: boolean;
  onNavigateToScreen?: (screen: AppScreen) => void;
  onNavigateBack: () => void;
  onNavigateToReader: (mode?: "auto" | "timetable" | "sign" | "notice") => void;
  onNavigateToNavigation: (destinationQuery?: string) => void;
  onNavigateToTimetable: () => void;
}

export const VoiceAssistantScreen: React.FC<VoiceAssistantScreenProps> = ({
  currentScreen = "voice",
  screenHistory,
  hasReadingResult,
  onNavigateToScreen,
  onNavigateBack,
  onNavigateToReader,
  onNavigateToNavigation,
  onNavigateToTimetable,
}) => {
  const [isListening, setIsListening] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("Ready to listen. Tap the microphone below.");
  const [lastCommand, setLastCommand] = useState<ParsedVoiceCommand | null>(null);
  const [customCommandInput, setCustomCommandInput] = useState<string>("");
  const [isNativeAvailable, setIsNativeAvailable] = useState<boolean>(true);
  const [nativeUnavailableReason, setNativeUnavailableReason] = useState<string>("");

  useEffect(() => {
    const avail = voiceRecognitionService.checkAvailability();
    setIsNativeAvailable(avail.available);
    if (!avail.available && avail.reason) {
      setNativeUnavailableReason(avail.reason);
    }
    return () => {
      voiceRecognitionService.stopListening();
      speechService.stop();
    };
  }, []);

  // Execute a recognized voice command using the active screen context
  const dispatchCommand = async (rawText: string) => {
    if (!rawText.trim()) return;

    await hapticsService.triggerButtonPress();
    setStatusMessage("Processing command...");
    const parsed = parseVoiceCommand(rawText);
    setLastCommand(parsed);

    const resultMessage = await dispatchVoiceCommand(parsed, {
      currentScreen,
      screenHistory,
      hasReadingResult,
      onNavigateToScreen,
      onNavigateToReader,
      onNavigateToNavigation,
      onNavigateToTimetable,
      onNavigateBack,
      onStopListening: () => {
        globalVoiceService.pauseListening(false);
      },
      onResumeListening: () => {
        globalVoiceService.resumeListening(false);
      },
      onExitVoiceMode: () => {
        globalVoiceService.disableVoiceMode(false);
      },
    });

    setStatusMessage(resultMessage);
  };

  const handleToggleListening = async () => {
    if (isListening) {
      voiceRecognitionService.stopListening();
      setIsListening(false);
      return;
    }

    // Immediately stop any active TTS output before listening
    await speechService.stop();

    if (!isNativeAvailable) {
      const msg =
        "On-device speech recognition is active in native Android builds. In Expo Go, you can tap any verified voice command below or type your question.";
      await speechService.speak(msg, { force: true });
      setStatusMessage(msg);
      return;
    }

    try {
      setIsListening(true);
      setTranscript("");
      setStatusMessage("Listening... Speak your command now.");
      await hapticsService.triggerBottomRight();

      await voiceRecognitionService.startListening({
        onStart: () => {
          setIsListening(true);
        },
        onResult: (res) => {
          setTranscript(res.transcript);
          if (res.isFinal) {
            setIsListening(false);
            dispatchCommand(res.transcript);
          }
        },
        onError: (err) => {
          setIsListening(false);
          setStatusMessage("I couldn't hear that clearly. Tap to try again.");
        },
        onEnd: () => {
          setIsListening(false);
        },
      });
    } catch {
      setIsListening(false);
      setStatusMessage("Failed to start microphone.");
    }
  };

  const exampleCommands = [
    { label: "Where am I?", query: "where am i" },
    { label: "What can I do here?", query: "what can i do here" },
    { label: "Go Home", query: "go home" },
    { label: "Open Reader", query: "open reader" },
    { label: "Open Navigation", query: "open navigation" },
    { label: "Open Timetable", query: "open timetable" },
    { label: "Open Settings", query: "open settings" },
    { label: "Go Back", query: "go back" },
    { label: "Repeat that", query: "repeat that" },
    { label: "Stop", query: "stop" },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* 1. Header */}
      <View style={styles.headerRow}>
        <Pressable
          onPress={onNavigateBack}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Back to Home"
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
          <Text style={styles.backButtonText}>Home</Text>
        </Pressable>

        <Text style={styles.screenTitle} accessibilityRole="header">
          Voice Assistant
        </Text>

        <View style={{ width: 40 }} />
      </View>

      {/* 2. Runtime Capability Notice if in Expo Go */}
      {!isNativeAvailable && (
        <View style={styles.capabilityNotice} accessible={true} accessibilityRole="summary">
          <Ionicons name="information-circle" size={20} color={Colors.primary} />
          <Text style={styles.capabilityNoticeText}>
            Continuous microphone recognition is active in the prebuilt native Android APK.
            {"\n"}In Expo Go, use the verified command chips or the text field below.
          </Text>
        </View>
      )}

      {/* 3. Real Push to Talk Button */}
      <View style={styles.micSection}>
        <Pressable
          onPress={handleToggleListening}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={isListening ? "Stop listening" : "Tap to speak voice command"}
          accessibilityHint="Starts microphone and listens for speech"
          style={({ pressed }) => [
            styles.micButton,
            isListening && styles.micButtonListening,
            pressed && styles.micButtonPressed,
          ]}
        >
          <Ionicons
            name={isListening ? "mic" : "mic-outline"}
            size={48}
            color="#FFFFFF"
          />
        </Pressable>

        <Text style={styles.micStatusText}>
          {isListening ? "Listening... Tap to Stop" : "Tap Microphone to Speak"}
        </Text>
      </View>

      {/* 4. Live Transcription & Status Card */}
      <View
        style={styles.statusCard}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Text style={styles.statusLabel}>RECOGNIZED TRANSCRIPT</Text>
        <Text style={styles.transcriptText}>
          {transcript ? `"${transcript}"` : "Speak a command or tap an example below"}
        </Text>

        <View style={styles.divider} />

        <Text style={styles.statusLabel}>ASSISTANT RESPONSE</Text>
        <Text style={styles.statusMessageText}>{statusMessage}</Text>
      </View>

      {/* 5. Quick Test Commands (Always functional!) */}
      <View style={styles.examplesSection}>
        <Text style={styles.examplesTitle}>Verified Voice Commands</Text>
        <Text style={styles.examplesSubtitle}>
          Tap any command to test instant application dispatch:
        </Text>

        <View style={styles.chipsWrap}>
          {exampleCommands.map((cmd, idx) => (
            <Pressable
              key={idx}
              onPress={() => {
                setTranscript(cmd.query);
                dispatchCommand(cmd.query);
              }}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={`Dispatch command: ${cmd.label}`}
              style={styles.commandChip}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={Colors.primary} />
              <Text style={styles.commandChipText}>{cmd.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* 6. Manual Command Input Field */}
      <View style={styles.manualInputSection}>
        <Text style={styles.manualInputLabel}>Or Type a Command:</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.textInputField}
            placeholder="e.g. read timetable, next class, take me to hall..."
            placeholderTextColor={Colors.textPlaceholder}
            value={customCommandInput}
            onChangeText={setCustomCommandInput}
            onSubmitEditing={() => {
              dispatchCommand(customCommandInput);
              setCustomCommandInput("");
            }}
            accessible={true}
            accessibilityLabel="Type voice command text"
          />
          <Pressable
            onPress={() => {
              dispatchCommand(customCommandInput);
              setCustomCommandInput("");
            }}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Send typed voice command"
            style={styles.sendButton}
          >
            <Ionicons name="send" size={18} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  contentContainer: {
    padding: 20,
    paddingTop: 48,
    paddingBottom: 60,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: Colors.textPrimary,
  },
  capabilityNotice: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: Colors.primaryLight,
    padding: 14,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  capabilityNoticeText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
    flex: 1,
    fontWeight: "600",
  },
  micSection: {
    alignItems: "center",
    marginVertical: 20,
  },
  micButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 4,
    borderColor: "#FFFFFF",
  },
  micButtonListening: {
    backgroundColor: Colors.stopButton,
    borderColor: "#FACC15",
    borderWidth: 4,
  },
  micButtonPressed: {
    transform: [{ scale: 0.94 }],
  },
  micStatusText: {
    fontSize: 15,
    fontWeight: "800",
    color: Colors.textPrimary,
    marginTop: 14,
  },
  statusCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: Colors.border,
    marginBottom: 24,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  transcriptText: {
    fontSize: 18,
    fontWeight: "800",
    color: Colors.textPrimary,
    lineHeight: 24,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: 14,
  },
  statusMessageText: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  examplesSection: {
    marginBottom: 24,
  },
  examplesTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  examplesSubtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 12,
  },
  chipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  commandChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  commandChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  manualInputSection: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  manualInputLabel: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.textPrimary,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
  },
  textInputField: {
    flex: 1,
    backgroundColor: Colors.backgroundAlt,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: Colors.textPrimary,
    minHeight: 48,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
