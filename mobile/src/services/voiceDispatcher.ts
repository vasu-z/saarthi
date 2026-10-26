import {
  ParsedVoiceCommand,
  parseVoiceCommand,
  SCREEN_INTENT_MAP,
  NavigationIntentType,
} from "./voiceCommands";
import {
  describeWhereAmI,
  describeWhatCanIDo,
  getScreenRegistryEntry,
  SCREEN_REGISTRY,
} from "../navigation/screenRegistry";
import type { AppScreen } from "../../App";
import { speechService } from "./speech";
import { readingPipeline, ReadingPipelineResult } from "./readingPipeline";
import { askGeneralQuery } from "../api/client";
import { searchCampusPois } from "../data/campusSurveyData";

export interface VoiceCommandDispatchContext {
  currentScreen: AppScreen;
  screenHistory?: AppScreen[];
  hasReadingResult?: boolean;
  isCapturing?: boolean;
  currentReadingResult?: ReadingPipelineResult | null;
  onNavigateToScreen?: (screen: AppScreen) => void;
  onNavigateBack?: () => AppScreen | boolean | void | null;
  onNavigateToReader?: (mode?: "auto" | "timetable" | "sign" | "notice") => void;
  onNavigateToAssist?: () => void;
  onNavigateToNavigation?: (destinationQuery?: string) => void;
  onNavigateToTimetable?: () => void;
  onTriggerScan?: () => Promise<void> | void;
  onReadFullText?: () => Promise<void> | void;
  onSummarizeResult?: () => Promise<void> | void;
  onScanAgain?: () => void;
  onStopListening?: () => void;
  onResumeListening?: () => void;
  onExitVoiceMode?: () => void;
}

export interface DispatchVoiceCommandOptions {
  speak?: boolean;
}

/**
 * Dispatches a recognized or typed voice command using the actual active screen context.
 *
 * Implements Phase 1 Screen Awareness & Phase 2 Global Voice Navigation:
 * - "Open <Screen>" / "Go <Screen>": Dynamically navigates to the target screen and speaks confirmation.
 * - "Go Back" / "Back": Safely pops navigation history, preventing loops and duplicate entries.
 * - "Where am I?": Dynamically speaks the registered description and purpose of the current screen.
 * - "What can I do here?" / "Help": Dynamically speaks the genuinely available actions on the current screen.
 * - "Repeat that": Replays the last spoken message using the existing speech service buffer.
 * - "Stop": Immediately cuts off any active speech output.
 */
