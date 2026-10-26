"""
FastAPI Speech Synthesis API Route.

Handles speech synthesis using ElevenLabs official API with safe fallback handling.
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.services.elevenlabs import (
    elevenlabs_service,
    ElevenLabsError,
    ElevenLabsAuthenticationError,
    ElevenLabsQuotaExceededError,
)

router = APIRouter(prefix="/speech", tags=["speech"])


class SpeechSynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000, description="Text to synthesize into speech")
    voice_id: Optional[str] = Field(None, description="Optional custom ElevenLabs voice ID")


@router.get("/status", summary="Check ElevenLabs TTS configuration status")
async def get_speech_status():
    """Returns whether ElevenLabs TTS is configured and the active voice/model IDs."""
    return elevenlabs_service.get_status()


@router.post(
    "/synthesize",
    summary="Synthesize speech audio using ElevenLabs",
    response_class=Response,
    responses={
        200: {
            "content": {"audio/mpeg": {}},
            "description": "Synthesized MP3 audio stream",
        },
        400: {"description": "Invalid input text"},
        429: {"description": "ElevenLabs quota exceeded"},
        503: {"description": "ElevenLabs not configured"},
    },
)
async def synthesize_speech(request: SpeechSynthesizeRequest):
    """
    Synthesizes speech from input text and returns MP3 audio bytes.
    If unconfigured or credentials are missing, returns an explicit 503 error.
    """
    try:
        audio_bytes = await elevenlabs_service.synthesize_speech(
            text=request.text,
            voice_id=request.voice_id,
        )
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline; filename=speech.mp3",
                "Cache-Control": "public, max-age=3600",
            },
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ElevenLabsAuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except ElevenLabsQuotaExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        ) from exc
    except ElevenLabsError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
