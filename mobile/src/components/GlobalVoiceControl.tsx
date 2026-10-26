import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { globalVoiceService, GlobalVoiceState } from "../services/globalVoiceService";
import { hapticsService } from "../services/haptics";
import type { AppScreen } from "../../App";

export interface GlobalVoiceControlProps {
  currentScreen?: AppScreen;
}

/**
 * Accessible Global Voice Control component.
 *
 * Requirements:
 * 1. Clutter reduction: When inactive on the Home screen, the capsule is hidden
 *    because the purple bottom-right corner tile serves as the primary activator.
 * 2. Reactivation: On non-home screens (or when active anywhere), renders a
 *    reliable, TalkBack-accessible control to toggle or manage voice mode.
 * 3. Non-overlapping: Positioned safely at the bottom on scrollable screens
 *    (timetable, navigation, settings, results) and top on camera reader to
 *    never collide with titles, settings, status pills, or back buttons.
 * 4. Multi-modal accessibility: Distinguishes listening, paused, and inactive
 *    states through text, icons, and TalkBack announcements without relying on color alone.
 */
export const GlobalVoiceControl: React.FC<GlobalVoiceControlProps> = ({
  currentScreen = "home",
}) => {
  const insets = useSafeAreaInsets();
  const [voiceState, setVoiceState] = useState<GlobalVoiceState>(globalVoiceService.getState());

  useEffect(() => {
    const unsubscribe = globalVoiceService.subscribe((state) => {
      setVoiceState(state);
    });
    return () => unsubscribe();
  }, []);

  // 1. CLUTTER REDUCTION: On Home screen when voice mode is inactive, do NOT render the top capsule.
  // The purple Voice Assistant tile at the bottom-right is the primary activator on Home.
  if (currentScreen === "home" && !voiceState.isActive) {
    return null;
  }

  const handleToggleMode = async () => {
    await hapticsService.triggerButtonPress();
    await globalVoiceService.toggleVoiceMode();
  };

  const handlePauseResume = async () => {
    await hapticsService.triggerButtonPress();
    if (voiceState.isPaused || voiceState.error) {
      await globalVoiceService.resumeListening(true);
    } else {
      await globalVoiceService.pauseListening(true);
    }
  };

  const handleExit = async () => {
    await hapticsService.triggerButtonPress();
    await globalVoiceService.disableVoiceMode(true);
  };

  // Determine non-overlapping anchor position based on active screen layout:
  // - Top center on Home (when active) and Campus Reader (above tiles, between Auto Read & Door Sign).
  // - Bottom center on scrollable content screens (timetable, navigation, settings, results)
  //   to completely prevent overlap with header titles, back buttons, and settings icons.
  const isTopDocked = currentScreen === "home" || currentScreen === "reader";
  const anchorStyle = isTopDocked
    ? [styles.floatingAnchorTop, { top: Math.max(insets.top, 8) + 2 }]
    : [styles.floatingAnchorBottom, { bottom: Math.max(insets.bottom, 12) + 8 }];

  // 2. INACTIVE STATE (Only rendered on non-home screens to allow voice mode activation)
  if (!voiceState.isActive) {
    return (
      <View pointerEvents="box-none" style={anchorStyle}>
        <Pressable
          onPress={handleToggleMode}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Voice Mode is off. Double-tap to turn voice mode on."
          accessibilityHint="Activates global voice navigation mode across all screens"
          style={({ pressed }) => [
            styles.inactivePill,
            pressed && styles.pillPressed,
          ]}
          hitSlop={8}
        >
          <Ionicons name="mic-outline" size={18} color="#94A3B8" style={styles.pillIcon} />
          <Text style={styles.inactivePillText}>Voice Mode: OFF</Text>
        </Pressable>
      </View>
    );
  }

  // 3. ACTIVE STATE (LISTENING, SPEAKING, PAUSED, OR RECOVERABLE RETRY) - Rendered across all screens
  const isPaused = voiceState.isPaused;
  const isListening = voiceState.isListening && !voiceState.isPaused;
  const isProcessing = voiceState.isProcessing;
  const isSpeaking = voiceState.isSpeaking;
  const hasError = Boolean(voiceState.error);

  let statusText = "Ready";
  let statusIcon: keyof typeof Ionicons.glyphMap = "mic-outline";
  let statusColor = "#38BDF8";

  if (hasError) {
    statusText = "Tap to Retry";
    statusIcon = "alert-circle";
    statusColor = "#EF4444";
  } else if (isPaused) {
    statusText = "Voice: PAUSED";
    statusIcon = "pause-circle";
    statusColor = "#F59E0B";
  } else if (isProcessing) {
    statusText = "Processing...";
    statusIcon = "sync";
    statusColor = "#A855F7";
  } else if (isListening) {
    statusText = "Listening...";
    statusIcon = "mic";
    statusColor = "#10B981";
  } else if (isSpeaking) {
    statusText = "Speaking...";
    statusIcon = "volume-medium";
    statusColor = "#38BDF8";
  } else {
    statusText = "Ready";
    statusIcon = "mic-outline";
    statusColor = "#38BDF8";
  }

  const accessibilityLabel = hasError
    ? `Voice recognition error: ${voiceState.error}. Double-tap to retry.`
    : isPaused
    ? "Voice mode is paused. Double-tap to resume listening."
    : isListening
    ? "Voice mode is listening. Double-tap to pause listening."
    : isSpeaking
    ? "Assistant is speaking. Double-tap to pause listening."
    : "Voice mode is active. Double-tap to pause listening.";

  const accessibilityHint = hasError
    ? "Retries starting voice recognition"
    : isPaused
    ? "Resumes voice recognition"
    : "Pauses voice recognition";

  const containerBorderColor = hasError
    ? styles.activePillError
    : isPaused
    ? styles.activePillPaused
    : isListening
    ? styles.activePillListening
    : styles.activePillSpeaking;

  return (
    <View pointerEvents="box-none" style={anchorStyle}>
      <View style={[styles.activePillContainer, containerBorderColor]}>
        {/* Left Toggle: Pause/Resume listening (56dp touch target) */}
        <Pressable
          onPress={handlePauseResume}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          style={({ pressed }) => [
            styles.statusToggleSection,
            pressed && styles.sectionPressed,
          ]}
          hitSlop={8}
        >
          <Ionicons
            name={statusIcon}
            size={20}
            color={statusColor}
            style={styles.pillIcon}
          />
          <View style={styles.statusTextWrap} accessibilityLiveRegion="polite">
            <Text
              style={[
                styles.activeStatusText,
                { color: statusColor },
              ]}
              numberOfLines={1}
            >
              {statusText}
            </Text>
          </View>
        </Pressable>

        {/* Separator Divider */}
        <View style={styles.pillDivider} />

        {/* Right Button: Exit Voice Mode (56dp touch target) */}
        <Pressable
          onPress={handleExit}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Exit Voice Mode. Double-tap to turn off voice mode completely."
          accessibilityHint="Disables voice mode and stops microphone completely"
          style={({ pressed }) => [
            styles.exitSection,
            pressed && styles.sectionPressed,
          ]}
          hitSlop={8}
        >
          <Ionicons name="close" size={18} color="#F87171" />
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  floatingAnchorTop: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 9999,
  },
  floatingAnchorBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 9999,
  },
  inactivePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.94)",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "rgba(148, 163, 184, 0.4)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 5,
    elevation: 6,
    minHeight: 56,
  },
  pillPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.97 }],
  },
  pillIcon: {
    marginRight: 6,
  },
  inactivePillText: {
    color: "#E2E8F0",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  activePillContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.96)",
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 28,
    borderWidth: 1.5,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 8,
    minHeight: 56,
  },
  activePillListening: {
    borderColor: "#10B981",
    shadowColor: "#059669",
  },
  activePillSpeaking: {
    borderColor: "#38BDF8",
    shadowColor: "#0284C7",
  },
  activePillPaused: {
    borderColor: "#F59E0B",
    shadowColor: "#D97706",
  },
  activePillError: {
    borderColor: "#EF4444",
    shadowColor: "#DC2626",
  },
  statusToggleSection: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    minHeight: 56,
    minWidth: 56,
  },
  sectionPressed: {
    opacity: 0.75,
  },
  statusTextWrap: {
    justifyContent: "center",
  },
  activeStatusText: {
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  textSky: {
    color: "#38BDF8",
  },
  textAmber: {
    color: "#F59E0B",
  },
  pillDivider: {
    width: 1,
    height: 24,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    marginHorizontal: 4,
  },
  exitSection: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    minHeight: 56,
    minWidth: 56,
  },
  exitText: {
    color: "#F87171",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
});