export async function dispatchVoiceCommand(
  input: string | ParsedVoiceCommand,
  context: VoiceCommandDispatchContext,
  options: DispatchVoiceCommandOptions = { speak: true }
): Promise<string> {
  const parsed = typeof input === "string" ? parseVoiceCommand(input) : input;
  const currentScreen = context.currentScreen || "home";

  const speakIfEnabled = async (text: string) => {
    if (options.speak !== false) {
      await speechService.speak(text, { force: true });
    }
  };

  switch (parsed.intent) {
    case "stop_listening": {
      context.onStopListening?.();
      const msg = "Listening paused. Tap the voice button to resume.";
      await speakIfEnabled(msg);
      return msg;
    }

    case "resume_listening": {
      context.onResumeListening?.();
      const msg = "Listening resumed.";
      await speakIfEnabled(msg);
      return msg;
    }

    case "exit_voice_mode": {
      context.onExitVoiceMode?.();
      const msg = "Voice mode is off.";
      await speakIfEnabled(msg);
      return msg;
    }

    case "stop": {
      await speechService.stop();
      return "Stopped speaking.";
    }

    case "repeat": {
      const ok = await speechService.repeatLast();
      if (!ok) {
        const msg = "Nothing to repeat yet.";
        await speakIfEnabled(msg);
        return msg;
      }
      return "Replaying last message.";
    }

    case "scan_now": {
      if (context.isCapturing) {
        const msg = "A scan is already in progress. Please wait.";
        await speakIfEnabled(msg);
        return msg;
      }

      if (currentScreen !== "reader") {
        const spokenMsg = "Opening camera in Auto Read mode. Say 'scan now' when ready.";
        await speakIfEnabled(spokenMsg);
        if (context.onNavigateToReader) {
          context.onNavigateToReader("auto");
        } else if (context.onNavigateToScreen) {
          context.onNavigateToScreen("reader");
        }
        return spokenMsg;
      }

      if (context.onTriggerScan) {
        await context.onTriggerScan();
        return "Scan initiated.";
      } else {
        const notReady = "Camera is not ready yet. Please wait a moment.";
        await speakIfEnabled(notReady);
        return notReady;
      }
    }

    case "read_full_text": {
      if (context.onReadFullText) {
        await context.onReadFullText();
        return "Reading full text.";
      }

      const sourceText =
        context.currentReadingResult?.response?.source_text?.trim() ||
        context.currentReadingResult?.response?.spoken_summary?.trim();

      if (!sourceText) {
        const noTextMsg =
          "No text was detected in the latest scan. Say 'scan again' to try another scan.";
        await speakIfEnabled(noTextMsg);
        return noTextMsg;
      }

      const fullSpoken = `Full text: ${sourceText}`;
      await speakIfEnabled(fullSpoken);
      return fullSpoken;
    }

    case "summarize_this": {
      if (context.onSummarizeResult) {
        await context.onSummarizeResult();
        return "Reading summary.";
      }

      const summary =
        context.currentReadingResult?.response?.spoken_summary?.trim();

      if (!summary) {
        const noSummaryMsg =
          "No summary is available for this scan. Say 'scan again' to try another scan.";
        await speakIfEnabled(noSummaryMsg);
        return noSummaryMsg;
      }

      const summarySpoken = `Summary: ${summary}`;
      await speakIfEnabled(summarySpoken);
      return summarySpoken;
    }

    case "scan_again": {
      const msg = "Returning to camera. Say 'scan now' when ready.";
      await speakIfEnabled(msg);

      if (context.onScanAgain) {
        context.onScanAgain();
      } else if (context.onNavigateToReader) {
        context.onNavigateToReader("auto");
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("reader");
      }

      return msg;
    }

    case "where_am_i": {
      const response = describeWhereAmI(currentScreen);
      await speakIfEnabled(response);
      return response;
    }

    case "what_can_i_do": {
      const response = describeWhatCanIDo(currentScreen);
      await speakIfEnabled(response);
      return response;
    }

    // Phase 2: Global Voice Navigation
    case "open_home":
    case "open_reader":
    case "open_results":
    case "open_timetable":
    case "open_navigation":
    case "open_voice":
    case "open_settings":
    case "open_assist": {
      const targetScreen: AppScreen =
        parsed.targetScreen ||
        SCREEN_INTENT_MAP[parsed.intent as NavigationIntentType] ||
        "home";

      const targetEntry = getScreenRegistryEntry(targetScreen);

      // Check if already on the target screen
      if (currentScreen === targetScreen) {
        if (targetScreen === "reader" && context.onTriggerScan && !context.isCapturing) {
          await context.onTriggerScan();
          return "Scan initiated.";
        }
        const alreadyMsg = `You are already on the ${targetEntry.screenName} screen.`;
        await speakIfEnabled(alreadyMsg);
        return alreadyMsg;
      }

      // Check if trying to view results with no scan available
      if (targetScreen === "results" && context.hasReadingResult === false) {
        const noResultMsg =
          "No reading results available yet. Please scan a document or sign first.";
        await speakIfEnabled(noResultMsg);
        return noResultMsg;
      }

      // Spoken confirmation
      const spokenMsg = `Opening ${targetEntry.screenName}.`;
      await speakIfEnabled(spokenMsg);

      // Trigger navigation callback
      if (context.onNavigateToScreen) {
        context.onNavigateToScreen(targetScreen);
      } else {
        // Fallback to legacy callbacks
        if (targetScreen === "reader") {
          context.onNavigateToReader?.("auto");
        } else if (targetScreen === "navigation") {
          context.onNavigateToNavigation?.("");
        } else if (targetScreen === "timetable") {
          context.onNavigateToTimetable?.();
        } else if (targetScreen === "home") {
          context.onNavigateBack?.();
        }
      }

      return spokenMsg;
    }

    case "go_back": {
      let backResult: AppScreen | boolean | void | null = undefined;
      if (context.onNavigateBack) {
        backResult = context.onNavigateBack();
      }

      // If at root of history and on home
      if (
        backResult === false ||
        backResult === null ||
        (context.screenHistory &&
          context.screenHistory.length === 0 &&
          currentScreen === "home")
      ) {
        const spoken =
          "You are already on the Home screen. There is nowhere to go back.";
        await speakIfEnabled(spoken);
        return spoken;
      }

      // Determine previous screen's conversational name
      let destinationName = "the previous screen";
      if (
        typeof backResult === "string" &&
        SCREEN_REGISTRY[backResult as AppScreen]
      ) {
        destinationName = SCREEN_REGISTRY[backResult as AppScreen].screenName;
      } else if (context.screenHistory && context.screenHistory.length > 0) {
        const prev = context.screenHistory[context.screenHistory.length - 1];
        if (SCREEN_REGISTRY[prev]) {
          destinationName = SCREEN_REGISTRY[prev].screenName;
        }
      } else if (currentScreen !== "home") {
        destinationName = "Home";
      }

      const spoken = `Returning to ${destinationName}.`;
      await speakIfEnabled(spoken);
      return spoken;
    }

    case "next_class": {
      const next = await readingPipeline.queryNextClass();
      return next.spokenDescription;
    }

    case "read_this": {
      const mode = parsed.readingMode || "auto";
      const modeName =
        mode === "timetable"
          ? "timetable"
          : mode === "sign"
          ? "room sign"
          : mode === "notice"
          ? "notice"
          : "general text";
      const spoken = `Opening camera in ${modeName} reading mode.`;
      await speakIfEnabled(spoken);
      const validMode: "auto" | "timetable" | "sign" | "notice" =
        mode === "timetable" || mode === "sign" || mode === "notice"
          ? mode
          : "auto";
      if (context.onNavigateToReader) {
        context.onNavigateToReader(validMode);
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("reader");
      }
      return spoken;
    }

    case "navigate_to": {
      const dest = (parsed.destinationQuery || "").trim();
      const matches = searchCampusPois(dest);

      let spoken = "";
      if (matches.length === 1) {
        spoken = `Finding walking route to ${matches[0].name}.`;
      } else if (matches.length > 1) {
        spoken = `Found multiple campus locations. Did you mean ${matches[0].name} or ${matches[1].name}?`;
      } else if (dest) {
        spoken = `Searching campus map for ${dest}.`;
      } else {
        spoken = "Opening campus map. Select a verified destination to start navigation.";
      }

      await speakIfEnabled(spoken);
      if (context.onNavigateToNavigation) {
        context.onNavigateToNavigation(matches[0]?.name || dest);
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("navigation");
      }
      return spoken;
    }

    case "general_query": {
      try {
        const queryRes = await askGeneralQuery(parsed.rawTranscript);
        const ans = queryRes.answer || "I could not find an answer for that.";
        await speakIfEnabled(ans);
        return ans;
      } catch {
        const fallback =
          "I could not connect to answer that question right now. You can ask for your next class, campus directions, or to scan text.";
        await speakIfEnabled(fallback);
        return fallback;
      }
    }

    case "what_is_ahead": {
      const desc = "Opening Live Camera Assist with Gemma 4 vision.";
      await speakIfEnabled(desc);
      if (context.onNavigateToAssist) {
        context.onNavigateToAssist();
      } else if (context.onNavigateToScreen) {
        context.onNavigateToScreen("assist");
      } else if (context.onNavigateToReader) {
        context.onNavigateToReader("auto");
      }
      return desc;
    }

    case "unknown":
    default: {
      const msg =
        "I did not recognize the command. You can ask for your next class, directions to a campus building, to read text, or ask a question.";
      await speakIfEnabled(msg);
      return msg;
    }
  }
}
