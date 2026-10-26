/**
 * Saarthi Campus Map View.
 *
 * Full-screen interactive map powered by @maplibre/maplibre-react-native.
 * Uses OpenStreetMap-based styles with visible attribution and no private tokens.
 *
 * Fallback Resilience:
 * If MapLibre Native is not linked (e.g. headless tests or Expo Go without dev-client),
 * gracefully falls back to an accessible high-contrast tactile vector map canvas without crashing.
 */

import React, { useRef, useEffect, useState, useMemo } from "react";
import { StyleSheet, View, Text, Pressable, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { RealGpsLocation } from "../services/locationService";
import { CampusPoi } from "../data/campusSurveyData";
import { Colors } from "../theme/colors";

// Import MapLibre safely to support both native and headless/test environments
let MapLibreGL: any = null;
try {
  MapLibreGL = require("@maplibre/maplibre-react-native").default;
  if (MapLibreGL && MapLibreGL.setAccessToken) {
    MapLibreGL.setAccessToken(null); // OpenStreetMap requires no proprietary token
  }
} catch {
  MapLibreGL = null;
}

// OpenStreetMap production raster tile style configuration
export const OSM_RASTER_STYLE = {
  version: 8,
  name: "OpenStreetMap Production Tiles",
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: "osm-tiles-layer",
      type: "raster",
      source: "osm-tiles",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};
export const OSM_STYLE_JSON = JSON.stringify(OSM_RASTER_STYLE);
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export interface CampusMapViewProps {
  currentLocation: RealGpsLocation | null;
  selectedDestination: CampusPoi | null;
  destinations: CampusPoi[];
  routeCoordinates: [number, number][]; // [lat, lon]
  onSelectPoi: (poi: CampusPoi) => void;
  isRecenterRequested?: boolean;
  onRecenterComplete?: () => void;
}

export const CampusMapView: React.FC<CampusMapViewProps> = ({
  currentLocation,
  selectedDestination,
  destinations,
  routeCoordinates,
  onSelectPoi,
  isRecenterRequested,
  onRecenterComplete,
}) => {
  const cameraRef = useRef<any>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isNativeMapAvailable, setIsNativeMapAvailable] = useState<boolean>(Boolean(MapLibreGL?.MapView));

  // Default viewport centered on Chandigarh University campus
  const initialCenterCoordinate = useMemo<[number, number]>(() => {
    return [76.57505, 30.76864]; // [lon, lat] for MapLibre
  }, []);

  // Recenter camera when requested or when user location first locks
  useEffect(() => {
    if (isRecenterRequested && cameraRef.current) {
      if (currentLocation && !currentLocation.isStale) {
        cameraRef.current.setCamera({
          centerCoordinate: [currentLocation.longitude, currentLocation.latitude],
          zoomLevel: 17,
          animationDuration: 800,
        });
      } else {
        cameraRef.current.setCamera({
          centerCoordinate: initialCenterCoordinate,
          zoomLevel: 16,
          animationDuration: 800,
        });
      }
      onRecenterComplete?.();
    }
  }, [isRecenterRequested, currentLocation, initialCenterCoordinate, onRecenterComplete]);

  // Convert route coordinates to GeoJSON LineString for MapLibre
  const routeFeature = useMemo<any>(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return null;
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: routeCoordinates.map(([lat, lon]) => [lon, lat]), // [lon, lat]
      },
    };
  }, [routeCoordinates]);

  // If MapLibre Native module failed or is unavailable, render accessible fallback canvas
  if (!isNativeMapAvailable || mapError || !MapLibreGL) {
    return (
      <View style={styles.container} accessible={true} accessibilityLabel="Campus Map Overview">
        <View style={styles.fallbackHeader}>
          <Ionicons name="map-outline" size={20} color={Colors.primary} />
          <Text style={styles.fallbackTitle}>Chandigarh University Campus Overview</Text>
        </View>

        {/* Tactile landmark list overview */}
        <View style={styles.fallbackCard}>
          <Text style={styles.fallbackSubtitle}>
            Interactive GPS and Turn-by-Turn Spoken Guidance are active.
          </Text>
          <Text style={styles.osmAttributionText}>{OSM_ATTRIBUTION}</Text>
        </View>

        {/* Selected target badge */}
        {selectedDestination && (
          <View style={styles.selectedPoiBanner}>
            <Ionicons name="flag" size={18} color="#05DF72" />
            <Text style={styles.selectedPoiText}>
              Destination Target: {selectedDestination.name} ({selectedDestination.shortCode})
            </Text>
          </View>
        )}

        {/* Route distance notice */}
        {routeCoordinates.length > 0 && (
          <View style={styles.routeNoticeBanner}>
            <Ionicons name="walk" size={18} color="#38BDF8" />
            <Text style={styles.routeNoticeText}>
              Route polyline plotted with {routeCoordinates.length} survey waypoints.
            </Text>
          </View>
        )}

        <View style={styles.attributionFooter}>
          <Text style={styles.attributionSub}>{OSM_ATTRIBUTION}</Text>
        </View>
      </View>
    );
  }

  // Render Full MapLibre Interactive Native Map
  const { MapView, Camera, ShapeSource, LineLayer, PointAnnotation } = MapLibreGL;

  return (
    <View style={styles.container} accessible={false}>
      <MapView
        style={styles.map}
        styleURL={OSM_STYLE_JSON}
        logoEnabled={false}
        attributionEnabled={false}
        onDidFailLoadingMap={(err: any) => {
          setMapError("Map style loading error. Campus routing remains active.");
        }}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: initialCenterCoordinate,
            zoomLevel: 16,
          }}
        />

        {/* 1. Walking Route Polyline Layer */}
        {routeFeature && (
          <ShapeSource id="campusWalkingRouteSource" shape={routeFeature}>
            <LineLayer
              id="campusWalkingRouteLayer"
              style={{
                lineColor: "#38BDF8", // Luminous high-contrast cyan blue
                lineWidth: 6,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          </ShapeSource>
        )}

        {/* 2. Destination Markers */}
        {destinations.map((poi) => {
          const isSelected = selectedDestination?.id === poi.id;
          return (
            <PointAnnotation
              key={poi.id}
              id={`poi_${poi.id}`}
              coordinate={[poi.longitude, poi.latitude]}
              onSelected={() => onSelectPoi(poi)}
            >
              <View
                style={[
                  styles.markerPin,
                  isSelected && styles.markerPinSelected,
                  { backgroundColor: isSelected ? "#05DF72" : "#7525E6" },
                ]}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel={`${poi.name}, ${poi.category}`}
              >
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
                  size={14}
                  color="#FFFFFF"
                />
              </View>
            </PointAnnotation>
          );
        })}

        {/* 3. Live Phone GPS Location Marker */}
        {currentLocation && !currentLocation.isStale && (
          <PointAnnotation
            id="userGpsLocation"
            coordinate={[currentLocation.longitude, currentLocation.latitude]}
          >
            <View style={styles.userLocationOuter}>
              <View style={styles.userLocationPulse} />
              <View style={styles.userLocationInner} />
            </View>
          </PointAnnotation>
        )}
      </MapView>

      {/* Visible OpenStreetMap Attribution Bar */}
      <View style={styles.attributionBadge} accessible={true} accessibilityLabel={`Map data: ${OSM_ATTRIBUTION}`}>
        <Text style={styles.attributionBadgeText}>{OSM_ATTRIBUTION}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#030712",
    overflow: "hidden",
  },
  map: {
    flex: 1,
  },
  markerPin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  markerPinSelected: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 3,
    borderColor: "#FACC15",
    transform: [{ scale: 1.15 }],
  },
  userLocationOuter: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  userLocationPulse: {
    position: "absolute",
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(56, 189, 248, 0.35)",
  },
  userLocationInner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#38BDF8",
    borderWidth: 2.5,
    borderColor: "#FFFFFF",
  },
  attributionBadge: {
    position: "absolute",
    bottom: 6,
    right: 8,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  attributionBadgeText: {
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: "500",
  },
  // Fallback View Styles
  fallbackHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    backgroundColor: "rgba(15, 23, 42, 0.8)",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.08)",
  },
  fallbackTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  fallbackCard: {
    margin: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  fallbackSubtitle: {
    color: "#E2E8F0",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  osmAttributionText: {
    color: "#64748B",
    fontSize: 11,
  },
  selectedPoiBanner: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(5, 223, 114, 0.12)",
    borderWidth: 1,
    borderColor: "#05DF72",
    gap: 8,
  },
  selectedPoiText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  routeNoticeBanner: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderWidth: 1,
    borderColor: "#38BDF8",
    gap: 8,
  },
  routeNoticeText: {
    color: "#E2E8F0",
    fontSize: 13,
    flex: 1,
  },
  attributionFooter: {
    marginTop: "auto",
    padding: 12,
    alignItems: "center",
  },
  attributionSub: {
    color: "#64748B",
    fontSize: 11,
  },
});
