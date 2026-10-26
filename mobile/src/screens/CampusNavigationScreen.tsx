/**
 * Saarthi Campus Map & GPS Navigation Screen.
 *
 * Implements a real map-and-navigation workflow with live GPS, Valhalla walking routes,
 * MapLibre interactive canvas, and spoken turn-by-turn guidance.
 *
 * Design & Accessibility (Part G & Standing Rules):
 * - Full interactive map occupying primary visual area.
 * - Spoken turn-by-turn guidance and large accessible controls (>= 56dp touch target).
 * - Real GPS accuracy diagnostics and staleness warnings.
 * - Single clear "Start Navigation" button.
 * - Only Repeat, Stop Speaking, and End Navigation controls during active guidance.
 * - Honest Indoor separation (Part F): Discloses QR/landmark indoor confirmation vs outdoor GPS.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  ActivityIndicator,
  AccessibilityInfo,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import {
  locationService,
  RealGpsLocation,
  LocationDiagnostics,
  GpsAccuracyLevel,
} from "../services/locationService";
import {
  outdoorRoutingService,
  OutdoorRoute,
  RouteCoordinates,
} from "../services/outdoorRoutingService";
import {
  navigationProgressService,
  NavigationProgressState,
} from "../services/navigationProgressService";
import {
  CHANDIGARH_UNIVERSITY_POIS,
  CampusPoi,
  searchCampusPois,
} from "../data/campusSurveyData";
import { CampusMapView } from "../components/CampusMapView";
import { NavigationRoute } from "../navigation/campusRouter";

export interface CampusNavigationScreenProps {
  initialStartNodeId?: string;
  initialDestinationQuery?: string;
  onNavigateBack: () => void;
  onActiveRouteChanged?: (route: NavigationRoute | null) => void;
  onOpenLiveAssist?: () => void;
}

export const CampusNavigationScreen: React.FC<CampusNavigationScreenProps> = ({
  initialDestinationQuery,
  onNavigateBack,
  onActiveRouteChanged,
  onOpenLiveAssist,
}) => {
  const insets = useSafeAreaInsets();

  // Location & GPS State
  const [currentLocation, setCurrentLocation] = useState<RealGpsLocation | null>(null);
  const [gpsDiagnostics, setGpsDiagnostics] = useState<LocationDiagnostics | null>(null);
  const [isLocationDenied, setIsLocationDenied] = useState<boolean>(false);
  const [isGpsDisabled, setIsGpsDisabled] = useState<boolean>(false);
  const [locationErrorMessage, setLocationErrorMessage] = useState<string | null>(null);

  // Search & Destination State
  const [searchQuery, setSearchQuery] = useState<string>(initialDestinationQuery || "");
  const [selectedPoi, setSelectedPoi] = useState<CampusPoi | null>(null);
  const [avoidStairs, setAvoidStairs] = useState<boolean>(false);

  // Navigation & Route State
  const [isCalculatingRoute, setIsCalculatingRoute] = useState<boolean>(false);
  const [activeOutdoorRoute, setActiveOutdoorRoute] = useState<OutdoorRoute | null>(null);
  const [navProgress, setNavProgress] = useState<NavigationProgressState>(
    navigationProgressService.getState()
  );
  const [routeError, setRouteError] = useState<string | null>(null);

  // Map Controls State
  const [isRecenterRequested, setIsRecenterRequested] = useState<boolean>(false);
  const [navigationMode, setNavigationMode] = useState<"outdoor_gps" | "indoor_landmark">("outdoor_gps");

  // Filtered POIs
  const filteredPois = useMemo(() => {
    return searchCampusPois(searchQuery);
  }, [searchQuery]);

  // Initial destination preset if provided via query
  useEffect(() => {
    if (initialDestinationQuery && !selectedPoi) {
      const matches = searchCampusPois(initialDestinationQuery);
      if (matches.length > 0) {
        setSelectedPoi(matches[0]);
      }
    }
  }, [initialDestinationQuery]);

  // Subscribe to navigation progress updates
  useEffect(() => {
    const unsubscribe = navigationProgressService.subscribe((state) => {
      setNavProgress(state);
    });
    return () => unsubscribe();
  }, []);

  // Initialize and watch device location
  useEffect(() => {
    let isMounted = true;

    const handleLocationUpdate = (loc: RealGpsLocation) => {
      if (!isMounted) return;
      setCurrentLocation(loc);
      navigationProgressService.processGpsUpdate(loc);
    };

    const handleDiagnostics = (diag: LocationDiagnostics) => {
      if (!isMounted) return;
      setGpsDiagnostics(diag);
      setIsLocationDenied(!diag.permissionGranted);
      setIsGpsDisabled(!diag.servicesEnabled);
    };

    (async () => {
      const perm = await locationService.startWatchingLocation(
        handleLocationUpdate,
        handleDiagnostics
      );

      if (!isMounted) return;

      if (!perm.granted) {
        setIsLocationDenied(true);
        setLocationErrorMessage(perm.errorMessage || "Location permission denied.");
      } else if (!perm.servicesEnabled) {
        setIsGpsDisabled(true);
        setLocationErrorMessage("Device GPS is turned off. Please turn on Location in Settings.");
      }
    })();

    return () => {
      isMounted = false;
      locationService.stopWatchingLocation(handleLocationUpdate);
    };
  }, []);

  // Handle route recalculation when user deviates
  const handleRecalculateRoute = useCallback(
    async (devGps: RealGpsLocation) => {
      if (!selectedPoi) return;

      const startCoord: RouteCoordinates = {
        latitude: devGps.latitude,
        longitude: devGps.longitude,
      };
      const destCoord: RouteCoordinates = {
        latitude: selectedPoi.latitude,
        longitude: selectedPoi.longitude,
      };

      try {
        const newRoute = await outdoorRoutingService.calculateRoute(startCoord, destCoord, {
          avoidStairs,
          destinationName: selectedPoi.name,
        });

        if (newRoute.status === "success") {
          setActiveOutdoorRoute(newRoute);
          navigationProgressService.startNavigation(newRoute, handleRecalculateRoute);
          await speechService.speak(
            `New route calculated. Distance: ${newRoute.totalDistanceMeters} meters. ${newRoute.maneuvers[0]?.instruction || ""}`,
            { force: true }
          );
        }
      } catch {
        // Safe isolate
      }
    },
    [selectedPoi, avoidStairs]
  );

  // START NAVIGATION ACTION
  const handleStartNavigation = async () => {
    if (!selectedPoi) {
      setRouteError("Please select a verified destination from the campus list below.");
      await speechService.speak("Please select a destination first.", { force: true });
      return;
    }

    if (!currentLocation || currentLocation.isStale) {
      setRouteError("Waiting for real GPS location fix. Please ensure you are outdoors with clear sky view.");
      await speechService.speak(
        "Acquiring GPS location fix. Please wait for satellite signal before starting navigation.",
        { force: true }
      );
      return;
    }

    await hapticsService.triggerButtonPress();
    setIsCalculatingRoute(true);
    setRouteError(null);

    const startCoord: RouteCoordinates = {
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
    };
    const destCoord: RouteCoordinates = {
      latitude: selectedPoi.latitude,
      longitude: selectedPoi.longitude,
    };

    try {
      const route = await outdoorRoutingService.calculateRoute(startCoord, destCoord, {
        avoidStairs,
        destinationName: selectedPoi.name,
      });

      setIsCalculatingRoute(false);

      if (route.status === "success") {
        setActiveOutdoorRoute(route);
        navigationProgressService.startNavigation(route, handleRecalculateRoute);
        await hapticsService.triggerSuccess();
        await speechService.speak(route.spokenSummary, { force: true });
      } else {
        setActiveOutdoorRoute(null);
        setRouteError(route.spokenSummary);
        await speechService.speak(route.spokenSummary, { force: true });
      }
    } catch (err: any) {
      setIsCalculatingRoute(false);
      const errMsg = "Failed to calculate walking route. Please check your data connection.";
      setRouteError(errMsg);
      await speechService.speak(errMsg, { force: true });
    }
  };

  // REPEAT INSTRUCTION
  const handleRepeatInstruction = async () => {
    await hapticsService.triggerBottomLeft();
    await navigationProgressService.repeatCurrentInstruction();
  };

  // STOP SPEAKING
  const handleStopSpeaking = async () => {
    await hapticsService.triggerBottomLeft();
    await navigationProgressService.stopSpeaking();
  };

  // END NAVIGATION
  const handleEndNavigation = async () => {
    await hapticsService.triggerBottomLeft();
    navigationProgressService.stopNavigation();
    setActiveOutdoorRoute(null);
    onActiveRouteChanged?.(null);
    await speechService.speak("Campus navigation stopped.", { force: true });
  };

  // RECENTER MAP
  const handleRecenter = async () => {
    await hapticsService.triggerButtonPress();
    setIsRecenterRequested(true);
    const msg = currentLocation
      ? `Centering map on current location. Accuracy: plus or minus ${Math.round(currentLocation.accuracyMeters)} meters.`
      : "Centering map on campus center.";
    await speechService.speak(msg, { force: true });
  };

  const accuracyBadgeColor = useMemo(() => {
    if (!currentLocation || currentLocation.isStale) return Colors.textMuted;
    switch (currentLocation.accuracyLevel) {
      case "excellent":
      case "good":
        return "#05DF72";
      case "moderate":
        return "#FACC15";
      case "poor":
      case "unusable":
        return "#FB923C";
      default:
        return Colors.error;
    }
  }, [currentLocation]);

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 8) }]}>
      {/* 1. TOP HEADER BAR */}
      <View style={styles.topHeader}>
        <Pressable
          onPress={onNavigateBack}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Back to Home Screen"
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          <Text style={styles.backButtonText}>Home</Text>
        </Pressable>

        <Text style={styles.headerTitle} accessibilityRole="header">
          Campus Map & GPS
        </Text>

        <View style={styles.headerRightActions}>
          {onOpenLiveAssist && (
            <Pressable
              onPress={onOpenLiveAssist}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Look Ahead with Live Camera Assist"
              accessibilityHint="Opens camera assist to describe doors, signs, and landmarks in front of you"
              style={styles.headerAssistButton}
            >
              <Ionicons name="camera" size={20} color="#38BDF8" />
            </Pressable>
          )}

          <Pressable
            onPress={handleRecenter}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Recenter map camera on your current GPS location"
            accessibilityHint="Re-aligns map to your position"
            style={styles.recenterButton}
          >
            <Ionicons name="locate" size={22} color="#38BDF8" />
          </Pressable>
        </View>
      </View>

      {/* 2. LIVE GPS DIAGNOSTICS BAR */}
      <View style={styles.gpsStatusBar} accessible={true} accessibilityRole="summary">
        <View style={styles.gpsStatusIndicator}>
          <View style={[styles.gpsDot, { backgroundColor: accuracyBadgeColor }]} />
          <Text style={styles.gpsStatusText}>
            {currentLocation && !currentLocation.isStale
              ? `GPS: ${currentLocation.accuracyLevel.toUpperCase()} (±${Math.round(currentLocation.accuracyMeters)}m)`
              : "GPS: Acquiring fix..."}
          </Text>
        </View>

        {/* Mode Toggle between Outdoor GPS & Indoor Confirmation */}
        <Pressable
          onPress={() => {
            const newMode = navigationMode === "outdoor_gps" ? "indoor_landmark" : "outdoor_gps";
            setNavigationMode(newMode);
            speechService.speak(
              newMode === "indoor_landmark"
                ? "Switched to Indoor Landmark Mode. Indoor positioning relies on door-sign OCR and verified room plaques."
                : "Switched to Outdoor GPS Navigation.",
              { force: true }
            );
          }}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={`Current mode is ${navigationMode === "outdoor_gps" ? "Outdoor GPS" : "Indoor Landmark"}. Double-tap to switch.`}
          style={styles.modeTogglePill}
        >
          <Ionicons
            name={navigationMode === "outdoor_gps" ? "navigate-circle" : "business-outline"}
            size={14}
            color="#C084FC"
          />
          <Text style={styles.modeToggleText}>
            {navigationMode === "outdoor_gps" ? "Outdoor GPS" : "Indoor Landmark"}
          </Text>
        </Pressable>
      </View>

      {/* 3. INDOOR MODE HONEST DISCLOSURE BANNER */}
      {navigationMode === "indoor_landmark" && (
        <View style={styles.indoorNoticeBanner} accessible={true} accessibilityRole="alert">
          <Ionicons name="information-circle-outline" size={18} color="#C084FC" />
          <Text style={styles.indoorNoticeText}>
            Indoor Mode Active: Satellite GPS cannot penetrate indoor structures. Use "Read Anything" on door plaques for verified indoor positioning.
          </Text>
        </View>
      )}

      {/* 4. PERMISSION / GPS DISABLED WARNING */}
      {(isLocationDenied || isGpsDisabled) && (
        <View style={styles.warningBanner} accessible={true} accessibilityRole="alert">
          <Ionicons name="warning-outline" size={20} color={Colors.warning} />
          <Text style={styles.warningBannerText}>
            {locationErrorMessage || "GPS Location is required for real outdoor turn-by-turn guidance."}
          </Text>
        </View>
      )}

      {/* 5. PRIMARY CONTENT AREA: INTERACTIVE FULL MAP */}
      <View style={styles.mapContainer}>
        <CampusMapView
          currentLocation={currentLocation}
          selectedDestination={selectedPoi}
          destinations={CHANDIGARH_UNIVERSITY_POIS}
          routeCoordinates={activeOutdoorRoute?.coordinates || []}
          onSelectPoi={(poi) => {
            setSelectedPoi(poi);
            setRouteError(null);
            speechService.speak(`Selected destination: ${poi.name}.`, { force: true });
          }}
          isRecenterRequested={isRecenterRequested}
          onRecenterComplete={() => setIsRecenterRequested(false)}
        />
      </View>

      {/* 6. GUIDANCE & ACTION AREA */}
      <View style={styles.bottomSheetArea}>
        {/* ACTIVE NAVIGATION INSTRUCTION CARD */}
        {activeOutdoorRoute && navProgress.isActive && (
          <View style={styles.activeNavCard} accessible={true}>
            <View style={styles.navHeaderRow}>
              <View style={styles.navActivePill}>
                <Text style={styles.navActivePillText}>NAVIGATING</Text>
              </View>
              <Text style={styles.navRemainingDistText}>
                ~{navProgress.remainingTotalDistanceMeters}m remaining
              </Text>
            </View>

            <Text style={styles.navNextInstructionText}>
              {navProgress.currentManeuver?.instruction || "Proceed along route."}
            </Text>

            {/* Accuracy Uncertainty Notice if needed */}
            {navProgress.isAccuracyUncertain && (
              <View style={styles.navCautionRow}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
                <Text style={styles.navCautionText}>
                  GPS uncertainty ±{Math.round(navProgress.gpsAccuracyMeters)}m. Confirm visual landmarks.
                </Text>
              </View>
            )}

            {/* Three Essential Navigation Controls: Repeat, Stop Speaking, End */}
            <View style={styles.navControlsRow}>
              <Pressable
                onPress={handleRepeatInstruction}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Repeat current spoken instruction"
                style={styles.navActionButtonSecondary}
              >
                <Ionicons name="volume-high" size={20} color="#FFFFFF" />
                <Text style={styles.navActionButtonText}>Repeat</Text>
              </Pressable>

              {onOpenLiveAssist && (
                <Pressable
                  onPress={onOpenLiveAssist}
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel="Look Ahead with Live Camera Assist"
                  accessibilityHint="Inspect doors, signs, and path with Gemma 4 vision"
                  style={styles.navActionButtonSecondary}
                >
                  <Ionicons name="camera" size={20} color="#38BDF8" />
                  <Text style={styles.navActionButtonText}>Look</Text>
                </Pressable>
              )}

              <Pressable
                onPress={handleStopSpeaking}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Stop current speech"
                style={styles.navActionButtonSecondary}
              >
                <Ionicons name="volume-mute" size={20} color="#FFFFFF" />
                <Text style={styles.navActionButtonText}>Silence</Text>
              </Pressable>

              <Pressable
                onPress={handleEndNavigation}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="End navigation session"
                style={styles.navActionButtonEnd}
              >
                <Ionicons name="close-circle" size={20} color="#FFFFFF" />
                <Text style={styles.navActionButtonText}>End</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ARRIVED STATE CARD */}
        {activeOutdoorRoute && navProgress.isArrived && (
          <View style={styles.arrivedCard} accessible={true}>
            <Ionicons name="checkmark-circle" size={42} color={Colors.success} />
            <Text style={styles.arrivedTitle}>Destination Reached</Text>
            <Text style={styles.arrivedSubtitle}>
              You have arrived at {selectedPoi?.name}.
            </Text>
            <Pressable
              onPress={handleEndNavigation}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Finish navigation session"
              style={styles.finishNavButton}
            >
              <Text style={styles.finishNavButtonText}>Finish Navigation</Text>
            </Pressable>
          </View>
        )}

        {/* ROUTE SETUP SECTION (When not navigating) */}
        {(!activeOutdoorRoute || (!navProgress.isActive && !navProgress.isArrived)) && (
          <ScrollView
            style={styles.setupScrollView}
            contentContainerStyle={styles.setupScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Accessible Destination Search Input */}
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={20} color="#94A3B8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search campus building, block, hostel..."
                placeholderTextColor="#64748B"
                value={searchQuery}
                onChangeText={setSearchQuery}
                accessible={true}
                accessibilityLabel="Destination landmark search"
                accessibilityHint="Type or use speech to search university points of interest"
              />
              {searchQuery ? (
                <Pressable
                  onPress={() => setSearchQuery("")}
                  accessible={true}
                  accessibilityLabel="Clear search text"
                  style={styles.clearSearchButton}
                >
                  <Ionicons name="close-circle" size={18} color="#94A3B8" />
                </Pressable>
              ) : null}
            </View>

            {/* Selected Destination Tag */}
            {selectedPoi && (
              <View style={styles.selectedPoiCard}>
                <Ionicons name="location" size={22} color="#05DF72" />
                <View style={styles.selectedPoiInfo}>
                  <Text style={styles.selectedPoiTitle}>{selectedPoi.name}</Text>
                  <Text style={styles.selectedPoiDesc}>
                    {selectedPoi.category.toUpperCase()} • {selectedPoi.tactileCues || "Surveyed POI"}
                  </Text>
                </View>
              </View>
            )}

            {/* Avoid Stairs Toggle Switch */}
            <View style={styles.stairsToggleRow}>
              <View style={styles.stairsTextWrap}>
                <Text style={styles.stairsTitle}>Avoid Stairs (Accessible Routing)</Text>
                <Text style={styles.stairsSubtitle}>Requires step-free paved ramps and pathways</Text>
              </View>
              <Switch
                value={avoidStairs}
                onValueChange={setAvoidStairs}
                trackColor={{ false: "#334155", true: "#005CE6" }}
                thumbColor="#FFFFFF"
                accessible={true}
                accessibilityLabel="Avoid stairs toggle switch"
              />
            </View>

            {/* Route Calculation Error */}
            {routeError && (
              <View style={styles.errorCard} accessible={true} accessibilityRole="alert">
                <Ionicons name="alert-circle" size={20} color={Colors.error} />
                <Text style={styles.errorCardText}>{routeError}</Text>
              </View>
            )}

            {/* One Clear Start Navigation Button */}
            <Pressable
              onPress={handleStartNavigation}
              disabled={isCalculatingRoute}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={
                selectedPoi
                  ? `Start navigation to ${selectedPoi.name}`
                  : "Start navigation. Please select a destination first."
              }
              style={[styles.startNavButton, !selectedPoi && styles.startNavButtonDisabled]}
            >
              {isCalculatingRoute ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Ionicons name="navigate" size={22} color="#FFFFFF" />
                  <Text style={styles.startNavButtonText}>
                    {selectedPoi ? `Start Navigation to ${selectedPoi.shortCode}` : "Select a Destination"}
                  </Text>
                </>
              )}
            </Pressable>

            {/* Filtered Campus Landmarks List */}
            <Text style={styles.poiSectionTitle}>
              Verified Campus POIs ({filteredPois.length})
            </Text>

            {filteredPois.slice(0, 10).map((poi) => {
              const isSelected = selectedPoi?.id === poi.id;
              return (
                <Pressable
                  key={poi.id}
                  onPress={() => {
                    setSelectedPoi(poi);
                    setRouteError(null);
                    speechService.speak(`Selected destination: ${poi.name}.`, { force: true });
                  }}
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${poi.name}, ${poi.category}`}
                  style={[styles.poiItemCard, isSelected && styles.poiItemCardSelected]}
                >
                  <View style={styles.poiIconWrap}>
                    <Ionicons
                      name={
                        poi.category === "entrance"
                          ? "log-in"
                          : poi.category === "hostel"
                          ? "home"
                          : poi.category === "dining"
                          ? "restaurant"
                          : "business"
                      }
                      size={20}
                      color={isSelected ? "#05DF72" : "#94A3B8"}
                    />
                  </View>
                  <View style={styles.poiItemTextWrap}>
                    <Text style={[styles.poiItemTitle, isSelected && styles.poiItemTitleSelected]}>
                      {poi.name}
                    </Text>
                    <Text style={styles.poiItemSubtitle}>
                      {poi.category} • {poi.description}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#030712",
  },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 56,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 56,
    minHeight: 56,
    gap: 6,
  },
  backButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  headerRightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerAssistButton: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    borderWidth: 1,
    borderColor: "#38BDF8",
  },
  recenterButton: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  gpsStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: "rgba(15, 23, 42, 0.8)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
  },
  gpsStatusIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  gpsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gpsStatusText: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "700",
  },
  modeTogglePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: "rgba(117, 37, 230, 0.2)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(192, 132, 252, 0.3)",
    gap: 5,
  },
  modeToggleText: {
    color: "#C084FC",
    fontSize: 11,
    fontWeight: "700",
  },
  indoorNoticeBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(117, 37, 230, 0.15)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  indoorNoticeText: {
    color: "#E2E8F0",
    fontSize: 12,
    flex: 1,
    lineHeight: 16,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  warningBannerText: {
    color: "#FCA5A5",
    fontSize: 12,
    flex: 1,
    fontWeight: "600",
  },
  mapContainer: {
    flex: 1,
    minHeight: 220,
  },
  bottomSheetArea: {
    flex: 1,
    backgroundColor: "#0B1120",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
  },
  // Active Navigation Card Styles
  activeNavCard: {
    padding: 16,
    gap: 10,
  },
  navHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  navActivePill: {
    backgroundColor: "rgba(5, 223, 114, 0.2)",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#05DF72",
  },
  navActivePillText: {
    color: "#05DF72",
    fontSize: 12,
    fontWeight: "800",
  },
  navRemainingDistText: {
    color: "#38BDF8",
    fontSize: 14,
    fontWeight: "800",
  },
  navNextInstructionText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
    marginVertical: 4,
  },
  navCautionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    padding: 8,
    borderRadius: 8,
  },
  navCautionText: {
    color: "#FCD34D",
    fontSize: 12,
    flex: 1,
  },
  navControlsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  navActionButtonSecondary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 56,
    borderRadius: 14,
    backgroundColor: "rgba(30, 41, 59, 0.9)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    gap: 8,
  },
  navActionButtonEnd: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 56,
    borderRadius: 14,
    backgroundColor: "#DC2626",
    gap: 8,
  },
  navActionButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  // Arrived Card Styles
  arrivedCard: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  arrivedTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "800",
  },
  arrivedSubtitle: {
    color: "#94A3B8",
    fontSize: 15,
    textAlign: "center",
  },
  finishNavButton: {
    width: "100%",
    height: 56,
    backgroundColor: "#005CE6",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  finishNavButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  // Route Setup Styles
  setupScrollView: {
    flex: 1,
  },
  setupScrollContent: {
    padding: 16,
    gap: 12,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    borderRadius: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    gap: 10,
  },
  searchInput: {
    flex: 1,
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  clearSearchButton: {
    padding: 6,
  },
  selectedPoiCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(5, 223, 114, 0.12)",
    borderWidth: 1,
    borderColor: "#05DF72",
    gap: 12,
  },
  selectedPoiInfo: {
    flex: 1,
  },
  selectedPoiTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  selectedPoiDesc: {
    color: "#A7F3D0",
    fontSize: 12,
    marginTop: 2,
  },
  stairsToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  stairsTextWrap: {
    flex: 1,
    marginRight: 12,
  },
  stairsTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  stairsSubtitle: {
    color: "#94A3B8",
    fontSize: 12,
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    padding: 12,
    borderRadius: 10,
    gap: 8,
  },
  errorCardText: {
    color: "#FCA5A5",
    fontSize: 13,
    flex: 1,
  },
  startNavButton: {
    flexDirection: "row",
    height: 56,
    backgroundColor: "#005CE6",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    elevation: 4,
  },
  startNavButtonDisabled: {
    backgroundColor: "#1E293B",
  },
  startNavButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  poiSectionTitle: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 8,
  },
  poiItemCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 12,
    minHeight: 56,
  },
  poiItemCardSelected: {
    borderColor: "#05DF72",
    backgroundColor: "rgba(5, 223, 114, 0.08)",
  },
  poiIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  poiItemTextWrap: {
    flex: 1,
  },
  poiItemTitle: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  poiItemTitleSelected: {
    color: "#05DF72",
  },
  poiItemSubtitle: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 2,
  },
});
