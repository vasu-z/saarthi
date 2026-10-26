"""
Tests for ElevenLabs Speech Synthesis backend route and service.
"""

import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import get_settings
import httpx


@pytest.fixture
def client():
    return TestClient(app)


def test_speech_status_unconfigured(client, monkeypatch):
    """When ELEVENLABS_API_KEY is not set, status returns configured: False."""
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    get_settings.cache_clear()

    response = client.get("/api/v1/speech/status")
    assert response.status_code == 200
    data = response.json()
    assert data["configured"] is False
    assert "voice_id" in data
    assert "model_id" in data


def test_speech_status_configured(client, monkeypatch):
    """When ELEVENLABS_API_KEY is set, status returns configured: True."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test_elevenlabs_key_123")
    get_settings.cache_clear()

    response = client.get("/api/v1/speech/status")
    assert response.status_code == 200
    data = response.json()
    assert data["configured"] is True


def test_synthesize_unconfigured_returns_503(client, monkeypatch):
    """When unconfigured, synthesize returns 503 explaining configuration requirement."""
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    get_settings.cache_clear()

    response = client.post("/api/v1/speech/synthesize", json={"text": "Welcome to campus"})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"].lower()


def test_synthesize_empty_text_returns_422_or_400(client, monkeypatch):
    """Empty text is rejected with validation error."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test_key")
    get_settings.cache_clear()

    response = client.post("/api/v1/speech/synthesize", json={"text": "   "})
    # Either Pydantic schema validation or ValueError yields 400 or 422
    assert response.status_code in (400, 422)


@pytest.mark.asyncio
async def test_synthesize_success_returns_audio(client, monkeypatch):
    """When configured and upstream returns 200, returns audio/mpeg bytes."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "valid_test_key")
    get_settings.cache_clear()

    fake_mp3 = b"ID3\x03\x00\x00\x00\x00\x00#TSSE\x00\x00\x00\x0f\x00\x00\x03Lavf58.29.100\x00\xff\xfb\x90\x04"

    mock_response = httpx.Response(
        status_code=200,
        content=fake_mp3,
        headers={"content-type": "audio/mpeg"},
        request=httpx.Request("POST", "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        response = client.post("/api/v1/speech/synthesize", json={"text": "Welcome to Chandigarh University"})
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.content == fake_mp3


@pytest.mark.asyncio
async def test_synthesize_quota_exceeded_returns_429(client, monkeypatch):
    """When upstream returns 429 quota exceeded, endpoint returns 429."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "valid_test_key")
    get_settings.cache_clear()

    mock_response = httpx.Response(
        status_code=429,
        text="quota exceeded",
        request=httpx.Request("POST", "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        response = client.post("/api/v1/speech/synthesize", json={"text": "Test quota"})
        assert response.status_code == 429
        assert "quota" in response.json()["detail"].lower()
