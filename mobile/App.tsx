import React, { useState, useEffect, useCallback, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { Colors } from "./src/theme/colors";
import { speechService } from "./src/services/speech";
import { NavigationRoute, CampusGraph } from "./src/navigation/campusRouter";
import { CampusLocalizer, LocalizationResult } from "./src/navigation/localization";
import { ReadingPipelineResult } from "./src/services/readingPipeline";
import sampleCampusData from "./src/data/sample_campus_graph.json";

// Shared deterministic localizer initialized with verified campus graph
const campusLocalizer = new CampusLocalizer(sampleCampusData as unknown as CampusGraph);

// Modular Screens
import { useCameraPermissions } from "expo-camera";
import { HomeScreen } from "./src/screens/HomeScreen";
import { CampusReaderScreen, ReadingMode } from "./src/screens/CampusReaderScreen";
import { ReadingResultsScreen } from "./src/screens/ReadingResultsScreen";
import { TimetableScreen } from "./src/screens/TimetableScreen";
import { CampusNavigationScreen } from "./src/screens/CampusNavigationScreen";
import { VoiceAssistantScreen } from "./src/screens/VoiceAssistantScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { CameraAssistScreen } from "./src/screens/CameraAssistScreen";
import { globalVoiceService } from "./src/services/globalVoiceService";
import { GlobalVoiceControl } from "./src/components/GlobalVoiceControl";

export type AppScreen =
  | "home"
  | "reader"
  | "results"
  | "timetable"
  | "navigation"
  | "voice"
  | "settings"
  | "assist";

const ONBOARDING_KEY = "@saarthi_onboarding_played";

export function SaarthiApp() {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>("home");
  const [screenHistory, setScreenHistory] = useState<AppScreen[]>([]);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [readerMode, setReaderMode] = useState<ReadingMode>("auto");
  const [currentReadingResult, setCurrentReadingResult] = useState<ReadingPipelineResult | null>(null);
  const [currentImageUri, setCurrentImageUri] = useState<string | undefined>(undefined);
  const [activeRoute, setActiveRoute] = useState<NavigationRoute | null>(null);
  const [currentStartNodeId, setCurrentStartNodeId] = useState<string>("entrance_main");
  const [navDestinationQuery, setNavDestinationQuery] = useState<string>("");

  const [isVoiceModeActive, setIsVoiceModeActive] = useState<boolean>(
    globalVoiceService.getState().isActive
  );
  const [showOnboarding, setShowOnboarding] = useState<boolean>(false);

  useEffect(() => {
    return globalVoiceService.subscribe((state) => {
      setIsVoiceModeActive(state.isActive);
    });
  }, []);

  // Show dismissible onboarding banner on first launch without speaking automatically
  useEffect(() => {
    (async () => {
      try {
        const played = await AsyncStorage.getItem(ONBOARDING_KEY);
        if (!played) {
          setShowOnboarding(true);
        }
      } catch {
        // Safe ignore
      }
    })();
  }, []);

  const handleDismissOnboarding = useCallback(async () => {
    setShowOnboarding(false);
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      // Safe ignore
    }
  }, []);

  const handleNavigate = useCallback(
    (screen: AppScreen, params?: any) => {
      if (params?.mode) {
        setReaderMode(params.mode);
      }
      if (params?.destinationQuery) {
        setNavDestinationQuery(params.destinationQuery);
      }
      if (screen !== currentScreen) {
        setScreenHistory((prev) => {
          if (prev.length > 0 && prev[prev.length - 1] === currentScreen) {
            return prev;
          }
          return [...prev, currentScreen];
        });
        setCurrentScreen(screen);
      }
    },
    [currentScreen]
  );

  const handleGoBack = useCallback((): AppScreen | null => {
    if (screenHistory.length > 0) {
      const prevScreen = screenHistory[screenHistory.length - 1];
      setScreenHistory((prev) => prev.slice(0, -1));
      setCurrentScreen(prevScreen);
      return prevScreen;
    } else {
      if (currentScreen !== "home") {
        setCurrentScreen("home");
        return "home";
      }
      return null;
    }
  }, [screenHistory, currentScreen]);

  const handleReadingComplete = (
    result: ReadingPipelineResult,
    mode: ReadingMode,
    imageUri?: string
  ) => {
    setCurrentReadingResult(result);
    setReaderMode(mode);
    setCurrentImageUri(imageUri);
    setScreenHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === currentScreen) {
        return prev;
      }
      return [...prev, currentScreen];
    });
    setCurrentScreen("results");
  };

  const handleSetLocationFromSign = (locationName: string): LocalizationResult => {
    const result = campusLocalizer.localizeFromOcr(locationName);
    if (result.isLocalized && result.node) {
      setCurrentStartNodeId(result.node.id);
    }
    // Return result so caller can announce status or handle unmapped room safely
    return result;
  };

  const handleReplayOnboarding = async () => {
    setShowOnboarding(true);
    const welcome =
      "Welcome to SAARTHI! Tap the purple Voice Assistant tile at the bottom right to activate voice control. Then speak naturally to navigate the app.";
    await speechService.speak(welcome, { force: true });
  };

  const handleCancelRoute = () => {
    setActiveRoute(null);
  };

  const handleRepeatRouteStep = async () => {
    if (activeRoute) {
      const stepIndex = activeRoute.currentStepIndex || 0;
      const step = activeRoute.steps[stepIndex];
      if (step) {
        await speechService.speak(step.spokenInstruction, { force: true });
      }
    }
  };

  // Connect globalVoiceService with current navigation context
  const scanTriggerRef = useRef<(() => Promise<void>) | null>(null);
  const resultsVoiceActionsRef = useRef<{
    onReadFullText: () => Promise<void>;
    onSummarize: () => Promise<void>;
    onScanAgain: () => void;
  } | null>(null);

  useEffect(() => {
    globalVoiceService.setDispatchContextProvider(() => ({
      currentScreen,
      screenHistory,
      hasReadingResult: Boolean(currentReadingResult),
      currentReadingResult,
      onNavigateToScreen: (screen: AppScreen) => handleNavigate(screen),
      onNavigateBack: () => handleGoBack(),
      onNavigateToReader: (mode) => {
        setReaderMode(mode || "auto");
        handleNavigate("reader");
      },
      onNavigateToAssist: () => {
        handleNavigate("assist");
      },
      onNavigateToNavigation: (dest) => {
        setNavDestinationQuery(dest || "");
        handleNavigate("navigation");
      },
      onNavigateToTimetable: () => handleNavigate("timetable"),
      onTriggerScan: async () => {
        if (scanTriggerRef.current) {
          await scanTriggerRef.current();
        }
      },
      onReadFullText: async () => {
        if (resultsVoiceActionsRef.current) {
          await resultsVoiceActionsRef.current.onReadFullText();
        }
      },
      onSummarizeResult: async () => {
        if (resultsVoiceActionsRef.current) {
          await resultsVoiceActionsRef.current.onSummarize();
        }
      },
      onScanAgain: () => {
        if (resultsVoiceActionsRef.current) {
          resultsVoiceActionsRef.current.onScanAgain();
        } else {
          handleNavigate("reader");
        }
      },
      onStopListening: () => {
        globalVoiceService.pauseListening(false);
      },
      onResumeListening: () => {
        globalVoiceService.resumeListening(false);
      },
      onExitVoiceMode: () => {
        globalVoiceService.disableVoiceMode(false);
      },
    }));
  }, [
    currentScreen,
    screenHistory,
    currentReadingResult,
    handleNavigate,
    handleGoBack,
  ]);

  return (
    <View style={styles.appContainer}>
      <StatusBar style="dark" />

      {currentScreen === "home" && (
        <HomeScreen
          onNavigate={handleNavigate}
          activeRoute={activeRoute}
          onCancelRoute={handleCancelRoute}
          onRepeatRouteStep={handleRepeatRouteStep}
          isVoiceModeActive={isVoiceModeActive}
          onToggleVoiceMode={() => globalVoiceService.toggleVoiceMode()}
          showOnboarding={showOnboarding}
          onDismissOnboarding={handleDismissOnboarding}
        />
      )}

      {currentScreen === "reader" && (
        <CampusReaderScreen
          initialMode={readerMode}
          onNavigateBack={handleGoBack}
          onReadingComplete={handleReadingComplete}
          permissionResponse={cameraPermission}
          onRequestPermission={requestCameraPermission}
          onRegisterScanTrigger={(trigger) => {
            scanTriggerRef.current = trigger;
          }}
          onOpenLiveAssist={() => handleNavigate("assist")}
        />
      )}

      {currentScreen === "results" && currentReadingResult && (
        <ReadingResultsScreen
          result={currentReadingResult}
          mode={readerMode}
          imageUri={currentImageUri}
          onNavigateHome={() => handleNavigate("home")}
          onScanAnother={() => handleNavigate("reader")}
          onSetLocation={handleSetLocationFromSign}
          onViewTimetable={() => handleNavigate("timetable")}
          onRegisterResultsActions={(actions) => {
            resultsVoiceActionsRef.current = actions;
          }}
        />
      )}

      {currentScreen === "timetable" && (
        <TimetableScreen
          onNavigateBack={handleGoBack}
          onScanTimetable={() => {
            setReaderMode("timetable");
            handleNavigate("reader");
          }}
        />
      )}

      {currentScreen === "navigation" && (
        <CampusNavigationScreen
          initialStartNodeId={currentStartNodeId}
          initialDestinationQuery={navDestinationQuery}
          onNavigateBack={handleGoBack}
          onActiveRouteChanged={setActiveRoute}
          onOpenLiveAssist={() => handleNavigate("assist")}
        />
      )}

      {currentScreen === "assist" && (
        <CameraAssistScreen
          onNavigateBack={handleGoBack}
          permissionResponse={cameraPermission}
          onRequestPermission={requestCameraPermission}
        />
      )}

      {currentScreen === "voice" && (
        <VoiceAssistantScreen
          currentScreen={currentScreen}
          screenHistory={screenHistory}
          hasReadingResult={!!currentReadingResult}
          onNavigateToScreen={(screen) => handleNavigate(screen)}
          onNavigateBack={handleGoBack}
          onNavigateToReader={(mode) => {
            setReaderMode(mode || "auto");
            handleNavigate("reader");
          }}
          onNavigateToNavigation={(dest) => {
            setNavDestinationQuery(dest || "");
            handleNavigate("navigation");
          }}
          onNavigateToTimetable={() => handleNavigate("timetable")}
        />
      )}

      {currentScreen === "settings" && (
        <SettingsScreen
          onNavigateBack={handleGoBack}
          onReplayOnboarding={handleReplayOnboarding}
        />
      )}

      {/* Global Voice Mode Accessible Floating Capsule across all screens */}
      <GlobalVoiceControl currentScreen={currentScreen} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider style={styles.rootProvider}>
      <SaarthiApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  rootProvider: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  appContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
