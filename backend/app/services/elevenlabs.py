"""
ElevenLabs Official Text-to-Speech Service.

Provides natural multilingual speech synthesis for Saarthi assistive voice feedback.
Official ElevenLabs REST API documentation:
https://elevenlabs.io/docs/api-reference/text-to-speech
"""

from typing import Optional, Dict, Any
import httpx
from app.core.config import get_settings


class ElevenLabsError(Exception):
    """Base exception for ElevenLabs API errors."""
    pass


class ElevenLabsAuthenticationError(ElevenLabsError):
    """Raised when the ElevenLabs API key is missing, invalid, or unauthorized."""
    pass


class ElevenLabsQuotaExceededError(ElevenLabsError):
    """Raised when the ElevenLabs tier quota or rate limit is exceeded."""
    pass


class ElevenLabsService:
    """Service client for official ElevenLabs Text-to-Speech API."""

    def __init__(self) -> None:
        pass

    def get_status(self) -> Dict[str, Any]:
        """Returns the current configuration status of ElevenLabs TTS."""
        settings = get_settings()
        return {
            "configured": settings.is_elevenlabs_configured,
            "voice_id": settings.ELEVENLABS_VOICE_ID,
            "model_id": settings.ELEVENLABS_MODEL_ID,
        }

    async def synthesize_speech(
        self,
        text: str,
        voice_id: Optional[str] = None,
    ) -> bytes:
        """
        Synthesizes spoken audio from text using ElevenLabs API.

        Args:
            text: The text to be spoken.
            voice_id: Optional override for the target voice ID.

        Returns:
            Raw audio bytes in audio/mpeg format.

        Raises:
            ValueError: If text is empty or exceeds character limits.
            ElevenLabsAuthenticationError: If unconfigured or 401 unauthorized.
            ElevenLabsQuotaExceededError: If 429 rate limited or quota exhausted.
            ElevenLabsError: On upstream API errors or timeouts.
        """
        clean_text = (text or "").strip()
        if not clean_text:
            raise ValueError("Speech synthesis text cannot be empty.")

        if len(clean_text) > 3000:
            raise ValueError("Speech synthesis text exceeds maximum safe limit of 3000 characters.")

        settings = get_settings()
        if not settings.is_elevenlabs_configured:
            raise ElevenLabsAuthenticationError(
                "ElevenLabs API key is not configured. Set ELEVENLABS_API_KEY in backend/.env"
            )

        target_voice_id = (voice_id or settings.ELEVENLABS_VOICE_ID).strip()
        endpoint = f"{settings.ELEVENLABS_API_URL.rstrip('/')}/text-to-speech/{target_voice_id}"

        headers = {
            "xi-api-key": settings.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }

        payload = {
            "text": clean_text,
            "model_id": settings.ELEVENLABS_MODEL_ID,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }

        try:
            async with httpx.AsyncClient(timeout=settings.ELEVENLABS_TIMEOUT_SECONDS) as client:
                response = await client.post(endpoint, json=payload, headers=headers)

                if response.status_code == 200:
                    return response.content

                if response.status_code == 401:
                    raise ElevenLabsAuthenticationError(
                        "ElevenLabs API key is unauthorized or invalid."
                    )

                if response.status_code == 429:
                    raise ElevenLabsQuotaExceededError(
                        "ElevenLabs quota exceeded or rate limit reached."
                    )

                raise ElevenLabsError(
                    f"ElevenLabs API error ({response.status_code}): {response.text[:200]}"
                )

        except httpx.TimeoutException as exc:
            raise ElevenLabsError("Connection to ElevenLabs API timed out.") from exc
        except httpx.RequestError as exc:
            raise ElevenLabsError(f"Network error connecting to ElevenLabs: {str(exc)}") from exc


elevenlabs_service = ElevenLabsService()
